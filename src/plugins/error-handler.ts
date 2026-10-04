import { Elysia, type ValidationError } from 'elysia'
import { ApiError } from '../lib/errors'
import { errorMeta, logger } from '../lib/logger'

function formatValidation(error: Readonly<ValidationError>) {
  let issues: { path?: string; message?: string; summary?: string }[] = []
  try {
    issues = error.all ?? []
  } catch {}
  const first = issues[0]
  const pathOf = (path?: string) => (path ?? '').replace(/^\//, '').replaceAll('/', '.') || error.type
  const custom = typeof error.customError === 'string' ? error.customError : undefined
  const message = custom ?? first?.summary ?? first?.message ?? 'Validation failed'

  const violations = issues.slice(0, 20).map((issue) => ({ field: pathOf(issue.path), message: issue.summary ?? issue.message ?? 'Invalid value' }))
  const errors: Record<string, string[]> = {}
  for (const v of violations) (errors[v.field] ??= []).push(v.message)

  return { error: { code: 'VALIDATION_ERROR', message, errors, violations } }
}

const pgErrorCode = (error: unknown): string | undefined => {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } }
  if (typeof candidate?.cause?.code === 'string') return candidate.cause.code
  if (typeof candidate?.code === 'string' && /^\d{5}$/.test(candidate.code)) return candidate.code
  return undefined
}

export const errorHandler = new Elysia({ name: 'error-handler' }).onError({ as: 'global' }, ({ code, error, set, request }) => {
  if (error instanceof ApiError) {
    set.status = error.status
    if (error.headers) Object.assign(set.headers, error.headers)
    return error.toJSON()
  }

  switch (code) {
    case 'VALIDATION':
      if (error.type === 'response') {
        // the handler produced a body that does not match its documented model: a server bug
        logger.error('response validation failed', { url: request.url, message: error.message.slice(0, 2000) })
        set.status = 500
        return { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }
      }
      set.status = 422
      return formatValidation(error)
    case 'NOT_FOUND':
      set.status = 404
      return { error: { code: 'NOT_FOUND', message: 'Route not found' } }
    case 'PARSE':
      set.status = 400
      return { error: { code: 'BAD_REQUEST', message: 'Invalid request body' } }
    case 'INVALID_COOKIE_SIGNATURE':
      set.status = 400
      return { error: { code: 'BAD_REQUEST', message: 'Invalid cookie' } }
  }

  const pgCode = pgErrorCode(error)
  if (pgCode === '23505') {
    set.status = 409
    return { error: { code: 'CONFLICT', message: 'Resource already exists' } }
  }
  if (pgCode === '22P02') {
    set.status = 422
    return { error: { code: 'VALIDATION_ERROR', message: 'Invalid identifier' } }
  }

  logger.error('unhandled error', { ...errorMeta(error), method: request.method, url: request.url })
  set.status = 500
  return { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }
})
