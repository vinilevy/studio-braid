# Screen Studio Bridge — Especificação Técnica Oficial

## 1. Contexto & Formato Físico do Screen Studio
O Screen Studio (v3.7+, `polyrecorder 2.7.0`) grava seus dados em um diretório/pacote `.screenstudio`:
- `meta.json`: Metadados gerais da gravação.
- `project.json`: Timeline de edição do Screen Studio (slices, zooms).
- `recording/`: Contém os dados brutos gravados.

### Estrutura de `recording/metadata.json`
O arquivo `metadata.json` contém a lista de `recorders`:
- `type: "display"` (Gravação da tela)
- `type: "webcam"` (Câmera)
- `type: "microphone"` (Microfone)
- `type: "systemAudio"` (Áudio do sistema operacional)
- `type: "cursor"` e `type: "input"` (Telemetria do mouse e cliques)

Cada `recorder` possui um array `sessions[]`:
```json
{
  "durationMs": 186102.2,
  "processTimeStartMs": 4712.49,
  "processTimeEndMs": 190814.69,
  "unixStartMs": 1790894155407.0,
  "unixEndMs": 1790894341509.2,
  "outputFilename": "channel-2-display-0.m3u8"
}
```

---

## 2. Requisito Crítico: Múltiplas Sessões (Anti-Bug de 4 minutos)
Quando o usuário grava e realiza pausas (ou quando o sistema fragmenta a gravação), o Screen Studio gera múltiplas sessões sequenciais:
- Exemplo real verificado: um projeto de ~35 minutos contém **7 sessões** (`sessions[0]` a `sessions[6]`).
- A Sessão 0 possui apenas ~3 minutos (`channel-2-display-0.m3u8`).
- As Sessões 1 a 6 possuem o restante do conteúdo.
- **REGRA INVIOLÁVEL:** O motor NUNCA pode ler apenas o primeiro arquivo. Ele DEVE iterar por todo o array `sessions` de cada canal e concatenar todas as sessões.

---

## 3. Mídias e Codecs Observados
1. **Display (Tela):**
   - Codec: H.264
   - Resolução: Nativa do monitor (ex: 2560x1410)
   - FPS: 60 fps
   - Formato original: HLS playlist (`.m3u8`) com fMP4 (`-0000.mp4` init e `.m4s` fragments).
2. **Webcam (Câmera):**
   - Codec: HEVC / H.265
   - FPS: 25 fps
   - **Atenção Windows / DaVinci Resolve Free:** DaVinci Resolve Free no Windows frequentemente falha ao decodificar HEVC sem pacotes pagos da Microsoft Store.
   - **SOLUÇÃO OBRIGATÓRIA:** Transcodificar a Câmera para **H.264 High Profile MP4** (`-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p`).
3. **Áudios (Microfone e Sistema):**
   - Formato original: `.m4a` ou `.m3u8`
   - **SOLUÇÃO OBRIGATÓRIA:** Exportar como **WAV PCM 48kHz 24-bit (ou 16-bit)** (`-c:a pcm_s24le -ar 48000`).

---

## 4. Estrutura de Saída da Pasta Exportada
```text
[Nome do Projeto] - DaVinci/
├── 01_MEDIA/
│   ├── SCREEN.mp4
│   ├── CAMERA.mp4
│   ├── MICROPHONE.wav
│   └── SYSTEM_AUDIO.wav
├── 02_DAVINCI/
│   └── [Nome do Projeto].fcpxml
├── 03_DATA/
│   ├── project_manifest.json
│   └── sync_report.json
└── logs/
    └── export.log
```

---

## 5. Estrutura do FCPXML (DaVinci Resolve)
O arquivo FCPXML (versão 1.9 ou 1.10) organiza as 4 mídias sincronizadas:
- **V1 (Vídeo 1):** `SCREEN.mp4`
- **V2 (Vídeo 2):** `CAMERA.mp4`
- **A1 (Áudio 1):** `MICROPHONE.wav`
- **A2 (Áudio 2):** `SYSTEM_AUDIO.wav`

---

## 6. Critérios de Tolerância do SyncValidator
Após a geração dos arquivos com FFmpeg, executar `ffprobe` nas 4 mídias:
- `maxDeviationMs <= 100ms`: **STATUS OK** (lip-sync perfeito).
- `100ms < maxDeviationMs <= 400ms`: **STATUS WARNING** (aceitável com ressalvas).
- `maxDeviationMs > 400ms`: **STATUS ERROR** (investigação necessária).
