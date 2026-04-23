import type { Context } from 'hono'
import type { ErrorHandler } from 'hono/types'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'
import { SlopItError, type SlopItErrorCode } from '../errors.js'

const CODE_TO_STATUS: Record<SlopItErrorCode, ContentfulStatusCode> = {
  BLOG_NAME_CONFLICT: 409,
  BLOG_NOT_FOUND: 404,
  POST_SLUG_CONFLICT: 409,
  POST_NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  IDEMPOTENCY_KEY_CONFLICT: 422,
  NOT_IMPLEMENTED: 501,
}

type ErrorBody = {
  error: {
    code: string
    message: string
    details: Record<string, unknown>
  }
}

/**
 * Wrap handler errors in the documented envelope and map to HTTP status.
 * ZodError → 400 with details.issues. SlopItError → mapped status with
 * code + details. Anything else → 500 with a generic message (full
 * error is logged to stderr via console.error for the consumer to pick up).
 *
 * Register via app.onError(errorMiddleware) — Hono's compose intercepts
 * thrown errors before they can propagate through middleware try/catch.
 */
export const errorMiddleware: ErrorHandler = (err, c) => {
  return respondError(c, err)
}

export function respondError(c: Context, err: unknown): Response {
  if (err instanceof ZodError) {
    const body: ErrorBody = {
      error: {
        code: 'ZOD_VALIDATION',
        message: 'Request body failed schema validation',
        details: { issues: err.issues },
      },
    }
    return c.json(body, 400)
  }
  if (err instanceof SyntaxError) {
    // Malformed JSON body. Hono's c.req.json() / Request#json() throw
    // SyntaxError when the body is not valid JSON. Map to 400 so callers
    // can distinguish a protocol-level parse failure from a schema one.
    const body: ErrorBody = {
      error: {
        code: 'BAD_REQUEST',
        message: 'Malformed JSON body',
        details: { message: err.message },
      },
    }
    return c.json(body, 400)
  }
  if (err instanceof SlopItError) {
    const status: ContentfulStatusCode = CODE_TO_STATUS[err.code] ?? 500
    const body: ErrorBody = {
      error: { code: err.code, message: err.message, details: err.details },
    }
    return c.json(body, status)
  }
  console.error('[slopit] unhandled error:', err)
  const body: ErrorBody = {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred',
      details: {},
    },
  }
  return c.json(body, 500)
}
