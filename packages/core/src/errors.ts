export class BridgeError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 422) {
    super(message); this.name = 'BridgeError';
  }
}
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BridgeError('CANCELLED', 'Processamento cancelado.', 409);
}
