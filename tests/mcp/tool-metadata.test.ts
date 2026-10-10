import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { createApiKey, createBlog } from '../../src/blogs.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createMcpServer, type McpServerConfig } from '../../src/mcp/server.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { attachAuth } from './helpers.js'

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

// readOnly / destructive / idempotent per tool. openWorldHint is false on all.
const HINTS: Record<string, [boolean, boolean, boolean]> = {
  signup: [false, false, false],
  create_post: [false, false, false],
  update_post: [false, false, true],
  delete_post: [false, true, true],
  update_blog: [false, false, true],
  get_blog: [true, false, true],
  get_post: [true, false, true],
  list_posts: [true, false, true],
  report_bug: [true, false, true],
  upload_media: [false, false, false],
  list_media: [true, false, true],
  delete_media: [false, true, true],
}

interface JsonSchema {
  type?: string
  description?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  anyOf?: JsonSchema[]
  additionalProperties?: unknown
}

/** Every property, at every depth, of an inputSchema — with its path. */
function propertiesOf(schema: JsonSchema, path = ''): [string, JsonSchema][] {
  const out: [string, JsonSchema][] = []
  const variants = [schema, ...(schema.anyOf ?? [])]
  for (const v of variants) {
    for (const [key, child] of Object.entries(v.properties ?? {})) {
      out.push([path + key, child], ...propertiesOf(child, `${path}${key}.`))
    }
  }
  return out
}

/** True when some object in the schema forbids extra properties. */
function closesObjects(schema: JsonSchema): boolean {
  if (schema.additionalProperties === false) return true
  const children = [
    ...Object.values(schema.properties ?? {}),
    ...(schema.items ? [schema.items] : []),
    ...(schema.anyOf ?? []),
  ]
  return children.some(closesObjects)
}

