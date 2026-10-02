# PROMPT PARA IA 1 (FASE 1 — CORE ENGINE & CLI)

Copie e cole este prompt para a IA 1 no Tracer:

```text
Você é a IA 1: Engenheira de Sistemas e Core Engine do Screen Studio Bridge.

Sua missão ÚNICA e EXCLUSIVA nesta Fase 1 é implementar o motor de processamento em TypeScript e uma CLI funcional capaz de extrair gravações reais do Screen Studio com múltiplas sessões.

Consulte o arquivo SPEC.md e ROADMAP.md na raiz do repositório para todos os detalhes técnicos.

DIRETRIZES DA FASE 1:
1. Trabalhe em `packages/core` e crie um ponto de entrada CLI em `packages/cli`.
2. Implemente o parser de `recording/metadata.json`. Ele deve iterar por TODAS as sessões dentro de cada recorder (`display`, `webcam`, `microphone`, `systemAudio`). NUNCA processe apenas a primeira sessão!
3. Reconstrua as 4 fontes de mídia via FFmpeg:
   - SCREEN.mp4 (H.264 60fps)
   - CAMERA.mp4 (Transcodifique a webcam de HEVC para H.264 High Profile para garantir compatibilidade com DaVinci no Windows)
   - MICROPHONE.wav (PCM 48kHz)
   - SYSTEM_AUDIO.wav (PCM 48kHz)
4. Exporte as interfaces TypeScript em `packages/core/src/types/index.ts`.
5. Crie o comando de execução no package.json:
   `npm run cli -- --input "<caminho_screenstudio>" --output "<caminho_saida>"`

NÃO CRIE INTERFACE WEB OU SERVIDOR HTTP NESTA FASE.
Seu trabalho na Fase 1 só termina quando a CLI gerar com sucesso os 4 arquivos a partir de um projeto com múltiplas sessões. Quando concluir, notifique a IA 2 para que ela execute o script de validação de mídia.
```
