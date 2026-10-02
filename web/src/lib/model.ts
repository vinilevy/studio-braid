import type { ApiError, ProgressEvent, TrackKind } from './types'

export const TRACKS: {
  kind: TrackKind
  label: string
  file: string
  detail: string
  action: string
}[] = [
  {
    kind: 'display',
    label: 'Tela',
    file: 'SCREEN.mp4',
    detail: 'H.264 · frames preservados',
    action: 'Reconstruindo tela',
  },
  {
    kind: 'webcam',
    label: 'Câmera',
    file: 'CAMERA.mp4',
    detail: 'H.264 · compatível com DaVinci',
    action: 'Reconstruindo câmera',
  },
  {
    kind: 'microphone',
    label: 'Microfone',
    file: 'MICROPHONE.wav',
    detail: 'WAV PCM · 24-bit / 48 kHz',
    action: 'Preparando microfone',
  },
  {
    kind: 'systemAudio',
    label: 'Áudio do sistema',
    file: 'SYSTEM_AUDIO.wav',
    detail: 'WAV PCM · 24-bit / 48 kHz',
    action: 'Preparando áudio do sistema',
  },
]

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

// Millisecond precision rounds the reported value, never normalizes different tracks.
export function formatPreciseDuration(ms: number): string {
  const rounded = Math.max(0, Math.round(ms))
  return `${formatDuration(rounded)}.${String(rounded % 1000).padStart(3, '0')}`
}

export function friendlyProgress(event: ProgressEvent | null): string {
  if (!event) return 'Iniciando a preparação do projeto…'
  const track = TRACKS.find((source) => source.kind === event.currentTrack)
  const channel = track
    ? {
        display: 'da tela',
        webcam: 'da câmera',
        microphone: 'do microfone',
        systemAudio: 'do áudio do sistema',
      }[track.kind]
    : null
  switch (event.stage) {
    case 'queued':
      return 'Aguardando a vez deste projeto no serviço local…'
    case 'analyze':
      return 'Conferindo o projeto e todas as sessões gravadas…'
    case 'reconstruct':
      return track ? `${track.action}…` : 'Reconstruindo as sessões da gravação…'
    case 'concat':
      return track
        ? `Reunindo as sessões ${channel} sem as pausas da gravação…`
        : 'Reunindo as sessões sem as pausas da gravação…'
    case 'validate':
      return track
        ? `Conferindo a duração e a integridade ${channel}…`
        : 'Conferindo a duração, os canais e o sincronismo da gravação…'
    case 'fcpxml':
      return 'Preparando a timeline para o DaVinci Resolve e o relatório final…'
    case 'cancelling':
      return 'Interrompendo o processamento e removendo os arquivos temporários com segurança…'
    case 'cancelled':
      return 'Preparação cancelada. Seus arquivos originais estão intactos.'
    case 'failed':
      return 'Não foi possível concluir a preparação. Confira o diagnóstico.'
    case 'complete':
      return 'Mídias e timeline prontas. Verificação concluída.'
    default:
      return 'Preparando o projeto nesta máquina…'
  }
}