describe('MCP tool metadata', () => {
  let dir: string
  let store: Store
  let blogId: string
  let otherBlogId: string
  let apiKey: string
  let client: Client
  let tools: Tool[]
  let closer: () => Promise<void>

  const boot = async (extra: Partial<McpServerConfig> = {}) => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      bugReportUrl: 'https://bugs.example/new',
      ...extra,
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const c = new Client({ name: 'test', version: '0' }, {})
    attachAuth(clientT, apiKey)
    await c.connect(clientT)
    client = c
    // listTools() also primes the client's outputSchema validators, so every
    // client.callTool() below fails if structuredContent doesn't match.
    tools = (await c.listTools()).tools
    closer = async () => {
      await c.close()
      await server.close()
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-meta-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    blogId = createBlog(store, { name: 'bb' }).blog.id
    apiKey = createApiKey(store, blogId).apiKey
    otherBlogId = createBlog(store, { name: 'other' }).blog.id
    await boot()
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const tool = (name: string): Tool => {
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error(`tool ${name} not registered`)
    return t
  }

  /**
   * Call through the SDK client (which validates structuredContent against
   * the declared outputSchema and throws on a mismatch), then validate
   * again explicitly so the assertion doesn't hinge on client internals.
   */
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult
    expect(result.structuredContent, `${name} returned no structuredContent`).toBeDefined()
    const validate = new AjvJsonSchemaValidator().getValidator(tool(name).outputSchema!)
    const check = validate(result.structuredContent)
    expect(check.valid, `${name}: ${check.errorMessage}`).toBe(true)
    return result
  }

  const ok = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args)
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    return result.structuredContent as Record<string, unknown>
  }

  const fails = async (name: string, args: Record<string, unknown>, code: string) => {
    const result = await call(name, args)
    expect(result.isError).toBe(true)
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe(code)
  }

  describe('tools/list', () => {
    it('every tool has a title, all four hints, and openWorldHint false', () => {
      expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(HINTS).sort())
      for (const t of tools) {
        expect(t.title, t.name).toBeTruthy()
        expect(t.annotations?.title, t.name).toBe(t.title)
        const [readOnly, destructive, idempotent] = HINTS[t.name]
        expect(t.annotations, t.name).toMatchObject({
          readOnlyHint: readOnly,
          destructiveHint: destructive,
          idempotentHint: idempotent,
          openWorldHint: false,
        })
      }
    })

    it('every input parameter, nested ones included, has a description', () => {
      for (const t of tools) {
        const props = propertiesOf(t.inputSchema)
        expect(props.length, t.name).toBeGreaterThan(0)
        for (const [path, schema] of props) {
          expect(schema.description, `${t.name}.${path} has no description`).toBeTruthy()
        }
      }
    })

    it('every tool declares an open outputSchema that covers the error envelope', () => {
      for (const t of tools) {
        const schema = t.outputSchema as JsonSchema | undefined
        expect(schema?.type, t.name).toBe('object')
        expect(schema?.properties?.error, `${t.name} outputSchema lacks error`).toBeDefined()
        expect(closesObjects(schema!), `${t.name} outputSchema forbids new fields`).toBe(false)
      }
    })

    it('server has a title and instructions that walk through signup → create_post', () => {
      expect(client.getServerVersion()).toMatchObject({ name: '@slopit/core', title: 'SlopIt' })
      const text = client.getInstructions() ?? ''
      expect(text).toContain('`signup`')
      expect(text).toContain('Authorization: Bearer <api_key>')
      expect(text).toContain('`create_post`')
      expect(text).toContain('`post_url`')
    })

    it("instructions drop the API-key step under authMode: 'none'", async () => {
      await closer()
      await boot({ authMode: 'none' })
      const text = client.getInstructions() ?? ''
      expect(text).toContain('No API key is needed')
      expect(text).not.toContain('Bearer')
    })

    it('no tool metadata or instructions name a hosted domain', () => {
      const all = JSON.stringify(tools) + (client.getInstructions() ?? '')
      expect(all).not.toContain('slopit.io')
    })
  })

  describe('structuredContent matches outputSchema', () => {
    const seedPost = () =>
      ok('create_post', { blog_id: blogId, title: 'Seed', body: 'Seed body.', tags: ['x'] })

    it('signup', async () => {
      const sc = await ok('signup', { name: 'fresh', email: 'Owner@Example.com' })
      expect(sc.api_key).toMatch(/^sk_slop_/)
      expect(sc.email_sent).toBe(false)
      await fails('signup', { name: 'bb' }, 'BLOG_NAME_CONFLICT')
    })

    it('create_post (published, draft, idempotent replay)', async () => {
      const published = await ok('create_post', { blog_id: blogId, title: 'Hello', body: 'Hi.' })
      expect(published.post_url).toBe('https://b.example/hello/')
      const draft = await ok('create_post', {
        blog_id: blogId,
        title: 'Later',
        body: 'Soon.',
        status: 'draft',
        coverImage: 'https://img.example/c.png',
        language: 'de',
      })
      expect(draft.post_url).toBeUndefined()
      const args = { blog_id: blogId, title: 'Once', body: 'x', idempotency_key: 'k1' }
      const first = await ok('create_post', args)
      expect(await ok('create_post', args)).toEqual(first)
      await fails(
        'create_post',
        { blog_id: blogId, title: 'Hello', body: 'Again.' },
        'POST_SLUG_CONFLICT',
      )
    })

    it('update_post', async () => {
      await seedPost()
      const sc = await ok('update_post', {
        blog_id: blogId,
        slug: 'seed',
        patch: { title: 'Seed v2', status: 'draft' },
      })
      expect((sc.post as { title: string }).title).toBe('Seed v2')
      await fails('update_post', { blog_id: blogId, slug: 'nope', patch: {} }, 'POST_NOT_FOUND')
    })

    it('delete_post', async () => {
      await seedPost()
      expect(await ok('delete_post', { blog_id: blogId, slug: 'seed' })).toEqual({ deleted: true })
      await fails('delete_post', { blog_id: blogId, slug: 'seed' }, 'POST_NOT_FOUND')
    })

    it('update_blog', async () => {
      const sc = await ok('update_blog', {
        blog_id: blogId,
        patch: {
          analytics: { umami: { siteId: 'abc' } },
          parentSiteUrl: 'https://home.example',
          language: 'pt-BR',
        },
      })
      expect((sc.blog as { language: string }).language).toBe('pt-BR')
      await fails('update_blog', { blog_id: otherBlogId, patch: {} }, 'BLOG_NOT_FOUND')
    })

    it('get_blog', async () => {
      const sc = await ok('get_blog', { blog_id: blogId })
      expect((sc.blog as { id: string }).id).toBe(blogId)
      await fails('get_blog', { blog_id: otherBlogId }, 'BLOG_NOT_FOUND')
    })

    it('get_post', async () => {
      await seedPost()
      const sc = await ok('get_post', { blog_id: blogId, slug: 'seed' })
      expect((sc.post as { slug: string }).slug).toBe('seed')
      await fails('get_post', { blog_id: blogId, slug: 'nope' }, 'POST_NOT_FOUND')
    })

    it('list_posts', async () => {
      await seedPost()
      expect(((await ok('list_posts', { blog_id: blogId })).posts as unknown[]).length).toBe(1)
      expect(await ok('list_posts', { blog_id: blogId, status: 'draft' })).toEqual({ posts: [] })
      await fails('list_posts', { blog_id: otherBlogId }, 'BLOG_NOT_FOUND')
    })

    it('report_bug (always an error in core)', async () => {
      await fails('report_bug', { summary: 'broken' }, 'NOT_IMPLEMENTED')
    })

    it('upload_media', async () => {
      const sc = await ok('upload_media', {
        blog_id: blogId,
        filename: 'p.png',
        content_type: 'image/png',
        data_base64: PNG_BASE64,
      })
      expect((sc.media as { url: string }).url).toMatch(/\/_media\/.+\.png$/)
      await fails(
        'upload_media',
        { blog_id: blogId, filename: 'a.txt', content_type: 'text/plain', data_base64: PNG_BASE64 },
        'MEDIA_TYPE_UNSUPPORTED',
      )
    })

    it('list_media', async () => {
      await ok('upload_media', {
        blog_id: blogId,
        filename: 'p.png',
        content_type: 'image/png',
        data_base64: PNG_BASE64,
      })
      expect(((await ok('list_media', { blog_id: blogId })).media as unknown[]).length).toBe(1)
      await fails('list_media', { blog_id: otherBlogId }, 'BLOG_NOT_FOUND')
    })

    it('delete_media', async () => {
      const up = await ok('upload_media', {
        blog_id: blogId,
        filename: 'p.png',
        content_type: 'image/png',
        data_base64: PNG_BASE64,
      })
      const id = (up.media as { id: string }).id
      expect(await ok('delete_media', { blog_id: blogId, media_id: id })).toEqual({ deleted: true })
      await fails('delete_media', { blog_id: blogId, media_id: id }, 'MEDIA_NOT_FOUND')
    })

    it('UNAUTHORIZED errors still validate', async () => {
      apiKey = 'sk_slop_wrong'
      await closer()
      await boot()
      await fails('get_blog', { blog_id: blogId }, 'UNAUTHORIZED')
    })

    it('SDK input-validation errors carry no structuredContent and do not throw', async () => {
      const result = (await client.callTool({
        name: 'create_post',
        arguments: { blog_id: blogId, body: 'no title' },
      })) as CallToolResult
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toBeUndefined()
    })
  })
})
