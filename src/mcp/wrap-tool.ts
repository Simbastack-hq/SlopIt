import { createHash } from 'node:crypto'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { getBlogInternal } from '../blogs.js'
import { SlopItError } from '../errors.js'
import { mapErrorToEnvelope } from '../envelope.js'
import {
  lookupIdempotencyRecord,
  recordIdempotencyResponse,
  type IdempotencyScope,
} from '../idempotency-store.js'
import type { Blog } from '../schema/index.js'
import { hashApiKey, verifyApiKey } from '../auth/api-key.js'
import { resolveBearer } from './auth.js'
import type { McpServerConfig } from './server.js'

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

export interface WrapToolOpts {
  auth: 'required' | 'public'
  idempotent?: boolean
  crossBlogGuard?: boolean
}

export interface ToolCtx {
  store: McpServerConfig['store']
  config: McpServerConfig
  blog?: Blog
  apiKeyHash?: string
}

export type ToolBusiness<A> = (args: A, ctx: ToolCtx) => unknown

type WrappedToolCallback<A> = (args: A, extra: Extra) => Promise<CallToolResult>

/**
 * Canonicalize args (minus idempotency_key) for MCP idempotency hashing.
 * Recursively sort object keys, compact JSON. Arrays preserve their
 * order — only object keys are sorted.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']'
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function canonicalRequestHash(toolName: string, args: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { idempotency_key: _, ...rest } = args
  return createHash('sha256')
    .update('MCP\0' + toolName + '\0' + canonicalJson(rest))
    .digest('hex')
}

function successResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as CallToolResult['structuredContent'],
  }
}

function errorResult(err: unknown): CallToolResult {
  const env = mapErrorToEnvelope(err)
  return {
    isError: true,
    content: [{ type: 'text', text: `${env.code}: ${env.message}` }],
    structuredContent: {
      error: { code: env.code, message: env.message, details: env.details },
    },
  }
}

/**
 * Wrap a business handler with the auth → cross-blog → idempotency →
 * error-envelope pipeline. Every MCP tool registration goes through
 * this. Config is explicit (first arg) so multiple McpServer instances
 * in the same process don't collide on a global, and so tests can
 * stand up an isolated server without module state.
 */
export function wrapTool<A extends Record<string, unknown> = Record<string, unknown>>(
  config: McpServerConfig,
  name: string,
  opts: WrapToolOpts,
  business: ToolBusiness<A>,
): WrappedToolCallback<A> {
  return async (args, extra) => {
    try {
      const ctx: ToolCtx = { store: config.store, config }

      // Step 1: Auth
      if (opts.auth === 'required') {
        if (config.authMode === 'none') {
          if (!opts.crossBlogGuard) {
            throw new SlopItError(
              'UNAUTHORIZED',
              "Tool requires authentication but authMode: 'none' cannot resolve blog without crossBlogGuard",
            )
          }
          const blogId = args.blog_id
          if (typeof blogId !== 'string') {
            throw new SlopItError('BLOG_NOT_FOUND', 'Missing or invalid blog_id', {})
          }
          ctx.blog = getBlogInternal(config.store, blogId)
          ctx.apiKeyHash = ''
        } else {
          const bearer = resolveBearer(extra, config)
          if (!bearer) throw new SlopItError('UNAUTHORIZED', 'Missing bearer token')
          const blog = verifyApiKey(config.store, bearer)
          if (!blog) throw new SlopItError('UNAUTHORIZED', 'Invalid API key')
          ctx.blog = blog
          ctx.apiKeyHash = hashApiKey(bearer)
        }
      }

      // Step 2: Cross-blog guard
      if (opts.crossBlogGuard && ctx.blog) {
        const blogId = args.blog_id
        if (typeof blogId === 'string' && blogId !== ctx.blog.id) {
          throw new SlopItError('BLOG_NOT_FOUND', `Blog "${blogId}" does not exist`, {
            blog_id: blogId,
          })
        }
      }

      // Step 3: Idempotency lookup
      const idemKey = typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined
      let idemScope: IdempotencyScope | undefined
      if (opts.idempotent === true && idemKey !== undefined && !!ctx.apiKeyHash) {
        idemScope = {
          key: idemKey,
          apiKeyHash: ctx.apiKeyHash,
          method: 'MCP',
          path: name,
          requestHash: canonicalRequestHash(name, args),
        }
        const result = lookupIdempotencyRecord(config.store, idemScope)
        if (result.status === 'hit-match') {
          return successResult(JSON.parse(result.body))
        }
        if (result.status === 'hit-mismatch') {
          throw new SlopItError(
            'IDEMPOTENCY_KEY_CONFLICT',
            `Idempotency-Key "${idemKey}" already used with a different payload for MCP tool ${name}`,
            { key: idemKey, method: 'MCP', path: name },
          )
        }
      }

      // Step 4: Run business
      const result = await business(args, ctx)

      // Step 5: Record on success
      if (idemScope !== undefined) {
        recordIdempotencyResponse(config.store, idemScope, JSON.stringify(result), 200)
      }

      // Step 6: Success envelope
      return successResult(result)
    } catch (err) {
      // Step 7: Error envelope
      return errorResult(err)
    }
  }
}
