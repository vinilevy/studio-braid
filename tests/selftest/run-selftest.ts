#!/usr/bin/env tsx
/**
 * selftest — a auditoria é testada contra si mesma.
 *
 *   npx tsx tests/selftest/run-selftest.ts [--baseline "<exportação boa>" --source "<mock>.screenstudio"] [--keep]
 *
 * 1. Gera um mock de 5 sessões (com gabarito) e exporta com a CLI da IA 1 → exportação BASE.
 * 2. A base precisa passar sem nenhum FAIL (prova de ausência de falso positivo).
 * 3. Cada sabotagem é aplicada numa cópia da base e PRECISA produzir o FAIL esperado
 *    (prova de que o auditor não tem ponto cego para aquela classe de defeito).
 */
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createMockBundle } from '../create-mock-bundle.ts';
import { runBridgeCli } from '../lib/cli.ts';
import { ffmpeg } from '../lib/exec.ts';
import { probe } from '../lib/ffprobe.ts';
import type { MockTruth } from '../lib/markers.ts';
import { c, type Report } from '../lib/report.ts';
import { verifyExport } from '../verify-export.ts';
import { verifyFcpxml } from '../verify-fcpxml.ts';

interface Case {
  id: string;
  what: string;
  target: 'export' | 'fcpxml';
  /** Finding id prefixes that must appear as FAIL. */
  expect: string[];
  mutate: (dir: string, ctx: Ctx) => Promise<void>;
}

interface Ctx {
  source: string;
  truth: MockTruth;
}

const media = (dir: string, f: string) => path.join(dir, '01_MEDIA', f);

async function replaceMedia(dir: string, file: string, args: (input: string, output: string) => string[]): Promise<void> {
  const target = media(dir, file);
  const tmp = target.replace(/(\.\w+)$/, '.sabotage$1');
  await ffmpeg(['-v', 'error', ...args(target, tmp)]);
  await rename(tmp, target);
}

async function editFile(file: string, edit: (text: string) => string): Promise<void> {
  const before = await readFile(file, 'utf8');
  const after = edit(before);
  if (after === before) throw new Error(`sabotagem não alterou ${path.basename(file)} (padrão não encontrado)`);
  await writeFile(file, after);
}

const fcpxmlOf = async (dir: string) => {
  const { readdir } = await import('node:fs/promises');
  const d = path.join(dir, '02_DAVINCI');
  const name = (await readdir(d)).find((n) => n.endsWith('.fcpxml'));
  if (!name) throw new Error('base sem FCPXML');
  return path.join(d, name);
};

const pcm = ['-c:a', 'pcm_s24le', '-ar', '48000'];

