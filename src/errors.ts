export type SlopItErrorCode = 'BLOG_NAME_CONFLICT' | 'BLOG_NOT_FOUND' | 'POST_SLUG_CONFLICT'

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
