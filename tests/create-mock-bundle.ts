#!/usr/bin/env tsx
/**
 * create-mock-bundle — mini-projetos sintéticos do Screen Studio para regressão contínua.
 *
 *   npx tsx tests/create-mock-bundle.ts --out tests/fixtures/generated --sessions 1,3,5 [--layout ss4|ss37] [--zip]
 *
 * Cada mock reproduz as armadilhas medidas nos projetos reais (ver tests/README.md):
 *  - recorders em ARRAY, com "cursor"/"input" além das 4 mídias; várias sessões com pausas entre elas;
 *  - vídeo em HLS fMP4 com PTS no relógio do host (≈24539 s) e sem edit list;
 *  - câmera HEVC com B-frames: 1º keyframe com dts = início da sessão e pts = +80 ms (atraso de composição);
 *  - tela VFR (frames só quando "algo muda"), com 0–2 frames além de durationMs;
 *  - áudio .m4a por sessão mais longo (+64/+86 ms) ou mais curto (−120 ms) que durationMs;
 *  - sessão órfã no disco (init + 1 segmento, sem playlist) que NÃO está no metadata;
 *  - nome com acentos gravado em NFD; ZIP opcional criado com `ditto` (idêntico ao "Comprimir" do Finder:
 *    UTF-8 sem flag, data descriptors e __MACOSX/._metadata.json).
 * Conteúdo: flashes brancos (tela/câmera) e bipes (mic 700 Hz, sistema 2800 Hz) nos MESMOS instantes; a
 * sessão i começa com uma rajada de (i % 5) + 1 pulsos. O gabarito fica em "<bundle>.truth.json".
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ffmpeg, mapLimit, run } from './lib/exec.ts';
import { initTimescale, shiftFragmentFile } from './lib/fmp4.ts';
import type { MockTruth, TruthMarker } from './lib/markers.ts';
import type { MediaKind } from './lib/screenstudio.ts';

export type MockLayout = 'ss4' | 'ss37';

export interface MockOptions {
  outDir: string;
  sessions: number;
  layout?: MockLayout;
  name?: string;
  seed?: number;
  zip?: boolean;
  tracks?: MediaKind[];
  orphan?: boolean;
  /** Webcam frame size; default 320x180 (16:9). Use 320x240 to exercise 4:3 → preset scaling. */
  webcamSize?: [number, number];
}

export interface MockBundle {
  bundlePath: string;
  zipPath?: string;
  truthPath: string;
  truth: MockTruth;
}

const RES = { display: [640, 360] as [number, number], webcam: [320, 180] as [number, number] };
const FPS = { display: 60, webcam: 25 };
const BEEP = { microphone: 700, systemAudio: 2800 };
const PULSE = { onMs: 200, offMs: 200 };
const BURST_AT_MS = 400;
const HOST_AT_PROCESS_ZERO = 24537.17; // seconds; host clock seen in real polyrecorder logs
const UNIX_AT_PROCESS_ZERO = 1790888253492.702 - 1999.603;
const FIRST_PROCESS_START_MS = 1999.603;

const CHANNEL: Record<MediaKind, string> = {
  systemAudio: 'channel-1-system-audio',
  display: 'channel-2-display',
  microphone: 'channel-3-microphone',
  webcam: 'channel-4-webcam',
};

/** Deterministic, deliberately non-frame-aligned durations (3.6 s – 6.2 s). */
export function sessionDurations(n: number, seed = 1): number[] {
  return Array.from({ length: n }, (_, i) => 3600 + ((i * 1777 + seed * 911 + 523) % 2600) + ((i * 37 + seed * 13) % 1000) / 1000 + 0.457);
}

const pulsesFor = (index: number) => (index % 5) + 1;
const lateMarkerMs = (durationMs: number) => Math.floor((durationMs - 600) / 200) * 200;

/** [onMs, offMs) windows of every pulse inside one session (session-relative). */
function pulseWindows(index: number, durationMs: number): [number, number][] {
  const windows: [number, number][] = [];
  for (let j = 0; j < pulsesFor(index); j++) windows.push([BURST_AT_MS + j * (PULSE.onMs + PULSE.offMs), BURST_AT_MS + j * (PULSE.onMs + PULSE.offMs) + PULSE.onMs]);
  const late = lateMarkerMs(durationMs);
  windows.push([late, late + PULSE.onMs]);
  return windows;
}

