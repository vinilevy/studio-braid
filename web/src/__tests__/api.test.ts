import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, asApiError, BridgeError, request } from '../lib/api'
import { jsonResponse, projectAnalysis, serverStatus } from './fixtures'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('local JSON API contract', () => {
  it('requests status with GET, without a body and without cached responses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(serverStatus))
    expect(await api.status()).toEqual(serverStatus)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/status',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
        body: undefined,
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('analyzes using paths as JSON, never FormData or file bytes', async () => {
    const paths = {
      inputPath: 'C:\\Gravações\\Projeto.screenstudio.zip',
      outputPath: 'D:\\Exports\\Projeto',
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(projectAnalysis))
    expect(await api.analyze(paths)).toEqual(projectAnalysis)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/analyze',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(paths),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      }),
    )
  })

  it.each([{ jobId: 'new-id' }, { id: 'legacy-id' }, { jobId: 'preferred-id', id: 'other-id' }])(
    'reads a supported creation response: %j',
    async (payload) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(payload))
      expect(
        await api.createJob({
          inputPath: projectAnalysis.inputPath,
          outputPath: projectAnalysis.outputPath,
        }),
      ).toBe('jobId' in payload ? payload.jobId : payload.id)
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/jobs',
        expect.objectContaining({ method: 'POST' }),
      )
    },
  )

  it('rejects a creation response without an identifier', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ state: 'queued' }))
    await expect(api.createJob({ inputPath: 'x', outputPath: 'y' })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
  })

  it('URI-encodes job identifiers for snapshot, cancel and output folder requests', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}))
    await api.snapshot('job /?')
    await api.cancel('job /?')
    await api.openOutput('job /?')
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/jobs/job%20%2F%3F',
      '/api/jobs/job%20%2F%3F/cancel',
      '/api/jobs/job%20%2F%3F/open-output',
    ])
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{}' })
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: '{}' })
  })

  it('requests the native picker with only its kind and supports a dismissed picker', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ inputPath: null }))
    expect(await api.pickInput('zip')).toEqual({ inputPath: null })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/pick-input',
      expect.objectContaining({ body: '{"kind":"zip"}' }),
    )
  })

  it('supports a 204 cancel response without attempting JSON parsing', async () => {
    const response = new Response(null, { status: 204 })
    const json = vi.spyOn(response, 'json')
    fetchMock.mockResolvedValueOnce(response)
    expect(await api.cancel('job')).toBeUndefined()
    expect(json).not.toHaveBeenCalled()
  })

  it('passes a supplied abort signal instead of replacing it', async () => {
    const controller = new AbortController()
    fetchMock.mockResolvedValueOnce(jsonResponse(serverStatus))
    await api.status(controller.signal)
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
  })
})

describe('API failures', () => {
  it.each([
    [
      { error: { code: 'PROJECT_INCOMPLETE', message: 'Metadata ausente' } },
      'PROJECT_INCOMPLETE',
      'Metadata ausente',
    ],
    [{ code: 'INVALID_PATH', message: 'Caminho inválido' }, 'INVALID_PATH', 'Caminho inválido'],
    [{}, 'HTTP_400', 'O serviço local não conseguiu completar esta operação.'],
  ] as const)('unwraps non-OK response %j', async (payload, code, message) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(payload, 400))
    await expect(request('/api/failure')).rejects.toMatchObject({
      name: 'BridgeError',
      code,
      message,
      status: 400,
    })
  })

  it('maps invalid successful JSON to a diagnostic rather than accepting null', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 200 }))
    await expect(request('/api/invalid')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('maps a fetch network error to a local-service error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(api.status()).rejects.toMatchObject({ code: 'CONNECTION_ERROR' })
  })

  it('preserves an explicit abort failure so the owner can suppress it', async () => {
    const controller = new AbortController()
    controller.abort()
    const failure = new DOMException('Aborted', 'AbortError')
    fetchMock.mockRejectedValueOnce(failure)
    await expect(api.status(controller.signal)).rejects.toBe(failure)
  })

  it('normalizes errors without leaking arbitrary objects', () => {
    expect(asApiError(new BridgeError({ code: 'SPECIFIC', message: 'diagnostic' }, 400))).toEqual({
      code: 'SPECIFIC',
      message: 'diagnostic',
    })
    expect(asApiError(new Error('Disconnected'))).toEqual({
      code: 'CONNECTION_ERROR',
      message: 'Disconnected',
    })
    expect(asApiError({ token: 'not-to-be-used' })).toEqual({
      code: 'UNKNOWN_ERROR',
      message: expect.any(String),
    })
  })
})
