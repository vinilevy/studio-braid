#!/usr/bin/env tsx
/**
 * run-regression — regressão contínua: mocks → CLI da IA 1 → verify-export + verify-fcpxml.
 *
 *   npm --prefix tests run verify                       (todos os mocks)
 *   npm --prefix tests run verify -- --only m5,zip3     (subconjunto)
 *   npm --prefix tests run verify -- --real "<projeto>.screenstudio"   (inclui projeto real; lento)
 *
 * Saídas em tests/output/regression/, relatórios JSON ao lado. Código de saída 1 se qualquer FAIL.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createMockBundle, type MockLayout } from './create-mock-bundle.ts';
import { runBridgeCli } from './lib/cli.ts';
import { c, type Report } from './lib/report.ts';
import type { MediaKind } from './lib/screenstudio.ts';
import { verifyExport } from './verify-export.ts';
import { verifyFcpxml } from './verify-fcpxml.ts';

interface Scenario {
  id: string;
  what: string;
  sessions: number;
  layout?: MockLayout;
  zip?: boolean;
  tracks?: MediaKind[];
  missing?: ('V2' | 'A2')[];
  webcamSize?: [number, number];
  /** Extra CLI arguments for this scenario (e.g. camera preset flags). */
  cliArgs?: string[];
}

const ALL: MediaKind[] = ['display', 'webcam', 'microphone', 'systemAudio'];
const SCENARIOS: Scenario[] = [
  { id: 'm1', what: '1 sessão, SS 4.0 (HLS)', sessions: 1 },
  { id: 'm3', what: '3 sessões, SS 4.0 (HLS)', sessions: 3 },
  { id: 'm5', what: '5 sessões, SS 4.0 (HLS)', sessions: 5 },
  { id: 'ss37', what: '3 sessões, SS 3.7 (MP4 consolidado + HLS)', sessions: 3, layout: 'ss37' },
  { id: 'zip3', what: '3 sessões em .zip do Finder (NFD, __MACOSX)', sessions: 3, zip: true },
  { id: 'nocam', what: '3 sessões sem câmera', sessions: 3, tracks: ALL.filter((k) => k !== 'webcam'), missing: ['V2'] },
  { id: 'nosys', what: '3 sessões sem áudio do sistema', sessions: 3, tracks: ALL.filter((k) => k !== 'systemAudio'), missing: ['A2'] },
  { id: 'cam43', what: '3 sessões, webcam 4:3 (320x240)', sessions: 3, webcamSize: [320, 240] },
];

interface Row {
  id: string;
  what: string;
  cli: string;
  exportVerdict: string;
  fcpxmlVerdict: string;
  markers: string;
  fails: string[];
}

const short = (r: Report) => `${r.verdict === 'REPROVADO' ? c.red('REPROVADO') : r.verdict === 'APROVADO' ? c.green('APROVADO') : c.yellow('RESSALVAS')} (${r.count('FAIL')}F/${r.count('WARN')}W)`;

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}
type Exec = (input: string, output: string, expectSessions?: number) => Promise<ExecResult>;

