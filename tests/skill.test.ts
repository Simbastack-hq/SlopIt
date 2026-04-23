import { describe, expect, it } from 'vitest'
import { generateSkillFile } from '../src/skill.js'

describe('generateSkillFile', () => {
  const text = generateSkillFile({ baseUrl: 'https://api.example' })

  it('starts with an h1 introducing SlopIt', () => {
    expect(text.split('\n')[0]).toMatch(/^# /)
    expect(text).toMatch(/SlopIt/)
  })

  it('has all required sections in fixed order', () => {
    const sections = ['What SlopIt is', 'Auth', 'Endpoints', 'Schema', 'Error codes', 'Idempotency']
    let lastIdx = -1
    for (const section of sections) {
      const idx = text.indexOf(`## ${section}`)
      expect(idx, `section "${section}" missing`).toBeGreaterThan(-1)
      expect(idx, `section "${section}" out of order`).toBeGreaterThan(lastIdx)
      lastIdx = idx
    }
  })

  it('documents Authorization: Bearer', () => {
    expect(text).toMatch(/Authorization:\s+Bearer/)
  })

  it('lists all 9 REST routes in the endpoints table', () => {
    const expected = [
      'GET /health',
      'POST /signup',
      'GET /schema',
      'POST /bridge/report_bug',
      'GET /blogs/:id',
      'POST /blogs/:id/posts',
      'GET /blogs/:id/posts',
      'GET /blogs/:id/posts/:slug',
      'PATCH /blogs/:id/posts/:slug',
      'DELETE /blogs/:id/posts/:slug',
    ]
    for (const route of expected) {
      expect(text, `missing route ${route}`).toContain(route)
    }
  })

  it('lists all SlopItErrorCode values', () => {
    const codes = [
      'BLOG_NAME_CONFLICT',
      'BLOG_NOT_FOUND',
      'POST_SLUG_CONFLICT',
      'POST_NOT_FOUND',
      'UNAUTHORIZED',
      'IDEMPOTENCY_KEY_CONFLICT',
      'NOT_IMPLEMENTED',
    ]
    for (const code of codes) expect(text).toContain(code)
  })

  it('includes the weakened-guarantee caveat in the Idempotency section', () => {
    const idemStart = text.indexOf('## Idempotency')
    expect(idemStart).toBeGreaterThan(-1)
    const section = text.slice(idemStart)
    // Must mention best-effort / crash / retry caveat
    expect(section.toLowerCase()).toMatch(/best-effort|not crash-safe|may re-execute/)
  })

  it('refers to GET /schema for the machine-readable JSONSchema', () => {
    expect(text).toMatch(/GET \/schema/)
  })

  it('does NOT list MCP tools (deferred to feat/mcp-tools)', () => {
    // MCP tools table is intentionally omitted this feature; assert
    // the section heading is not present.
    expect(text).not.toMatch(/## MCP tools/i)
  })
})