const windowExpr = (windows: [number, number][], unitsPerSec: number, variable: string) =>
  windows.map(([a, b]) => `gte(${variable},${Math.round((a / 1000) * unitsPerSec)})*lt(${variable},${Math.round((b / 1000) * unitsPerSec)})`).join('+');

async function hlsFromFile(dir: string, input: string, prefix: string, extraSegmentOptions = ''): Promise<void> {
  const segmentOptions = ['use_editlist=0', extraSegmentOptions].filter(Boolean).join(':');
  await ffmpeg(
    ['-v', 'error', '-i', input, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
      '-hls_segment_options', segmentOptions, '-hls_fmp4_init_filename', `${prefix}-0000.mp4`, '-hls_segment_filename', `${prefix}-%04d.m4s`,
      '-start_number', '1', `${prefix}.m3u8`],
    { cwd: dir },
  );
}

async function shiftToHostClock(dir: string, prefix: string, hostStartSec: number): Promise<void> {
  const timescale = await initTimescale(path.join(dir, `${prefix}-0000.mp4`));
  const ticks = BigInt(Math.round(hostStartSec * timescale));
  const own = new RegExp(`^${prefix}-\\d{4}\\.m4s$`);
  const segments = (await readdir(dir)).filter((f) => own.test(f));
  for (const f of segments) await shiftFragmentFile(path.join(dir, f), ticks);
}

interface VideoJob {
  dir: string;
  prefix: string;
  kind: 'display' | 'webcam';
  size: [number, number];
  durationMs: number;
  windows: [number, number][];
  hostStartSec: number;
  layout: MockLayout;
  /** true = keep only frames that "change" (VFR, like ScreenCaptureKit). */
  vfr: boolean;
}

async function encodeVideo(job: VideoJob): Promise<void> {
  const fps = FPS[job.kind];
  const [w, h] = job.size;
  // Exactly one frame presented after durationMs: the 1–2 frame "tail" seen in real sessions.
  const frames = Math.floor((job.durationMs / 1000) * fps) + 2;
  const lit = windowExpr(job.windows, fps, 'n');
  // trim BEFORE select: -frames:v would count output frames and stretch a VFR session.
  const filters = [`trim=end_frame=${frames}`, `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${lit}'`];
  if (job.vfr) {
    // Keep ~10 fps of "static screen" + every frame around each flash + the last two frames.
    const around = windowExpr(job.windows.map(([a, b]) => [Math.max(0, a - 50), b + 50] as [number, number]), fps, 'n');
    filters.push(`select='not(mod(n,6))+${around}+gte(n,${frames - 2})'`);
  }
  const tmp = path.join(job.dir, `.tmp-${job.prefix}.mp4`);
  const bg = job.kind === 'webcam' ? '0x303030' : '0x202020';
  const codec =
    job.kind === 'webcam' && job.layout === 'ss4'
      ? ['-c:v', 'libx265', '-preset', 'veryfast', '-x265-params', 'bframes=3:b-adapt=0:keyint=50:log-level=error', '-tag:v', 'hvc1']
      : ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast', '-crf', '23', '-g', '120', '-bf', job.kind === 'webcam' ? '3' : '0'];
  await ffmpeg([
    '-v', 'error', '-f', 'lavfi', '-i', `color=c=${bg}:s=${w}x${h}:r=${fps}:d=${((frames + 1) / fps).toFixed(6)}`,
    '-vf', filters.join(','), ...(job.vfr ? ['-fps_mode', 'vfr'] : []), ...codec, '-pix_fmt', 'yuv420p', '-an', tmp,
  ]);
  await hlsFromFile(job.dir, tmp, job.prefix, 'video_track_timescale=600');
  await shiftToHostClock(job.dir, job.prefix, job.hostStartSec);
  if (job.layout === 'ss37') {
    // Screen Studio 3.7 also writes a consolidated MP4 (with the edit list Apple adds for B-frames).
    await ffmpeg(['-v', 'error', '-i', tmp, '-c', 'copy', '-movflags', '+faststart', path.join(job.dir, `${job.prefix}.mp4`)]);
  }
  await rm(tmp, { force: true });
}

