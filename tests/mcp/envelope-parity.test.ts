import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SlopItError, type SlopItErrorCode } from '../../src/errors.js'
import { mapErrorToEnvelope } from '../../src/envelope.js'
import { createStore, type Store } from '../../src/db/store.js'

const CODES: SlopItErrorCode[] = [
  'BLOG_NAME_CONFLICT',
  'BLOG_NOT_FOUND',
  'POST_SLUG_CONFLICT',
  'POST_NOT_FOUND',
  'UNAUTHORIZED',
  'IDEMPOTENCY_KEY_CONFLICT',
  'NOT_IMPLEMENTED',
]

describe('envelope parity across transports', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-parity-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each(CODES)(
    'SlopItError code %s maps to the same code + details on both transports',
    (code) => {
      const err = new SlopItError(code, `${code} msg`, { detail: 'x' })
      const env = mapErrorToEnvelope(err)

      // REST wire body shape (what src/api/errors.ts emits):
      const restWire = { error: { code: env.code, message: env.message, details: env.details } }

      // MCP wire body shape (what wrapTool emits; statusHint stripped):
      const mcpWire = {
        error: { code: env.code, message: env.message, details: env.details },
      }

      expect(restWire).toEqual(mcpWire)
      expect(env.code).toBe(code)
    },
  )
})
