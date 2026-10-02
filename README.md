# Studio Braid (Screen Studio Bridge)

Motor local Node.js/TypeScript e interface web para reconstruir **todas** as sessões de gravação do Screen Studio diretamente para o DaVinci Resolve com FCPXML e sincronização cirúrgica de áudio e vídeo.

---

## ⚡ Instalação Rápida no Windows (PC do Gustavo)

Para instalar no Windows com todas as dependências (Node.js, FFmpeg, atalho na Área de Trabalho e inicialização automática com o sistema):

### Comando Único (PowerShell):
```powershell
git clone https://github.com/vinilevy/studio-braid.git "$env:USERPROFILE\StudioBraid"; cd "$env:USERPROFILE\StudioBraid"; .\install.bat
```

> Ou baixe a pasta do repositório e dê **dois cliques em `install.bat`**.

### O que acontece automaticamente:
- 🚀 **Inicialização Automática**: Sempre que o PC for ligado ou reiniciado, o Studio Braid abre sozinho no navegador.
- 🖥️ **Ícone na Área de Trabalho**: Um atalho **Studio Braid** é criado no Desktop. Ao clicar, ele abre o sistema sem exibir nenhuma janela preta ou terminal.
- 📦 **Instalação Autônoma**: Verifica e instala automaticamente o Node.js e FFmpeg via `winget` se necessário.
- 🌐 **Interface Web Local**: Disponível em `http://127.0.0.1:3847`.
- 🛑 **Parar o Servidor**: Basta executar `scripts\windows\stop.bat`.

---
## Requisitos

- Node.js 22+ e npm.
- FFmpeg e FFprobe no PATH, com `libx264` e o bitstream filter `setts` com opção `prescale` (validado localmente com FFmpeg 9.0.2). Também é possível configurar binaries via `ExportOptions` no core.
- Espaço livre para intermediários + resultado; a análise fornece estimativa conservadora, não garantia de bitrate CRF.

## CLI

```sh
npm ci
npm run build:engine
npm run cli -- --input "/caminho/Projeto.screenstudio" --output "/caminho/Projeto - DaVinci"
# Alternativa compilada (sem tsx em produção):
node packages/cli/dist/index.js --input "/caminho/Projeto.screenstudio.zip" --output "/caminho/saida" --json
# Executável de workspace após build/install:
npx --no-install bridge-cli --input "/caminho/Projeto.screenstudio" --output "/caminho/saida"
```

`--json` escreve um ExportResult no stdout; progresso/erros ficam no stderr. SIGINT/SIGTERM cancelam o job (exit 130), esperam o FFmpeg fechar e limpam temporários. A saída deve estar ausente ou vazia; nunca há overwrite de mídia do usuário.

## Saída

```text
Projeto - DaVinci/
├── 01_MEDIA/
│   ├── SCREEN.mp4       # H.264 original, remux sem perda
│   ├── CAMERA.mp4       # H.264 High/yuv420p, CRF18, veryfast
│   ├── MICROPHONE.wav   # PCM 24-bit/48 kHz
│   └── SYSTEM_AUDIO.wav # PCM 24-bit/48 kHz
├── 02_DAVINCI/Projeto.fcpxml
├── 03_DATA/project_manifest.json
├── 03_DATA/sync_report.json
└── logs/export.log
```

Faixas ausentes são reportadas e não sintetizadas como se fossem uma gravação real. FCPXML 1.10 usa URLs relativos (`../01_MEDIA/*`) para transportar a pasta inteira ao Windows. Importe pelo diálogo de timeline XML do Resolve. **Importação real no Resolve/Windows ainda exige smoke test**; DTD validado e codecs corretos não são prova de funcionamento nessa plataforma.

## Fidelidade e sincronismo

- A timeline remove pausas de relógio de parede. Sessões vêm exclusivamente do metadata, nunca de um glob de fragmentos.
- Vídeos HLS fMP4 e MP4 consolidados são suportados. Inicialização e fragmentos são verificados antes de abrir FFmpeg; URIs remotas, criptografadas ou fora do bundle são bloqueadas.
- Tela: todos os packets/frames H.264 são preservados, incluindo VFR e timestamps internos. Apenas o PTS/DTS e hold do sample terminal são ajustados na timebase 1/60000 ao fim registrado, com arredondamento no acumulado, evitando o padding indevido observado em fontes reais.
- Câmera: `PTS-STARTPTS` remove o atraso de composição do primeiro frame HEVC/H.264 com B-frames. Não alinhar usando o PTS bruto do host. Sem `-t`, `-shortest` ou conversão CFR que descarte frames. Eventual cauda de PTS além do fim é ajustada somente no último segundo; valor registrado no relatório.
- Áudio: 48 kHz, PCM 24-bit; trim/pad por sessão para impedir deriva acumulada. Canais e volume preservados, sem mixagem. Pequenos offsets reais de unixStartMs são considerados.
- FFprobe decodifica e conta todos os frames do resultado, além de checar codec, perfil, pixel format, duração e início. O relatório inclui source/output frames e fronteiras de cada sessão.
- Gate estrito **<100 ms**; não publica sucesso com drift maior. O relatório comprova integridade temporal, **não** sincronismo perceptual de fala/ação.
- Contagens de sessões diferentes entre canais presentes, clocks divergentes >100ms, mudanças de resolução/codec/canais e mídia quebrada falham explicitamente. Esses layouts não são reconstruídos por adivinhação.

