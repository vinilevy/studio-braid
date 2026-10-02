#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { exportProject, BridgeError } from '@screen-studio-bridge/core';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' } }, strict: true });
  if (values.help) { console.log('bridge-cli --input "/projeto.screenstudio[.zip]" --output "/saida" [--json]'); return; }
  if (!values.input || !values.output) throw new BridgeError('CLI_ARGUMENTS', 'Use --input e --output. Veja --help.', 400);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await exportProject({ inputPath: values.input, outputPath: values.output, signal: controller.signal,
      onProgress(event) { process.stderr.write(`${event.percent.toFixed(1)}% [${event.stage}/${event.currentTrack}] ${event.message}\n`); } });
    console.log(values.json ? JSON.stringify(result) : `Concluído: ${result.outputPath}\nFCPXML: ${result.fcpxmlPath}\nDesvio máximo: ${result.syncReport.maxDeviationMs.toFixed(3)}ms`);
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
main().catch(error => {
  const e = error instanceof BridgeError ? error : new BridgeError('UNEXPECTED_ERROR', error instanceof Error ? error.message : 'Falha inesperada.');
  process.stderr.write(`${e.code}: ${e.message}\n`); process.exitCode = e.code === 'CANCELLED' ? 130 : 1;
});
