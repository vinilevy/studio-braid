import { createServer } from './app.js';

const { app } = await createServer({ logger: true });
await app.listen({ host: '127.0.0.1', port: 3847 });
let closing = false;
const close = () => {
  if (closing) return; closing = true;
  void app.close().then(() => { process.exitCode = 0; }, error => { app.log.error(error); process.exitCode = 1; });
};
process.once('SIGINT', close); process.once('SIGTERM', close);
