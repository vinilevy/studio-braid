# Screen Studio Bridge · Web local

Interface standalone em React 19, TypeScript estrito, Vite, Tailwind CSS 4 e Lucide. Não altera o motor nem seus contratos. Os imports de `packages/core/src/types/index.ts` são **type-only**: nenhum código Node é incluído no navegador.

## Instalar e compilar

```sh
cd web
npm ci
npm run build
npm test
```

`npm run build` verifica TypeScript antes de gerar `web/dist/`. O Fastify serve esta pasta em **http://127.0.0.1:3847**; ele deve estar rodando na máquina de quem usa a interface. Não existe serviço de nuvem, CDN ou analytics. Fontes e ícones estão no build local.

## Desenvolver

```sh
# Backend da IA 1 rodando em 3847; em outro terminal:
cd web
npm run dev
```

Vite abre em `127.0.0.1:5173`, exclusivamente loopback. `/api` usa proxy para `127.0.0.1:3847`; Host/Origin são normalizados para respeitar o bloqueio de acesso cross-site do servidor. A porta **3847 continua pertencendo ao Fastify**. `npm run preview` é apenas uma prévia estática em 4173, sem API: para testar o fluxo completo, use o build servido pelo Fastify ou o dev com proxy.

## Contratos consumidos

| Operação              | Endpoint                         | Observação                                                                          |
| --------------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| Status                | `GET /api/status`                | Atualização a cada 10 s; disponibilidade real dos dois binários                     |
| Análise               | `POST /api/projects/analyze`     | JSON `{ inputPath, outputPath?, cameraResolution, quality }`                        |
| Criar job             | `POST /api/jobs`                 | JSON `{ inputPath, outputPath, cameraResolution, quality }`; aceita `jobId` ou `id` |
| Progresso             | `GET /api/jobs/:id/events`       | SSE `event: message`, com `ProgressEvent`                                           |
| Recuperar estado      | `GET /api/jobs/:id`              | Snapshot inicial, em reconexão e a cada 10 s                                        |
| Cancelar              | `POST /api/jobs/:id/cancel`      | Confirmação antes da chamada; aguarda estado terminal                               |
| Selecionar localmente | `POST /api/system/pick-input`    | JSON `{ kind: 'folder' \| 'zip' }` → `{ inputPath: string \| null }`                |
| Abrir saída           | `POST /api/jobs/:id/open-output` | JSON `{}`; apenas o job concluído                                                   |

Erros do servidor podem vir em `{ error: { code, message } }`. A interface preserva código e mensagem em detalhes técnicos, com explicação amigável em português.

## Perfis de exportação

Na tela pós-análise, **4K Upscale Master + Qualidade Máxima / Studio (CRF 14)** estão selecionados por padrão. Os seletores usam os tipos compartilhados do motor, sem alterar contratos em `packages/`.

| Controle            | Opção                                            | Valor enviado à API               |
| ------------------- | ------------------------------------------------ | --------------------------------- |
| Resolução da câmera | 4K Ultra HD (3840x2160) — Upscale Master         | `cameraResolution: '4k'` (padrão) |
| Resolução da câmera | Resolução Nativa da Gravação                     | `cameraResolution: 'native'`      |
| Resolução da câmera | 1080p Full HD                                    | `cameraResolution: '1080p'`       |
| Qualidade de imagem | Qualidade Máxima / Studio (CRF 14 - Recomendado) | `quality: 'maximum'` (padrão)     |
| Qualidade de imagem | Alta Qualidade (CRF 17)                          | `quality: 'high'`                 |
| Qualidade de imagem | Exportação Rápida                                | `quality: 'fast'`                 |

Os mesmos valores são enviados na análise e na criação do job. Alterar resolução ou qualidade invalida a estimativa anterior: **Atualizar estimativa** consulta novamente a API e libera a preparação apenas após a checagem do perfil selecionado. A UI exibe `diskSpace.estimatedRequiredBytes` e `availableBytes` retornados, sem multiplicadores próprios, valores fixos ou teto artificial de 6 GB. A estimativa depende da duração, das fontes e do perfil; não é o tamanho final medido da exportação.

O upscale aumenta as dimensões, mas **não cria detalhes ausentes na gravação**. Sem câmera gravada, o seletor não fabrica uma faixa. A tela continua na resolução nativa: `screenResolution` não é enviado nesta interface. Novo Projeto restaura os padrões 4K/Studio; verificar novamente o destino preserva as escolhas atuais.

## Decisões que protegem os arquivos

