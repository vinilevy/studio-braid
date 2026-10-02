#!/usr/bin/env tsx
/**
 * verify-fcpxml — auditoria do FCPXML gerado para o DaVinci Resolve.
 *
 *   npx tsx tests/verify-fcpxml.ts "<saida> - DaVinci"            (procura 02_DAVINCI/*.fcpxml)
 *   npx tsx tests/verify-fcpxml.ts arquivo.fcpxml [--dtd FCPXMLv1_10.dtd] [--json out.json] [--strict]
 *
 * Confere: XML bem-formado; versão; ids/refs internos; cada <asset src> (pré-1.9) ou <media-rep src>
 * (1.9+) resolvido e existente no disco; faixas V1=SCREEN, V2=CAMERA, A1=MICROPHONE, A2=SYSTEM_AUDIO
 * (spine + lanes 1/−1/−2); alinhamento no início, durações coerentes com o ffprobe e com a grade de frames.
 */
import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { run } from './lib/exec.ts';
import { audioStream, parseRate, probe, videoStream, type ProbeResult } from './lib/ffprobe.ts';
import { ms, Report } from './lib/report.ts';

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
}

type Track = 'V1' | 'V2' | 'A1' | 'A2';
const EXPECTED: Record<Track, string> = { V1: 'SCREEN.mp4', V2: 'CAMERA.mp4', A1: 'MICROPHONE.wav', A2: 'SYSTEM_AUDIO.wav' };
const LANE_TO_TRACK: Record<string, Track> = { '1': 'V2', '-1': 'A1', '-2': 'A2' };
const CLIP_TAGS = new Set(['asset-clip', 'clip', 'ref-clip', 'sync-clip', 'mc-clip', 'video', 'audio', 'gap']);
const SUPPORTED_VERSIONS = ['1.8', '1.9', '1.10', '1.11'];

const exists = (p: string) => access(p).then(() => true, () => false);

function toTree(items: unknown[]): XNode[] {
  const out: XNode[] = [];
  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    const name = Object.keys(item).find((k) => k !== ':@');
    if (!name || name.startsWith('#') || name.startsWith('?') || name.startsWith('!')) continue;
    out.push({ name, attrs: (item[':@'] as Record<string, string>) ?? {}, children: toTree((item[name] as unknown[]) ?? []) });
  }
  return out;
}

export function parseFcpxml(text: string): XNode | undefined {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    preserveOrder: true,
    ignoreDeclaration: true,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
  });
  return toTree(parser.parse(text) as unknown[]).find((n) => n.name === 'fcpxml');
}

const all = (node: XNode, name: string): XNode[] => [...(node.name === name ? [node] : []), ...node.children.flatMap((c) => all(c, name))];
const first = (node: XNode, name: string): XNode | undefined => all(node, name)[0];

/** FCPXML rational time: "0s", "3600s", "1001/30000s", "15234517/1000000s" → seconds. */
export function parseTime(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const m = /^(-?\d+)(?:\/(\d+))?s$/.exec(v.trim());
  if (!m) return NaN;
  return Number(m[1]) / (m[2] ? Number(m[2]) : 1);
}

/** Resolves a media src (absolute file:// URL or relative reference) against the FCPXML location. */
export function resolveSrc(src: string, fcpxmlPath: string): { path?: string; kind: 'absolute' | 'relative' | 'invalid'; problem?: string } {
  if (/\s/.test(src)) return { kind: 'invalid', problem: 'contém espaço/caractere de controle não codificado (use %20)' };
  if (/%(?![0-9A-Fa-f]{2})/.test(src)) return { kind: 'invalid', problem: '"%" sem dois dígitos hexadecimais' };
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(src);
  if (isAbsolute && !/^file:/i.test(src)) return { kind: 'invalid', problem: `esquema não suportado (${src.split(':')[0]}://)` };
  try {
    const url = new URL(src, pathToFileURL(fcpxmlPath));
    if (url.protocol !== 'file:') return { kind: 'invalid', problem: 'não é file://' };
    // Windows drive URLs (file:///C:/…) only convert on win32; keep the decoded pathname elsewhere.
    const decoded = /^\/[A-Za-z]:\//.test(url.pathname) && process.platform !== 'win32' ? decodeURIComponent(url.pathname.slice(1)) : fileURLToPath(url);
    return { path: decoded, kind: isAbsolute ? 'absolute' : 'relative' };
  } catch (e) {
    return { kind: 'invalid', problem: (e as Error).message };
  }
}