async function encodeAudio(dir: string, prefix: string, lengthMs: number, hz: number, windows: [number, number][]): Promise<void> {
  const tone = `0.5*sin(2*PI*${hz}*t)*(${windowExpr(windows, 48000, 'n')})+0.0005*(2*random(0)-1)`;
  await ffmpeg([
    '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=exprs='${tone}|${tone}':s=48000:d=${(lengthMs / 1000).toFixed(6)}`,
    '-c:a', 'aac', '-b:a', '192k', path.join(dir, `${prefix}.m4a`),
  ]);
  await hlsFromFile(dir, `${prefix}.m4a`, prefix);
}

/** Leaves only an init segment + first fragment, like the aborted session found in real bundles. */
async function makeOrphan(dir: string, prefix: string): Promise<void> {
  for (const f of await readdir(dir)) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const playlistOrConsolidated = rest === '.m3u8' || rest === '.m4a' || rest === '.mp4';
    const laterFragment = /^-\d{4}\.m4s$/.test(rest) && rest !== '-0001.m4s';
    if (playlistOrConsolidated || laterFragment) await rm(path.join(dir, f));
  }
}

export async function createMockBundle(opts: MockOptions): Promise<MockBundle> {
  const layout = opts.layout ?? 'ss4';
  const seed = opts.seed ?? 1;
  const tracks = opts.tracks ?? ['display', 'webcam', 'microphone', 'systemAudio'];
  const res = { display: RES.display, webcam: opts.webcamSize ?? RES.webcam };
  const n = opts.sessions;
  const name = opts.name ?? `Mock ${n} ${n === 1 ? 'sessão' : 'sessões'} ${layout} — Aula Ação`;
  // Finder-created names are frequently NFD on disk; the engine must surface them as NFC.
  const bundleName = `${name}.screenstudio`.normalize('NFD');
  await mkdir(opts.outDir, { recursive: true });
  const bundlePath = path.join(opts.outDir, bundleName);
  await rm(bundlePath, { recursive: true, force: true });
  const rec = path.join(bundlePath, 'recording');
  await mkdir(rec, { recursive: true });

  const durations = sessionDurations(n, seed);
  const pauses = durations.map((_, i) => 20000 + 7000 * i);
  const starts: number[] = [];
  let pt = FIRST_PROCESS_START_MS;
  for (let i = 0; i < n; i++) {
    starts.push(pt);
    pt += (durations[i] as number) + (pauses[i] as number);
  }
  const hostStart = (i: number) => Math.round((HOST_AT_PROCESS_ZERO + (starts[i] as number) / 1000) * 600) / 600;

  await mapLimit([...Array(n + (opts.orphan === false ? 0 : 1)).keys()], 3, async (i) => {
    const isOrphan = i === n;
    const d = isOrphan ? 1600 : (durations[i] as number);
    const windows = isOrphan ? ([[BURST_AT_MS, BURST_AT_MS + 600]] as [number, number][]) : pulseWindows(i, d);
    const host = isOrphan ? hostStart(n - 1) + 120 : hostStart(i);
    if (tracks.includes('display')) await encodeVideo({ dir: rec, prefix: `${CHANNEL.display}-${i}`, kind: 'display', size: res.display, durationMs: d, windows, hostStartSec: host, layout, vfr: true });
    if (tracks.includes('webcam')) await encodeVideo({ dir: rec, prefix: `${CHANNEL.webcam}-${i}`, kind: 'webcam', size: res.webcam, durationMs: d, windows, hostStartSec: host, layout, vfr: false });
    // Real .m4a pieces deviate from durationMs: longer (AAC padding) or, sometimes, shorter.
    const micLen = !isOrphan && i === 1 ? d - 120 : d + 64;
    if (tracks.includes('microphone')) await encodeAudio(rec, `${CHANNEL.microphone}-${i}`, micLen, BEEP.microphone, windows);
    if (tracks.includes('systemAudio')) await encodeAudio(rec, `${CHANNEL.systemAudio}-${i}`, d + 86, BEEP.systemAudio, windows);
    if (isOrphan) for (const kind of tracks) await makeOrphan(rec, `${CHANNEL[kind]}-${i}`);
  });

  const session = (i: number, extra: Record<string, unknown> = {}, deltaMs = 0) => ({
    durationMs: (durations[i] as number) + deltaMs,
    processTimeEndMs: (starts[i] as number) + (durations[i] as number) + deltaMs,
    processTimeStartMs: starts[i] as number,
    unixEndMs: UNIX_AT_PROCESS_ZERO + (starts[i] as number) + (durations[i] as number) + deltaMs,
    unixStartMs: UNIX_AT_PROCESS_ZERO + (starts[i] as number),
    ...extra,
  });
  const idx = [...Array(n).keys()];
  const videoExt = layout === 'ss37' ? 'mp4' : 'm3u8';
  const recorders: Record<string, unknown>[] = [
    { configuration: {}, cursorImagesFolder: 'cursors', cursorsInfoFile: 'cursors.json', id: 'channel-0-cursor', type: 'cursor' },
    {
      configuration: { captureKeyStrokes: true }, id: 'channel-0-input', type: 'input',
      sessions: idx.map((i) => session(i, { keyStrokesFilename: `keystrokes-${i}.json`, mouseClicksFilename: `mouseclicks-${i}.json`, mouseMovesFilename: `mousemoves-${i}.json` })),
    },
  ];
  if (tracks.includes('systemAudio')) recorders.push({ configuration: {}, id: CHANNEL.systemAudio, type: 'systemAudio', sessions: idx.map((i) => session(i, { outputFilename: `${CHANNEL.systemAudio}-${i}.m4a` })) });
  if (tracks.includes('display')) {
    recorders.push({
      configuration: { displayId: 2, excludeFinderDesktopIcons: false, excludedWindowIds: [], videoCompressionSettings: { maxKeyFrameInterval: 120, quality: 0.85 } },
      id: CHANNEL.display, type: 'display',
      sessions: idx.map((i) => session(i, { bounds: { height: res.display[1], width: res.display[0], x: 0, y: 0 }, displayRefreshRate: 60, outputFilename: `${CHANNEL.display}-${i}.${videoExt}`, recordingScale: 1 })),
    });
  }
  if (tracks.includes('microphone')) recorders.push({ configuration: { deviceId: 'MockUSBAudioEngine:QA:Mic:0' }, id: CHANNEL.microphone, type: 'microphone', sessions: idx.map((i) => session(i, { outputFilename: `${CHANNEL.microphone}-${i}.m4a` })) });
  if (tracks.includes('webcam')) {
    recorders.push({
      configuration: { codec: layout === 'ss4' ? { hevc: { rateControl: { quality: { value: 0.5 } } } } : { h264: {} }, deviceId: '0x100000mockqa' },
      id: CHANNEL.webcam, type: 'webcam',
      // Real webcam sessions differ from the display by a few microseconds.
      sessions: idx.map((i) => session(i, { deviceFrameRate: 25, outputFilename: `${CHANNEL.webcam}-${i}.${videoExt}`, videoSize: { height: res.webcam[1], width: res.webcam[0] } }, 0.0043)),
    });
  }
  const metadata = {
    logFilename: 'polyrecorder.log',
    polyrecorderVersion: layout === 'ss4' ? '2.7.0+ss.5' : '2.7.0',
    recorders,
    sessions: idx.map((i) => session(i)),
    state: 'complete',
  };
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  await writeFile(path.join(rec, 'metadata.json'), json(metadata));
  await writeFile(path.join(rec, 'metadata-raw.json'), json(metadata));
  await writeFile(path.join(rec, 'cursors.json'), json({}));
  await mkdir(path.join(rec, 'cursors'), { recursive: true });
  await writeFile(path.join(rec, 'polyrecorder.log'), 'mock polyrecorder log (QA)\n');
  for (const i of idx) for (const f of ['keystrokes', 'mouseclicks', 'mousemoves']) await writeFile(path.join(rec, `${f}-${i}.json`), '[]\n');
  const version = layout === 'ss4' ? { version: '4.0.1-4897', requiredVersion: '4.0.0' } : { version: '3.7.5-4595', requiredVersion: '2.4.0-beta' };
  await writeFile(path.join(bundlePath, 'meta.json'), json({ json: { ...version, createdAt: new Date(UNIX_AT_PROCESS_ZERO).toISOString() }, meta: { values: { createdAt: ['Date'] }, v: 1 } }));
  await writeFile(path.join(bundlePath, 'project.json'), json({ json: { mock: true, note: 'Projeto sintético de QA — editor state omitido.' } }));
  await writeFile(path.join(bundlePath, 'recording-markers.json'), json({ json: [] }));

  const timelineStarts: number[] = [];
  let cursor = 0;
  for (const d of durations) {
    timelineStarts.push(cursor);
    cursor += d;
  }
  const markers: TruthMarker[] = idx.flatMap((i) => [
    { session: i, kind: 'burst' as const, pulses: pulsesFor(i), timeMs: (timelineStarts[i] as number) + BURST_AT_MS },
    { session: i, kind: 'late' as const, pulses: 1, timeMs: (timelineStarts[i] as number) + lateMarkerMs(durations[i] as number) },
  ]);
  const truth: MockTruth = {
    schema: 'ssb-mock-truth/1',
    projectName: name.normalize('NFC'),
    layout,
    tracks,
    sessions: idx.map((i) => ({ index: i, durationMs: durations[i] as number, timelineStartMs: timelineStarts[i] as number })),
    timelineDurationMs: cursor,
    pulse: PULSE,
    beepHz: BEEP,
    resolution: res,
    markers,
    quirks: {
      cameraCompositionDelayMs: layout === 'ss4' ? 80 : 'edit list no MP4 consolidado (HLS sem)',
      displayVfr: 'base 10 fps + 60 fps ao redor dos flashes',
      microphoneLengthDeltaMs: idx.map((i) => (i === 1 ? -120 : 64)),
      systemAudioLengthDeltaMs: 86,
      hostClockStartSec: idx.map(hostStart),
      pausesMs: pauses.slice(0, n - 1),
      orphanSession: opts.orphan === false ? null : n,
      nfdBundleName: true,
    },
  };
  const truthPath = `${bundlePath}.truth.json`;
  await writeFile(truthPath, json(truth));

  let zipPath: string | undefined;
  if (opts.zip) {
    zipPath = `${bundlePath}.zip`;
    await rm(zipPath, { force: true });
    if (process.platform === 'darwin') {
      // Extended attributes make ditto emit the __MACOSX/._* AppleDouble entries seen in real zips.
      for (const f of [path.join(rec, 'metadata.json'), path.join(rec, `${CHANNEL.display}-0-0001.m4s`)]) {
        await run('xattr', ['-w', 'com.apple.metadata:kMDItemWhereFroms', 'qa-mock', f], { allowFail: true });
      }
      await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundlePath, zipPath]);
    } else {
      await run('zip', ['-r', '-q', zipPath, bundleName], { cwd: opts.outDir });
    }
  }
  return { bundlePath, zipPath, truthPath, truth };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: path.join(import.meta.dirname, 'fixtures', 'generated') },
      sessions: { type: 'string', default: '1,3,5' },
      layout: { type: 'string', default: 'ss4' },
      seed: { type: 'string', default: '1' },
      zip: { type: 'boolean', default: false },
      'no-webcam': { type: 'boolean', default: false },
      'no-system-audio': { type: 'boolean', default: false },
      'no-orphan': { type: 'boolean', default: false },
      'webcam-size': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const webcamSize = values['webcam-size'] ? (values['webcam-size'].split('x').map(Number) as [number, number]) : undefined;
  if (values.help) {
    console.log('Uso: tsx tests/create-mock-bundle.ts [--out dir] [--sessions 1,3,5] [--layout ss4|ss37] [--seed 1] [--zip] [--no-webcam] [--no-system-audio] [--no-orphan] [--webcam-size 320x240]');
    return;
  }
  const tracks: MediaKind[] = ['display', 'webcam', 'microphone', 'systemAudio'].filter(
    (k) => !(k === 'webcam' && values['no-webcam']) && !(k === 'systemAudio' && values['no-system-audio']),
  ) as MediaKind[];
  for (const n of values.sessions.split(',').map(Number).filter((x) => x > 0)) {
    const t0 = Date.now();
    const b = await createMockBundle({ outDir: path.resolve(values.out), sessions: n, layout: values.layout as MockLayout, seed: Number(values.seed), zip: values.zip, tracks, orphan: !values['no-orphan'], webcamSize });
    console.log(`✓ ${path.basename(b.bundlePath).normalize('NFC')}  ${n} sessão(ões), ${(b.truth.timelineDurationMs / 1000).toFixed(3)} s  (${Date.now() - t0} ms)`);
    console.log(`    bundle:   ${b.bundlePath}`);
    if (b.zipPath) console.log(`    zip:      ${b.zipPath}`);
    console.log(`    gabarito: ${b.truthPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`create-mock-bundle: ${(e as Error).stack ?? e}`);
    process.exit(2);
  });
}
