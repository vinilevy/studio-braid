import Fastify, { type FastifyServerOptions } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { z } from 'zod';
import { analyzeProject, BridgeError, toolVersion, type AnalyzeRequest, type CreateJobResponse, type ServerStatus } from '@screen-studio-bridge/core';
import { JobManager, type ExportRunner, type JobEvent } from './jobs.js';
import { UploadManager } from './uploads.js';
import { openOutput, pickInput } from './system.js';

export interface ServerOptions {
  logger?: FastifyServerOptions['logger']; staticDir?: string; port?: number;
  ffmpegPath?: string; ffprobePath?: string; runner?: ExportRunner;
}
const pathsSchema = z.object({ inputPath: z.string().trim().min(1).max(4096), outputPath: z.string().trim().min(1).max(4096).optional(),
  cameraResolution: z.enum(['native', '4k', '1080p']).optional(), quality: z.enum(['maximum', 'high', 'fast']).optional(), screenResolution: z.enum(['native', '4k']).optional() }).strict();
function bodyPaths(body: unknown, outputRequired = false) {
  const parsed = pathsSchema.safeParse(body);
  if (!parsed.success || (outputRequired && !parsed.data.outputPath)) throw new BridgeError('INVALID_REQUEST', outputRequired ? 'Informe inputPath e outputPath para criar um job; opções: cameraResolution native/4k/1080p, quality maximum/high/fast, screenResolution native/4k.' : 'Informe inputPath para analisar o projeto (outputPath opcional); cameraResolution native/4k/1080p, quality maximum/high/fast, screenResolution native/4k.', 400);
  if (!isAbsolute(parsed.data.inputPath) || (parsed.data.outputPath && !isAbsolute(parsed.data.outputPath))) throw new BridgeError('ABSOLUTE_PATH_REQUIRED', 'A API requer caminhos absolutos no computador local.', 400);
  return parsed.data;
}
export async function createServer(options: ServerOptions = {}) {
  const port = options.port ?? 3847;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 32 * 1024, requestTimeout: 0 });
  const uploads = new UploadManager();
  const jobs = new JobManager(options.runner, { ffmpegPath: options.ffmpegPath, ffprobePath: options.ffprobePath }, path => uploads.release(path));
  const streams = new Set<() => void>();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1', 'localhost']);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  app.addHook('onRequest', async (request, reply) => {
    const address = app.server.address();
    if (address && typeof address !== 'string') {
      allowedHosts.add(`127.0.0.1:${address.port}`); allowedHosts.add(`localhost:${address.port}`);
      allowedOrigins.add(`http://127.0.0.1:${address.port}`); allowedOrigins.add(`http://localhost:${address.port}`);
    }
    // Host guard prevents DNS rebinding; Origin/Sec-Fetch guard blocks cross-site local filesystem access.
    if (!allowedHosts.has(request.headers.host?.toLowerCase() ?? '')) throw new BridgeError('HOST_FORBIDDEN', 'Host deve ser localhost.', 403);
    if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) throw new BridgeError('ORIGIN_FORBIDDEN', 'Origem não autorizada para o servidor local.', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new BridgeError('ORIGIN_FORBIDDEN', 'Requisição cross-site bloqueada.', 403);
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
  });
  app.setErrorHandler((error, _request, reply) => {
    const known: Error & { statusCode?: number } = error instanceof Error ? error : new Error('Erro desconhecido.');
    const status = error instanceof BridgeError ? error.statusCode : typeof known.statusCode === 'number' ? known.statusCode : 500;
    reply.code(status).send({ error: { code: error instanceof BridgeError ? error.code : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message: error instanceof BridgeError ? error.message : status === 500 ? 'Falha interna do servidor local.' : known.message } });
  });
  await app.register(multipart, { limits: { fieldSize: 16 * 1024 } });
  let toolsCache: Pick<ServerStatus, 'ffmpeg' | 'ffprobe'> | undefined, toolsUpdated = 0;
  const toolsStatus = async () => {
    if (!toolsCache || Date.now() - toolsUpdated > 30_000) {
      const status = async (binary: string) => toolVersion(binary).then(version => ({ available: true, version }), () => ({ available: false, error: `Instale ${binary} no PATH.` }));
      const [ffmpeg, ffprobe] = await Promise.all([status(options.ffmpegPath ?? 'ffmpeg'), status(options.ffprobePath ?? 'ffprobe')]);
      toolsCache = { ffmpeg, ffprobe }; toolsUpdated = Date.now();
    }
    return toolsCache;
  };
  app.get('/api/status', async (): Promise<ServerStatus> => {
    const status = await toolsStatus(); return { status: status.ffmpeg.available && status.ffprobe.available ? 'ok' : 'degraded', version: '0.1.0', localOnly: true, activeJobs: jobs.activeCount, ...status };
  });
  let analyzing = false;
  app.post('/api/projects/analyze', async request => {
    if (analyzing) throw new BridgeError('ANALYSIS_BUSY', 'Análise local em andamento. Aguarde.', 429);
    analyzing = true; let uploaded: string | undefined;
    const controller = new AbortController(); const abort = () => controller.abort(); request.raw.once('aborted', abort);
    try {
      const paths: AnalyzeRequest = request.isMultipart() ? await uploads.receive(request) : bodyPaths(request.body);
      if (request.isMultipart()) uploaded = paths.inputPath;
      return await analyzeProject(paths.inputPath, paths.outputPath, controller.signal, paths);
    } catch (error) { if (uploaded) await uploads.discard(uploaded); throw error; }
    finally { analyzing = false; request.raw.removeListener('aborted', abort); }
  });
  app.post('/api/jobs', async (request, reply): Promise<CreateJobResponse> => {
    const paths = bodyPaths(request.body, true);
    const snapshot = jobs.create({ ...paths, inputPath: resolve(paths.inputPath), outputPath: resolve(paths.outputPath!) });
    uploads.lease(snapshot.inputPath); reply.code(202); return { ...snapshot, jobId: snapshot.id };
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async request => jobs.get(request.params.id));
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (request, reply) => { reply.code(202); return jobs.cancel(request.params.id); });
  app.get<{ Params: { id: string } }>('/api/jobs/:id/events', async (request, reply) => {
    const id = request.params.id, snapshot = jobs.get(id);
    const rawId = request.headers['last-event-id'], after = typeof rawId === 'string' && /^\d+$/u.test(rawId) ? Number(rawId) : 0;
    let closed = false, unsubscribe: (() => void) | undefined, heartbeat: NodeJS.Timeout | undefined;
    const close = () => { if (closed) return; closed = true; if (heartbeat) clearInterval(heartbeat); unsubscribe?.(); streams.delete(close); reply.raw.end(); };
    const send = (event: JobEvent) => {
      if (closed || reply.raw.destroyed) { close(); return; }
      const writable = reply.raw.write(`id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event.data)}\n\n`);
      // A slow/disconnected reader reconnects and replays; do not buffer unbounded progress/results.
      if (!writable && reply.raw.writableLength > 1024 * 1024) close();
      if (['completed', 'failed', 'cancelled'].includes(event.data.state ?? '')) close();
    };
    // Subscribe before hijack, so limit/404 errors can still be serialized normally.
    if (!['completed', 'failed', 'cancelled'].includes(snapshot.state)) unsubscribe = jobs.subscribe(id, send);
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write('retry: 1500\n\n'); streams.add(close); reply.raw.once('close', close);
    const history = jobs.history(id, after);
    if (history.length) { for (const event of history) { send(event); if (closed) break; } }
    else send({ id: after, data: snapshot.progress });
    if (!closed) heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); else close(); }, 15_000).unref();
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/open-output', async request => {
    const job = jobs.get(request.params.id); if (job.state !== 'completed' || !job.result) throw new BridgeError('OUTPUT_NOT_READY', 'A pasta só pode ser aberta após conclusão.', 409);
    await openOutput(job.result.outputPath); return { opened: true };
  });
  let dialogOpen = false;
  app.post('/api/system/pick-input', async request => {
    const parsed = z.object({ kind: z.enum(['folder', 'zip']) }).strict().safeParse(request.body);
    if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'kind deve ser folder ou zip.', 400);
    if (dialogOpen) throw new BridgeError('DIALOG_BUSY', 'Já existe um seletor aberto.', 409);
    dialogOpen = true; try { return { inputPath: await pickInput(parsed.data.kind) }; } finally { dialogOpen = false; }
  });
  const staticDir = resolve(options.staticDir ?? fileURLToPath(new URL('../../../web/dist', import.meta.url)));
  await app.register(fastifyStatic, { root: staticDir, dotfiles: 'deny', list: false, suppressWarning: true });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method) || /\.[a-z0-9]+(?:\?|$)/iu.test(request.url))
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
    if (await access(resolve(staticDir, 'index.html')).then(() => true).catch(() => false)) return reply.type('text/html').sendFile('index.html');
    return reply.code(503).send({ error: { code: 'WEB_NOT_BUILT', message: 'Execute npm --prefix web run build para gerar web/dist.' } });
  });
  app.addHook('preClose', async () => { for (const close of [...streams]) close(); await jobs.close(); await uploads.close(); });
  return { app, jobs };
}
