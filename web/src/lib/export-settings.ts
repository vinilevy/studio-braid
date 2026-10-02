import type { CameraResolution, RenderOptions, RenderQuality } from './types'

export const CAMERA_RESOLUTION_OPTIONS = [
  {
    value: '4k',
    label: '4K Ultra HD (3840x2160) — Upscale Master',
    description: 'Master em 4K Ultra HD. O upscale não cria detalhes ausentes na gravação.',
  },
  {
    value: 'native',
    label: 'Resolução Nativa da Gravação',
    description: 'Mantém as dimensões originais da câmera, sem upscale.',
  },
  {
    value: '1080p',
    label: '1080p Full HD',
    description: 'Saída de câmera em Full HD (1920x1080).',
  },
] as const satisfies readonly { value: CameraResolution; label: string; description: string }[]

export const QUALITY_OPTIONS = [
  {
    value: 'maximum',
    label: 'Qualidade Máxima / Studio (CRF 14 - Recomendado)',
    description: 'CRF 14 · Perfil Studio recomendado para preservar a qualidade de imagem.',
  },
  {
    value: 'high',
    label: 'Alta Qualidade (CRF 17)',
    description: 'CRF 17 · Equilíbrio entre qualidade de imagem e tamanho da exportação.',
  },
  {
    value: 'fast',
    label: 'Exportação Rápida',
    description: 'Prioriza uma preparação mais rápida para começar a editar.',
  },
] as const satisfies readonly { value: RenderQuality; label: string; description: string }[]

export type { CameraResolution }
export type ImageQuality = RenderQuality
export type ExportSettings = Required<Pick<RenderOptions, 'cameraResolution' | 'quality'>>

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  cameraResolution: '4k',
  quality: 'maximum',
}
