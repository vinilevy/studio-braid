/**
 * QA's own, deliberately independent reader of Screen Studio bundles.
 * It must never import the engine's parser: if both shared code, a parsing bug
 * would corrupt the oracle and the system under test at the same time.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';

export type MediaKind = 'display' | 'webcam' | 'microphone' | 'systemAudio';
export const MEDIA_KINDS: readonly MediaKind[] = ['display', 'webcam', 'microphone', 'systemAudio'];
export const OUTPUT_FILE: Record<MediaKind, string> = {
  display: 'SCREEN.mp4',
  webcam: 'CAMERA.mp4',
  microphone: 'MICROPHONE.wav',
  systemAudio: 'SYSTEM_AUDIO.wav',
};
export const KIND_LABEL: Record<MediaKind, string> = {
  display: 'Tela',
  webcam: 'Câmera',
  microphone: 'Microfone',
  systemAudio: 'Áudio do sistema',
};

export interface SsSession {
  durationMs?: number;
  unixStartMs?: number;
  unixEndMs?: number;
  processTimeStartMs?: number;
  processTimeEndMs?: number;
  outputFilename?: string;
  [key: string]: unknown;
}
export interface SsRecorder {
  id?: string;
  type?: string;
  sessions?: SsSession[];
  [key: string]: unknown;
}
export interface SsMetadata {
  polyrecorderVersion?: string;
  state?: string;
  recorders: SsRecorder[];
  sessions?: SsSession[];
}

export interface ExpectedSession {
  index: number;
  /** Index parsed from outputFilename (channel-2-display-<n>.m3u8); falls back to array position. */
  fileIndex: number;
  durationMs: number;
  unixStartMs: number;
  unixEndMs: number;
  outputFilename?: string;
  /** Where this session must start/end in the exported, pause-free timeline. */
  timelineStartMs: number;
  timelineEndMs: number;
}

export interface ExpectedTrack {
  kind: MediaKind;
  recorderId: string;
  sessions: ExpectedSession[];
  totalMs: number;
}

export interface SourceProject {
  kind: 'folder' | 'zip';
  path: string;
  bundleName: string;
  projectName: string;
  metadataLocation: string;
  metadata: SsMetadata;
  polyrecorderVersion?: string;
  tracks: ExpectedTrack[];
  sessionCount: number;
  wallClockSpanMs: number;
  pausesMs: number;
  orphanFiles: string[];
  warnings: string[];
}

const RECORDING_FILE = /^(channel-\d+-[a-z-]+?)-(\d+)(?:-(\d{4}))?\.(m3u8|mp4|m4s|m4a)$/i;

function sessionIndexFromFilename(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const m = RECORDING_FILE.exec(name);
  return m && m[3] === undefined ? Number(m[2]) : undefined;
}

function normalizeRecorders(raw: unknown): SsRecorder[] {
  if (Array.isArray(raw)) return raw as SsRecorder[];
  // Defensive: tolerate a keyed object ({ display: {...} }) in case a future version changes shape.
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, SsRecorder>).map(([key, r]) => ({ ...r, type: r?.type ?? key, id: r?.id ?? key }));
  }
  return [];
}

export function parseMetadata(text: string, where: string): SsMetadata {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`metadata.json inválido em ${where}: ${(e as Error).message}`);
  }
  const obj = json as Record<string, unknown>;
  const recorders = normalizeRecorders(obj.recorders);
  if (recorders.length === 0) throw new Error(`metadata.json em ${where} não tem "recorders".`);
  return {
    polyrecorderVersion: typeof obj.polyrecorderVersion === 'string' ? obj.polyrecorderVersion : undefined,
    state: typeof obj.state === 'string' ? obj.state : undefined,
    recorders,
    sessions: Array.isArray(obj.sessions) ? (obj.sessions as SsSession[]) : undefined,
  };
}

