import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createMcpServer } from '../../src/mcp/server.js'

describe('MCP tool: report_bug', () => {
  let dir: string
  let store: Store
  let client: Client
  let closer: () => Promise<void>

  const boot = async (bugReportUrl?: string) => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      bugReportUrl,
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const c = new Client({ name: 'test', version: '0' }, {})
    await c.connect(clientT)
    client = c
    closer = async () => {
      await c.close()
      await server.close()
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-bridge-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns NOT_IMPLEMENTED envelope with details.use when bugReportUrl is configured', async () => {
    await boot('https://slopit.io/bridge')
    const result = (await client.callTool({
      name: 'report_bug',
      arguments: { summary: 'does not deploy on sundays' },
    })) as unknown as {
      isError: boolean
      structuredContent: { error: { code: string; details: { use?: string } } }
    }
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('NOT_IMPLEMENTED')
    expect(result.structuredContent.error.details.use).toBe('https://slopit.io/bridge')
  })

  it('returns NOT_IMPLEMENTED envelope without details.use when bugReportUrl is not configured', async () => {
    await boot()
    const result = (await client.callTool({
      name: 'report_bug',
      arguments: {},
    })) as unknown as {
      isError: boolean
      structuredContent: { error: { code: string; details: Record<string, unknown> } }
    }
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('NOT_IMPLEMENTED')
    expect(result.structuredContent.error.details).toEqual({})
  })
})
