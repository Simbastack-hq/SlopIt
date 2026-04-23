import { createHash } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { Store } from '../db/store.js'
import { SlopItError } from '../errors.js'
import { respondError } from './errors.js'

const APPLIES_TO = new Set<string>(['POST', 'PATCH', 'DELETE'])

export interface IdempotencyMiddlewareConfig {
  store: Store
}

type StoredRow = {
  request_hash: string
  response_status: number
  response_body: string
}

/**
 * Idempotency-Key middleware. Applies to POST/PATCH/DELETE requests
 * carrying an Idempotency-Key header. Replays the stored response on
 * match; 422 on mismatched payload; pass-through with record-on-2xx
 * otherwise. Weakened guarantee per spec decision #20 — recording
 * happens after the handler commits, so a crash window exists. See the
 * spec's per-endpoint failure-mode table and SKILL.md.
 *
 * Scope = (key, api_key_hash, method, path). Depends on the auth
 * middleware (or a test stand-in) having set c.var.apiKeyHash. For
 * /signup the hash is '' (pre-auth bootstrap).
 */
export function idempotencyMiddleware(config: IdempotencyMiddlewareConfig): MiddlewareHandler<{ Variables: { apiKeyHash: string } }> {
  return async (c, next) => {
    if (!APPLIES_TO.has(c.req.method)) return next()
    const key = c.req.header('Idempotency-Key')
    if (!key) return next()

    const apiKeyHash = c.var.apiKeyHash ?? ''
    const method = c.req.method
    const path = c.req.path
    const contentType = c.req.header('Content-Type') ?? ''
    const rawBody = await c.req.text()
    // Re-expose body so the handler can re-read it
    c.req.raw = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: rawBody || undefined,
    }) as typeof c.req.raw
    const queryString = [...new URL(c.req.url).searchParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&')
    const hashInput = [method, path, contentType, queryString, rawBody].join('\0')
    const requestHash = createHash('sha256').update(hashInput).digest('hex')

    const existing = config.store.db
      .prepare(
        `SELECT request_hash, response_status, response_body
           FROM idempotency_keys
          WHERE key = ? AND api_key_hash = ? AND method = ? AND path = ?`,
      )
      .get(key, apiKeyHash, method, path) as StoredRow | undefined

    if (existing) {
      if (existing.request_hash !== requestHash) {
        const err = new SlopItError(
          'IDEMPOTENCY_KEY_CONFLICT',
          `Idempotency-Key "${key}" already used with a different payload for ${method} ${path}`,
          { key, method, path },
        )
        return respondError(c, err)
      }
      // Replay stored response
      return new Response(existing.response_body, {
        status: existing.response_status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Miss — run handler, capture response
    await next()
    const status = c.res.status
    if (status < 200 || status >= 300) return

    const body = await c.res.clone().text()
    config.store.db
      .prepare(
        `INSERT INTO idempotency_keys
           (key, api_key_hash, method, path, request_hash, response_status, response_body)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key, apiKeyHash, method, path, requestHash, status, body)
  }
}