async function findFcpxml(input: string): Promise<string[]> {
  const info = await stat(input).catch(() => undefined);
  if (!info) return [];
  if (info.isFile()) return [input];
  const found: string[] = [];
  for (const dir of [path.join(input, '02_DAVINCI'), input]) {
    for (const n of await readdir(dir).catch(() => [] as string[])) if (/\.fcpxml$/i.test(n)) found.push(path.join(dir, n));
  }
  return found;
}

interface ClipInfo {
  track: Track | 'primary-extra';
  tag: string;
  ref?: string;
  assetName?: string;
  offset?: number;
  start?: number;
  duration?: number;
  lane?: string;
}

export interface VerifyFcpxmlOptions {
  input: string;
  dtd?: string;
  strict?: boolean;
  jsonPath?: string;
  quiet?: boolean;
  /** Tracks known to be absent from the recording (their lane may legitimately be missing). */
  missingTracks?: Track[];
}

export async function verifyFcpxml(opts: VerifyFcpxmlOptions): Promise<Report> {
  const report = new Report('verify-fcpxml', path.resolve(opts.input), opts.strict);
  const files = await findFcpxml(opts.input);
  if (files.length === 0) {
    report.fail('fcpxml-missing', 'arquivo', `Nenhum .fcpxml encontrado em ${opts.input} (esperado 02_DAVINCI/<Projeto>.fcpxml).`);
    return finish(report, opts);
  }
  if (files.length > 1) report.warn('fcpxml-multiple', 'arquivo', `Mais de um .fcpxml encontrado; auditando ${path.basename(files[0] as string)}.`);
  const file = path.resolve(files[0] as string);
  if (!file.includes(`${path.sep}02_DAVINCI${path.sep}`)) report.warn('fcpxml-location', 'arquivo', 'FCPXML fora de 02_DAVINCI/ (SPEC §4).');
  const text = await readFile(file, 'utf8');
  report.facts.file = file;

  // ── Sintaxe ───────────────────────────────────────────────────────────────
  const valid = XMLValidator.validate(text);
  if (valid !== true) {
    report.fail('xml-syntax', 'xml', `XML malformado na linha ${valid.err.line}, coluna ${valid.err.col}: ${valid.err.msg}`);
    return finish(report, opts);
  }
  if (!/^\s*<\?xml[^>]*encoding="UTF-8"/i.test(text)) report.warn('xml-encoding', 'xml', 'Declaração <?xml … encoding="UTF-8"?> ausente.');
  if (!/<!DOCTYPE fcpxml>/.test(text)) report.info('xml-doctype', 'xml', '<!DOCTYPE fcpxml> ausente.');
  const root = parseFcpxml(text);
  if (!root) {
    report.fail('xml-root', 'xml', 'Elemento raiz <fcpxml> não encontrado.');
    return finish(report, opts);
  }
  const version = root.attrs.version ?? '';
  if (!SUPPORTED_VERSIONS.includes(version)) {
    report.fail('fcpxml-version', 'xml', `fcpxml version="${version}" fora do suportado pelo Resolve (${SUPPORTED_VERSIONS.join(', ')}); SPEC pede 1.9/1.10.`);
  } else {
    (['1.9', '1.10'].includes(version) ? report.pass.bind(report) : report.warn.bind(report))('fcpxml-version', 'xml', `fcpxml version="${version}".`);
  }
  if (opts.dtd) await validateDtd(report, file, opts.dtd);

  // ── Recursos ──────────────────────────────────────────────────────────────
  const resources = first(root, 'resources');
  const formats = new Map((resources ? resources.children.filter((n) => n.name === 'format') : []).map((f) => [f.attrs.id ?? '', f]));
  const assets = new Map((resources ? resources.children.filter((n) => n.name === 'asset') : []).map((a) => [a.attrs.id ?? '', a]));
  const ids = (resources?.children ?? []).map((n) => n.attrs.id).filter(Boolean) as string[];
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupIds.length) report.fail('resource-ids', 'recursos', `ids duplicados em <resources>: ${[...new Set(dupIds)].join(', ')}.`);
  for (const [id, f] of formats) {
    const fd = parseTime(f.attrs.frameDuration);
    if (f.attrs.frameDuration && !(fd && fd > 0)) report.fail(`format-${id}`, 'recursos', `format ${id}: frameDuration inválido "${f.attrs.frameDuration}".`);
  }

  const assetFiles = new Map<string, { path?: string; probe?: ProbeResult }>();
  for (const [id, a] of assets) {
    const name = a.attrs.name ?? id;
    const reps = a.children.filter((c) => c.name === 'media-rep');
    const original = reps.find((r) => (r.attrs.kind ?? 'original-media') === 'original-media');
    const src = original?.attrs.src ?? a.attrs.src;
    if (a.attrs.src && ['1.9', '1.10', '1.11'].includes(version)) report.warn(`asset-src-attr-${id}`, 'mídia', `asset ${name}: atributo src em <asset> foi removido no DTD 1.9+ (use <media-rep>).`);
    if (!src) {
      report.fail(`asset-nosrc-${id}`, 'mídia', `asset ${name} sem caminho de mídia (<media-rep src> ou asset@src).`);
      continue;
    }
    const resolved = resolveSrc(src, file);
    if (resolved.kind === 'invalid' || !resolved.path) {
      report.fail(`asset-url-${id}`, 'mídia', `asset ${name}: src inválido "${src}" — ${resolved.problem}.`);
      continue;
    }
    if (!(await exists(resolved.path))) {
      report.fail(`asset-missing-${id}`, 'mídia', `asset ${name}: arquivo não existe → ${resolved.path} (src="${src}").`, {
        fixHint: 'Gerar src apontando para 01_MEDIA/<arquivo> relativo ao .fcpxml ou como file:/// absoluto e percent-encoded.',
      });
      continue;
    }
    const st = await stat(resolved.path);
    if (!st.isFile() || st.size === 0) {
      report.fail(`asset-empty-${id}`, 'mídia', `asset ${name}: ${resolved.path} não é arquivo válido (tamanho ${st.size}).`);
      continue;
    }
    if (path.basename(path.dirname(resolved.path)) !== '01_MEDIA') report.warn(`asset-dir-${id}`, 'mídia', `asset ${name} fora de 01_MEDIA/: ${resolved.path}`);
    if (resolved.kind === 'relative') {
      report.info(`asset-relative-${id}`, 'mídia', `asset ${name}: URL relativa "${src}" → ${resolved.path}.`);
    } else if (/^file:\/\/\/(Users|Volumes|private|home)\//.test(src)) {
      report.warn(`asset-mac-path-${id}`, 'mídia', `asset ${name}: caminho absoluto de Mac/Unix (${src}) não abre no Windows do Gustavo sem relink.`);
    }
    let p: ProbeResult | undefined;
    try {
      p = await probe(resolved.path);
    } catch {
      report.fail(`asset-unprobeable-${id}`, 'mídia', `asset ${name}: ffprobe não lê ${resolved.path}.`);
    }
    assetFiles.set(id, { path: resolved.path, probe: p });
    if (p) checkAssetAgainstMedia(report, id, a, formats, p);
  }
  const relativeCount = report.findings.filter((f) => f.id.startsWith('asset-relative-')).length;
  if (relativeCount > 0) {
    report.warn('relative-urls', 'mídia', `${relativeCount} mídia(s) com URL relativa: portátil Mac→Windows, mas a resolução relativa pelo DaVinci Resolve ainda precisa de smoke test (se falhar: Relink apontando para 01_MEDIA/).`);
  }

  // ── Faixas V1/V2/A1/A2 ────────────────────────────────────────────────────
  const sequence = first(root, 'sequence');
  const spine = sequence && first(sequence, 'spine');
  if (!sequence || !spine) {
    report.fail('no-sequence', 'faixas', 'Sem <sequence>/<spine>: o Resolve não terá timeline para importar.');
    return finish(report, opts);
  }
  const seqFormat = formats.get(sequence.attrs.format ?? '');
  const frame = parseTime(seqFormat?.attrs.frameDuration) ?? 1 / 60;
  report.facts.sequence = { format: sequence.attrs.format, width: seqFormat?.attrs.width, height: seqFormat?.attrs.height, frameDuration: seqFormat?.attrs.frameDuration };
  if (seqFormat?.attrs.width && seqFormat.attrs.height) {
    const standard = ['1920x1080', '3840x2160', '2560x1440', '1280x720'].includes(`${seqFormat.attrs.width}x${seqFormat.attrs.height}`);
    if (!standard) report.info('sequence-res', 'faixas', `Timeline criada em ${seqFormat.attrs.width}x${seqFormat.attrs.height} (resolução nativa da tela, fora dos padrões de entrega).`);
  }

  const clips: ClipInfo[] = [];
  const describe = (n: XNode, track: ClipInfo['track']): ClipInfo => {
    const ref = n.attrs.ref ?? n.children.find((c) => (c.name === 'video' || c.name === 'audio') && c.attrs.ref)?.attrs.ref;
    const asset = ref ? assets.get(ref) : undefined;
    const src = asset && (asset.children.find((c) => c.name === 'media-rep')?.attrs.src ?? asset.attrs.src);
    return {
      track,
      tag: n.name,
      ref,
      assetName: asset ? (src ? decodeURIComponent(path.posix.basename(src)) : asset.attrs.name) : undefined,
      offset: parseTime(n.attrs.offset),
      start: parseTime(n.attrs.start) ?? 0,
      duration: parseTime(n.attrs.duration),
      lane: n.attrs.lane,
    };
  };
  const primary = spine.children.filter((n) => CLIP_TAGS.has(n.name));
  const v1 = primary[0];
  if (!v1) report.fail('v1-missing', 'faixas', 'Spine vazio: nenhuma mídia em V1.');
  else {
    clips.push(describe(v1, 'V1'));
    for (const extra of primary.slice(1)) clips.push(describe(extra, 'primary-extra'));
    const connected = v1.children.filter((c) => CLIP_TAGS.has(c.name) && c.attrs.lane !== undefined);
    for (const c of connected) {
      const track = LANE_TO_TRACK[c.attrs.lane ?? ''];
      if (track) clips.push(describe(c, track));
      else report.warn(`lane-${c.attrs.lane}`, 'faixas', `Clipe conectado em lane ${c.attrs.lane} (${c.attrs.name ?? c.name}) — fora do esquema V2/A1/A2.`);
    }
    if (v1.name === 'gap') report.fail('v1-gap', 'faixas', 'O spine começa com <gap>: SCREEN ficaria em V2 no Resolve, não em V1.');
  }

  const rows: string[][] = [];
  for (const track of ['V1', 'V2', 'A1', 'A2'] as Track[]) {
    const found = clips.filter((c) => c.track === track);
    const expectedFile = EXPECTED[track];
    const expectedMissing = opts.missingTracks?.includes(track);
    if (found.length === 0) {
      rows.push([track, expectedFile, '—', '—', '—', '—']);
      if (expectedMissing) report.info(`track-${track}`, 'faixas', `${track} ausente — esperado (faixa não gravada).`);
      else report.fail(`track-${track}`, 'faixas', `${track} não declarada (esperado ${expectedFile}${track === 'V1' ? ' no spine' : ` em lane ${Object.entries(LANE_TO_TRACK).find(([, t]) => t === track)?.[0]}`}).`);
      continue;
    }
    if (found.length > 1) report.fail(`track-dup-${track}`, 'faixas', `${track} tem ${found.length} clipes (${found.map((c) => c.assetName).join(', ')}).`);
    const clip = found[0] as ClipInfo;
    rows.push([track, expectedFile, clip.assetName ?? clip.ref ?? '?', fmt(clip.offset), fmt(clip.start), fmt(clip.duration)]);
    if (clip.assetName !== expectedFile) {
      report.fail(`track-${track}`, 'faixas', `${track} contém ${clip.assetName ?? clip.ref ?? '?'}; esperado ${expectedFile}.`, { fixHint: 'V1=spine SCREEN; conectados: CAMERA lane="1", MICROPHONE lane="-1", SYSTEM_AUDIO lane="-2".' });
    } else {
      report.pass(`track-${track}`, 'faixas', `${track} = ${expectedFile}${track === 'V1' ? ' (spine)' : ` (lane ${clip.lane})`}.`);
    }
  }
  report.table('Mapeamento de faixas para o DaVinci Resolve', ['faixa', 'esperado', 'encontrado', 'offset', 'start', 'duração'], rows);
  if (clips.some((c) => c.track === 'primary-extra')) report.info('primary-extra', 'faixas', `Spine com ${primary.length} elementos; V1 deveria ser um único clipe contínuo de SCREEN.`);

  checkTiming(report, clips, assets, assetFiles, frame, sequence);
  checkNames(report, root);
  return finish(report, opts);
}

