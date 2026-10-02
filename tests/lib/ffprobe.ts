import { ffprobeBin, run } from './exec.ts';

export interface StreamInfo {
  index: number;
  codecType: 'video' | 'audio' | 'data' | 'subtitle' | string;
  codecName: string;
  codecTag?: string;
  profile?: string;
  width?: number;
  height?: number;
  pixFmt?: string;
  sampleAspectRatio?: string;
  displayAspectRatio?: string;
  rFrameRate?: string;
  avgFrameRate?: string;
  hasBFrames?: number;
  sampleRate?: number;
  channels?: number;
  sampleFmt?: string;
  bitsPerSample?: number;
  bitsPerRawSample?: number;
  timeBase?: string;
  startTimeSec?: number;
  durationSec?: number;
  nbFrames?: number;
}

export interface ProbeResult {
  path: string;
  formatName: string;
  durationSec: number;
  startTimeSec: number;
  sizeBytes: number;
  streams: StreamInfo[];
}

export interface PacketTime {
  ptsSec: number;
  dtsSec: number;
  durationSec: number;
  key: boolean;
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === 'N/A' || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** "60/1" → 60, "30000/1001" → 29.97…, "0/0" → undefined */
export function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [a, b] = rate.split('/').map(Number);
  if (a === undefined || !Number.isFinite(a)) return undefined;
  if (b === undefined) return a;
  if (!b) return undefined;
  return a / b;
}

export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await run(ffprobeBin(), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]);
  const j = JSON.parse(stdout) as { format?: Record<string, unknown>; streams?: Record<string, unknown>[] };
  const f = j.format ?? {};
  return {
    path,
    formatName: String(f.format_name ?? ''),
    durationSec: num(f.duration) ?? NaN,
    startTimeSec: num(f.start_time) ?? 0,
    sizeBytes: num(f.size) ?? 0,
    streams: (j.streams ?? []).map((s) => ({
      index: Number(s.index),
      codecType: String(s.codec_type ?? ''),
      codecName: String(s.codec_name ?? ''),
      codecTag: s.codec_tag_string ? String(s.codec_tag_string) : undefined,
      profile: s.profile ? String(s.profile) : undefined,
      width: num(s.width),
      height: num(s.height),
      pixFmt: s.pix_fmt ? String(s.pix_fmt) : undefined,
      sampleAspectRatio: s.sample_aspect_ratio ? String(s.sample_aspect_ratio) : undefined,
      displayAspectRatio: s.display_aspect_ratio ? String(s.display_aspect_ratio) : undefined,
      rFrameRate: s.r_frame_rate ? String(s.r_frame_rate) : undefined,
      avgFrameRate: s.avg_frame_rate ? String(s.avg_frame_rate) : undefined,
      hasBFrames: num(s.has_b_frames),
      sampleRate: num(s.sample_rate),
      channels: num(s.channels),
      sampleFmt: s.sample_fmt ? String(s.sample_fmt) : undefined,
      bitsPerSample: num(s.bits_per_sample),
      bitsPerRawSample: num(s.bits_per_raw_sample),
      timeBase: s.time_base ? String(s.time_base) : undefined,
      startTimeSec: num(s.start_time),
      durationSec: num(s.duration),
      nbFrames: num(s.nb_frames),
    })),
  };
}

/**
 * Lists every packet of one stream (demux only, no decoding — fast even for long files).
 * `select` follows ffprobe syntax: "v:0", "a:0".
 */
export async function packetTimes(path: string, select = 'v:0'): Promise<PacketTime[]> {
  const { stdout } = await run(ffprobeBin(), [
    '-v', 'error', '-select_streams', select,
    '-show_entries', 'packet=pts_time,dts_time,duration_time,flags',
    '-of', 'csv=p=0:nk=0', path,
  ]);
  const packets: PacketTime[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const fields: Record<string, string> = {};
    for (const part of line.split(',')) {
      const eq = part.indexOf('=');
      if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
    const pts = num(fields.pts_time);
    const dts = num(fields.dts_time);
    packets.push({
      ptsSec: pts ?? dts ?? NaN,
      dtsSec: dts ?? pts ?? NaN,
      durationSec: num(fields.duration_time) ?? 0,
      key: (fields.flags ?? '').startsWith('K'),
    });
  }
  return packets;
}

export interface FrameRateStats {
  packets: number;
  nominalFps?: number;
  averageFps?: number;
  /** Largest gap between consecutive presentation timestamps. */
  maxGapMs: number;
  /** Share of gaps that deviate more than 10% from the nominal frame interval. */
  irregularGapRatio: number;
  constantFrameRate: boolean;
  firstPtsSec: number;
  lastPtsSec: number;
}

export function frameRateStats(packets: PacketTime[], nominalFps: number | undefined, durationSec: number): FrameRateStats {
  const pts = packets.map((p) => p.ptsSec).filter(Number.isFinite).sort((a, b) => a - b);
  let maxGap = 0;
  let irregular = 0;
  const nominalGap = nominalFps ? 1 / nominalFps : undefined;
  for (let i = 1; i < pts.length; i++) {
    const gap = (pts[i] as number) - (pts[i - 1] as number);
    if (gap > maxGap) maxGap = gap;
    if (nominalGap && Math.abs(gap - nominalGap) > nominalGap * 0.1) irregular++;
  }
  const averageFps = durationSec > 0 ? pts.length / durationSec : undefined;
  const irregularGapRatio = pts.length > 1 ? irregular / (pts.length - 1) : 0;
  const constantFrameRate =
    nominalFps !== undefined && averageFps !== undefined && Math.abs(averageFps - nominalFps) / nominalFps < 0.01 && irregularGapRatio < 0.01;
  return {
    packets: pts.length,
    nominalFps,
    averageFps,
    maxGapMs: maxGap * 1000,
    irregularGapRatio,
    constantFrameRate,
    firstPtsSec: pts[0] ?? NaN,
    lastPtsSec: pts[pts.length - 1] ?? NaN,
  };
}

export const videoStream = (p: ProbeResult): StreamInfo | undefined => p.streams.find((s) => s.codecType === 'video');
export const audioStream = (p: ProbeResult): StreamInfo | undefined => p.streams.find((s) => s.codecType === 'audio');
