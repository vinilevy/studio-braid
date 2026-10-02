#!/usr/bin/env tsx
/**
 * make-davinci-kit — empacota uma exportação de mock aprovada + checklist para o smoke test manual
 * no DaVinci Resolve (Windows do Gustavo). Nomes de arquivo/pasta só em ASCII: ZIPs com acentos viram
 * mojibake no Explorer do Windows. Os timecodes do checklist saem do gabarito (.truth.json).
 *
 *   npx tsx tests/make-davinci-kit.ts --export "tests/output/regression/m3 - DaVinci" --source "<mock>.screenstudio"
 */
import { cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { run } from './lib/exec.ts';
import { findTruthFile, loadTruth } from './lib/markers.ts';
import { REPO_ROOT } from './lib/cli.ts';

const timecode = (ms: number, fps: number) => {
  const total = ms / 1000;
  const s = Math.floor(total);
  const ff = Math.min(fps - 1, Math.round((total - s) * fps));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(s % 60)}:${pad(ff)}`;
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      export: { type: 'string', default: path.join(REPO_ROOT, 'tests', 'output', 'regression', 'm3 - DaVinci') },
      source: { type: 'string' },
      out: { type: 'string', default: path.join(REPO_ROOT, 'validation', 'davinci-smoke-kit') },
      name: { type: 'string', default: 'SSB-Smoke-Mock3' },
    },
  });
  const exportDir = path.resolve(values.export);
  const sourceDir = values.source ?? (await (async () => {
    const dir = path.join(REPO_ROOT, 'tests', 'fixtures', 'generated', 'm3');
    const name = (await readdir(dir)).find((n) => n.endsWith('.screenstudio'));
    return name ? path.join(dir, name) : undefined;
  })());
  if (!sourceDir) throw new Error('Informe --source <mock>.screenstudio (gabarito necessário).');
  const truthFile = await findTruthFile(sourceDir);
  if (!truthFile) throw new Error(`Sem gabarito para ${sourceDir}`);
  const truth = await loadTruth(truthFile);

  const out = path.resolve(values.out);
  await rm(out, { recursive: true, force: true });
  const kit = path.join(out, values.name);
  await mkdir(kit, { recursive: true });
  for (const d of ['01_MEDIA', '02_DAVINCI', '03_DATA', 'logs']) await cp(path.join(exportDir, d), path.join(kit, d), { recursive: true }).catch(() => undefined);
  const xml = (await readdir(path.join(kit, '02_DAVINCI'))).find((n) => n.endsWith('.fcpxml'));
  if (!xml) throw new Error('Exportação sem FCPXML.');
  const xmlName = `${values.name}.fcpxml`;
  await rename(path.join(kit, '02_DAVINCI', xml), path.join(kit, '02_DAVINCI', xmlName));

  const fps = 60;
  const rows = truth.markers
    .map((m) => `| ${timecode(m.timeMs, fps)} | ${(m.timeMs / 1000).toFixed(3)} s | sessão ${m.session + 1} | ${m.kind === 'burst' ? `${m.pulses} flash(es)/bipe(s) — início da sessão` : '1 flash/bipe — fim da sessão'} |`)
    .join('\n');
  const durationS = (truth.timelineDurationMs / 1000).toFixed(3);
  const checklist = `# Teste rápido no DaVinci Resolve — Screen Studio Bridge

Este kit confirma no Resolve 4 coisas que nenhum teste automático consegue provar:

1. O FCPXML encontra as mídias pelos **caminhos relativos** (\`../01_MEDIA/...\`).
2. A tela gravada com **taxa de quadros variável (VFR)** não encolhe, não acelera e termina junto com o áudio.
3. A câmera (25 fps, com o tempo real de cada quadro preservado) não deriva.
4. As 4 faixas entram como **V1 Tela, V2 Câmera, A1 Microfone, A2 Áudio do sistema**, alinhadas.

O projeto é sintético (${truth.sessions.length} sessões, ${durationS} s): fundo escuro com **flashes brancos** na tela e na câmera e **bipes** no microfone (grave) e no áudio do sistema (agudo), sempre no MESMO instante.

## Passos

1. Extraia o ZIP numa pasta local (ex.: \`C:\\Bridge-Teste\\\`). Não mova nada de dentro da pasta \`${values.name}\`.
2. Abra o DaVinci Resolve e anote a versão (Help → About / Ajuda → Sobre).
3. Crie um projeto novo vazio.
4. **File → Import → Timeline…** (Ctrl+Shift+I) e escolha \`${values.name}\\02_DAVINCI\\${xmlName}\`.
   Deixe marcado "Automatically import source clips into media pool". Se o Resolve perguntar sobre a taxa de quadros, use **60 fps**.

## O que conferir (responda Sim/Não e anote valores)

- **A. Mídia online:** nenhum clipe vermelho/"Media Offline". Se aparecer offline: clique direito → Relink Clips → aponte para \`${values.name}\\01_MEDIA\` e anote **"caminho relativo falhou"**.
- **B. Faixas:** V1 = SCREEN.mp4 · V2 = CAMERA.mp4 · A1 = MICROPHONE.wav · A2 = SYSTEM_AUDIO.wav.
- **C. Duração:** os 4 clipes começam em 00:00:00:00 e terminam juntos (~${durationS} s). No Media Pool, anote as colunas **Duration** e **FPS** de SCREEN.mp4 e CAMERA.mp4.
- **D. Sincronismo quadro a quadro:** pare nos tempos abaixo (setas ← → andam 1 quadro) e confira se o flash da tela, o flash da câmera e os bipes nas ondas de A1/A2 começam no mesmo quadro. Desligue V2 (ícone de olho) para ver o V1.

| Timecode (60 fps) | Segundos | Sessão | Esperado |
|---|---|---|---|
${rows}

- **E. Reprodução contínua:** dê play do início ao fim. Flash e bipe devem soar/aparecer juntos até o final; a imagem da tela não pode acelerar nem acabar antes do áudio.
- **F. Clip Attributes:** clique direito em SCREEN.mp4 → Clip Attributes → anote o **Video Frame Rate** que o Resolve atribuiu. Repita para CAMERA.mp4.

## Enviar para o Levi

Versão do Resolve, respostas A–F e um print da timeline com as 4 faixas visíveis.

Se tudo passar, o próximo passo é repetir com a exportação real de 35 min (\`validation/exports/real-seven-sessions-v2\`, ~1,9 GB), conferindo D e E em três pontos (início, meio e fim) com um evento visível e audível (palma, início de fala).
`;
  await writeFile(path.join(out, 'CHECKLIST-DAVINCI.md'), checklist, 'utf8');
  const zip = `${out}.zip`;
  await rm(zip, { force: true });
  await run('zip', ['-r', '-q', '-X', zip, values.name, 'CHECKLIST-DAVINCI.md'], { cwd: out });
  console.log(`Kit: ${out}\nZIP: ${zip}`);
}

main().catch((e) => {
  console.error(`make-davinci-kit: ${(e as Error).stack ?? e}`);
  process.exit(2);
});
