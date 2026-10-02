import { createServer } from './app.js';

try { process.loadEnvFile?.(); } catch {}

const port = Number(process.env.PORT) || 3847;
const host = process.env.HOST || '127.0.0.1';
const ffmpegPath = process.env.FFMPEG_PATH || undefined;
const ffprobePath = process.env.FFPROBE_PATH || undefined;

const { app } = await createServer({ logger: true, port, ffmpegPath, ffprobePath });
await app.listen({ host, port });
let closing = false;
const close = () => {
  if (closing) return; closing = true;
  void app.close().then(() => { process.exitCode = 0; }, error => { app.log.error(error); process.exitCode = 1; });
};
process.once('SIGINT', close); process.once('SIGTERM', close);
