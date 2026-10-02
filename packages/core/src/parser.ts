import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ProjectMetadata, RecordingSession, TrackKind } from './types/index.js';
import { BridgeError, checkAbort } from './errors.js';
import { confinedFile, safeProjectName, safeRelativePath } from './paths.js';

export const TRACK_KINDS: TrackKind[] = ['display', 'webcam', 'microphone', 'systemAudio'];
const sessionSchema = z.object({
  durationMs: z.number().finite().positive(), unixStartMs: z.number().finite().nonnegative(),
  unixEndMs: z.number().finite().nonnegative(), outputFilename: z.string().min(1),
}).passthrough();
const recorderSchema = z.object({ type: z.string(), sessions: z.array(sessionSchema).max(10_000) }).passthrough();
export async function readJson(path: string): Promise<unknown> {
  if ((await stat(path)).size > 20 * 1024 ** 2) throw new BridgeError('JSON_LIMIT', 'JSON excede 20 MiB.');
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new BridgeError('INVALID_JSON', `JSON inválido: ${basename(path)}`); }
}

export async function validatePlaylist(path: string, bundlePath: string): Promise<void> {
  const content = await readFile(path, 'utf8');
  if (content.length > 20 * 1024 ** 2 || !content.startsWith('#EXTM3U') || !content.includes('#EXT-X-ENDLIST'))
    throw new BridgeError('INVALID_HLS', 'Playlist inválida, incompleta ou live.');
  let media = 0, init = 0;
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXT-X-(KEY|SESSION-KEY|STREAM-INF|I-FRAME-STREAM-INF|MEDIA):/u.test(line))
      throw new BridgeError('UNSAFE_HLS', 'HLS criptografado, remoto ou multi-variant não suportado.');
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = line.match(/(?:^|[,:])URI="([^"]+)"/u)?.[1];
      if (!uri) throw new BridgeError('INVALID_HLS', 'Init segment ausente/inválido.');
      await confinedFile(bundlePath, join(dirname(path), safeRelativePath(uri))); init++;
    } else if (!line.startsWith('#')) {
      await confinedFile(bundlePath, join(dirname(path), safeRelativePath(line))); media++;
    } else if (/\bURI=/u.test(line)) throw new BridgeError('UNSAFE_HLS', 'URI HLS não reconhecida.');
  }
  if (!init || !media) throw new BridgeError('INVALID_HLS', 'Playlist precisa de init segment e fragmentos fMP4.');
}

export async function parseProject(bundlePath: string, inputPath = bundlePath, signal?: AbortSignal): Promise<ProjectMetadata> {
  const root = resolve(bundlePath);
  // Validate the native package, but preserve all unrelated Screen Studio editing data.
  for (const file of ['meta.json', 'project.json', 'recording/metadata.json']) await confinedFile(root, join(root, file));
  const raw = await readJson(join(root, 'recording', 'metadata.json'));
  const top = z.object({ recorders: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]) }).passthrough().safeParse(raw);
  if (!top.success) throw new BridgeError('INVALID_METADATA', 'metadata.json deve conter recorders.');
  const entries = Array.isArray(top.data.recorders) ? top.data.recorders : Object.entries(top.data.recorders).map(([type, value]) => ({ type, ...(value as object) }));
  const tracks: ProjectMetadata['tracks'] = [], warnings: string[] = [];
  for (const entry of entries) {
    checkAbort(signal);
    const type = (entry as { type?: unknown })?.type;
    if (!TRACK_KINDS.includes(type as TrackKind)) continue; // cursor/input are NOT media recorders.
    const parsed = recorderSchema.safeParse(entry);
    if (!parsed.success) throw new BridgeError('INVALID_METADATA', `Sessões inválidas na faixa ${String(type)}: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
    const kind = parsed.data.type as TrackKind;
    if (tracks.some(t => t.kind === kind)) throw new BridgeError('AMBIGUOUS_TRACK', `Múltiplos recorders ${kind}; seleção implícita proibida.`);
    const sessions: RecordingSession[] = [];
    for (const [index, s] of parsed.data.sessions.entries()) {
      checkAbort(signal);
      if (s.unixEndMs <= s.unixStartMs || Math.abs(s.unixEndMs - s.unixStartMs - s.durationMs) > 100)
        throw new BridgeError('INVALID_TIMESTAMPS', `Duração/timestamps inconsistentes: ${kind}, sessão ${index}.`);
      const sourcePath = await confinedFile(root, join(root, 'recording', safeRelativePath(s.outputFilename)));
      if (/\.m3u8$/iu.test(sourcePath)) await validatePlaylist(sourcePath, root);
      else if (!/\.(mp4|mov|m4a|wav)$/iu.test(sourcePath)) throw new BridgeError('UNSUPPORTED_MEDIA', `Formato de sessão não suportado: ${s.outputFilename}`);
      sessions.push({ index, durationMs: s.durationMs, unixStartMs: s.unixStartMs, unixEndMs: s.unixEndMs, outputFilename: s.outputFilename, sourcePath });
    }
    sessions.sort((a, b) => a.unixStartMs - b.unixStartMs);
    for (let i = 1; i < sessions.length; i++) {
      if (sessions[i].unixStartMs < sessions[i - 1].unixEndMs - 1)
        throw new BridgeError('OVERLAPPING_SESSIONS', `Sessões sobrepostas na faixa ${kind}.`);
      if (sessions[i].sourcePath === sessions[i - 1].sourcePath) throw new BridgeError('DUPLICATE_SESSION', `Arquivo reutilizado na faixa ${kind}.`);
    }
    if (new Set(sessions.map(s => s.sourcePath)).size !== sessions.length) throw new BridgeError('DUPLICATE_SESSION', 'Sessões duplicadas.');
    if (sessions.length) tracks.push({ kind, sessions, durationMs: sessions.reduce((n, s) => n + s.durationMs, 0) });
    else warnings.push(`Faixa ${kind} sem sessões; não será sintetizada.`);
  }
  const display = tracks.find(t => t.kind === 'display');
  if (!display) throw new BridgeError('NO_SCREEN', 'Projeto sem sessões de tela.');
  for (const kind of TRACK_KINDS) if (!tracks.some(t => t.kind === kind)) warnings.push(`Fonte ${kind} ausente.`);
  let name = basename(inputPath).replace(/\.zip$/iu, '').replace(/\.screenstudio$/iu, '');
  const meta = await readJson(join(root, 'meta.json')) as { name?: unknown; json?: { name?: unknown } };
  if (typeof meta?.json?.name === 'string') name = meta.json.name;
  else if (typeof meta?.name === 'string') name = meta.name;
  return { name: safeProjectName(name), inputPath: resolve(inputPath), bundlePath: root, tracks,
    durationMs: display.durationMs, sessionCount: display.sessions.length, warnings };
}

export function defaultOutputPath(name: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  return join(homedir(), 'Movies', 'Screen Studio Bridge', stamp, `${safeProjectName(name)} - DaVinci`);
}
