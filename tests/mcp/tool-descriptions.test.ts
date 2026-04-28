import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createMcpServer } from '../../src/mcp/server.js'

const BANNED = ['endpoint', 'mcp', 'middleware', 'primitive', 'bridge']
const EXPECTED_TOOLS = [
  'signup',
  'create_post',
  'update_post',
  'delete_post',
  'get_blog',
  'get_post',
  'list_posts',
  'report_bug',
  'upload_media',
  'list_media',
  'delete_media',
]

describe('MCP tool descriptions', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-desc-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('all 11 tools are registered, each with a description under 240 chars and no banned vocab', async () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' }, {})
    await client.connect(clientT)

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort())

    for (const tool of tools) {
      expect(tool.description, `tool "${tool.name}" is missing a description`).toBeTruthy()
      expect(
        tool.description!.length,
        `tool "${tool.name}" description too long: ${tool.description!.length}`,
      ).toBeLessThan(240)
      const lower = tool.description!.toLowerCase()
      for (const banned of BANNED) {
        expect(
          lower,
          `tool "${tool.name}" description contains banned word "${banned}"`,
        ).not.toContain(banned)
      }
    }

    await client.close()
    await server.close()
  })
})
