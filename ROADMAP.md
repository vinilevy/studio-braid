# Roadmap de Desenvolvimento & Critérios de Aceite (Tracer)

> **Regra Suprema para os Agentes:**  
> Nenhuma IA avança para a fase seguinte sem que a fase anterior esteja **testada, validada e aprovada com script de teste real**.

---

## 🛑 FASE 1: O Motor & Prova Funcional via CLI (Seção 90)
*Status: EM ANDAMENTO*

### Responsabilidade da IA 1 (Backend/Engine)
- [ ] Ler `SPEC.md`.
- [ ] Implementar parser de `recording/metadata.json` em `packages/core`.
- [ ] Implementar concatenação de todas as sessões HLS fMP4 para:
  - `SCREEN.mp4` (H.264 60fps)
  - `CAMERA.mp4` (Transcodificado para H.264 25fps)
  - `MICROPHONE.wav` (PCM 48kHz)
  - `SYSTEM_AUDIO.wav` (PCM 48kHz)
- [ ] Criar CLI executável em `packages/cli` para rodar via terminal:
  `npm run cli -- --input "<caminho_screenstudio>" --output "<caminho_saida>"`

### Responsabilidade da IA 2 (QA / Tester)
- [ ] Criar script de auditoria `tests/verify-export.ts` que executa `ffprobe` nas 4 saídas geradas pela IA 1.
- [ ] Testar contra um projeto real do Screen Studio com múltiplas sessões.
- [ ] **Critério de Aprovação da Fase 1:**
  - `SCREEN.mp4` tem duração completa (~30-35 min), e **NÃO** apenas 3-4 minutos.
  - O desvio máximo entre as faixas é $\le 100\text{ ms}$.

---

## 🛑 FASE 2: FCPXML & Servidor Local Fastify
*Status: BLOQUEADO (Aguardando aprovação da Fase 1)*

### Responsabilidade da IA 1
- [ ] Implementar gerador de `[Projeto].fcpxml` (v1.9/1.10) para o DaVinci Resolve com as 4 tracks (V1, V2, A1, A2).
- [ ] Implementar servidor Fastify em `127.0.0.1:3847` com endpoints:
  - `GET /api/status`
  - `POST /api/projects/analyze`
  - `POST /api/jobs`
  - `GET /api/jobs/:id/events` (SSE para progresso em tempo real)
  - `POST /api/jobs/:id/cancel`

### Responsabilidade da IA 2
- [ ] Criar validador de XML `tests/verify-fcpxml.ts` (testa conformidade da sintaxe e caminhos relativos/absolutos).
- [ ] Testar importação de mock no DaVinci.

---

## 🛑 FASE 3: Interface Web Local (React + Vite) & Integração Final
*Status: BLOQUEADO (Aguardando aprovação da Fase 2)*

### Responsabilidade da IA 2
- [ ] Desenvolver frontend em `web/` com Vite, React, Tailwind CSS e Lucide Icons.
- [ ] Implementar Drag & Drop para pastas `.screenstudio` e arquivos `.zip`.
- [ ] Conectar ao Server-Sent Events (SSE) para exibir progresso real por canal.
- [ ] Botão "Preparar para DaVinci" e "Abrir Pasta".
- [ ] Rodar `npm run build` gerando `web/dist`.

### Responsabilidade da IA 1
- [ ] Fazer o Fastify servir estaticamente a pasta `web/dist` na porta `3847`.
