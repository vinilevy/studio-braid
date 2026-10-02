import type {
  ApiError,
  AnalyzeRequest,
  CreateJobRequest,
  CreateJobResponse,
  JobSnapshot,
  ProjectAnalysis,
  ServerStatus,
} from './types'

export class BridgeError extends Error {
  readonly code: string
  readonly status?: number
  constructor(error: ApiError, status?: number) {
    super(error.message)
    this.name = 'BridgeError'
    this.code = error.code
    this.status = status
  }
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof BridgeError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'CONNECTION_ERROR', message: error.message }
  return { code: 'UNKNOWN_ERROR', message: 'Não foi possível completar a operação.' }
}

export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body === undefined
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(120_000),
      cache: 'no-store',
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new BridgeError({
      code: 'CONNECTION_ERROR',
      message: 'O serviço local não respondeu. Verifique se o Bridge está aberto nesta máquina.',
    })
  }
  if (response.status === 204) return undefined as T
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const data = payload as { error?: ApiError; code?: string; message?: string } | null
    throw new BridgeError(
      {
        code: data?.error?.code ?? data?.code ?? `HTTP_${response.status}`,
        message:
          data?.error?.message ??
          data?.message ??
          'O serviço local não conseguiu completar esta operação.',
      },
      response.status,
    )
  }
  if (payload === null)
    throw new BridgeError({
      code: 'INVALID_RESPONSE',
      message: 'O serviço enviou uma resposta vazia ou inválida.',
    })
  return payload as T
}

export const api = {
  status: (signal?: AbortSignal) => request<ServerStatus>('/api/status', undefined, signal),
  analyze: (body: AnalyzeRequest, signal?: AbortSignal) =>
    request<ProjectAnalysis>('/api/projects/analyze', body, signal),
  async createJob(body: CreateJobRequest) {
    const job = await request<Partial<CreateJobResponse>>('/api/jobs', body)
    const id = job.jobId ?? job.id
    if (!id)
      throw new BridgeError({
        code: 'INVALID_RESPONSE',
        message: 'O serviço não informou o identificador da exportação.',
      })
    return id
  },
  snapshot: (id: string, signal?: AbortSignal) =>
    request<JobSnapshot>(`/api/jobs/${encodeURIComponent(id)}`, undefined, signal),
  cancel: (id: string) => request<unknown>(`/api/jobs/${encodeURIComponent(id)}/cancel`, {}),
  pickInput: (kind: 'folder' | 'zip') =>
    request<{ inputPath: string | null }>('/api/system/pick-input', { kind }),
  openOutput: (id: string) =>
    request<unknown>(`/api/jobs/${encodeURIComponent(id)}/open-output`, {}),
}
