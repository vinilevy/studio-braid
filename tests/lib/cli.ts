import { access } from 'node:fs/promises';
import path from 'node:path';
import { run, type RunResult } from './exec.ts';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DEFAULT_CLI = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');

/** Runs the engine CLI (a Node script; default: packages/cli/dist/index.js) on one input. */
export async function runBridgeCli(input: string, output: string, cliJs = process.env.BRIDGE_CLI_JS || DEFAULT_CLI, extraArgs: string[] = []): Promise<RunResult & { ms: number }> {
  await access(cliJs).catch(() => {
    throw new Error(`CLI da IA 1 não encontrada em ${cliJs} (rode "npm run build:engine" na raiz ou passe --cli-js).`);
  });
  const t0 = Date.now();
  const result = await run(process.execPath, [cliJs, '--input', input, '--output', output, '--json', ...extraArgs], { allowFail: true });
  return { ...result, ms: Date.now() - t0 };
}
