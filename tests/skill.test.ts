import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateSkillFile } from '../src/skill.js'
import { createStore } from '../src/db/store.js'
import { createRenderer } from '../src/rendering/generator.js'
import { createApiRouter } from '../src/api/index.js'

describe('generateSkillFile', () => {
  const text = generateSkillFile({ baseUrl: 'https://api.example' })

  it('starts with an h1 introducing SlopIt', () => {
    expect(text.split('\n')[0]).toMatch(/^# /)
    expect(text).toMatch(/SlopIt/)
  })

  it('has all required sections in fixed order', () => {
    const sections = [
      'What SlopIt is',
      'Auth',
      'Endpoints',
      'Schema',
      'Error codes',
      'Idempotency',
      'MCP tools',
    ]
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

  it('lists all REST routes as absolute URLs anchored on baseUrl', () => {
    const base = 'https://api.example'
    const expected = [
      `GET ${base}/health`,
      `POST ${base}/signup`,
      `GET ${base}/schema`,
      `POST ${base}/bridge/report_bug`,
      `GET ${base}/blogs/:id`,
      `POST ${base}/blogs/:id/posts`,
      `GET ${base}/blogs/:id/posts`,
      `GET ${base}/blogs/:id/posts/:slug`,
      `PATCH ${base}/blogs/:id/posts/:slug`,
      `DELETE ${base}/blogs/:id/posts/:slug`,
    ]
    for (const route of expected) {
      expect(text, `missing route ${route}`).toContain(route)
    }
  })

  it('lists all SlopItErrorCode values plus the envelope codes', () => {
    const codes = [
      // SlopItErrorCode values
      'BLOG_NAME_CONFLICT',
      'BLOG_NOT_FOUND',
      'POST_SLUG_CONFLICT',
      'POST_NOT_FOUND',
      'UNAUTHORIZED',
      'IDEMPOTENCY_KEY_CONFLICT',
      'NOT_IMPLEMENTED',
      // Envelope codes emitted by respondError (not SlopItError)
      'BAD_REQUEST',
      'ZOD_VALIDATION',
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

  it('Idempotency section explicitly states /signup is NOT replayed (drift guard)', () => {
    // The middleware skips replay when apiKeyHash is empty (see
    // src/api/idempotency.ts). If SKILL.md claims otherwise, agents
    // will write retry logic that silently no-ops. Guard the claim.
    const idemStart = text.indexOf('## Idempotency')
    const section = text.slice(idemStart)
    // Must call out /signup specifically, not just mention it
    expect(section).toMatch(/\/signup is NOT replayed/i)
    // Must not list /signup in the "authenticated mutation" intro
    const intro = section.split('\n\n')[1] ?? ''
    expect(intro).not.toMatch(/POST \/signup/)
  })

  it('refers to GET <baseUrl>/schema for the machine-readable JSONSchema', () => {
    expect(text).toContain('GET https://api.example/schema')
  })

  it('includes the MCP tools section with all 8 tool names', () => {
    expect(text).toContain('## MCP tools')
    const tools = [
      'signup',
      'create_post',
      'update_post',
      'delete_post',
      'get_blog',
      'get_post',
      'list_posts',
      'report_bug',
    ]
    for (const tool of tools) {
      expect(text, `MCP section missing tool: ${tool}`).toContain(tool)
    }
  })
})

describe('SKILL.md endpoint parity with createApiRouter', () => {
  it('every route mounted by createApiRouter appears in the SKILL.md endpoints table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slopit-skill-parity-'))
    const store = createStore({ dbPath: join(dir, 'p.db') })
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })

    // Extract Hono's routes list. Each has method + path. SKILL.md
    // emits these as absolute URLs anchored on baseUrl, so prefix each
    // path with baseUrl when matching.
    const baseUrl = 'https://api.example'
    const routes = app.routes
      .filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method} ${baseUrl}${r.path}`)

    const skill = generateSkillFile({ baseUrl })
    for (const route of new Set(routes)) {
      expect(skill, `SKILL.md missing route ${route}`).toContain(route)
    }

    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
