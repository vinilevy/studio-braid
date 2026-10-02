import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { ApiError, ExportResult, ProgressEvent, ProjectAnalysis } from '../lib/types'
import { exportResult, jobSnapshot, jsonResponse, projectAnalysis, serverStatus } from './fixtures'

class UIEventSource {
  static instances: UIEventSource[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = vi.fn()
  constructor(_url: string) {
    UIEventSource.instances.push(this)
  }
  message(event: ProgressEvent) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }))
  }
}

const fetchMock = vi.fn<typeof fetch>()
let analysis: ProjectAnalysis
let analyzeError: ApiError | undefined

beforeEach(() => {
  analysis = projectAnalysis
  analyzeError = undefined
  UIEventSource.instances = []
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input)
    if (path === '/api/status') return jsonResponse(serverStatus)
    if (path === '/api/projects/analyze')
      return analyzeError ? jsonResponse({ error: analyzeError }, 400) : jsonResponse(analysis)
    if (path === '/api/system/pick-input')
      return jsonResponse({ inputPath: projectAnalysis.inputPath })
    if (path === '/api/jobs' && init?.method === 'POST')
      return jsonResponse({ jobId: 'job-123' }, 201)
    if (path === '/api/jobs/job-123') return jsonResponse(jobSnapshot())
    if (path === '/api/jobs/job-123/cancel') return jsonResponse({ state: 'cancelled' })
    if (path === '/api/jobs/job-123/open-output') return new Response(null, { status: 204 })
    throw new Error(`Unexpected mocked endpoint: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', UIEventSource)
})
afterEach(() => vi.unstubAllGlobals())

async function analyzedApp() {
  const user = userEvent.setup()
  render(<App />)
  await user.type(screen.getByLabelText(/^Caminho do projeto/i), projectAnalysis.inputPath)
  await user.click(screen.getByRole('button', { name: /^Analisar$/i }))
  await screen.findByRole('heading', { name: projectAnalysis.name })
  return user
}

async function processingApp() {
  const user = await analyzedApp()
  await user.click(screen.getByRole('button', { name: /preparar para davinci/i }))
  await screen.findByRole('progressbar', { name: /progresso geral/i })
  await waitFor(() => expect(UIEventSource.instances).toHaveLength(1))
  return { user, source: UIEventSource.instances[0]! }
}

async function completedApp(result: ExportResult = exportResult) {
  const { user, source } = await processingApp()
  act(() =>
    source.message({
      stage: 'complete',
      state: 'completed',
      percent: 100,
      currentTrack: 'fcpxml',
      message: 'Concluído',
      result,
    }),
  )
  await screen.findByRole('button', { name: /novo projeto/i })
  return user
}

describe('accessible frontend workflow', () => {
  it('shows project sessions/duration, absent channels and verified disk capacity', async () => {
    await analyzedApp()
    expect(screen.getByText(/sessões detectadas: 7/i)).toBeVisible()
    expect(screen.getAllByText('00:01:15').length).toBeGreaterThan(0)
    const camera = screen.getByRole('heading', { name: 'Câmera' }).closest('article')!
    expect(within(camera).getByText('Não gravado')).toBeVisible()
    expect(screen.getByText('Espaço suficiente')).toBeVisible()
    expect(screen.getByRole('button', { name: /preparar para davinci/i })).toBeEnabled()
  })

  it('distinguishes unknown disk space from insufficient space', async () => {
    analysis = {
      ...projectAnalysis,
      diskSpace: { ...projectAnalysis.diskSpace, availableBytes: null, sufficient: null },
    }
    await analyzedApp()
    expect(screen.getByText('Espaço não verificado')).toBeVisible()
    expect(screen.getByText('Não informado')).toBeVisible()
    expect(screen.queryByText('Espaço insuficiente')).not.toBeInTheDocument()
  })

  it('disables preparation while the destination has unverified changes', async () => {
    const user = await analyzedApp()
    await user.type(screen.getByRole('textbox', { name: /pasta de saída/i }), '-changed')
    expect(screen.getByRole('button', { name: /preparar para davinci/i })).toBeDisabled()
    expect(screen.getByText('Verifique o novo destino')).toBeVisible()
  })

  it('does not upload a browser-dropped File without a readable absolute path', async () => {
    render(<App />)
    const dropzone = screen.getByRole('heading', {
      name: /seu próximo projeto começa aqui/i,
    }).parentElement!
    const dataTransfer = {
      files: [new File(['not-a-video'], 'Projeto.screenstudio.zip')],
      getData: vi.fn(() => ''),
    }
    fireEvent.drop(dropzone, { dataTransfer })
    expect(screen.getByText(/o navegador protege o caminho/i)).toBeVisible()
    expect(screen.getByLabelText(/^Caminho do projeto/i)).toHaveFocus()
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/projects/analyze')).toBe(false)
    expect(fetchMock.mock.calls.some(([, init]) => init?.body instanceof FormData)).toBe(false)
  })

  it('supports file-URI drag data as a local path rather than file content', async () => {
    render(<App />)
    const dropzone = screen.getByRole('heading', {
      name: /seu próximo projeto começa aqui/i,
    }).parentElement!
    const uri = 'file:///Users/Levi/Grava%C3%A7%C3%B5es/Teste.screenstudio'
    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [],
        getData: (type: string) => (type === 'text/uri-list' ? `# Comment\n${uri}` : ''),
      },
    })
    await screen.findByRole('heading', { name: projectAnalysis.name })
    const body = fetchMock.mock.calls.find(([path]) => path === '/api/projects/analyze')?.[1]?.body
    expect(JSON.parse(String(body))).toEqual({
      inputPath: projectAnalysis.inputPath,
      cameraResolution: '4k',
      quality: 'maximum',
    })
  })

  it('opens a labeled native-picker dialog and requests only the chosen picker kind', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /selecionar arquivo ou pasta/i }))
    const dialog = screen.getByRole('dialog', { name: /selecionar arquivo ou pasta/i })
    await user.click(within(dialog).getByRole('button', { name: /projeto compactado/i }))
    await screen.findByRole('heading', { name: projectAnalysis.name })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/pick-input',
      expect.objectContaining({ body: '{"kind":"zip"}' }),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders real SSE progress and requires confirmation before sending cancel', async () => {
    const { user, source } = await processingApp()
    act(() =>
      source.message({
        stage: 'reconstruct',
        percent: 42.5,
        currentTrack: 'microphone',
        message: 'Preparando microfone',
      }),
    )
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42.5')
    await user.click(screen.getByRole('button', { name: /^Cancelar$/i }))
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/cancel'))).toBe(false)
    const dialog = screen.getByRole('dialog', { name: /cancelar a preparação/i })
    await user.click(within(dialog).getByRole('button', { name: /sim, cancelar/i }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/jobs/job-123/cancel',
        expect.objectContaining({ method: 'POST', body: '{}' }),
      ),
    )
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(source.close).toHaveBeenCalled()
  })

  it('shows only generated media and never calls timestamp integrity perfect lip-sync', async () => {
    await completedApp()
    expect(screen.getByText('Sincronismo validado')).toBeVisible()
    expect(screen.getByText(/13,12 ms/i)).toBeVisible()
    expect(screen.getByText(/não substitui a revisão perceptual/i)).toBeVisible()
    expect(screen.getByText('SCREEN.mp4')).toBeVisible()
    expect(screen.getByText('MICROPHONE.wav')).toBeVisible()
    expect(screen.getByText('SYSTEM_AUDIO.wav')).toBeVisible()
    expect(screen.queryByText('CAMERA.mp4')).not.toBeInTheDocument()
    expect(screen.queryByText(/sincronismo perfeito/i)).not.toBeInTheDocument()
  })

  it('shows a non-approved sync report in red even if the numeric deviation is small', async () => {
    await completedApp({
      ...exportResult,
      syncReport: { ...exportResult.syncReport, status: 'failed', maxDeviationMs: 1 },
    })
    const label = screen.getByText('Sincronismo não aprovado')
    expect(label.closest('.sync-badge')).toHaveClass('failed')
    expect(screen.queryByText('Sincronismo validado')).not.toBeInTheDocument()
  })

  it('opens only the completed job output and copies paths/reports through the clipboard', async () => {
    const user = await completedApp()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    await user.click(screen.getByRole('button', { name: /abrir pasta de saída/i }))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/jobs/job-123/open-output',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    )
    await user.click(screen.getByRole('button', { name: /copiar caminho da pasta de saída/i }))
    expect(writeText).toHaveBeenLastCalledWith(projectAnalysis.outputPath)
    await user.click(screen.getByRole('button', { name: /copiar relatório técnico/i }))
    expect(JSON.parse(String(writeText.mock.calls.at(-1)?.[0]))).toEqual(exportResult.syncReport)
    await user.click(screen.getByRole('button', { name: /novo projeto/i }))
    expect(screen.getByRole('textbox', { name: /^Caminho do projeto/i })).toHaveValue('')
  })

  it('keeps diagnostics collapsed until explicitly requested after an API failure', async () => {
    analyzeError = { code: 'INVALID_INPUT', message: 'Technical metadata diagnostic' }
    const user = userEvent.setup()
    render(<App />)
    await user.type(screen.getByLabelText(/^Caminho do projeto/i), projectAnalysis.inputPath)
    await user.click(screen.getByRole('button', { name: /^Analisar$/i }))
    const details = await screen.findByText(/ver detalhes técnicos/i)
    const disclosure = details.closest('details')!
    expect(disclosure).not.toHaveAttribute('open')
    expect(screen.getByText(/não encontramos um projeto válido/i)).toBeVisible()
    await user.click(details)
    expect(disclosure).toHaveAttribute('open')
    expect(within(disclosure).getByText(/Technical metadata diagnostic/)).toBeVisible()
  })
})

