import { createHash, randomBytes } from 'node:crypto'
import { generateApiKey, hashApiKey } from './auth/api-key.js'
import { getBlogsByEmail } from './blogs.js'
import type { Store } from './db/store.js'
import { generateShortId } from './ids.js'
import type { Blog } from './schema/index.js'

// 30 minutes — long enough for slow inboxes, short enough that a leaked
// link is mostly worthless. Aligned with the password-reset norm in
// almost every other product; nothing magic about the number.
const TOKEN_TTL_MS = 30 * 60 * 1000

const TOKEN_PREFIX = 'rt_'

/**
 * Normalize an email the same way `CreateBlogInputSchema.email` does
 * (trim + lowercase). Recovery callers receive raw form input; without
 * this, a stored "foo@bar.com" would not match a recovery request for
 * " Foo@Bar.com ".
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function generateToken(): string {
  // 32 bytes ≈ 256 bits of entropy — unguessable. Prefix is cosmetic so
  // a leaked token is recognizable in logs / bug reports.
  return TOKEN_PREFIX + randomBytes(32).toString('base64url')
}

export interface RecoveryRequestResult {
  /** Opaque plaintext token. Platform emails this exactly once; we only
   * store its sha256 hash. */
  token: string
  /** Whether at least one blog matched the requested email. Platform
   * uses this to decide whether to actually send the email — returning
   * a token in the no-match case would turn `/recover` into a free
   * email-spam endpoint. The HTTP/UI response stays generic regardless. */
  shouldSend: boolean
}

/**
 * Step 1 of recovery. Validates nothing about ownership — just generates
 * a single-use token, stores its hash, and tells the caller whether the
 * email matched any blogs.
 *
 * Side effect: sweeps expired rows on every insert. Bounded growth, no
 * cron job needed. Cheap because of `idx_recovery_tokens_expires`.
 *
 * Caller is responsible for: emailing the token (when shouldSend), and
 * always returning a generic HTTP/UI response so observers cannot
 * distinguish hit from miss by response shape.
 */
export function requestRecoveryByEmail(store: Store, email: string): RecoveryRequestResult {
  const normalized = normalizeEmail(email)
  const blogs = getBlogsByEmail(store, normalized)
  const token = generateToken()
  const tokenHash = hashToken(token)
  const now = Date.now()
  const expiresAt = now + TOKEN_TTL_MS

  const tx = store.db.transaction(() => {
    store.db.prepare('DELETE FROM recovery_tokens WHERE expires_at < ?').run(now)
    store.db
      .prepare('INSERT INTO recovery_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, normalized, expiresAt)
  })
  tx()

  return { token, shouldSend: blogs.length > 0 }
}

export interface RecoveryConsumeResult {
  /** The blog(s) currently registered under the recovered email, paired
   * with their newly-issued plaintext API keys. Old keys for these blogs
   * are revoked atomically before the new ones are minted. */
  blogs: Array<{ blog: Blog; apiKey: string }>
}

/**
 * Step 2 of recovery. Validates the plaintext token, marks it consumed
 * (single-use), then re-queries blogs by the email captured at step 1
 * and atomically rotates each blog's API keys. Returns the new keys for
 * the platform to email.
 *
 * Returns null on any failure mode (unknown / expired / already-consumed
 * token). Callers must not distinguish failure modes in their HTTP/UI
 * response.
 *
 * Transport requirement: callers MUST invoke this from an explicit user
 * action (a POST handler behind a confirmation button), not from a bare
 * GET on the link sent in the recovery email. Email security scanners,
 * inbox link previews, and browser prefetch will hit GET URLs without
 * the user's intent and would silently consume the token + rotate the
 * keys. Render a confirmation page on GET; consume on POST.
 *
 * Re-query semantics: blogs added under the same email between request
 * and consume are also rotated; blogs whose email association changed
 * are not. v1 has no email-reassignment path so this distinction is
 * mostly theoretical — revisit if/when that lands.
 */
export function consumeRecoveryToken(store: Store, token: string): RecoveryConsumeResult | null {
  const tokenHash = hashToken(token)
  const now = Date.now()

  // Lookup, validation, consume marker, re-query, key rotation: all in
  // one transaction so a concurrent consume cannot rotate twice.
  let result: RecoveryConsumeResult | null = null
  const tx = store.db.transaction(() => {
    const row = store.db
      .prepare('SELECT email, expires_at, consumed_at FROM recovery_tokens WHERE token_hash = ?')
      .get(tokenHash) as
      | { email: string; expires_at: number; consumed_at: number | null }
      | undefined

    if (row === undefined) return
    if (row.consumed_at !== null) return
    if (row.expires_at < now) return

    store.db
      .prepare('UPDATE recovery_tokens SET consumed_at = ? WHERE token_hash = ?')
      .run(now, tokenHash)

    const blogs = getBlogsByEmail(store, row.email)
    if (blogs.length === 0) {
      // Token was valid but no blogs match (e.g. the user deleted them
      // between request and consume). Token is consumed; return empty.
      result = { blogs: [] }
      return
    }

    const issued: Array<{ blog: Blog; apiKey: string }> = []
    const deleteKeys = store.db.prepare('DELETE FROM api_keys WHERE blog_id = ?')
    const insertKey = store.db.prepare(
      'INSERT INTO api_keys (id, blog_id, key_hash) VALUES (?, ?, ?)',
    )

    for (const blog of blogs) {
      deleteKeys.run(blog.id)
      const apiKey = generateApiKey()
      insertKey.run(generateShortId(), blog.id, hashApiKey(apiKey))
      issued.push({ blog, apiKey })
    }

    result = { blogs: issued }
  })
  tx()

  return result
}
