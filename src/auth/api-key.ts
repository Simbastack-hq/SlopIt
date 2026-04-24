import { createHash, randomBytes } from 'node:crypto'
import type { Store } from '../db/store.js'
import { getBlogInternal } from '../blogs.js'
import type { Blog } from '../schema/index.js'
import { SlopItError } from '../errors.js'

// API key lifecycle. Keys are opaque bearer tokens with a short "sk_slop_"
// prefix for visual recognition. We store only the sha256 hash.

const PREFIX = 'sk_slop_'

export function generateApiKey(): string {
  return PREFIX + randomBytes(24).toString('base64url')
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