describe('E2E QA follow-up regressions', () => {
  it('labels the optional initial destination and connects its help text', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByText(/Escolher pasta de saída/i))
    const destination = screen.getByRole('textbox', { name: 'Destino da exportação' })
    expect(destination).toHaveAttribute('id', 'initial-output')
    expect(destination).toBeVisible()
    expect(destination).toHaveAccessibleDescription(/pasta nova ou vazia/i)
    expect((destination as HTMLInputElement).labels).toHaveLength(1)
    await user.click(screen.getByText('Destino da exportação'))
    expect(destination).toHaveFocus()
  })

  it('displays measured media durations to milliseconds without forcing identical values', async () => {
    await completedApp({
      ...exportResult,
      manifest: {
        ...exportResult.manifest,
        timelineDurationMs: 15_235,
        media: exportResult.manifest.media.map((media, index) => ({
          ...media,
          durationMs: index === 1 ? 15_236 : 15_235,
        })),
      },
    })
    const screenRow = screen.getByText('SCREEN.mp4').closest<HTMLElement>('.media-row')!
    const microphoneRow = screen.getByText('MICROPHONE.wav').closest<HTMLElement>('.media-row')!
    expect(within(screenRow).getByText('00:00:15.235')).toBeVisible()
    expect(within(microphoneRow).getByText('00:00:15.236')).toBeVisible()
  })

  it('keeps the raw progress diagnostic in an optional disclosure, not the main caption', async () => {
    const { user, source } = await processingApp()
    const raw = 'FFprobe: duração, codec e contagem de todos os frames decodificados.'
    act(() =>
      source.message({ stage: 'validate', percent: 49, currentTrack: 'display', message: raw }),
    )
    expect(screen.getByText('Conferindo a duração e a integridade da tela…')).toBeVisible()
    expect(screen.getByText(raw)).not.toBeVisible()
    await user.click(screen.getByText('Ver diagnóstico desta etapa'))
    expect(screen.getByText(raw)).toBeVisible()
  })
})

