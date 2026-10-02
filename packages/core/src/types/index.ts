/** Stable v1 contract shared by CLI, server and web. All durations are milliseconds. */
export type TrackKind = 'display' | 'webcam' | 'microphone' | 'systemAudio';
export type TrackFile = 'SCREEN.mp4' | 'CAMERA.mp4' | 'MICROPHONE.wav' | 'SYSTEM_AUDIO.wav';
export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type CameraResolution = 'native' | '4k' | '1080p';
export type RenderQuality = 'maximum' | 'high' | 'fast';
export type ScreenResolution = 'native' | '4k';
/** Optional at API boundaries. Omitted values resolve to 4k / maximum / native. */
export interface RenderOptions {
  cameraResolution?: CameraResolution; quality?: RenderQuality; screenResolution?: ScreenResolution;
}
export interface ResolvedRenderOptions {
  cameraResolution: CameraResolution; quality: RenderQuality; screenResolution: ScreenResolution;
}
export interface VideoRenderSettings {
  mode: 'remux' | 'transcode'; resolution: CameraResolution; quality: RenderQuality;
  crf: number | null; x264Preset: string | null; width: number; height: number;
}
export interface RecordingSession {
  index: number; durationMs: number; unixStartMs: number; unixEndMs: number;
  outputFilename: string; sourcePath: string;
}
export interface RecordingTrack { kind: TrackKind; sessions: RecordingSession[]; durationMs: number }
export interface ProjectMetadata {
  name: string; inputPath: string; bundlePath: string;
  tracks: RecordingTrack[]; durationMs: number; sessionCount: number; warnings: string[];
}
export interface TrackAnalysis {
  kind: TrackKind; present: boolean; sessionCount: number; durationMs: number;
}
export interface DiskSpace {
  path: string; availableBytes: number | null; estimatedRequiredBytes: number;
  sufficient: boolean | null;
}
export interface AnalyzeRequest extends RenderOptions { inputPath: string; outputPath?: string }
export interface ProjectAnalysis {
  name: string; inputPath: string; outputPath: string; durationMs: number; sessionCount: number;
  tracks: TrackAnalysis[]; diskSpace: DiskSpace; warnings: string[];
  renderOptions?: ResolvedRenderOptions;
}
export interface CreateJobRequest extends RenderOptions { inputPath: string; outputPath: string }
export interface ProgressEvent {
  stage: string; percent: number; currentTrack: string; message: string;
  jobId?: string; state?: JobState; result?: ExportResult; error?: ApiError;
}
export interface ApiError { code: string; message: string }
export interface MediaProbe {
  path: string; durationMs: number; startTimeMs: number; codec: string;
  profile?: string; pixelFormat?: string; width?: number; height?: number;
  frameRate?: string; averageFrameRate?: string; frameCount?: number; sampleRate?: number; channels?: number;
  bitsPerSample?: number; timeBase: string;
}
export interface SessionReport {
  index: number; source: string; metadataDurationMs: number; sourceDurationMs: number;
  timelineStartMs: number; timelineEndMs: number; sourceFrames?: number;
  outputFrames?: number; startOffsetMs: number; paddingMs: number;
  boundaryDeviationMs: number; sourceFirstPtsMs?: number; tailAdjustmentMs?: number;
}
export interface TrackReport {
  kind: TrackKind; file: TrackFile; sessionCount: number; expectedDurationMs: number;
  actualDurationMs: number; deviationMs: number; framesPreserved: boolean | null;
  sourceFrames?: number; outputFrames?: number; nominalFrameRate?: string; sessions: SessionReport[]; probe: MediaProbe;
}
export interface SyncReport {
  schemaVersion: 1; generatedAt: string; status: 'ok' | 'failed';
  toleranceMs: number; maxDeviationMs: number; interTrackDeviationMs: number;
  timelineDurationMs: number; metadataDurationMs: number;
  tracks: TrackReport[]; warnings: string[];
  scope: 'timestamp-and-frame-integrity';
}
export interface ProjectManifest {
  schemaVersion: 1; projectName: string; inputPath: string; generatedAt: string;
  pausePolicy: 'remove-wall-clock-pauses'; timelineDurationMs: number;
  metadataDurationMs: number; sessionCount: number;
  media: { kind: TrackKind; file: string; durationMs: number; codec: string }[];
  fcpxml: string; missingTracks: TrackKind[]; ffmpegVersion: string; ffprobeVersion: string;
  renderOptions?: ResolvedRenderOptions;
  videoSettings?: Partial<Record<'display' | 'webcam', VideoRenderSettings>>;
}
export interface ExportResult {
  outputPath: string; fcpxmlPath: string; manifestPath: string; syncReportPath: string;
  manifest: ProjectManifest; syncReport: SyncReport;
}
export interface ExportOptions extends RenderOptions {
  inputPath: string; outputPath: string; signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void; ffmpegPath?: string; ffprobePath?: string;
  syncToleranceMs?: number;
}
export interface JobSnapshot extends RenderOptions {
  id: string; state: JobState; inputPath: string; outputPath: string;
  createdAt: string; progress: ProgressEvent; result?: ExportResult; error?: ApiError;
}
export interface CreateJobResponse extends JobSnapshot { jobId: string }
export interface ToolStatus { available: boolean; version?: string; error?: string }
export interface ServerStatus {
  status: 'ok' | 'degraded'; version: string; localOnly: true;
  ffmpeg: ToolStatus; ffprobe: ToolStatus; activeJobs: number;
}