const CASES: Case[] = [
  {
    id: 'only-first-session',
    what: 'Só a 1ª sessão exportada (o bug "3 min em vez de 35")',
    target: 'export',
    expect: ['sessions-ignored-display', 'sessions-ignored-webcam', 'sessions-ignored-microphone', 'sessions-ignored-systemAudio'],
    mutate: async (dir, { truth }) => {
      const d0 = ((truth.sessions[0]?.durationMs ?? 0) / 1000).toFixed(6);
      for (const f of ['SCREEN.mp4', 'CAMERA.mp4', 'MICROPHONE.wav', 'SYSTEM_AUDIO.wav']) await replaceMedia(dir, f, (i, o) => ['-i', i, '-t', d0, '-c', 'copy', o]);
    },
  },
  {
    id: 'report-lies',
    what: 'Mídia truncada mas sync_report.json ainda declara "ok" e durações completas',
    target: 'export',
    expect: ['sync-lies-display', 'sync-false-ok'],
    mutate: async (dir, { truth }) => {
      const d0 = ((truth.sessions[0]?.durationMs ?? 0) / 1000).toFixed(6);
      await replaceMedia(dir, 'SCREEN.mp4', (i, o) => ['-i', i, '-t', d0, '-c', 'copy', o]);
    },
  },
  {
    id: 'naive-concat',
    what: 'SYSTEM_AUDIO concatenado sem aparar/preencher sessões (+86 ms acumulando por sessão)',
    target: 'export',
    expect: ['duration-systemAudio', 'inter-track', 'marker-sync'],
    mutate: async (dir, { source, truth }) => {
      const inputs = truth.sessions.flatMap((s) => ['-i', path.join(source, 'recording', `channel-1-system-audio-${s.index}.m4a`)]);
      const graph = `${truth.sessions.map((_, i) => `[${i}:a]`).join('')}concat=n=${truth.sessions.length}:v=0:a=1[a]`;
      await ffmpeg(['-v', 'error', ...inputs, '-filter_complex', graph, '-map', '[a]', ...pcm, media(dir, 'SYSTEM_AUDIO.wav')]);
    },
  },
  {
    id: 'pauses-included',
    what: 'Pausas de relógio de parede inseridas como silêncio no MICROPHONE',
    target: 'export',
    expect: ['duration-microphone', 'inter-track', 'markers-missing'],
    mutate: async (dir, { truth }) => {
      const pauses = (truth.quirks.pausesMs as number[]) ?? [];
      const n0 = truth.sessions.length;
      const parts: string[] = [`[0:a]asplit=${n0}${truth.sessions.map((_, i) => `[in${i}]`).join('')}`];
      truth.sessions.forEach((s, i) => {
        parts.push(`[in${i}]atrim=start=${(s.timelineStartMs / 1000).toFixed(6)}:duration=${(s.durationMs / 1000).toFixed(6)},asetpts=PTS-STARTPTS[s${i}]`);
        if (i < truth.sessions.length - 1) parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${((pauses[i] ?? 0) / 1000).toFixed(3)}[p${i}]`);
      });
      const order = truth.sessions.flatMap((_, i) => (i < truth.sessions.length - 1 ? [`[s${i}]`, `[p${i}]`] : [`[s${i}]`])).join('');
      const n = truth.sessions.length * 2 - 1;
      await replaceMedia(dir, 'MICROPHONE.wav', (i, o) => ['-i', i, '-filter_complex', `${parts.join(';')};${order}concat=n=${n}:v=0:a=1[a]`, '-map', '[a]', ...pcm, o]);
    },
  },
  {
    id: 'camera-late',
    what: 'Câmera atrasada 233 ms (alinhada pelo PTS bruto do HLS, com atraso de composição)',
    target: 'export',
    expect: ['marker-sync'],
    mutate: async (dir) => {
      const dur = (await probe(media(dir, 'CAMERA.mp4'))).durationSec.toFixed(6);
      await replaceMedia(dir, 'CAMERA.mp4', (i, o) => ['-i', i, '-vf', 'tpad=start_duration=0.233:start_mode=clone', '-t', dur, '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', o]);
    },
  },
  {
    id: 'orphan-appended',
    what: 'Sessão órfã (fora do metadata) concatenada ao fim do SYSTEM_AUDIO',
    target: 'export',
    expect: ['markers-extra-systemAudio', 'duration-systemAudio'],
    mutate: async (dir, { truth }) => {
      const tone = `0.5*sin(2*PI*${truth.beepHz.systemAudio}*t)*gte(t,0.4)*lt(t,1.0)`;
      await replaceMedia(dir, 'SYSTEM_AUDIO.wav', (i, o) => ['-i', i, '-f', 'lavfi', '-i', `aevalsrc=exprs='${tone}|${tone}':s=48000:d=1.6`, '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', ...pcm, o]);
    },
  },
  {
    id: 'camera-hevc',
    what: 'CAMERA.mp4 deixada em HEVC (tela preta no DaVinci Free/Windows)',
    target: 'export',
    expect: ['camera-hevc'],
    mutate: async (dir) => replaceMedia(dir, 'CAMERA.mp4', (i, o) => ['-i', i, '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', o]),
  },
  {
    id: 'camera-distorted',
    what: 'Câmera esticada para 3840x1600 sem preservar o aspecto',
    target: 'export',
    expect: ['camera-aspect'],
    mutate: async (dir) => replaceMedia(dir, 'CAMERA.mp4', (i, o) => ['-i', i, '-vf', 'scale=3840:1600,setsar=1', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', o]),
  },
  {
    id: 'camera-10bit',
    what: 'Câmera "qualidade máxima" em 10-bit (High 10, yuv420p10le)',
    target: 'export',
    expect: ['camera-pixfmt', 'camera-profile'],
    mutate: async (dir) => replaceMedia(dir, 'CAMERA.mp4', (i, o) => ['-i', i, '-c:v', 'libx264', '-profile:v', 'high10', '-pix_fmt', 'yuv420p10le', '-preset', 'ultrafast', o]),
  },
  {
    id: 'screen-fake-remux',
    what: 'Tela recomprimida enquanto o manifest declara remux',
    target: 'export',
    expect: ['screen-remux-exact'],
    mutate: async (dir) => replaceMedia(dir, 'SCREEN.mp4', (i, o) => ['-i', i, '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '30', '-fps_mode', 'passthrough', '-preset', 'ultrafast', o]),
  },
  {
    id: 'manifest-crf-lie',
    what: 'Manifest declara CRF diferente do que o encoder gravou',
    target: 'export',
    expect: ['camera-manifest-crf'],
    mutate: async (dir) =>
      editFile(path.join(dir, '03_DATA', 'project_manifest.json'), (t) => {
        const j = JSON.parse(t) as { videoSettings?: { webcam?: { crf?: number } } };
        if (!j.videoSettings?.webcam || typeof j.videoSettings.webcam.crf !== 'number') return t;
        j.videoSettings.webcam.crf += 5;
        return JSON.stringify(j, null, 2);
      }),
  },
  {
    id: 'audio-44k',
    what: 'MICROPHONE.wav em 44,1 kHz/16-bit',
    target: 'export',
    expect: ['microphone-format'],
    mutate: async (dir) => replaceMedia(dir, 'MICROPHONE.wav', (i, o) => ['-i', i, '-c:a', 'pcm_s16le', '-ar', '44100', o]),
  },
  {
    id: 'swapped-audio',
    what: 'MICROPHONE e SYSTEM_AUDIO trocados',
    target: 'export',
    expect: ['swapped-microphone', 'swapped-systemAudio'],
    mutate: async (dir) => {
      await rename(media(dir, 'MICROPHONE.wav'), media(dir, 'tmp.wav'));
      await rename(media(dir, 'SYSTEM_AUDIO.wav'), media(dir, 'MICROPHONE.wav'));
      await rename(media(dir, 'tmp.wav'), media(dir, 'SYSTEM_AUDIO.wav'));
    },
  },
  {
    id: 'missing-track',
    what: 'SYSTEM_AUDIO.wav não gerado embora o metadata tenha a faixa',
    target: 'export',
    expect: ['missing-systemAudio'],
    mutate: async (dir) => rm(media(dir, 'SYSTEM_AUDIO.wav')),
  },
  {
    id: 'mojibake-name',
    what: 'Nome do projeto decodificado como CP437 (ZIP do Finder sem flag UTF-8)',
    target: 'export',
    expect: ['manifest-name-mojibake'],
    mutate: async (dir) =>
      editFile(path.join(dir, '03_DATA', 'project_manifest.json'), (t) => t.replace(/("projectName":\s*")([^"]*)(")/, (_, a, name: string, z) => `${a}${name.replace(/õ/g, 'o╠â').replace(/ç/g, 'c╠º')}${z}`)),
  },
  {
    id: 'fcpxml-missing-asset',
    what: 'FCPXML aponta para mídia inexistente',
    target: 'fcpxml',
    expect: ['asset-missing-'],
    mutate: async (dir) => editFile(await fcpxmlOf(dir), (t) => t.replace(/(src="[^"]*)CAMERA\.mp4"/, '$1CAMERA_inexistente.mp4"')),
  },
  {
    id: 'fcpxml-raw-space',
    what: 'URL de mídia com espaço não codificado',
    target: 'fcpxml',
    expect: ['asset-url-'],
    mutate: async (dir) => editFile(await fcpxmlOf(dir), (t) => t.replace(/(src="[^"]*)SCREEN\.mp4"/, '$1SCREEN copia.mp4"')),
  },
  {
    id: 'fcpxml-wrong-lanes',
    what: 'Câmera e microfone com lanes trocadas (V2↔A1)',
    target: 'fcpxml',
    expect: ['track-V2', 'track-A1'],
    mutate: async (dir) => editFile(await fcpxmlOf(dir), (t) => t.replace(/lane="1"/, 'lane="__X__"').replace(/lane="-1"/, 'lane="1"').replace('lane="__X__"', 'lane="-1"')),
  },
  {
    id: 'fcpxml-offset',
    what: 'Câmera deslocada meio segundo na timeline',
    target: 'fcpxml',
    expect: ['sync-offset-V2'],
    mutate: async (dir) => editFile(await fcpxmlOf(dir), (t) => t.replace(/(<asset-clip\b[^>]*lane="1"[^>]*\boffset=")[^"]*(")/, '$11/2s$2')),
  },
  {
    id: 'fcpxml-malformed',
    what: 'XML truncado/malformado',
    target: 'fcpxml',
    expect: ['xml-syntax'],
    mutate: async (dir) => editFile(await fcpxmlOf(dir), (t) => t.replace('</spine>', '')),
  },
  {
    id: 'fcpxml-version',
    what: 'Versão de FCPXML antiga demais para o Resolve',
    target: 'fcpxml',
    expect: ['fcpxml-version'],
    mutate: async (dir) => editFile(await fcpxmlOf(dir), (t) => t.replace(/<fcpxml version="[^"]*"/, '<fcpxml version="1.5"')),
  },
];

const failIds = (r: Report) => r.findings.filter((f) => f.severity === 'FAIL').map((f) => f.id);

async function audit(target: 'export' | 'fcpxml', dir: string, source: string): Promise<Report> {
  return target === 'export' ? verifyExport({ outputDir: dir, source, quiet: true }) : verifyFcpxml({ input: dir, quiet: true });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      baseline: { type: 'string' },
      source: { type: 'string' },
      'cli-js': { type: 'string' },
      only: { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  });
  const work = path.join(os.tmpdir(), `ssb-selftest-${Date.now()}`);
  await mkdir(work, { recursive: true });
  let source = values.source;
  let baseline = values.baseline;
  if (!baseline || !source) {
    console.log(c.dim('Gerando mock de 5 sessões e exportação base com a CLI da IA 1…'));
    const bundle = await createMockBundle({ outDir: path.join(work, 'mock'), sessions: 5 });
    source = bundle.bundlePath;
    baseline = path.join(work, 'baseline - DaVinci');
    const r = await runBridgeCli(source, baseline, values['cli-js']);
    if (r.code !== 0) throw new Error(`CLI falhou ao gerar a base (código ${r.code}):\n${r.stderr.split('\n').slice(-8).join('\n')}`);
  }
  const { findTruthFile, loadTruth } = await import('../lib/markers.ts');
  const truthFile = await findTruthFile(source);
  if (!truthFile) throw new Error(`Sem gabarito (.truth.json) para ${source}`);
  const ctx: Ctx = { source, truth: await loadTruth(truthFile) };

  const rows: { id: string; ok: boolean; note: string }[] = [];
  for (const target of ['export', 'fcpxml'] as const) {
    const r = await audit(target, baseline, source);
    const fails = failIds(r);
    rows.push({ id: `baseline:${target}`, ok: fails.length === 0, note: fails.length ? `FALSO POSITIVO: ${fails.join(', ')}` : `sem FAIL (${r.verdict})` });
  }
  const selected = values.only ? CASES.filter((k) => values.only?.split(',').includes(k.id)) : CASES;
  for (const k of selected) {
    const dir = path.join(work, k.id);
    try {
      await cp(baseline, dir, { recursive: true });
      await k.mutate(dir, ctx);
      const fails = failIds(await audit(k.target, dir, source));
      const missing = k.expect.filter((e) => !fails.some((f) => f.startsWith(e)));
      rows.push({ id: k.id, ok: missing.length === 0, note: missing.length ? `PONTO CEGO: faltou ${missing.join(', ')} (achou: ${fails.join(', ') || 'nada'})` : `${k.what} → ${k.expect.join(', ')}` });
    } catch (e) {
      rows.push({ id: k.id, ok: false, note: `erro ao montar o caso: ${(e as Error).message.split('\n')[0]}` });
    }
  }

  console.log(`\n${c.bold('Self-test da auditoria')}  ${c.dim(work)}`);
  for (const r of rows) console.log(`${r.ok ? c.green('✓') : c.red('✗')} ${r.id.padEnd(22)} ${c.dim(r.note)}`);
  const bad = rows.filter((r) => !r.ok).length;
  console.log(`\n${bad === 0 ? c.green(`OK: ${rows.length}/${rows.length}`) : c.red(`${bad} caso(s) falharam de ${rows.length}`)}`);
  if (!values.keep) await rm(work, { recursive: true, force: true });
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`selftest: ${(e as Error).stack ?? e}`);
  process.exit(2);
});
