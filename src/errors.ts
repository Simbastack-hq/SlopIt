export type SlopItErrorCode =
  | 'BAD_REQUEST'
  | 'BLOG_NAME_CONFLICT'
  | 'BLOG_NAME_RESERVED'
  | 'EMAIL_REQUIRED'
  | 'BLOG_NOT_FOUND'
  | 'POST_SLUG_CONFLICT'
  | 'POST_SLUG_RESERVED'
  | 'POST_NOT_FOUND'
  | 'TRANSLATION_CONFLICT'
  | 'TRANSLATIONS_DISABLED'
  | 'UNAUTHORIZED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'NOT_IMPLEMENTED'
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_TYPE_UNSUPPORTED'
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_QUOTA_EXCEEDED'
  | 'FACT_NOT_FOUND'
  | 'FACT_NAME_INVALID'
  | 'FACT_VALUE_INVALID'
  | 'FACT_CONFIRMED_AT_INVALID'
  | 'FACT_CONFLICT'
  | 'FACT_IN_USE'
  | 'FACT_LIMIT'
  | 'FACT_FANOUT'
  | 'FACT_IN_HEADING'
  | 'FACT_IN_URL'
  | 'FACT_NOT_ALLOWED_HERE'
  | 'FACT_RENDER_PENDING'

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