- **Nenhum upload:** não usamos multipart, `FileReader`, leitura de conteúdo, nem cópia de vídeo. Só JSON com caminhos. Picker abre diálogo nativo no servidor local.
- Navegadores comuns **não expõem o caminho absoluto** de arquivos arrastados. O drop aceita caminhos textuais/URI `file://` ou um `File.path` fornecido por um host nativo. Caso só o nome esteja disponível, a UI solicita seletor nativo ou caminho manual; nunca envia `C:\fakepath` nem tenta adivinhar uma pasta.
- Mac: copiar caminho com ⌥⌘C no Finder. Windows: “Copiar como caminho”; aspas são removidas. Se o projeto veio de outro computador, selecione a cópia **nesta máquina**.
- Alterar a saída ou o perfil invalida a checagem de disco anterior; exige nova análise antes de exportar. `sufficient: false` bloqueia exportação; `null` é “Espaço não verificado”, não sucesso nem insuficiência.
- Faixas ausentes aparecem como “Não gravado”; sucesso lista somente `manifest.media`. Não fabricamos câmera/áudio ou quatro resultados quando faltam fontes.
- `ProjectAnalysis` não informa resolução/FPS. A UI explica que serão verificados na exportação; valores reais de `MediaProbe` aparecem no resultado quando disponíveis.
- “Sincronismo validado” considera status do relatório e o maior desvio entre metadata/canais. A validação é **temporal e de integridade de frames**, não certificação perceptual de fala/ação. Não exibimos a promessa “Sincronismo Perfeito”.
- SSE fecha nos estados terminais/desmontagem. Reconexão não significa job falhou. Snapshots recuperam o final perdido; replay e consultas atrasadas não fazem o progresso retroceder.
- Saídas existentes não são sobrescritas pelo motor. A UI informa que o destino precisa ser uma pasta nova ou vazia.

## Precisão e diagnóstico da interface

Na conclusão, as durações vêm diretamente de `manifest.media[].durationMs` e aparecem como **HH:MM:SS.mmm** (arredondadas a 1 ms), sem forçar valores diferentes a parecerem iguais. O tooltip preserva o valor do relatório em milissegundos. Na análise/processamento, HH:MM:SS mantém leitura rápida.

A legenda principal de processamento traduz `stage` para português claro. A mensagem original e identificadores da etapa continuam disponíveis em “Ver diagnóstico desta etapa”, sem perda de informação técnica.

QA independente da IA 2 aprovou a interface base e, posteriormente, **o E2E dos novos seletores** no build `index-DD5UOrbO.js`: defaults, atualização obrigatória da estimativa e payloads confirmados. A mídia gerada pela UI em 1080p/high teve resolução/CRF/preset coerentes, tela remux preservada e flash/bip ≤11,2 ms. Os perfis têm **148 testes frontend passando**, incluindo os valores enviados à API, defaults, atualização da estimativa, bloqueio por disco insuficiente e reset; o build TypeScript/Vite passa. **Arrastar-e-soltar real e os diálogos nativos ainda exigem checagem manual**; importação no DaVinci/Windows não foi validada neste Mac.

**Custo de processamento:** 4K/Studio mantém o padrão definido pelo usuário, mas pode levar significativamente mais tempo. A IA 2 mediu cerca de 0,40× tempo real ao codificar **somente 60 segundos de webcam real 720p no Apple M5**, projetando linearmente ~86 minutos só de câmera para 35 minutos de gravação. Não foi exportação completa do REAL7 nem medição no Windows; não é ETA universal. Um aviso de custo na UI e eventual revisão do rótulo “Recomendado” são decisões de produto em aberto, não correções de bug.

## Estrutura

- `src/lib/types.ts`: referência somente leitura ao contrato compartilhado.
- `src/lib/api.ts`: cliente JSON, envelopes de erro e compatibilidade de resposta.
- `src/hooks/useBridge.ts`: fluxo, estado local, status, SSE e reconciliação.
- `src/components/`: entrada, análise, processamento, resultado, erro e primitivas acessíveis.
- `src/lib/model.ts`: caminhos, formatação, parsing e mensagens.
- `src/lib/export-settings.ts`: opções e padrões tipados de resolução/qualidade.
- `src/__tests__/`: testes frontend isolados. Não usam APIs reais nem alteram fontes do motor.

## Direção visual e acessibilidade

**Bancada de edição · DFII 14/15.** Grafite com verde-lima, enquadramento de cantos na dropzone e timeline vertical de quatro canais; composição calma inspirada na densidade útil de editores profissionais, sem dashboard genérico. Space Grotesk estrutura títulos; Manrope mantém legibilidade; JetBrains Mono diferencia caminhos, timestamps e métricas. Todas são auto-hospedadas.

Espaçamento base 4/8 px, painéis de borda fina, hover discreto, avanço de barra com percentual real. Animações respeitam `prefers-reduced-motion`. Diálogos nativos têm nome acessível e Escape/foco; as transições levam foco ao título. Inputs têm rótulos, progresso usa ARIA, e estados desconhecidos não são apresentados como êxito.

## Fontes técnicas

- [Vite: build e outDir](https://vite.dev/config/build-options.html)
- [Vite: proxy de desenvolvimento](https://vite.dev/config/server-options)
- [Tailwind: integração oficial com Vite](https://tailwindcss.com/docs/installation/using-vite)
- [HTML Standard: seletor de arquivos e fakepath](<https://html.spec.whatwg.org/multipage/input.html#file-upload-state-(type=file)>)
- [MDN: eventos e reconexão SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
