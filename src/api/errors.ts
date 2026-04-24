import type { Context } from 'hono'
import type { ErrorHandler } from 'hono/types'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { mapErrorToEnvelope } from '../envelope.js'

/**
 * Register via app.onError(errorMiddleware) — Hono's compose intercepts
 * thrown errors before they can propagate through middleware try/catch.
 * Delegates to mapErrorToEnvelope for the mapping (shared with MCP).
 */
export const errorMiddleware: ErrorHandler = (err, c) => {
  return respondError(c, err)
}

export function respondError(c: Context, err: unknown): Response {
  const env = mapErrorToEnvelope(err)
  return c.json(
    { error: { code: env.code, message: env.message, details: env.details } },
    env.statusHint as ContentfulStatusCode,
  )
}