function checkAssetAgainstMedia(report: Report, id: string, a: XNode, formats: Map<string, XNode>, p: ProbeResult): void {
  const name = a.attrs.name ?? id;
  const v = videoStream(p);
  const au = audioStream(p);
  if ((a.attrs.hasVideo === '1') !== Boolean(v)) report.fail(`asset-hasvideo-${id}`, 'mídia', `asset ${name}: hasVideo="${a.attrs.hasVideo ?? '0'}" mas o arquivo ${v ? 'tem' : 'não tem'} vídeo.`);
  if ((a.attrs.hasAudio === '1') !== Boolean(au)) {
    const sev = au && a.attrs.hasVideo === '1' ? 'warn' : 'fail';
    report[sev](`asset-hasaudio-${id}`, 'mídia', `asset ${name}: hasAudio="${a.attrs.hasAudio ?? '0'}" mas o arquivo ${au ? 'tem' : 'não tem'} áudio.`);
  }
  if (v && a.attrs.hasAudio === '1' && ['SCREEN.mp4', 'CAMERA.mp4'].includes(name)) {
    report.warn(`asset-embedded-audio-${id}`, 'faixas', `asset ${name} declara áudio embutido: o Resolve criará uma faixa de áudio para ele e MICROPHONE pode deixar de ser A1.`);
  }
  const dur = parseTime(a.attrs.duration);
  if (dur !== undefined && Number.isFinite(p.durationSec) && Math.abs(dur - p.durationSec) > 0.02) {
    report.fail(`asset-duration-${id}`, 'mídia', `asset ${name}: duration=${dur.toFixed(6)}s no XML, mídia tem ${p.durationSec.toFixed(6)}s (Δ ${ms((dur - p.durationSec) * 1000)}).`);
  }
  if (v) {
    const f = formats.get(a.attrs.format ?? '');
    if (!f) report.fail(`asset-format-${id}`, 'recursos', `asset ${name} (vídeo) referencia format "${a.attrs.format ?? ''}" inexistente.`);
    else {
      if ((f.attrs.width && Number(f.attrs.width) !== v.width) || (f.attrs.height && Number(f.attrs.height) !== v.height)) {
        report.fail(`format-size-${id}`, 'recursos', `format de ${name}: ${f.attrs.width}x${f.attrs.height} no XML, vídeo é ${v.width}x${v.height}.`);
      }
      const fd = parseTime(f.attrs.frameDuration);
      const fps = parseRate(v.rFrameRate);
      if (fd && fps && Math.abs(1 / fd - fps) > 0.05) report.warn(`format-rate-${id}`, 'recursos', `format de ${name}: ${(1 / fd).toFixed(3)} fps no XML; o arquivo anuncia ${fps.toFixed(3)} fps (r_frame_rate ${v.rFrameRate}).`);
    }
  }
  if (au) {
    if (a.attrs.audioRate && Number(a.attrs.audioRate.replace(/k$/i, '000')) !== au.sampleRate) {
      report.fail(`asset-rate-${id}`, 'mídia', `asset ${name}: audioRate="${a.attrs.audioRate}" mas o WAV é ${au.sampleRate} Hz.`);
    }
    if (a.attrs.audioChannels && Number(a.attrs.audioChannels) !== au.channels) {
      report.warn(`asset-channels-${id}`, 'mídia', `asset ${name}: audioChannels="${a.attrs.audioChannels}" mas o arquivo tem ${au.channels} canais.`);
    }
  }
}

