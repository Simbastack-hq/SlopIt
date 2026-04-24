import { createHash } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { Store } from '../db/store.js'
import { SlopItError } from '../errors.js'
import {
  lookupIdempotencyRecord,
  recordIdempotencyResponse,
  type IdempotencyScope,
} from '../idempotency-store.js'
import { respondError } from './errors.js'

const APPLIES_TO = new Set<string>(['POST', 'PATCH', 'DELETE'])

export interface IdempotencyMiddlewareConfig {
  store: Store
}

/**
 * Idempotency-Key middleware. Applies to POST/PATCH/DELETE requests
 * carrying an Idempotency-Key header from an AUTHENTICATED caller.
 * Delegates scope lookup/record to src/idempotency-store.ts (shared
 * with MCP). Weakened guarantee per spec decision #20.
 */
export function idempotencyMiddleware(
  config: IdempotencyMiddlewareConfig,
): MiddlewareHandler<{ Variables: { apiKeyHash: string } }> {
  return async (c, next) => {
    if (!APPLIES_TO.has(c.req.method)) return next()
    const key = c.req.header('Idempotency-Key')
    if (!key) return next()

    const apiKeyHash = c.var.apiKeyHash ?? ''
    if (!apiKeyHash) return next()

    const method = c.req.method
    const path = c.req.path
    const contentType = c.req.header('Content-Type') ?? ''
    const rawBody = await c.req.text()
    // Re-expose body so the handler can re-read it
    c.req.raw = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: rawBody || undefined,
    })
    const queryString = [...new URL(c.req.url).searchParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&')
    const hashInput = [method, path, contentType, queryString, rawBody].join('\0')
    const requestHash = createHash('sha256').update(hashInput).digest('hex')

    const scope: IdempotencyScope = { key, apiKeyHash, method, path, requestHash }
    const result = lookupIdempotencyRecord(config.store, scope)

    if (result.status === 'hit-mismatch') {
      return respondError(
        c,
        new SlopItError(
          'IDEMPOTENCY_KEY_CONFLICT',
          `Idempotency-Key "${key}" already used with a different payload for ${method} ${path}`,
          { key, method, path },
        ),
      )
    }
    if (result.status === 'hit-match') {
      return new Response(result.body, {
        status: result.responseStatus,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await next()
    const status = c.res.status
    if (status < 200 || status >= 300) return

    const body = await c.res.clone().text()
    recordIdempotencyResponse(config.store, scope, body, status)
  }
}
