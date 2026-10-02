import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBridge } from '../hooks/useBridge'
import type { JobSnapshot, ProgressEvent, ProjectAnalysis, ServerStatus } from '../lib/types'
import { exportResult, jobSnapshot, jsonResponse, projectAnalysis, serverStatus } from './fixtures'

class MockEventSource {
  static instances: MockEventSource[] = []
  readonly url: string
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = vi.fn()
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  open() {
    this.onopen?.(new Event('open'))
  }
  error() {
    this.onerror?.(new Event('error'))
  }
  message(progress: ProgressEvent, lastEventId = '') {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(progress), lastEventId }))
  }
  raw(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
}

const fetchMock = vi.fn<typeof fetch>()
let statusResponse: ServerStatus
let analysisResponse: ProjectAnalysis
let snapshotResponse: JobSnapshot
let snapshotFetch: (() => Promise<Response>) | undefined
let cancelResponse: Response
let pickerResponse: Response

beforeEach(() => {
  MockEventSource.instances = []
  statusResponse = serverStatus
  analysisResponse = projectAnalysis
  snapshotResponse = jobSnapshot()
  snapshotFetch = undefined
  cancelResponse = jsonResponse({ state: 'cancelled' })
  pickerResponse = jsonResponse({ inputPath: projectAnalysis.inputPath })
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input)
    if (path === '/api/status') return jsonResponse(statusResponse)
    if (path === '/api/projects/analyze') return jsonResponse(analysisResponse)
    if (path === '/api/system/pick-input') return pickerResponse
    if (path === '/api/jobs' && init?.method === 'POST')
      return jsonResponse({ jobId: 'job-123' }, 201)
    if (path === '/api/jobs/job-123/cancel') return cancelResponse
    if (path === '/api/jobs/job-123')
      return snapshotFetch ? snapshotFetch() : jsonResponse(snapshotResponse)
    throw new Error(`Unexpected mocked endpoint: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', MockEventSource)
})
afterEach(() => vi.unstubAllGlobals())

async function mountProject() {
  const hook = renderHook(() => useBridge())
  await waitFor(() => expect(hook.result.current.checkingStatus).toBe(false))
  await act(async () => {
    await hook.result.current.analyze(projectAnalysis.inputPath)
  })
  expect(hook.result.current.phase).toBe('analysis')
  return hook
}

async function mountRunning() {
  const hook = await mountProject()
  await act(async () => {
    await hook.result.current.start()
  })
  await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))
  expect(hook.result.current.phase).toBe('processing')
  const source = MockEventSource.instances[0]!
  return { ...hook, source }
}

function countRequests(path: string) {
  return fetchMock.mock.calls.filter((call) => call[0] === path).length
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

describe('project analysis and safe export preconditions', () => {
  it('normalizes a copied Windows path and only sends JSON path data', async () => {
    const hook = renderHook(() => useBridge())
    await act(async () => {
      await hook.result.current.analyze('  "C:\\Gravações\\Teste.screenstudio.zip"  ')
    })
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/projects/analyze')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      inputPath: 'C:\\Gravações\\Teste.screenstudio.zip',
      cameraResolution: '4k',
      quality: 'maximum',
    })
    expect(hook.result.current.analysis).toEqual(projectAnalysis)
    expect(hook.result.current.outputPath).toBe(projectAnalysis.outputPath)
  })

  it('blocks invalid input and relative output before any analyze request', async () => {
    const hook = renderHook(() => useBridge())
    await act(async () => {
      await hook.result.current.analyze('relative.screenstudio')
    })
    expect(countRequests('/api/projects/analyze')).toBe(0)
    expect(hook.result.current.notice).not.toBe('')
    act(() => hook.result.current.setOutputPath('relative-output'))
    await act(async () => {
      await hook.result.current.analyze(projectAnalysis.inputPath)
    })
    expect(countRequests('/api/projects/analyze')).toBe(0)
    expect(hook.result.current.phase).toBe('input')
  })

  it('does not create a job if the output changed until it is reanalyzed', async () => {
    const hook = await mountProject()
    act(() => hook.result.current.setOutputPath('/Users/Levi/Exports/Novo'))
    expect(hook.result.current.outputDirty).toBe(true)
    await act(async () => {
      await hook.result.current.start()
    })
    expect(countRequests('/api/jobs')).toBe(0)
    expect(hook.result.current.phase).toBe('analysis')
    analysisResponse = { ...projectAnalysis, outputPath: '/Users/Levi/Exports/Novo' }
    await act(async () => {
      await hook.result.current.analyze()
    })
    expect(hook.result.current.outputDirty).toBe(false)
    await act(async () => {
      await hook.result.current.start()
    })
    const body = fetchMock.mock.calls.find(([url]) => url === '/api/jobs')?.[1]?.body
    expect(JSON.parse(String(body))).toEqual({
      inputPath: projectAnalysis.inputPath,
      outputPath: '/Users/Levi/Exports/Novo',
      cameraResolution: '4k',
      quality: 'maximum',
    })
  })

  it('does not treat quotes around an unchanged output as a different destination', async () => {
    const hook = await mountProject()
    act(() => hook.result.current.setOutputPath(`"${projectAnalysis.outputPath}"`))
    expect(hook.result.current.outputDirty).toBe(false)
  })

  it('blocks export when space is definitely insufficient', async () => {
    analysisResponse = {
      ...projectAnalysis,
      diskSpace: { ...projectAnalysis.diskSpace, sufficient: false, availableBytes: 0 },
    }
    const hook = await mountProject()
    await act(async () => {
      await hook.result.current.start()
    })
    expect(countRequests('/api/jobs')).toBe(0)
  })

  it('allows unknown disk capacity without mislabeling it as insufficient', async () => {
    analysisResponse = {
      ...projectAnalysis,
      diskSpace: { ...projectAnalysis.diskSpace, sufficient: null, availableBytes: null },
    }
    const hook = await mountProject()
    await act(async () => {
      await hook.result.current.start()
    })
    expect(countRequests('/api/jobs')).toBe(1)
    expect(hook.result.current.phase).toBe('processing')
  })

  it('blocks export when a local video tool is unavailable', async () => {
    statusResponse = { ...serverStatus, status: 'degraded', ffmpeg: { available: false } }
    const hook = await mountProject()
    await act(async () => {
      await hook.result.current.start()
    })
    expect(hook.result.current.ready).toBe(false)
    expect(countRequests('/api/jobs')).toBe(0)
  })

  it('prevents duplicate job submissions while the first request is pending', async () => {
    const hook = await mountProject()
    const pending = deferredResponse()
    fetchMock.mockImplementationOnce(() => pending.promise)
    let start!: Promise<void>
    act(() => {
      start = hook.result.current.start()
    })
    expect(hook.result.current.busy).toBe('start')
    await act(async () => {
      await hook.result.current.start()
    })
    expect(countRequests('/api/jobs')).toBe(1)
    await act(async () => {
      pending.resolve(jsonResponse({ jobId: 'job-123' }))
      await start
    })
    expect(hook.result.current.phase).toBe('processing')
  })

  it('uses the native picker path, and cancelling the picker does not analyze', async () => {
    const hook = renderHook(() => useBridge())
    pickerResponse = jsonResponse({ inputPath: null })
    await act(async () => {
      await hook.result.current.pick('zip')
    })
    expect(hook.result.current.phase).toBe('input')
    expect(countRequests('/api/projects/analyze')).toBe(0)
    pickerResponse = jsonResponse({ inputPath: projectAnalysis.inputPath })
    await act(async () => {
      await hook.result.current.pick('folder')
    })
    expect(hook.result.current.phase).toBe('analysis')
    expect(countRequests('/api/projects/analyze')).toBe(1)
  })

  it('gives the path fallback if the native picker is unavailable', async () => {
    pickerResponse = jsonResponse(
      { error: { code: 'PICKER_UNAVAILABLE', message: 'Not supported' } },
      503,
    )
    const hook = renderHook(() => useBridge())
    await act(async () => {
      await hook.result.current.pick('folder')
    })
    expect(hook.result.current.phase).toBe('input')
    expect(hook.result.current.notice).toMatch(/caminho completo/i)
    expect(countRequests('/api/projects/analyze')).toBe(0)
  })
})

describe('SSE lifecycle and terminal recovery', () => {
  it('applies real progress then completes using the SSE result and closes the stream', async () => {
    const { result, source } = await mountRunning()
    expect(source.url).toBe('/api/jobs/job-123/events')
    act(() => source.open())
    expect(result.current.connection).toBe('live')
    act(() =>
      source.message({
        stage: 'reconstruct',
        percent: 63,
        currentTrack: 'microphone',
        message: 'Preparando microfone',
      }),
    )
    expect(result.current.progress?.percent).toBe(63)
    expect(result.current.furthestStep).toBe(2)
    act(() =>
      source.message({
        stage: 'complete',
        percent: 100,
        currentTrack: 'fcpxml',
        message: 'Concluído',
        state: 'completed',
        result: exportResult,
      }),
    )
    expect(result.current.phase).toBe('success')
    expect(result.current.result).toEqual(exportResult)
    expect(source.close).toHaveBeenCalled()
    act(() => result.current.reset())
    expect(result.current.phase).toBe('input')
    expect(result.current.result).toBeNull()
    expect(result.current.jobId).toBeNull()
  })

  it('surfaces an engine error from the terminal failure event', async () => {
    const { result, source } = await mountRunning()
    const error = { code: 'SYNC_FAILED', message: 'Desvio excedido' }
    act(() =>
      source.message({
        stage: 'failed',
        percent: 80,
        currentTrack: '',
        message: 'Falhou',
        state: 'failed',
        error,
      }),
    )
    expect(result.current.phase).toBe('error')
    expect(result.current.error).toEqual(error)
    expect(source.close).toHaveBeenCalled()
  })

  it('keeps processing across a stream disconnect instead of inventing an export failure', async () => {
    const { result, source } = await mountRunning()
    snapshotFetch = async () => {
      throw new TypeError('Offline')
    }
    await act(async () => source.error())
    expect(result.current.connection).toBe('reconnecting')
    expect(result.current.phase).toBe('processing')
    expect(result.current.error).toBeNull()
    expect(source.close).not.toHaveBeenCalled()
  })

  it('recovers a lost terminal event from GET snapshot following a disconnect', async () => {
    const { result, source } = await mountRunning()
    snapshotResponse = jobSnapshot({ state: 'completed', result: exportResult })
    await act(async () => source.error())
    expect(result.current.phase).toBe('success')
    expect(result.current.result).toEqual(exportResult)
    expect(source.close).toHaveBeenCalled()
    expect(countRequests('/api/jobs/job-123')).toBeGreaterThanOrEqual(2)
  })

  it('recovers a job already completed before the EventSource connects', async () => {
    snapshotResponse = jobSnapshot({ state: 'completed', result: exportResult })
    const hook = await mountProject()
    await act(async () => {
      await hook.result.current.start()
    })
    await waitFor(() => expect(hook.result.current.phase).toBe('success'))
    expect(hook.result.current.result).toEqual(exportResult)
    expect(MockEventSource.instances[0]?.close).toHaveBeenCalled()
  })

  it('reads terminal failure details from a snapshot when its SSE event was missed', async () => {
    const { result, source } = await mountRunning()
    const error = { code: 'DISK_FULL', message: 'No space' }
    snapshotResponse = jobSnapshot({ state: 'failed', error })
    await act(async () => source.error())
    expect(result.current.phase).toBe('error')
    expect(result.current.error).toEqual(error)
  })

  it('does not declare success for a terminal event without an export report', async () => {
    const { result, source } = await mountRunning()
    act(() =>
      source.message({
        stage: 'complete',
        percent: 100,
        currentTrack: 'fcpxml',
        message: 'Concluído',
      }),
    )
    expect(result.current.phase).toBe('error')
    expect(result.current.error?.code).toBe('MISSING_RESULT')
    expect(result.current.result).toBeNull()
  })

  it('ignores malformed SSE payloads without abandoning a running job', async () => {
    const { result, source } = await mountRunning()
    act(() => source.raw('{malformed'))
    expect(result.current.phase).toBe('processing')
    expect(result.current.progress?.percent).toBe(15)
    expect(result.current.notice).not.toBe('')
  })

  it('never regresses accepted percentage or channel during replay', async () => {
    const { result, source } = await mountRunning()
    act(() =>
      source.message(
        { stage: 'reconstruct', percent: 70, currentTrack: 'microphone', message: 'Newer' },
        '20',
      ),
    )
    act(() =>
      source.message(
        { stage: 'reconstruct', percent: 30, currentTrack: 'display', message: 'Stale' },
        '21',
      ),
    )
    expect(result.current.progress?.percent).toBe(70)
    expect(result.current.furthestStep).toBe(2)
    act(() =>
      source.message(
        { stage: 'reconstruct', percent: 80, currentTrack: 'webcam', message: 'Older channel' },
        '22',
      ),
    )
    expect(result.current.progress?.percent).toBe(70)
    expect(result.current.progress?.currentTrack).toBe('microphone')
  })

  it('ignores duplicate or old SSE IDs even if the replay claims higher progress', async () => {
    const { result, source } = await mountRunning()
    act(() =>
      source.message(
        { stage: 'reconstruct', percent: 60, currentTrack: 'microphone', message: 'Latest' },
        '10',
      ),
    )
    act(() =>
      source.message(
        {
          stage: 'complete',
          percent: 100,
          currentTrack: 'fcpxml',
          message: 'Old terminal',
          result: exportResult,
        },
        '9',
      ),
    )
    expect(result.current.phase).toBe('processing')
    expect(result.current.progress?.percent).toBe(60)
    act(() =>
      source.message(
        { stage: 'reconstruct', percent: 65, currentTrack: 'microphone', message: 'Duplicate' },
        '10',
      ),
    )
    expect(result.current.progress?.percent).toBe(60)
  })

  it('discards a delayed nonterminal snapshot when a newer SSE arrived meanwhile', async () => {
    const pending = deferredResponse()
    snapshotFetch = () => pending.promise
    const { result, source } = await mountRunning()
    act(() =>
      source.message(
        { stage: 'reconstruct', percent: 50, currentTrack: 'microphone', message: 'Live update' },
        '2',
      ),
    )
    await act(async () => {
      pending.resolve(
        jsonResponse(
          jobSnapshot({
            progress: {
              stage: 'reconstruct',
              percent: 75,
              currentTrack: 'systemAudio',
              message: 'Outdated snapshot',
            },
          }),
        ),
      )
    })
    expect(result.current.progress?.percent).toBe(50)
    expect(result.current.progress?.message).toBe('Live update')
    expect(result.current.furthestStep).toBe(2)
  })

  it('still accepts a delayed terminal snapshot after newer nonterminal SSE', async () => {
    const pending = deferredResponse()
    snapshotFetch = () => pending.promise
    const { result, source } = await mountRunning()
    act(() =>
      source.message(
        { stage: 'reconstruct', percent: 55, currentTrack: 'microphone', message: 'Live update' },
        '2',
      ),
    )
    await act(async () => {
      pending.resolve(jsonResponse(jobSnapshot({ state: 'completed', result: exportResult })))
    })
    expect(result.current.phase).toBe('success')
    expect(result.current.result).toEqual(exportResult)
  })

  it('closes an old stream before a manual reconnect and closes again on unmount', async () => {
    const { result, source, unmount } = await mountRunning()
    act(() => result.current.reconnect())
    expect(source.close).toHaveBeenCalled()
    expect(MockEventSource.instances).toHaveLength(2)
    const replacement = MockEventSource.instances[1]!
    const snapshotCall = fetchMock.mock.calls
      .filter(([path]) => path === '/api/jobs/job-123')
      .at(-1)
    expect(snapshotCall?.[1]?.signal?.aborted).toBe(false)
    unmount()
    expect(replacement.close).toHaveBeenCalled()
    expect(snapshotCall?.[1]?.signal?.aborted).toBe(true)
  })

  it('aborts a pending analysis request when the view unmounts', async () => {
    const hook = renderHook(() => useBridge())
    const pending = deferredResponse()
    await waitFor(() => expect(hook.result.current.checkingStatus).toBe(false))
    fetchMock.mockImplementationOnce(() => pending.promise)
    let analyzing!: Promise<void>
    act(() => {
      analyzing = hook.result.current.analyze(projectAnalysis.inputPath)
    })
    const signal = fetchMock.mock.calls.find(([url]) => url === '/api/projects/analyze')?.[1]
      ?.signal
    expect(signal?.aborted).toBe(false)
    hook.unmount()
    expect(signal?.aborted).toBe(true)
    pending.resolve(jsonResponse(projectAnalysis))
    await analyzing
  })
})

describe('confirmed cancellation, not optimistic success', () => {
  it('waits for a terminal SSE if POST cancel is only an acknowledgement', async () => {
    cancelResponse = new Response(null, { status: 204 })
    const { result, source } = await mountRunning()
    await act(async () => {
      await result.current.cancel()
    })
    expect(result.current.phase).toBe('processing')
    expect(result.current.notice).toMatch(/aguardando/i)
    act(() =>
      source.message({
        stage: 'cancelled',
        percent: 15,
        currentTrack: '',
        message: 'Cancelado',
        state: 'cancelled',
      }),
    )
    expect(result.current.phase).toBe('cancelled')
    expect(result.current.result).toBeNull()
    expect(source.close).toHaveBeenCalled()
  })

  it('accepts an explicit cancelled snapshot returned by POST cancel', async () => {
    const { result, source } = await mountRunning()
    await act(async () => {
      await result.current.cancel()
    })
    expect(result.current.phase).toBe('cancelled')
    expect(source.close).toHaveBeenCalled()
  })

  it('keeps processing if cancellation cannot be confirmed', async () => {
    cancelResponse = jsonResponse({ error: { code: 'HTTP_503', message: 'Busy' } }, 503)
    const { result, source } = await mountRunning()
    await act(async () => {
      await result.current.cancel()
    })
    expect(result.current.phase).toBe('processing')
    expect(result.current.notice).toMatch(/não foi possível confirmar/i)
    expect(source.close).not.toHaveBeenCalled()
  })
})

describe('export resolution and image-quality profile', () => {
  it('starts each project with 4K and Studio maximum quality and sends both to the job', async () => {
    const hook = await mountProject()
    expect(hook.result.current.cameraResolution).toBe('4k')
    expect(hook.result.current.quality).toBe('maximum')
    expect(hook.result.current.exportSettingsDirty).toBe(false)
    await act(async () => {
      await hook.result.current.start()
    })
    const call = fetchMock.mock.calls.find(([path]) => path === '/api/jobs')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      inputPath: projectAnalysis.inputPath,
      outputPath: projectAnalysis.outputPath,
      cameraResolution: '4k',
      quality: 'maximum',
    })
  })

  it.each([
    ['native', 'high'],
    ['1080p', 'fast'],
    ['4k', 'high'],
  ] as const)(
    'reanalyzes %s/%s before export so the disk estimate matches the selected profile',
    async (cameraResolution, quality) => {
      const hook = await mountProject()
      act(() => {
        hook.result.current.setCameraResolution(cameraResolution)
        hook.result.current.setQuality(quality)
      })
      expect(hook.result.current.exportSettingsDirty).toBe(true)
      expect(hook.result.current.analysisDirty).toBe(true)
      await act(async () => {
        await hook.result.current.start()
      })
      expect(countRequests('/api/jobs')).toBe(0)
      analysisResponse = {
        ...projectAnalysis,
        diskSpace: { ...projectAnalysis.diskSpace, estimatedRequiredBytes: 4.5 * 1024 ** 3 },
      }
      await act(async () => {
        await hook.result.current.analyze()
      })
      const analysisCall = fetchMock.mock.calls
        .filter(([path]) => path === '/api/projects/analyze')
        .at(-1)
      expect(JSON.parse(String(analysisCall?.[1]?.body))).toMatchObject({
        cameraResolution,
        quality,
      })
      expect(hook.result.current.exportSettingsDirty).toBe(false)
      expect(hook.result.current.analysis?.diskSpace.estimatedRequiredBytes).toBe(4.5 * 1024 ** 3)
      await act(async () => {
        await hook.result.current.start()
      })
      const call = fetchMock.mock.calls.find(([path]) => path === '/api/jobs')
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ cameraResolution, quality })
    },
  )

  it('restores 4K/Studio defaults on a new project and preserves selections during destination checks', async () => {
    const hook = await mountProject()
    act(() => {
      hook.result.current.setCameraResolution('1080p')
      hook.result.current.setQuality('fast')
    })
    await act(async () => {
      await hook.result.current.analyze()
    })
    expect(hook.result.current.cameraResolution).toBe('1080p')
    expect(hook.result.current.quality).toBe('fast')
    act(() => hook.result.current.reset())
    expect(hook.result.current.cameraResolution).toBe('4k')
    expect(hook.result.current.quality).toBe('maximum')
    expect(hook.result.current.analysisDirty).toBe(false)
  })

  it('does not alter the API estimate to fit an arbitrary 3–6 GB range', async () => {
    analysisResponse = {
      ...projectAnalysis,
      diskSpace: { ...projectAnalysis.diskSpace, estimatedRequiredBytes: 8 * 1024 ** 3 },
    }
    const hook = await mountProject()
    expect(hook.result.current.analysis?.diskSpace.estimatedRequiredBytes).toBe(8 * 1024 ** 3)
  })
})