function checkTiming(report: Report, clips: ClipInfo[], assets: Map<string, XNode>, files: Map<string, { probe?: ProbeResult }>, frame: number, sequence: XNode): void {
  const v1 = clips.find((c) => c.track === 'V1');
  if (!v1) return;
  const misaligned: string[] = [];
  const onGrid = (t: number | undefined) => t === undefined || Math.abs(t / frame - Math.round(t / frame)) < 1e-6;
  for (const c of clips) {
    if (c.track === 'primary-extra') continue;
    for (const [field, value] of [['offset', c.offset], ['start', c.start], ['duration', c.duration]] as const) {
      if (!onGrid(value)) misaligned.push(`${c.track} ${field}=${value?.toFixed(6)}s (${(value! / frame).toFixed(3)} frames)`);
    }
    if (c.track !== 'V1') {
      // Connected clip offset is expressed in the parent's local time: aligned ⇔ offset == parent start.
      if (c.offset !== undefined && Math.abs(c.offset - (v1.start ?? 0)) > 1e-6) {
        report.fail(`sync-offset-${c.track}`, 'sincronismo', `${c.track} (${c.assetName}) começa em ${fmt(c.offset)} relativo ao V1 (esperado ${fmt(v1.start)}): faixas desalinhadas no Resolve.`);
      }
    }
    if ((c.start ?? 0) !== 0) report.warn(`clip-start-${c.track}`, 'sincronismo', `${c.track} usa start=${fmt(c.start)}: o início da mídia é cortado na timeline.`);
    const asset = c.ref ? assets.get(c.ref) : undefined;
    const measured = c.ref ? files.get(c.ref)?.probe?.durationSec : undefined;
    const reference = measured ?? parseTime(asset?.attrs.duration);
    if (c.duration !== undefined && reference !== undefined && Math.abs(c.duration - reference) > Math.max(frame, 0.005)) {
      report.fail(`clip-duration-${c.track}`, 'sincronismo', `${c.track} (${c.assetName}): clipe dura ${fmt(c.duration)} mas a mídia tem ${reference.toFixed(6)}s (Δ ${ms((c.duration - reference) * 1000)}) — a timeline corta ou estende a faixa.`);
    }
  }
  const durations = clips.filter((c) => c.track !== 'primary-extra' && c.duration !== undefined).map((c) => c.duration as number);
  if (durations.length > 1) {
    const spread = (Math.max(...durations) - Math.min(...durations)) * 1000;
    if (spread > 100) report.fail('clip-spread', 'sincronismo', `Durações dos clipes na timeline divergem ${ms(spread)} (> 100ms).`);
    else report.pass('clip-spread', 'sincronismo', `Os ${durations.length} clipes começam juntos e divergem ${ms(spread)} em duração.`);
  }
  const seqDur = parseTime(sequence.attrs.duration);
  if (seqDur !== undefined && durations.length && seqDur + frame < Math.max(...durations)) {
    report.warn('sequence-duration', 'sincronismo', `sequence duration=${fmt(seqDur)} menor que o clipe mais longo (${Math.max(...durations).toFixed(6)}s).`);
  }
  if (misaligned.length) {
    report.warn('frame-grid', 'sincronismo', `${misaligned.length} tempo(s) fora da grade de frames da sequência (${(1 / frame).toFixed(3)} fps). O Final Cut rejeita; o Resolve arredonda (até ±½ frame).`, {
      detail: misaligned.slice(0, 8).join('\n'),
      fixHint: 'Expressar offset/start/duration dos clipes como múltiplos de frameDuration (ex.: 914/60s).',
    });
  }
}

