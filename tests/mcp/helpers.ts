import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * Wrap the client-side InMemoryTransport so every outgoing message
 * carries authInfo. SDK exposes send({ authInfo }) natively; that
 * flows into extra.authInfo on the server side, which resolveBearer
 * reads. Test-only; production HTTP transport reads headers.
 */
export function attachAuth(transport: InMemoryTransport, token: string): void {
  const original = transport.send.bind(transport)
  transport.send = (message, options) =>
    original(message, { ...(options ?? {}), authInfo: { token, clientId: 'test', scopes: [] } })
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return client.request(
    { method: 'tools/call', params: { name, arguments: args } },
    CallToolResultSchema,
  )
}
