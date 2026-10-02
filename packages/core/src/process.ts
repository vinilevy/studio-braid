import { spawn } from 'node:child_process';
import { BridgeError, checkAbort } from './errors.js';

export interface ProcessOptions { signal?: AbortSignal; onLine?: (line: string) => void; capture?: boolean; timeoutMs?: number; allowStderr?: boolean }
/** No shell interpolation. Waits for process CLOSE before resolving/rejecting and before temp cleanup. */
export async function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<{ stdout: string; stderr: string }> {
  checkAbort(options.signal);
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', spawnError: Error | undefined, timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000); killTimer.unref();
    };
    options.signal?.addEventListener('abort', terminate, { once: true });
    const timeout = options.timeoutMs ? setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs) : undefined;
    child.on('error', e => { spawnError = e; });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (s: string) => {
      if (options.capture !== false) {
        stdout += s;
        if (stdout.length > 20 * 1024 ** 2) { spawnError = new BridgeError('PROCESS_OUTPUT_LIMIT', 'Saída do processo excedeu o limite.'); terminate(); }
      }
      if (options.onLine) {
        pending += s;
        const lines = pending.split(/\r?\n/u); pending = lines.pop() ?? '';
        for (const line of lines) options.onLine(line);
      }
    });
    child.stderr.on('data', (s: string) => { stderr = (stderr + s).slice(-32768); });
    child.on('close', code => {
      if (killTimer) clearTimeout(killTimer); if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', terminate);
      if (options.onLine && pending) options.onLine(pending);
      if (options.signal?.aborted) return fail(new BridgeError('CANCELLED', 'Processamento cancelado.', 409));
      if (timedOut) return fail(new BridgeError('PROCESS_TIMEOUT', `${command} excedeu o tempo permitido.`, 500));
      if (spawnError) return fail(new BridgeError('PROCESS_UNAVAILABLE', `${command}: ${spawnError.message}`, 503));
      if (code !== 0 || (!options.allowStderr && stderr.trim()))
        return fail(new BridgeError('MEDIA_PROCESS_FAILED', `${command} falhou (${code}): ${stderr.trim().slice(-4000)}`, 422));
      ok({ stdout, stderr });
    });
    if (options.signal?.aborted) terminate();
  });
}
export async function toolVersion(command: string): Promise<string> {
  const result = await runProcess(command, ['-version'], { timeoutMs: 10_000, allowStderr: true });
  return result.stdout.split('\n')[0];
}
export async function runFFmpeg(args: string[], durationMs: number, options: ProcessOptions & { binary?: string; onPercent?: (percent: number) => void } = {}): Promise<void> {
  await runProcess(options.binary ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-xerror', '-progress', 'pipe:1', '-nostats', ...args], {
    ...options, capture: false, onLine(line) {
      if (line.startsWith('out_time_us=')) options.onPercent?.(Math.max(0, Math.min(99.5, Number(line.slice(12)) / 1000 / durationMs * 100)));
      options.onLine?.(line);
    },
  });
  options.onPercent?.(100);
}
