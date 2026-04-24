import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SlopItError } from '../src/errors.js'
import { mapErrorToEnvelope } from '../src/envelope.js'

describe('mapErrorToEnvelope', () => {
  it('maps ZodError to ZOD_VALIDATION envelope with 400 statusHint', () => {
    const schema = z.object({ n: z.number() })
    let caught: unknown
    try {
      schema.parse({ n: 'oops' })
    } catch (e) {
      caught = e
    }
    const env = mapErrorToEnvelope(caught)
    expect(env.code).toBe('ZOD_VALIDATION')
    expect(env.statusHint).toBe(400)
    expect(env.details).toHaveProperty('issues')
    expect(env.message).toBe('Request body failed schema validation')
  })

  it('maps SyntaxError to BAD_REQUEST envelope with 400 statusHint', () => {
    const env = mapErrorToEnvelope(new SyntaxError('bad json'))
    expect(env.code).toBe('BAD_REQUEST')
    expect(env.statusHint).toBe(400)
    expect(env.message).toBe('Malformed JSON body')
    expect(env.details).toEqual({ message: 'bad json' })
  })

  it('maps SlopItError to its code + mapped statusHint', () => {
    const err = new SlopItError('BLOG_NOT_FOUND', 'not found', { blog_id: 'x' })
    const env = mapErrorToEnvelope(err)
    expect(env.code).toBe('BLOG_NOT_FOUND')
    expect(env.statusHint).toBe(404)
    expect(env.details).toEqual({ blog_id: 'x' })
  })

  it('maps SlopItError with unknown code to 500 statusHint', () => {
    // cast through unknown — this tests the fallback, not public API
    const err = Object.assign(new SlopItError('BLOG_NOT_FOUND', 'x'), { code: 'WEIRD' as never })
    const env = mapErrorToEnvelope(err)
    expect(env.statusHint).toBe(500)
  })

  it('maps unknown throwables to INTERNAL_ERROR + console.error', () => {
    const logs: string[] = []
    const origConsole = console.error
    console.error = (...args: unknown[]) => {
      // Capture ALL args — mapErrorToEnvelope logs `'[slopit] …:'` as
      // arg[0] and the Error as arg[1]; asserting against only arg[0]
      // would miss the actual error text.
      logs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    }
    try {
      const env = mapErrorToEnvelope(new Error('boom'))
      expect(env.code).toBe('INTERNAL_ERROR')
      expect(env.statusHint).toBe(500)
      expect(env.message).toBe('An internal error occurred')
      expect(env.details).toEqual({})
      expect(logs.join(' ')).toContain('boom')
      expect(logs.join(' ')).toContain('[slopit]')
    } finally {
      console.error = origConsole
    }
  })
})
