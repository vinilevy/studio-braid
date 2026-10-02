# Teste rápido no DaVinci Resolve — Screen Studio Bridge

Este kit confirma no Resolve 4 coisas que nenhum teste automático consegue provar:

1. O FCPXML encontra as mídias pelos **caminhos relativos** (`../01_MEDIA/...`).
2. A tela gravada com **taxa de quadros variável (VFR)** não encolhe, não acelera e termina junto com o áudio.
3. A câmera (25 fps, com o tempo real de cada quadro preservado) não deriva.
4. As 4 faixas entram como **V1 Tela, V2 Câmera, A1 Microfone, A2 Áudio do sistema**, alinhadas.

O projeto é sintético (3 sessões, 15.235 s): fundo escuro com **flashes brancos** na tela e na câmera e **bipes** no microfone (grave) e no áudio do sistema (agudo), sempre no MESMO instante.

## Passos

1. Extraia o ZIP numa pasta local (ex.: `C:\Bridge-Teste\`). Não mova nada de dentro da pasta `SSB-Smoke-Mock3`.
2. Abra o DaVinci Resolve e anote a versão (Help → About / Ajuda → Sobre).
3. Crie um projeto novo vazio.
4. **File → Import → Timeline…** (Ctrl+Shift+I) e escolha `SSB-Smoke-Mock3\02_DAVINCI\SSB-Smoke-Mock3.fcpxml`.
   Deixe marcado "Automatically import source clips into media pool". Se o Resolve perguntar sobre a taxa de quadros, use **60 fps**.

## O que conferir (responda Sim/Não e anote valores)

- **A. Mídia online:** nenhum clipe vermelho/"Media Offline". Se aparecer offline: clique direito → Relink Clips → aponte para `SSB-Smoke-Mock3\01_MEDIA` e anote **"caminho relativo falhou"**.
- **B. Faixas:** V1 = SCREEN.mp4 · V2 = CAMERA.mp4 · A1 = MICROPHONE.wav · A2 = SYSTEM_AUDIO.wav.
- **C. Duração:** os 4 clipes começam em 00:00:00:00 e terminam juntos (~15.235 s). No Media Pool, anote as colunas **Duration** e **FPS** de SCREEN.mp4 e CAMERA.mp4.
- **D. Sincronismo quadro a quadro:** pare nos tempos abaixo (setas ← → andam 1 quadro) e confira se o flash da tela, o flash da câmera e os bipes nas ondas de A1/A2 começam no mesmo quadro. Desligue V2 (ícone de olho) para ver o V1.

| Timecode (60 fps) | Segundos | Sessão | Esperado |
|---|---|---|---|
| 00:00:00:24 | 0.400 s | sessão 1 | 1 flash(es)/bipe(s) — início da sessão |
| 00:00:04:24 | 4.400 s | sessão 1 | 1 flash/bipe — fim da sessão |
| 00:00:05:26 | 5.434 s | sessão 2 | 2 flash(es)/bipe(s) — início da sessão |
| 00:00:08:38 | 8.634 s | sessão 2 | 1 flash/bipe — fim da sessão |
| 00:00:09:39 | 9.646 s | sessão 3 | 3 flash(es)/bipe(s) — início da sessão |
| 00:00:14:27 | 14.446 s | sessão 3 | 1 flash/bipe — fim da sessão |

- **E. Reprodução contínua:** dê play do início ao fim. Flash e bipe devem soar/aparecer juntos até o final; a imagem da tela não pode acelerar nem acabar antes do áudio.
- **F. Clip Attributes:** clique direito em SCREEN.mp4 → Clip Attributes → anote o **Video Frame Rate** que o Resolve atribuiu. Repita para CAMERA.mp4.

## Enviar para o Levi

Versão do Resolve, respostas A–F e um print da timeline com as 4 faixas visíveis.

Se tudo passar, o próximo passo é repetir com a exportação real de 35 min (`validation/exports/real-seven-sessions-v2`, ~1,9 GB), conferindo D e E em três pontos (início, meio e fim) com um evento visível e audível (palma, início de fala).