export function formatFrameRate(value: string | undefined): string | null {
  if (!value) return null
  const parts = value.split('/').map(Number)
  const rate = parts.length === 2 ? parts[0] / parts[1] : parts[0]
  return parts.length <= 2 && Number.isFinite(rate) && rate > 0
    ? rate.toLocaleString('pt-BR', { maximumFractionDigits: 2 })
    : null
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Não informado'
  if (bytes < 1024 ** 3)
    return `${(bytes / 1024 ** 2).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
  return `${(bytes / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`
}

export function cleanPath(value: string): string {
  let path = value.trim().replace(/^(["'])(.*)\1$/, '$2')
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path)
      path = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1).replace(/\//g, '\\')
      else if (url.hostname && url.hostname !== 'localhost')
        path = `\\\\${url.hostname}${path.replace(/\//g, '\\')}`
    } catch {
      /* The validation below explains malformed paths to the user. */
    }
  }
  return path
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path)
}

export function inputPathError(path: string): string | null {
  if (!path) return 'Cole o caminho do seu projeto para continuar.'
  if (/[\r\n\0]/.test(path)) return 'Informe apenas um caminho local por vez.'
  if (!isAbsolutePath(path))
    return 'Informe o caminho completo, começando por / no Mac ou C:\\ no Windows.'
  if (!/\.screenstudio(?:\.zip)?[\\/]?$/i.test(path))
    return 'Selecione um pacote .screenstudio ou um arquivo .screenstudio.zip.'
  return null
}

export function parseProgress(raw: string): ProgressEvent | null {
  try {
    const event: unknown = JSON.parse(raw)
    if (!event || typeof event !== 'object') return null
    const value = event as ProgressEvent
    if (
      typeof value.stage !== 'string' ||
      typeof value.percent !== 'number' ||
      !Number.isFinite(value.percent) ||
      typeof value.currentTrack !== 'string' ||
      typeof value.message !== 'string'
    )
      return null
    return { ...value, percent: Math.min(100, Math.max(0, value.percent)) }
  } catch {
    return null
  }
}

export function progressStep(event: ProgressEvent | null): number {
  if (!event) return -1
  if (event.stage === 'complete' || event.state === 'completed') return 5
  if (event.stage === 'fcpxml' || event.currentTrack === 'fcpxml') return 4
  return TRACKS.findIndex((track) => track.kind === event.currentTrack)
}

export function friendlyError(error: ApiError): string {
  const code = error.code.toUpperCase()
  if (/CONNECTION|NETWORK|HTTP_502|HTTP_503/.test(code))
    return 'Não conseguimos conversar com o serviço local. Abra o Screen Studio Bridge nesta máquina e tente novamente.'
  if (/INVALID_BUNDLE|INVALID_METADATA|MISSING_METADATA/.test(code))
    return 'Este projeto está incompleto ou contém dados de gravação inválidos. Selecione o pacote original completo do Screen Studio, incluindo suas sessões.'
  if (/OUTPUT_IN_INPUT/.test(code))
    return 'Escolha uma pasta de saída fora do projeto original. Isso protege sua gravação durante a exportação.'
  if (/OUTPUT_BUSY|ANALYSIS_BUSY/.test(code))
    return 'Outra operação está usando este projeto ou destino. Aguarde a preparação atual terminar ou escolha outra pasta de saída.'
  if (/ZIP_ENCRYPTED/.test(code))
    return 'Este ZIP está protegido por senha. Selecione uma cópia sem senha ou o pacote original do Screen Studio.'
  if (/INVALID_ZIP|ZIP_LIMIT|ZIP_DUPLICATE|ZIP_SYMLINK|ZIP_SLIP/.test(code))
    return 'Não foi possível abrir este arquivo compactado com segurança. Extraia o projeto nesta máquina e selecione o pacote .screenstudio completo.'
  if (/SPACE|DISK_FULL|ENOSPC/.test(code))
    return 'Não há espaço suficiente no destino. Libere espaço ou escolha outra pasta para exportar.'
  if (/FFMPEG|FFPROBE|TOOL_MISSING/.test(code))
    return 'Uma ferramenta de vídeo necessária não está disponível. Confira a instalação do FFmpeg e do FFprobe.'
  if (/NOT_FOUND|ENOENT|INVALID_INPUT|INVALID_PATH/.test(code))
    return 'Não encontramos um projeto válido nesse caminho. Confira o caminho completo e se o arquivo está nesta máquina.'
  if (/OUTPUT.*EXIST|OUTPUT_NOT_EMPTY|DESTINATION/.test(code))
    return 'A pasta de saída precisa estar vazia. Escolha uma nova pasta para proteger seus arquivos existentes.'
  if (/SYNC|DEVIATION|DRIFT/.test(code))
    return 'O projeto não passou na verificação de sincronismo. A exportação não foi aprovada; consulte os detalhes técnicos.'
  return 'Não foi possível concluir esta etapa. Seus arquivos de origem não foram alterados. Confira os detalhes e tente novamente.'
}

export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value)
  throw new Error(
    'O navegador não liberou a área de transferência. Selecione e copie o caminho manualmente.',
  )
}
