import type { MediaProbe } from './types/index.js';
import { BridgeError } from './errors.js';
import { runProcess } from './process.js';

export interface PacketStats {
  count: number; firstPtsMs: number; lastPtsMs: number; lastDurationMs: number;
  lastPresentationIndex: number; durationMs: number;
}
export function localInputArgs(path: string): string[] {
  return ['-protocol_whitelist', 'file', ...(/\.m3u8$/iu.test(path) ? ['-allowed_extensions', 'ALL'] : []), '-i', path];
}
export async function probeMedia(path: string, options: { binary?: string; signal?: AbortSignal; countFrames?: boolean; type?: 'video' | 'audio' } = {}): Promise<MediaProbe> {
  const { stdout } = await runProcess(options.binary ?? 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', ...(/\.m3u8$/iu.test(path) ? ['-allowed_extensions', 'ALL'] : []),
    ...(options.countFrames ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json', path], { signal: options.signal });
  const raw = JSON.parse(stdout);
  const stream = raw.streams?.find((s: { codec_type: string }) => !options.type || s.codec_type === options.type);
  const duration = Number(stream?.duration ?? raw.format?.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0) throw new BridgeError('INVALID_MEDIA', `Stream/duração inválida: ${path}`);
  const number = (v: unknown) => v !== undefined && v !== 'N/A' && Number.isFinite(Number(v)) ? Number(v) : undefined;
  return { path, durationMs: duration * 1000, startTimeMs: Number(stream.start_time ?? raw.format?.start_time ?? 0) * 1000,
    codec: stream.codec_name, profile: stream.profile, pixelFormat: stream.pix_fmt, width: stream.width, height: stream.height,
    frameRate: stream.r_frame_rate, averageFrameRate: stream.avg_frame_rate, frameCount: number(stream.nb_read_frames ?? stream.nb_frames), sampleRate: number(stream.sample_rate),
    channels: number(stream.channels), bitsPerSample: number(stream.bits_per_raw_sample || stream.bits_per_sample), timeBase: stream.time_base };
}

export async function scanVideoPackets(path: string, binary = 'ffprobe', signal?: AbortSignal): Promise<PacketStats> {
  let count = 0, firstPtsMs = Infinity, lastPtsMs = -Infinity, lastDurationMs = 0, lastPresentationIndex = 0;
  await runProcess(binary, ['-v', 'error', '-protocol_whitelist', 'file', ...(/\.m3u8$/iu.test(path) ? ['-allowed_extensions', 'ALL'] : []),
    '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'compact=p=0:nk=0', path], {
    signal, capture: false, onLine(line) {
      const fields = Object.fromEntries(line.split('|').filter(s => s.includes('=')).map(s => s.split('=')));
      if (!fields.pts_time || fields.pts_time === 'N/A') return;
      const pts = Number(fields.pts_time) * 1000;
      if (!Number.isFinite(pts)) return;
      firstPtsMs = Math.min(firstPtsMs, pts);
      if (pts >= lastPtsMs) { lastPtsMs = pts; lastDurationMs = Number(fields.duration_time ?? 0) * 1000; lastPresentationIndex = count; }
      count++;
    },
  });
  if (!count || !Number.isFinite(firstPtsMs)) throw new BridgeError('INVALID_VIDEO', 'Vídeo sem frames ou PTS válidos.');
  return { count, firstPtsMs, lastPtsMs, lastDurationMs, lastPresentationIndex, durationMs: lastPtsMs - firstPtsMs + lastDurationMs };
}
