import { createHash, randomInt } from 'node:crypto'
import type { Store } from '../db/store.js'
import { getBlogInternal } from '../blogs.js'
import type { Blog } from '../schema/index.js'
import { SlopItError } from '../errors.js'

// API key lifecycle. Keys are opaque bearer tokens with a short "sk_slop_"
// prefix for visual recognition. We store only the sha256 hash.

const PREFIX = 'sk_slop_'

// base62: alphanumeric only. We deliberately avoid base64url's `-` and `_`
// because they're visually ambiguous next to the `-----` separators in the
// onboarding credential block — humans and agents copy-pasting the block
// silently truncate them, producing 401s on a key that "looks right."
// 32 chars × log2(62) ≈ 190 bits of entropy, well above any practical bar.
const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const KEY_BODY_LEN = 32

export function generateApiKey(): string {
  // randomInt(0, n) uses crypto-grade rejection sampling — no modulo bias.
  let body = ''
  for (let i = 0; i < KEY_BODY_LEN; i++) {
    body += KEY_ALPHABET[randomInt(0, KEY_ALPHABET.length)]
  }
  return PREFIX + body
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function isApiKey(value: string): boolean {
  return value.startsWith(PREFIX)
}

/**
 * Hash the provided key, look it up in api_keys, and return the
 * associated Blog. Returns null for any failure mode (unknown key,
 * malformed key, deleted blog). Never throws on an invalid key — the
 * middleware layer maps null to 401.
 */
export function verifyApiKey(store: Store, key: string): Blog | null {
  if (!isApiKey(key)) return null
  const hash = hashApiKey(key)
  const row = store.db.prepare('SELECT blog_id FROM api_keys WHERE key_hash = ?').get(hash) as
    | { blog_id: string }
    | undefined
  if (!row) return null
  try {
    return getBlogInternal(store, row.blog_id)
  } catch (e) {
    if (e instanceof SlopItError && e.code === 'BLOG_NOT_FOUND') return null
    throw e
  }
}
