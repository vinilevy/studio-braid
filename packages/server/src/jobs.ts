import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { BridgeError, exportProject, resolveRenderOptions, type ApiError, type CreateJobRequest, type ExportOptions, type ExportResult, type JobSnapshot, type ProgressEvent } from '@screen-studio-bridge/core';

export interface JobEvent { id: number; data: ProgressEvent }
interface Job {
  snapshot: JobSnapshot; controller: AbortController; history: JobEvent[]; nextId: number;
  subscribers: Set<(event: JobEvent) => void>; done?: Promise<void>;
}
export type ExportRunner = (options: ExportOptions) => Promise<ExportResult>;
const terminal = (state: string) => ['completed', 'failed', 'cancelled'].includes(state);
export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private running = false; private closing = false;
  constructor(private readonly runner: ExportRunner = exportProject, private readonly binaries: Pick<ExportOptions, 'ffmpegPath' | 'ffprobePath'> = {}, private readonly onSettled?: (inputPath: string) => Promise<void>) {}
  get activeCount(): number { return [...this.jobs.values()].filter(j => !terminal(j.snapshot.state)).length; }
  private getJob(id: string): Job {
    const job = this.jobs.get(id); if (!job) throw new BridgeError('JOB_NOT_FOUND', 'Job não encontrado.', 404); return job;
  }
  get(id: string): JobSnapshot { return structuredClone(this.getJob(id).snapshot); }
  create(request: CreateJobRequest): JobSnapshot {
    if (this.closing) throw new BridgeError('SHUTTING_DOWN', 'Servidor encerrando.', 503);
    const renderOptions = resolveRenderOptions(request);
    if (this.activeCount >= 10) throw new BridgeError('QUEUE_FULL', 'Fila local cheia (limite: 10 jobs).', 429);
    const inputPath = resolve(request.inputPath), outputPath = resolve(request.outputPath);
    if ([...this.jobs.values()].some(j => !terminal(j.snapshot.state) && resolve(j.snapshot.outputPath) === outputPath))
      throw new BridgeError('OUTPUT_BUSY', 'Já existe um job reservando esta saída.', 409);
    // Bound retained results; active/streamed jobs are never evicted.
    for (const [id, job] of this.jobs) if (this.jobs.size >= 50 && terminal(job.snapshot.state) && !job.subscribers.size) this.jobs.delete(id);
    const id = randomUUID(), progress: ProgressEvent = { jobId: id, stage: 'queued', percent: 0, currentTrack: '', message: 'Aguardando motor local.', state: 'queued' };
    const job: Job = { snapshot: { id, state: 'queued', inputPath, outputPath, ...renderOptions, createdAt: new Date().toISOString(), progress }, controller: new AbortController(), history: [], nextId: 1, subscribers: new Set() };
    this.jobs.set(id, job); this.publish(job, progress); this.queue.push(id);
    setImmediate(() => { void this.pump(); });
    return this.get(id);
  }
  history(id: string, after = 0): JobEvent[] { return this.getJob(id).history.filter(e => e.id > after); }
  subscribe(id: string, listener: (event: JobEvent) => void): () => void {
    const job = this.getJob(id);
    const subscribers = [...this.jobs.values()].reduce((n, j) => n + j.subscribers.size, 0);
    if (job.subscribers.size >= 16 || subscribers >= 64) throw new BridgeError('SSE_LIMIT', 'Limite local de conexões SSE atingido.', 429);
    job.subscribers.add(listener); return () => { job.subscribers.delete(listener); };
  }
  private publish(job: Job, data: ProgressEvent): void {
    job.snapshot.progress = { ...data, jobId: job.snapshot.id, state: job.snapshot.state };
    const event: JobEvent = { id: job.nextId++, data: job.snapshot.progress };
    job.history.push(event); if (job.history.length > 128) job.history.shift();
    for (const subscriber of [...job.subscribers]) subscriber(event);
  }
  cancel(id: string): JobSnapshot {
    const job = this.getJob(id);
    if (terminal(job.snapshot.state)) return this.get(id); // idempotent; no deletion of complete exports.
    job.controller.abort();
    if (job.snapshot.state === 'queued') {
      const index = this.queue.indexOf(id); if (index >= 0) this.queue.splice(index, 1);
      job.snapshot.state = 'cancelled'; this.publish(job, { ...job.snapshot.progress, stage: 'cancelled', message: 'Job cancelado antes da execução.' });
      void this.onSettled?.(job.snapshot.inputPath).catch(() => {});
    } else this.publish(job, { ...job.snapshot.progress, stage: 'cancelling', message: 'Encerrando FFmpeg e limpando temporários.' });
    return this.get(id);
  }
  private async pump(): Promise<void> {
    if (this.running || this.closing) return;
    const id = this.queue.shift(); if (!id) return;
    const job = this.getJob(id);
    if (job.snapshot.state === 'cancelled') { void this.pump(); return; }
    this.running = true; job.snapshot.state = 'running';
    this.publish(job, { ...job.snapshot.progress, stage: 'analyze', message: 'Motor local iniciado.' });
    job.done = (async () => {
      try {
        const result = await this.runner({ inputPath: job.snapshot.inputPath, outputPath: job.snapshot.outputPath,
          ...resolveRenderOptions(job.snapshot), signal: job.controller.signal, ...this.binaries,
          onProgress: event => {
            if (event.stage !== 'complete') this.publish(job, { ...event, percent: Math.max(job.snapshot.progress.percent, event.percent) });
          } });
        job.snapshot.state = 'completed'; job.snapshot.result = result;
        this.publish(job, { stage: 'complete', percent: 100, currentTrack: '', message: 'Mídias e timeline validadas; temporários removidos.', result });
      } catch (error) {
        const cancelled = job.controller.signal.aborted || (error instanceof BridgeError && error.code === 'CANCELLED');
        const apiError: ApiError = error instanceof BridgeError ? { code: error.code, message: error.message } : { code: 'EXPORT_FAILED', message: error instanceof Error ? error.message : 'Falha na exportação.' };
        job.snapshot.state = cancelled ? 'cancelled' : 'failed'; job.snapshot.error = apiError;
        this.publish(job, { ...job.snapshot.progress, stage: cancelled ? 'cancelled' : 'failed', message: apiError.message, error: apiError });
      } finally {
        // Upload cleanup is best-effort and never removes user-supplied paths.
        await this.onSettled?.(job.snapshot.inputPath).catch(() => {});
        this.running = false; if (!this.closing) void this.pump();
      }
    })();
    await job.done;
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const [id, job] of this.jobs) if (!terminal(job.snapshot.state)) this.cancel(id);
    await Promise.all([...this.jobs.values()].map(j => j.done));
  }
}