function checkNames(report: Report, root: XNode): void {
  for (const n of [...all(root, 'project'), ...all(root, 'event')]) {
    const name = n.attrs.name ?? '';
    if (name !== name.normalize('NFC')) report.warn(`name-nfd-${n.name}`, 'nomes', `<${n.name} name> em NFD ("${name}"): acentos podem aparecer decompostos no Windows.`);
    if (/[╠╣║╗╝╚╔╩╦╬═]|Ã[\u0080-\u00bf]/.test(name)) report.fail(`name-mojibake-${n.name}`, 'nomes', `<${n.name} name="${name}">: mojibake (nome do ZIP decodificado como CP437).`);
  }
}

async function validateDtd(report: Report, file: string, dtd: string): Promise<void> {
  const r = await run('xmllint', ['--noout', '--dtdvalid', dtd, file], { allowFail: true }).catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }));
  if (r.code === 0) report.pass('dtd', 'xml', `Válido contra ${path.basename(dtd)} (xmllint).`);
  else report.fail('dtd', 'xml', `Inválido contra ${path.basename(dtd)}.`, { detail: r.stderr.trim().split('\n').slice(0, 10).join('\n') });
}

const fmt = (t: number | undefined) => (t === undefined ? '—' : Number.isNaN(t) ? 'inválido' : `${t.toFixed(6)}s`);

async function finish(report: Report, opts: VerifyFcpxmlOptions): Promise<Report> {
  if (!opts.quiet) report.print();
  if (opts.jsonPath) await report.writeJson(opts.jsonPath);
  return report;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dtd: { type: 'string' },
      json: { type: 'string' },
      strict: { type: 'boolean', default: false },
      'missing-tracks': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log('Uso: tsx tests/verify-fcpxml.ts <arquivo.fcpxml|pasta-de-saida> [--dtd FCPXMLv1_10.dtd] [--json out.json] [--strict] [--missing-tracks V2,A2]');
    process.exit(values.help ? 0 : 2);
  }
  const report = await verifyFcpxml({
    input: positionals[0] as string,
    dtd: values.dtd,
    strict: values.strict,
    jsonPath: values.json,
    missingTracks: values['missing-tracks']?.split(',').filter(Boolean) as Track[] | undefined,
  });
  process.exit(report.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`verify-fcpxml: erro inesperado: ${(e as Error).stack ?? e}`);
    process.exit(2);
  });
}
