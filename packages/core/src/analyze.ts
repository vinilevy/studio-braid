import { stat, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ProjectAnalysis, ProjectMetadata, DiskSpace, RenderOptions, ResolvedRenderOptions } from './types/index.js';
import { parseProject, defaultOutputPath, TRACK_KINDS } from './parser.js';
import { prepareInput } from './bundle.js';
import { TempManager } from './temp.js';
import { BridgeError, checkAbort } from './errors.js';

/** Shared defaults and runtime validation for direct core calls as well as HTTP jobs. */
export function resolveRenderOptions(options: RenderOptions = {}): ResolvedRenderOptions {
  const cameraResolution = options.cameraResolution === undefined ? '4k' : options.cameraResolution;
  const quality = options.quality === undefined ? 'maximum' : options.quality, screenResolution = options.screenResolution === undefined ? 'native' : options.screenResolution;
  if (!['native', '4k', '1080p'].includes(cameraResolution) || !['maximum', 'high', 'fast'].includes(quality) || !['native', '4k'].includes(screenResolution))
    throw new BridgeError('INVALID_RENDER_OPTIONS', 'cameraResolution deve ser native, 4k ou 1080p; quality maximum, high ou fast; screenResolution native ou 4k.', 400);
  return { cameraResolution, quality, screenResolution };
}
export async function estimateDiskSpace(project: ProjectMetadata, outputPath: string, options: RenderOptions = {}): Promise<DiskSpace> {
  const render = resolveRenderOptions(options);
  let path = resolve(outputPath);
  while (!await stat(path).then(s => s.isDirectory()).catch(() => false)) {
    const parent = dirname(path); if (parent === path) break; path = parent;
  }
  // Typical *average* bitrates, not encoder limits: screen VFR 3 Mbps (4K render 5),
  // camera 10 Mbps (1080p 8), each stereo WAV 48kHz/24-bit exactly 2.304 Mbps.
  // Sources already occupy disk; HLS playlist byte sizes are not media sizes.
  // Reserve 1.5x once for staged output/intermediates, without x2 copies or a fixed GiB surcharge.
  const screenBitrate = render.screenResolution === '4k' ? 5_000_000 : 3_000_000;
  const cameraBitrate = render.cameraResolution === '1080p' ? 8_000_000 : 10_000_000;
  const bitrate = project.tracks.reduce((sum, track) => sum + (track.kind === 'display' ? screenBitrate : track.kind === 'webcam' ? cameraBitrate : 48_000 * 24 * 2), 0);
  const estimatedRequiredBytes = Math.ceil(project.durationMs / 1000 * bitrate / 8 * 1.5);
  const availableBytes = await statfs(path, { bigint: true }).then(s => Number(s.bavail * s.bsize)).catch(() => null);
  return { path, availableBytes, estimatedRequiredBytes, sufficient: availableBytes === null ? null : availableBytes >= estimatedRequiredBytes };
}
export async function analyzeProject(inputPath: string, outputPath?: string, signal?: AbortSignal, options: RenderOptions = {}): Promise<ProjectAnalysis> {
  const renderOptions = resolveRenderOptions(options);
  const temp = new TempManager();
  try {
    const bundle = await prepareInput(inputPath, temp, signal);
    const project = await parseProject(bundle, inputPath, signal); checkAbort(signal);
    const output = outputPath ? resolve(outputPath) : defaultOutputPath(project.name);
    return { name: project.name, inputPath: resolve(inputPath), outputPath: output, durationMs: project.durationMs, sessionCount: project.sessionCount,
      tracks: TRACK_KINDS.map(kind => { const t = project.tracks.find(t => t.kind === kind); return { kind, present: !!t, sessionCount: t?.sessions.length ?? 0, durationMs: t?.durationMs ?? 0 }; }),
      renderOptions, diskSpace: await estimateDiskSpace(project, output, renderOptions),
      warnings: [...project.warnings, 'Espaço estimado por duração/faixas/resolução com margem de 1,5x; CRF, movimento e canais de áudio podem alterar o tamanho real.'] };
  } finally { await temp.dispose(); }
}
