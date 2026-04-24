import { describe, expect, it } from 'vitest'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { resolveBearer } from '../../src/mcp/auth.js'

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

const makeExtra = (overrides: Partial<Extra> = {}): Extra =>
  ({
    signal: new AbortController().signal,
    sendRequest: async () => ({ _meta: undefined }) as never,
    sendNotification: async () => undefined,
    ...overrides,
  }) as Extra

describe('resolveBearer', () => {
  it("returns null under authMode: 'none'", () => {
    expect(resolveBearer(makeExtra(), { authMode: 'none' })).toBeNull()
  })

  it('reads from authInfo.token when present', () => {
    const extra = makeExtra({ authInfo: { token: 'sk_slop_abc', clientId: 'x', scopes: [] } })
    expect(resolveBearer(extra, { authMode: 'api_key' })).toBe('sk_slop_abc')
  })

  it("reads from requestInfo.headers.authorization (lowercase key, 'Bearer ' prefix)", () => {
    const extra = makeExtra({
      requestInfo: { headers: { authorization: 'Bearer sk_slop_lower' } },
    })
    expect(resolveBearer(extra, { authMode: 'api_key' })).toBe('sk_slop_lower')
  })

  it('reads from requestInfo.headers case-insensitively (Authorization, AUTHORIZATION)', () => {
    const extra1 = makeExtra({
      requestInfo: { headers: { Authorization: 'Bearer sk_slop_cap' } },
    })
    expect(resolveBearer(extra1, { authMode: 'api_key' })).toBe('sk_slop_cap')

    const extra2 = makeExtra({
      requestInfo: { headers: { AUTHORIZATION: 'Bearer sk_slop_upper' } },
    })
    expect(resolveBearer(extra2, { authMode: 'api_key' })).toBe('sk_slop_upper')
  })

  it("accepts 'bearer ' prefix case-insensitively", () => {
    const extra = makeExtra({
      requestInfo: { headers: { authorization: 'bearer sk_slop_mixed' } },
    })
    expect(resolveBearer(extra, { authMode: 'api_key' })).toBe('sk_slop_mixed')
  })

  it('returns null when header is missing', () => {
    expect(resolveBearer(makeExtra(), { authMode: 'api_key' })).toBeNull()
  })

  it('returns null when header exists but is not a Bearer', () => {
    const extra = makeExtra({
      requestInfo: { headers: { authorization: 'Basic dXNlcjpwYXNz' } },
    })
    expect(resolveBearer(extra, { authMode: 'api_key' })).toBeNull()
  })

  it('prefers authInfo.token over the header when both are present', () => {
    const extra = makeExtra({
      authInfo: { token: 'sk_slop_from_authinfo', clientId: 'x', scopes: [] },
      requestInfo: { headers: { authorization: 'Bearer sk_slop_from_header' } },
    })
    expect(resolveBearer(extra, { authMode: 'api_key' })).toBe('sk_slop_from_authinfo')
  })
})
