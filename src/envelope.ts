import { ZodError } from 'zod'
import { SlopItError, type SlopItErrorCode } from './errors.js'

export interface Envelope {
  code: string
  message: string
  details: Record<string, unknown>
  statusHint: number
}

const CODE_TO_STATUS: Record<SlopItErrorCode, number> = {
  BLOG_NAME_CONFLICT: 409,
  BLOG_NAME_RESERVED: 400,
  BLOG_NOT_FOUND: 404,
  POST_SLUG_CONFLICT: 409,
  POST_NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  IDEMPOTENCY_KEY_CONFLICT: 422,
  NOT_IMPLEMENTED: 501,
}

/**
 * Map any thrown value to the transport-agnostic envelope. REST wraps
 * this in its JSON response body; MCP wraps it in
 * { isError: true, content, structuredContent }.
 *
 * Side effect: unhandled errors are logged via console.error so the
 * consumer's logger sees them regardless of transport.
 */
export function mapErrorToEnvelope(err: unknown): Envelope {
  if (err instanceof ZodError) {
    return {
      code: 'ZOD_VALIDATION',
      message: 'Request body failed schema validation',
      details: { issues: err.issues },
      statusHint: 400,
    }
  }
  if (err instanceof SyntaxError) {
    return {
      code: 'BAD_REQUEST',
      message: 'Malformed JSON body',
      details: { message: err.message },
      statusHint: 400,
    }
  }
  if (err instanceof SlopItError) {
    const statusHint = CODE_TO_STATUS[err.code] ?? 500
    return {
      code: err.code,
      message: err.message,
      details: err.details,
      statusHint,
    }
  }
  console.error('[slopit] unhandled error:', err)
  return {
    code: 'INTERNAL_ERROR',
    message: 'An internal error occurred',
    details: {},
    statusHint: 500,
  }
}
