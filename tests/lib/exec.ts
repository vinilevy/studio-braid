import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Resolve even when the process exits non-zero (caller inspects `code`). */
  allowFail?: boolean;
  env?: NodeJS.ProcessEnv;
}

export const ffmpegBin = (): string => process.env.FFMPEG_PATH || 'ffmpeg';
export const ffprobeBin = (): string => process.env.FFPROBE_PATH || 'ffprobe';

/** Spawns without a shell, so paths with spaces/accents never need quoting. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e) => reject(new Error(`Falha ao executar "${cmd}": ${e.message}`)));
    child.on('close', (code) => {
      const result = { code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
      if (result.code !== 0 && !opts.allowFail) {
        const tail = result.stderr.trim().split('\n').slice(-12).join('\n');
        reject(new Error(`"${cmd} ${args.slice(0, 6).join(' ')}…" saiu com código ${result.code}\n${tail}`));
        return;
      }
      resolve(result);
    });
  });
}

export async function ffmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(ffmpegBin(), ['-hide_banner', '-nostdin', '-y', ...args], opts);
}

/** Like `ffmpeg`, but returns raw stdout bytes (for -f f32le pipes). */
export function ffmpegBuffer(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), ['-hide_banner', '-nostdin', '-v', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg saiu com código ${code}: ${Buffer.concat(err).toString('utf8').trim().split('\n').slice(-4).join(' | ')}`)),
    );
  });
}

/** Runs `fn` over `items` with at most `limit` in flight; preserves order of results. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}