/** Production path used by the UI: analyze → POST /api/jobs (with options) → poll GET /api/jobs/:id. */
function httpExec(base: string, jobJson: Record<string, unknown>): Exec {
  return async (input, output, expectSessions) => {
    const t0 = Date.now();
    const post = async (p: string, body: unknown) => {
      const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const fail = (msg: string): ExecResult => ({ code: 1, stdout: '', stderr: msg, ms: Date.now() - t0 });
    const analysis = await post('/api/projects/analyze', { inputPath: input, outputPath: output });
    if (analysis.status !== 200) return fail(`analyze HTTP ${analysis.status}: ${JSON.stringify(analysis.json)}`);
    if (expectSessions !== undefined && analysis.json.sessionCount !== expectSessions) {
      return fail(`analyze devolveu sessionCount=${String(analysis.json.sessionCount)}; o mock tem ${expectSessions}`);
    }
    const job = await post('/api/jobs', { inputPath: input, outputPath: output, ...jobJson });
    if (job.status >= 300) return fail(`POST /api/jobs HTTP ${job.status}: ${JSON.stringify(job.json)}`);
    const id = String(job.json.jobId ?? job.json.id ?? '');
    if (!id) return fail(`POST /api/jobs sem id: ${JSON.stringify(job.json)}`);
    while (Date.now() - t0 < 30 * 60_000) {
      await sleep(500);
      const snap = (await (await fetch(`${base}/api/jobs/${id}`)).json()) as Record<string, unknown>;
      if (snap.state === 'completed') return { code: 0, stdout: JSON.stringify(snap), stderr: '', ms: Date.now() - t0 };
      if (snap.state === 'failed' || snap.state === 'cancelled') return fail(`job ${snap.state}: ${JSON.stringify(snap.error)}`);
    }
    return fail('timeout de 30 min aguardando o job');
  };
}

const cliExec = (cliJs: string | undefined, cliArgs: string[]): Exec => (input, output) => runBridgeCli(input, output, cliJs, cliArgs);

async function runCase(id: string, what: string, input: string, outRoot: string, missing: ('V2' | 'A2')[] | undefined, sourceForAudit: string, exec: Exec, expectSessions?: number): Promise<Row> {
  const output = path.join(outRoot, `${id} - DaVinci`);
  await rm(output, { recursive: true, force: true });
  const cli = await exec(input, output, expectSessions);
  await writeFile(path.join(outRoot, `${id}.cli.log`), `${cli.stderr}\n--- stdout ---\n${cli.stdout}`);
  if (cli.code !== 0) {
    const tail = cli.stderr.trim().split('\n').slice(-3).join(' | ');
    return { id, what, cli: c.red(`exit ${cli.code}`), exportVerdict: '—', fcpxmlVerdict: '—', markers: '—', fails: [`CLI saiu com ${cli.code}: ${tail}`] };
  }
  const exp = await verifyExport({ outputDir: output, source: sourceForAudit, quiet: true, jsonPath: path.join(outRoot, `${id}.verify-export.json`) });
  const fx = await verifyFcpxml({ input: output, quiet: true, missingTracks: missing, jsonPath: path.join(outRoot, `${id}.verify-fcpxml.json`) });
  const markers = exp.facts.markers as { worstAbsMs: number; worstSpreadMs: number } | undefined;
  return {
    id,
    what,
    cli: `ok ${(cli.ms / 1000).toFixed(1)}s`,
    exportVerdict: short(exp),
    fcpxmlVerdict: short(fx),
    markers: markers ? `${markers.worstAbsMs.toFixed(1)} / ${markers.worstSpreadMs.toFixed(1)} ms` : '—',
    fails: [...exp.findings, ...fx.findings].filter((f) => f.severity === 'FAIL').map((f) => `[${f.id}] ${f.title}`),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      real: { type: 'string', multiple: true },
      'cli-js': { type: 'string' },
      'cli-args': { type: 'string' },
      http: { type: 'string' },
      'job-json': { type: 'string' },
      out: { type: 'string', default: path.join(import.meta.dirname, 'output', 'regression') },
      fixtures: { type: 'string', default: path.join(import.meta.dirname, 'fixtures', 'generated') },
    },
  });
  const outRoot = path.resolve(values.out);
  await mkdir(outRoot, { recursive: true });
  const only = values.only?.split(',');
  const globalArgs = values['cli-args']?.split(/\s+/).filter(Boolean) ?? [];
  const jobJson = values['job-json'] ? (JSON.parse(values['job-json']) as Record<string, unknown>) : {};
  const execFor = (extra: string[] = []): Exec => (values.http ? httpExec(values.http.replace(/\/$/, ''), jobJson) : cliExec(values['cli-js'], [...globalArgs, ...extra]));
  console.log(c.dim(values.http ? `Modo HTTP: ${values.http} ${values['job-json'] ?? ''}` : `Modo CLI${globalArgs.length ? `: ${globalArgs.join(' ')}` : ''}`));
  const rows: Row[] = [];

  for (const s of SCENARIOS.filter((x) => !only || only.includes(x.id))) {
    process.stdout.write(c.dim(`• ${s.id}: ${s.what}… `));
    const bundle = await createMockBundle({ outDir: path.join(path.resolve(values.fixtures), s.id), sessions: s.sessions, layout: s.layout, zip: s.zip, tracks: s.tracks, webcamSize: s.webcamSize });
    const input = s.zip && bundle.zipPath ? bundle.zipPath : bundle.bundlePath;
    const row = await runCase(s.id, s.what, input, outRoot, s.missing, input, execFor(s.cliArgs), s.sessions);
    console.log(row.fails.length ? c.red('FAIL') : c.green('ok'));
    rows.push(row);
  }
  for (const [i, real] of (values.real ?? []).entries()) {
    const id = `real${i + 1}`;
    process.stdout.write(c.dim(`• ${id}: ${path.basename(real)} (projeto real, pode levar minutos)… `));
    const row = await runCase(id, `REAL: ${path.basename(real)}`, real, outRoot, undefined, real, execFor());
    console.log(row.fails.length ? c.red('FAIL') : c.green('ok'));
    rows.push(row);
  }

  console.log(`\n${c.bold('Regressão Screen Studio Bridge')}  ${c.dim(outRoot)}`);
  const header = ['caso', 'cenário', 'CLI', 'verify-export', 'verify-fcpxml', 'marcadores (abs/entre faixas)'];
  const table = [header, ...rows.map((r) => [r.id, r.what, r.cli, r.exportVerdict, r.fcpxmlVerdict, r.markers])];
  // eslint-disable-next-line no-control-regex
  const vis = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const widths = header.map((_, i) => Math.max(...table.map((r) => vis(r[i] ?? ''))));
  for (const [n, r] of table.entries()) {
    const line = r.map((cell, i) => cell + ' '.repeat((widths[i] ?? 0) - vis(cell))).join('  ');
    console.log(n === 0 ? c.dim(line) : line);
  }
  const failing = rows.filter((r) => r.fails.length);
  for (const r of failing) {
    console.log(`\n${c.red(`✗ ${r.id}`)} — ${r.what}`);
    for (const f of r.fails) console.log(`   ${f}`);
  }
  console.log(`\n${failing.length ? c.red(`${failing.length}/${rows.length} cenário(s) REPROVADO(s)`) : c.green(`${rows.length}/${rows.length} cenários sem FAIL`)}`);
  process.exit(failing.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`run-regression: ${(e as Error).stack ?? e}`);
  process.exit(2);
});
