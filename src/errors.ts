export type SlopItErrorCode =
  | 'BAD_REQUEST'
  | 'BLOG_NAME_CONFLICT'
  | 'BLOG_NAME_RESERVED'
  | 'BLOG_NOT_FOUND'
  | 'POST_SLUG_CONFLICT'
  | 'POST_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'NOT_IMPLEMENTED'
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_TYPE_UNSUPPORTED'
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_QUOTA_EXCEEDED'

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
