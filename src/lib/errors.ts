export type ErrorExtra = Record<string, unknown>

/**
 * Error rendered as ITD-compatible JSON: `{"error": {"code", "message", ...extra}}`.
 * `body` overrides the whole payload for the few legacy responses where `error` is a plain string.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string,
    public extra: ErrorExtra = {},
    public body?: Record<string, unknown>,
    public headers?: Record<string, string>
  ) {
    super(message)
    this.name = 'ApiError'
  }

  toJSON() {
    if (this.body) return this.body
    return { error: { code: this.code, message: this.message, ...this.extra } }
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', extra?: ErrorExtra) => new ApiError(400, code, message, extra)
export const unauthorized = (message = 'Unauthorized', code = 'UNAUTHORIZED') => new ApiError(401, code, message)
export const forbidden = (message = 'Forbidden', code = 'FORBIDDEN', extra?: ErrorExtra) => new ApiError(403, code, message, extra)
export const notFound = (message = 'Not found', code = 'NOT_FOUND') => new ApiError(404, code, message)
export const conflict = (message: string, code = 'CONFLICT') => new ApiError(409, code, message)
export const uriTooLong = (message = 'URI too long') => new ApiError(414, 'URI_TOO_LONG', message)
export const payloadTooLarge = (message = 'Файл слишком большой', code = 'FILE_TOO_LARGE') => new ApiError(413, code, message)

export function validationError(message: string, field?: string) {
  const extra: ErrorExtra = {}
  if (field) {
    extra.errors = { [field]: [message] }
    extra.violations = [{ field, message }]
  }
  return new ApiError(422, 'VALIDATION_ERROR', message, extra)
}

/** Legacy token errors are plain strings: the SDK matches `{"error": "token expired"}` etc. */
export const tokenError = (error: 'token expired' | 'invalid token' | 'invalid signature' | 'Unsupported token algorithm') =>
  new ApiError(401, null, error, {}, { error, message: error === 'token expired' ? 'Invalid or expired token' : error })

export const rateLimited = (message: string, retryAfter: number) =>
  new ApiError(429, 'RATE_LIMIT_EXCEEDED', message, { retryAfter, retry_after: retryAfter }, undefined, { 'retry-after': String(retryAfter) })