/** Builds the oracle: which tracks must exist and where every session boundary must land. */
export function expectedTracks(meta: SsMetadata, warnings: string[]): ExpectedTrack[] {
  const tracks: ExpectedTrack[] = [];
  for (const kind of MEDIA_KINDS) {
    const recs = meta.recorders.filter((r) => r.type === kind);
    if (recs.length === 0) continue;
    if (recs.length > 1) warnings.push(`Há ${recs.length} gravadores do tipo "${kind}"; a QA usa só o primeiro (${recs[0]?.id}).`);
    const rec = recs[0] as SsRecorder;
    const raw = Array.isArray(rec.sessions) ? rec.sessions : [];
    if (raw.length === 0) continue;
    let cursor = 0;
    const sessions: ExpectedSession[] = raw.map((s, i) => {
      const start = Number(s.unixStartMs);
      const end = Number(s.unixEndMs);
      let duration = Number(s.durationMs);
      if (!Number.isFinite(duration) || duration <= 0) {
        duration = Number.isFinite(end - start) ? end - start : 0;
        warnings.push(`${kind} sessão ${i}: durationMs ausente; usando unixEndMs − unixStartMs = ${duration.toFixed(1)}ms.`);
      }
      const session: ExpectedSession = {
        index: i,
        fileIndex: sessionIndexFromFilename(s.outputFilename) ?? i,
        durationMs: duration,
        unixStartMs: start,
        unixEndMs: end,
        outputFilename: s.outputFilename,
        timelineStartMs: cursor,
        timelineEndMs: cursor + duration,
      };
      cursor += duration;
      return session;
    });
    tracks.push({ kind, recorderId: String(rec.id ?? kind), sessions, totalMs: cursor });
  }
  return tracks;
}

function findOrphans(meta: SsMetadata, recordingNames: string[]): string[] {
  const known = new Map<string, Set<number>>();
  for (const r of meta.recorders) {
    if (!r.id || !MEDIA_KINDS.includes(r.type as MediaKind)) continue;
    const set = new Set<number>();
    (r.sessions ?? []).forEach((s, i) => set.add(sessionIndexFromFilename(s.outputFilename) ?? i));
    known.set(r.id, set);
  }
  const orphans = new Set<string>();
  for (const name of recordingNames) {
    const m = RECORDING_FILE.exec(name);
    if (!m) continue;
    const set = known.get(m[1] as string);
    if (set && !set.has(Number(m[2]))) orphans.add(`${m[1]}-${m[2]}`);
  }
  return [...orphans].sort();
}

function summarize(kind: 'folder' | 'zip', inputPath: string, bundleName: string, metadataLocation: string, meta: SsMetadata, recordingNames: string[]): SourceProject {
  const warnings: string[] = [];
  const tracks = expectedTracks(meta, warnings);
  if (tracks.length === 0) throw new Error('Nenhuma faixa de mídia (display/webcam/microphone/systemAudio) com sessões no metadata.json.');
  const counts = new Set(tracks.map((t) => t.sessions.length));
  if (counts.size > 1) warnings.push(`Faixas com números de sessões diferentes: ${tracks.map((t) => `${t.kind}=${t.sessions.length}`).join(', ')}.`);
  const reference = tracks.find((t) => t.kind === 'display') ?? (tracks[0] as ExpectedTrack);
  const first = reference.sessions[0] as ExpectedSession;
  const last = reference.sessions[reference.sessions.length - 1] as ExpectedSession;
  const wallClockSpanMs = last.unixEndMs - first.unixStartMs;
  if (meta.state && meta.state !== 'complete') warnings.push(`metadata.state = "${meta.state}" (esperado "complete").`);
  const nfcBundle = bundleName.normalize('NFC');
  return {
    kind,
    path: inputPath,
    bundleName: nfcBundle,
    projectName: nfcBundle.replace(/\.screenstudio$/i, ''),
    metadataLocation,
    metadata: meta,
    polyrecorderVersion: meta.polyrecorderVersion,
    tracks,
    sessionCount: Math.max(...tracks.map((t) => t.sessions.length)),
    wallClockSpanMs,
    pausesMs: Math.max(0, wallClockSpanMs - reference.totalMs),
    orphanFiles: findOrphans(meta, recordingNames),
    warnings,
  };
}

