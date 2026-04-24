import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

/**
 * Resolve the raw bearer token from a tool call's RequestHandlerExtra.
 *
 * Under authMode: 'none', always returns null — the wrapTool pipeline
 * resolves blog context from args.blog_id instead.
 *
 * Under authMode: 'api_key', tries two sources in order:
 *   1. extra.authInfo?.token — populated by transports that carry auth
 *      natively (InMemoryTransport.send({ authInfo }), OAuth-aware HTTP).
 *   2. extra.requestInfo?.headers — plain-record header map from HTTP
 *      transports. Lookup is case-insensitive (the SDK's IsomorphicHeaders
 *      is a plain object, not a `Headers` instance). Accepts both
 *      'Bearer ' and 'bearer ' prefixes case-insensitively.
 *
 * Returns null on any miss so the caller can map to UNAUTHORIZED once.
 */
export function resolveBearer(
  extra: Extra,
  config: { authMode?: 'api_key' | 'none' },
): string | null {
  if (config.authMode === 'none') return null

  if (typeof extra.authInfo?.token === 'string' && extra.authInfo.token !== '') {
    return extra.authInfo.token
  }

  const headers = extra.requestInfo?.headers
  if (!headers) return null

  let raw: string | undefined
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization') {
      raw = Array.isArray(v) ? v[0] : v
      break
    }
  }
  if (typeof raw !== 'string') return null

  const lower = raw.toLowerCase()
  if (!lower.startsWith('bearer ')) return null
  return raw.slice('bearer '.length).trim() || null
}
