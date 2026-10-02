import type { ExportResult, JobSnapshot, ProjectAnalysis, ServerStatus } from '../lib/types'

export const serverStatus: ServerStatus = {
  status: 'ok',
  version: '1.0.0',
  localOnly: true,
  ffmpeg: { available: true },
  ffprobe: { available: true },
  activeJobs: 0,
}

export const projectAnalysis: ProjectAnalysis = {
  name: 'Gravação com acentuação',
  inputPath: '/Users/Levi/Gravações/Teste.screenstudio',
  outputPath: '/Users/Levi/Exports/Teste',
  durationMs: 75_000,
  sessionCount: 7,
  tracks: [
    { kind: 'display', present: true, sessionCount: 7, durationMs: 75_000 },
    { kind: 'webcam', present: false, sessionCount: 0, durationMs: 0 },
    { kind: 'microphone', present: true, sessionCount: 7, durationMs: 75_000 },
    { kind: 'systemAudio', present: true, sessionCount: 7, durationMs: 75_000 },
  ],
  diskSpace: {
    path: '/Users/Levi/Exports',
    availableBytes: 20 * 1024 ** 3,
    estimatedRequiredBytes: 2 * 1024 ** 3,
    sufficient: true,
  },
  warnings: [],
}

export const exportResult: ExportResult = {
  outputPath: projectAnalysis.outputPath,
  fcpxmlPath: `${projectAnalysis.outputPath}/TIMELINE.fcpxml`,
  manifestPath: `${projectAnalysis.outputPath}/manifest.json`,
  syncReportPath: `${projectAnalysis.outputPath}/sync_report.json`,
  manifest: {
    schemaVersion: 1,
    projectName: projectAnalysis.name,
    inputPath: projectAnalysis.inputPath,
    generatedAt: '2026-10-01T12:00:00.000Z',
    pausePolicy: 'remove-wall-clock-pauses',
    timelineDurationMs: 75_000,
    metadataDurationMs: 75_000,
    sessionCount: 7,
    media: [
      { kind: 'display', file: 'SCREEN.mp4', durationMs: 75_000, codec: 'h264' },
      { kind: 'microphone', file: 'MICROPHONE.wav', durationMs: 75_000, codec: 'pcm_s24le' },
      { kind: 'systemAudio', file: 'SYSTEM_AUDIO.wav', durationMs: 75_000, codec: 'pcm_s24le' },
    ],
    fcpxml: 'TIMELINE.fcpxml',
    missingTracks: ['webcam'],
    ffmpegVersion: '8.0',
    ffprobeVersion: '8.0',
  },
  syncReport: {
    schemaVersion: 1,
    generatedAt: '2026-10-01T12:00:00.000Z',
    status: 'ok',
    toleranceMs: 100,
    maxDeviationMs: 13.12,
    interTrackDeviationMs: 0,
    timelineDurationMs: 75_000,
    metadataDurationMs: 75_000,
    tracks: [],
    warnings: [],
    scope: 'timestamp-and-frame-integrity',
  },
}

export function jobSnapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: 'job-123',
    state: 'running',
    inputPath: projectAnalysis.inputPath,
    outputPath: projectAnalysis.outputPath,
    createdAt: '2026-10-01T12:00:00.000Z',
    progress: {
      stage: 'reconstruct',
      percent: 15,
      currentTrack: 'display',
      message: 'Reconstruindo tela',
    },
    ...overrides,
  }
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