describe('4K master and Studio export controls', () => {
  it('provides labeled selects, 4K emphasis, and all specified resolution/quality options', async () => {
    await analyzedApp()
    const resolution = screen.getByRole('combobox', { name: 'Resolução da câmera' })
    const quality = screen.getByRole('combobox', { name: 'Qualidade de imagem' })
    expect(resolution).toHaveValue('4k')
    expect(quality).toHaveValue('maximum')
    expect(screen.getByText('4K UPSCALE MASTER')).toBeVisible()
    expect(
      within(resolution)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      '4K Ultra HD (3840x2160) — Upscale Master',
      'Resolução Nativa da Gravação',
      '1080p Full HD',
    ])
    expect(
      within(quality)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Qualidade Máxima / Studio (CRF 14 - Recomendado)',
      'Alta Qualidade (CRF 17)',
      'Exportação Rápida',
    ])
    expect(resolution).toHaveAccessibleDescription(/upscale não cria detalhes/i)
  })

  it('invalidates the old disk badge after a profile change and refreshes with the API number', async () => {
    const user = await analyzedApp()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Resolução da câmera' }), '1080p')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Qualidade de imagem' }), 'high')
    expect(screen.getByRole('button', { name: /preparar para davinci/i })).toBeDisabled()
    expect(screen.queryByText('Espaço suficiente')).not.toBeInTheDocument()
    expect(screen.getByText('Atualize a estimativa do perfil')).toBeVisible()
    analysis = {
      ...projectAnalysis,
      diskSpace: { ...projectAnalysis.diskSpace, estimatedRequiredBytes: 4.5 * 1024 ** 3 },
    }
    await user.click(screen.getByRole('button', { name: 'Atualizar estimativa' }))
    expect(screen.getByText('4,5 GB')).toBeVisible()
    expect(screen.getByText('Espaço suficiente')).toBeVisible()
    expect(screen.getByRole('button', { name: /preparar para davinci/i })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: /preparar para davinci/i }))
    const call = fetchMock.mock.calls.find(([path]) => path === '/api/jobs')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      cameraResolution: '1080p',
      quality: 'high',
    })
  })

  it('keeps insufficient space red and blocks preparing after an updated API estimate', async () => {
    const user = await analyzedApp()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Qualidade de imagem' }), 'fast')
    analysis = {
      ...projectAnalysis,
      diskSpace: {
        ...projectAnalysis.diskSpace,
        estimatedRequiredBytes: 5 * 1024 ** 3,
        availableBytes: 1 * 1024 ** 3,
        sufficient: false,
      },
    }
    await user.click(screen.getByRole('button', { name: 'Atualizar estimativa' }))
    expect(screen.getByText('Espaço insuficiente').closest('.disk-check')).toHaveClass('bad')
    expect(screen.getByRole('button', { name: /preparar para davinci/i })).toBeDisabled()
  })
})