## Segurança

ZIP64 com proteção contra Zip Slip, symlinks, dispositivos Windows, ADS, caminhos absolutos/UNC, duplicatas NFC/case, limites de 50k entradas/200 GiB, e leitura por streaming. Suporta ZIPs do Finder com nome UTF-8 sem flag e ignora `__MACOSX`/AppleDouble. Nenhuma mídia é enviada à nuvem. O motor não executa shell com filenames. Temporários são exclusivamente diretórios criados pelo TempManager; fontes não são registradas para limpeza.

## Testes

```sh
npm run test:core
npm --prefix tests install
npm --prefix tests run verify -- --help
```

O pacote standalone `tests/` é a auditoria independente; seus comandos disponíveis estão em `tests/package.json`. Evidência real atual: `validation/exports/real-seven-sessions-v2`, 7 sessões/34m58s, 4 mídias com 2098,202 s, desvio máximo do core 0,016 ms, 22666 frames de tela e 52461 de câmera preservados. Auditoria independente da IA 2: `tests/output/real7-v2-verify-export.json`; correlação do microfone alinhada em todas as sessões. Arquivos exportados são ignorados por `.gitignore`.

## Contrato com a UI

Tipos browser-safe: `packages/core/src/types/index.ts`. Contrato durável em `artifacts/engine-contract` no epic Traycer. Servidor local implementado e validado após aprovação da IA 2; o status de validação está no artefato.

Referências: [FFmpeg setts](https://ffmpeg.org/ffmpeg-bitstream-filters.html#setts), [FFmpeg timestamps](https://ffmpeg.org/ffmpeg.html), [Apple media-rep/URLs relativos](https://developer.apple.com/documentation/professional-video-applications/media-rep), [Apple FCPXML DTD](https://developer.apple.com/documentation/professional-video-applications/document-type-definition).

## Servidor local

```sh
npm run build:engine
npm start
# Desenvolvimento do backend:
npm run dev:server
```

Bind exclusivo: `http://127.0.0.1:3847`. O servidor serve `web/dist` automaticamente; enquanto o build não existir retorna `WEB_NOT_BUILT` (503). Gere a UI com `npm --prefix web run build`, sem modificar o lockfile raiz.

- `GET /api/status`: disponibilidade/versionamento FFmpeg/FFprobe e quantidade de jobs ativos.
- `POST /api/projects/analyze`: `{ "inputPath": "/caminho/Projeto.screenstudio", "outputPath": "/caminho/saida" }`; outputPath é opcional, retorna ProjectAnalysis.
- `POST /api/jobs`: `{inputPath,outputPath}` → 202, **CreateJobResponse** (`jobId`, mais o JobSnapshot com `id`). Fila serial de até 10 jobs, resultados em memória, até 50 jobs retidos; reiniciar servidor perde histórico, não apaga exportações.
- `GET /api/jobs/:id`: snapshot, resultado ou erro.
- `GET /api/jobs/:id/events`: SSE **event: message**; todos os dados no formato ProgressEvent. Replay dos últimos 128 eventos por `Last-Event-ID`, heartbeat a cada 15 s, terminal fecha o stream. Fechar o EventSource ao receber estado terminal.
- `POST /api/jobs/:id/cancel`: idempotente, 202. SIGTERM, fallback SIGKILL em 5 s; estado `cancelled` é publicado só após fechamento do processo e limpeza. Cancelamento é best-effort até a publicação atômica; não remove exportação já concluída.
- `POST /api/jobs/:id/open-output`: somente o path de um resultado concluído; sem path vindo do cliente.
- `POST /api/system/pick-input`: `{kind:"folder"|"zip"}` abre seletor nativo local, retorna `{inputPath:string|null}`. Sem diálogo disponível, a UI pode usar path absoluto manual.

API exige paths absolutos. Erros: `{error:{code,message}}`. Proteção Host/Origin + Sec-Fetch-Site bloqueia acesso por páginas remotas/DNS rebinding. Não há CORS permissivo. Vite deve usar proxy local com Origin reescrita para target, ou testar o build servido pelo backend.

**Upload é opcional; preferir seletor nativo/path para não duplicar GBs.** Se necessário para um browser sem acesso ao path, `analyze` aceita multipart por streaming no próprio host: cada campo `path` relativo deve preceder sua parte `file`; `outputPath` opcional. Um ZIP ou arquivos de uma pasta, jamais ambos. Temp TTL de 1 h para uploads não utilizados; leases impedem limpeza durante jobs, e os dados são removidos ao terminar/cancelar. Todos os limites/proteções de path são mantidos. Nada sai do host.
