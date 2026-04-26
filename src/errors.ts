export type SlopItErrorCode =
  | 'BLOG_NAME_CONFLICT'
  | 'BLOG_NAME_RESERVED'
  | 'BLOG_NOT_FOUND'
  | 'POST_SLUG_CONFLICT'
  | 'POST_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'NOT_IMPLEMENTED'

export class SlopItError extends Error {
  readonly code: SlopItErrorCode
  readonly details: Record<string, unknown>

  constructor(code: SlopItErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'SlopItError'
    this.code = code
    this.details = details
  }
}