async function loadFolder(dir: string): Promise<SourceProject> {
  const metadataPath = path.join(dir, 'recording', 'metadata.json');
  let text: string;
  try {
    text = await readFile(metadataPath, 'utf8');
  } catch {
    throw new Error(`recording/metadata.json não encontrado em "${dir}" — projeto incompleto ou não é um bundle do Screen Studio.`);
  }
  const names = await readdir(path.join(dir, 'recording')).catch(() => [] as string[]);
  return summarize('folder', dir, path.basename(dir), metadataPath, parseMetadata(text, metadataPath), names);
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
/** ZIPs from macOS Finder store UTF-8 (NFD) names without the UTF-8 flag; decode them as UTF-8 when valid. */
export function decodeZipName(raw: Buffer | string): string {
  if (typeof raw === 'string') return raw.normalize('NFC');
  try {
    return utf8Strict.decode(raw).normalize('NFC');
  } catch {
    return raw.toString('latin1');
  }
}

export const isAppleDouble = (name: string): boolean => name.startsWith('__MACOSX/') || path.posix.basename(name).startsWith('._');

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, decodeStrings: false, autoClose: false }, (err, zip) => (err || !zip ? reject(err ?? new Error('zip vazio')) : resolve(zip))),
  );
}

async function loadZip(file: string): Promise<SourceProject> {
  const zip = await openZip(file);
  try {
    const entries: { name: string; entry: yauzl.Entry }[] = [];
    await new Promise<void>((resolve, reject) => {
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = decodeZipName(entry.fileName as unknown as Buffer);
        if (!isAppleDouble(name)) entries.push({ name, entry });
        zip.readEntry();
      });
      zip.on('end', () => resolve());
      zip.on('error', reject);
      zip.readEntry();
    });
    const metas = entries.filter((e) => /(^|\/)recording\/metadata\.json$/.test(e.name));
    if (metas.length === 0) throw new Error(`Nenhum recording/metadata.json dentro de "${path.basename(file)}" (fora de __MACOSX).`);
    const chosen = metas[0] as { name: string; entry: yauzl.Entry };
    const bundlePrefix = chosen.name.slice(0, -'recording/metadata.json'.length);
    const text = await new Promise<string>((resolve, reject) => {
      zip.openReadStream(chosen.entry, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error('stream vazio'));
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', reject);
      });
    });
    const recordingNames = entries
      .filter((e) => e.name.startsWith(`${bundlePrefix}recording/`))
      .map((e) => e.name.slice(`${bundlePrefix}recording/`.length))
      .filter((n) => n && !n.includes('/'));
    const bundleName = bundlePrefix ? path.posix.basename(bundlePrefix.replace(/\/$/, '')) : path.basename(file).replace(/\.zip$/i, '');
    const project = summarize('zip', file, bundleName, `${path.basename(file)}!/${chosen.name}`, parseMetadata(text, chosen.name), recordingNames);
    if (metas.length > 1) project.warnings.push(`O ZIP contém ${metas.length} projetos; a QA usou "${bundleName}".`);
    return project;
  } finally {
    zip.close();
  }
}

/** Accepts a .screenstudio folder, a .zip, or a bare metadata.json. */
export async function loadSource(input: string): Promise<SourceProject> {
  const info = await stat(input).catch(() => undefined);
  if (!info) throw new Error(`Fonte não encontrada: ${input}`);
  if (info.isDirectory()) return loadFolder(input);
  if (/\.zip$/i.test(input)) return loadZip(input);
  if (/metadata\.json$/i.test(input)) {
    const text = await readFile(input, 'utf8');
    const bundleDir = path.dirname(path.dirname(input));
    const names = await readdir(path.dirname(input)).catch(() => [] as string[]);
    return summarize('folder', bundleDir, path.basename(bundleDir), input, parseMetadata(text, input), names);
  }
  throw new Error(`Fonte não reconhecida (esperado pasta .screenstudio, .zip ou metadata.json): ${input}`);
}

export const fmtMs = (ms: number): string => {
  if (!Number.isFinite(ms)) return '—';
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const s = (abs % 60_000) / 1000;
  const ss = s.toFixed(3).padStart(6, '0');
  return h > 0 ? `${sign}${h}:${String(m).padStart(2, '0')}:${ss}` : `${sign}${m}:${ss}`;
};
