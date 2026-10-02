# QA — Screen Studio Bridge (IA 2)

Auditoria independente e adversária das saídas da IA 1. Pacote standalone: tem `package.json` e lockfile próprios, não toca no lock da raiz e **nunca importa código de runtime do motor** (só `import type` de `packages/core/src/types/index.ts`). O oráculo é sempre o `recording/metadata.json` original, lido por um parser próprio (`lib/screenstudio.ts`).

```sh
npm --prefix tests install
npm --prefix tests run verify      # regressão: 8 mocks → CLI → verify-export + verify-fcpxml
npm --prefix tests run verify -- --http http://127.0.0.1:3847 --job-json '{"renderOptions":{...}}'   # caminho da UI: analyze → POST /api/jobs com opções → poll
npm --prefix tests run verify -- --cli-args "--flag valor"   # repassa flags à CLI, se existirem
npm --prefix tests run selftest    # o auditor contra si mesmo: base limpa + 21 sabotagens
npx --prefix tests tsx tests/verify-export.ts "<saida> - DaVinci" --source "<projeto>.screenstudio|.zip" [--json r.json] [--strict]
npx --prefix tests tsx tests/verify-fcpxml.ts "<saida> - DaVinci" [--dtd FCPXMLv1_10.dtd] [--json r.json]
npx --prefix tests tsx tests/create-mock-bundle.ts --sessions 1,3,5 [--layout ss37] [--zip] [--no-webcam] [--no-system-audio]
npx --prefix tests tsx tests/make-davinci-kit.ts   # kit de smoke test manual no Resolve/Windows
```

Código de saída: `0` aprovado (com ou sem ressalvas), `1` reprovado, `2` erro de uso. `--strict` transforma alertas em falhas.

## O que cada ferramenta prova

| Ferramenta | Prova |
|---|---|
| `verify-export.ts` | Cobertura ≥ 90% (senão: **sessões ignoradas**, com a lista das que faltam e seus horários); cada faixa = Σ `durationMs` ±100 ms; desvio entre faixas ≤ 100 ms; CAMERA H.264 High 8-bit yuv420p; para tela e câmera: aspecto igual ao da fonte (`videoSize` / `bounds × recordingScale`; barras de letterbox/pillarbox aceitas via `cropdetect`), dimensões pares, SAR 1:1, resolução coerente com `manifest.videoSettings` (`native`, `1080p`, `4k` em canvas exato), CRF declarado igual ao gravado no SEI do x264 e, no remux, pacotes idênticos à fonte (só keyframes podem crescer pelo SPS/PPS em banda); WAV PCM 48 kHz; início em t=0; frames da fonte vs. saída **quadro a quadro** (preservados, duplicados ou perdidos, e o deslocamento de cada sessão); posição de cada sessão de áudio por **correlação com a fonte** (resolução de 0,125 ms, sem marcadores); drift acumulado por sessão; coerência do `sync_report.json`/`project_manifest.json` com o ffprobe; layout do SPEC §4; nos mocks, flashes/bipes nos mesmos instantes em todas as faixas. |
| `verify-fcpxml.ts` | XML bem-formado e versão; ids/refs; cada `<media-rep src>` (1.9+) ou `<asset src>` resolvido e existente; V1=SCREEN no spine, V2=CAMERA lane 1, A1=MICROPHONE lane −1, A2=SYSTEM_AUDIO lane −2; clipes alinhados no início; durações vs. ffprobe; grade de frames da sequência; nomes em NFC/sem mojibake; DTD opcional via `xmllint`. |
| `create-mock-bundle.ts` | Projetos sintéticos com 1/3/5 sessões que reproduzem as armadilhas medidas nos projetos reais (abaixo) e um gabarito `<bundle>.truth.json` com o instante de cada marcador. |
| `selftest/run-selftest.ts` | A exportação base precisa passar sem FAIL (ausência de falso positivo) e cada sabotagem precisa gerar o FAIL esperado (ausência de ponto cego): só a 1ª sessão, relatório mentiroso, concatenação ingênua, pausas incluídas, câmera atrasada 233 ms, sessão órfã, HEVC, câmera esticada, câmera 10-bit, tela recomprimida declarada como remux, CRF mentido no manifest, 44,1 kHz, faixas trocadas, faixa ausente, mojibake e 7 defeitos de FCPXML. |

## Armadilhas do formato real (medidas com ffprobe e `polyrecorder.log`)

- `recorders` é **array** com `type`; `cursor` e `input` não são mídia.
- SS 4.0 (`polyrecorder 2.7.0+ss.5`): vídeo só em HLS fMP4; SS 3.7 (`2.7.0`): `.mp4` consolidado + HLS. Áudio sempre `.m4a` (+ HLS).
- Sessões órfãs no disco (init + 1 segmento, sem playlist) que **não** estão no metadata.
- PTS do vídeo no relógio do host (≈24539 s), sem edit list no init segment.
- Câmera com B-frames: 1º keyframe com `dts` = início da sessão e `pts` +81,7 ms (HEVC) / +233 ms (H.264). O `.mp4` consolidado do SS 3.7 tem edit list removendo exatamente esse atraso → o 1º frame pertence ao início da sessão.
- Pedaços por sessão não têm `durationMs`: áudio −168 a +105 ms, câmera ~+40 ms, tela +1 a +15 ms. Sem aparar/preencher por sessão, o drift acumula.
- Tela VFR (média 10,8 fps num contêiner de 60 nominal no projeto de 35 min).
- ZIP do Finder: UTF-8 **sem** flag (nome NFD vira `co╠üpia` em leitor que segue a spec), `__MACOSX/._*` espelhando tudo (inclusive `._metadata.json`), data descriptors e ZIP64 (16,8 GB).
- Projeto sem `recording/metadata.json` existe (gravação incompleta).

## Evidências desta rodada (2026-10-01)

- Projeto real de 7 sessões (34:58.202), v2 da IA 1: `output/real7-v2-verify-export.json`, `output/real7-v2-verify-fcpxml.json` — tela 100% dos frames na posição exata, microfone ±0,0 ms por sessão.
- Regressão de mocks: `output/regression/*.verify-*.json` (7/7 sem FAIL).
- E2E da interface servida pela IA 1: `output/e2e/` (inclui exportação 1080p/high escolhida nos seletores da UI).
- Presets (2026-10-01): CLI no padrão 4k/maximum 8/8; HTTP native/fast 8/8, 1080p/high 3/3, tela 4k 2/2 — `output/regression*/`. Qualidade confirmada no SEI: maximum = slow/CRF 14, high = medium/CRF 17, fast = veryfast/CRF 18.
- Custo medido da câmera (Apple M5, webcam real 720p, projetado para 35 min): 4k/maximum ≈ 86 min e 3,15 GB (0,40× tempo real); 1080p/high ≈ 13 min e 0,79 GB; native/maximum ≈ 9,5 min e 0,56 GB; native/fast ≈ 2,5 min e 0,34 GB.

Limites conhecidos: VFR, URLs relativas e grade de frames do FCPXML só se provam no Resolve real (`validation/davinci-smoke-kit.zip`); o sincronismo perceptual em projeto real é inferido por correlação com a fonte, não por marcadores.
