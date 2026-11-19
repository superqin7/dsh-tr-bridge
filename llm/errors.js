/**
 * Error type shared by the native TokenRouter LLM provider.
 *
 * The Harness turns a thrown error into a terminal `error`/`aborted` finish,
 * so the code field is the stable machine-readable part and the message must
 * never contain request bodies, credentials or native stderr.
 */
export class TrLlmError extends Error {
  constructor(message, code = 'TR_LLM_ERROR', options = undefined) {
    super(message, options)
    this.name = 'TrLlmError'
    this.code = code
  }
}

export function isAbortError(error) {
  return error?.name === 'AbortError'
    || error?.name === 'TimeoutError'
    || error?.code === 'ABORT_ERR'
}

export function asTrError(error, code = 'TR_LLM_ERROR') {
  if (error instanceof TrLlmError) return error
  if (isAbortError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  return new TrLlmError(message, code, { cause: error })
}
