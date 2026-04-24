import type { Context, MiddlewareHandler } from 'hono'
import type { Store } from '../db/store.js'
import type { Blog } from '../schema/index.js'
import { SlopItError } from '../errors.js'
import { getBlogInternal } from '../blogs.js'
import { verifyApiKey, hashApiKey } from './../auth/api-key.js'

export interface AuthMiddlewareConfig {
  store: Store
  authMode: 'api_key' | 'none'
}

// Skip list keyed by route path relative to this subapp, NOT the full
// URL. Using a relative path means the router still behaves correctly
// when mounted under a prefix (e.g. app.route('/api', createApiRouter(...))).
const SKIP_RELATIVE_PATHS = new Set(['/health', '/signup', '/schema', '/bridge/report_bug'])

type AuthVars = { blog: Blog; apiKeyHash: string }

/**
 * Derive this subapp's mount prefix from the middleware's own matched
 * routePath. When registered via `app.use('*', ...)`, Hono sets
 * `c.req.routePath` to `'/*'` at root mount, `/api/*` when mounted at
 * `/api`, etc. Stripping the trailing `/*` gives us the prefix.
 *
 * Everything downstream of this file (skip list, :id extraction) works
 * on the *relative* path so mounting is transparent.
 */
function relativePath(c: Context): string {
  const rp = c.req.routePath
  const mount = rp.endsWith('/*') ? rp.slice(0, -2) : ''
  return mount && c.req.path.startsWith(mount) ? c.req.path.slice(mount.length) : c.req.path
}

function extractIdFromRelPath(relPath: string): string | undefined {
  const m = relPath.match(/^\/(?:blogs|b)\/([^/?]+)/)
  return m ? m[1] : undefined
}

/**
 * Resolves the authenticated blog and attaches it (plus the api-key hash
 * for idempotency scoping) to c.var. Skips /health, /signup, /schema,
 * /bridge/report_bug and any OPTIONS request.
 *
 * For authMode='api_key' (default): requires Bearer token, calls
 * verifyApiKey. On null → UNAUTHORIZED 401.
 *
 * For authMode='none' (self-hosted): loads blog from the :id route
 * param. No token required. apiKeyHash is the empty string.
 *
 * Cross-blog guard: if :id doesn't match the resolved blog's id →
 * BLOG_NOT_FOUND (spec decision #18 — don't leak existence).
 *
 * Mount-safety: skip-list matching and :id extraction both operate on
 * the path relative to this subapp, so the router works identically
 * whether it is served at root or mounted under a prefix.
 */
export function authMiddleware(
  config: Pick<AuthMiddlewareConfig, 'store' | 'authMode'>,
): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    const relPath = relativePath(c)
    if (SKIP_RELATIVE_PATHS.has(relPath)) return next()

    const idParam = extractIdFromRelPath(relPath)

    if (config.authMode === 'none') {
      if (idParam === undefined) return next()
      const blog = getBlogInternal(config.store, idParam) // throws BLOG_NOT_FOUND
      c.set('blog', blog)
      c.set('apiKeyHash', '')
      return next()
    }

    // authMode === 'api_key'
    const auth = c.req.header('Authorization')
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new SlopItError('UNAUTHORIZED', 'Missing or malformed Authorization header')
    }
    const key = auth.slice('Bearer '.length).trim()
    const blog = verifyApiKey(config.store, key)
    if (!blog) {
      throw new SlopItError('UNAUTHORIZED', 'Invalid API key')
    }

    if (idParam !== undefined && idParam !== blog.id) {
      throw new SlopItError('BLOG_NOT_FOUND', `Blog "${idParam}" does not exist`, {
        blogId: idParam,
      })
    }

    c.set('blog', blog)
    c.set('apiKeyHash', hashApiKey(key))
    await next()
  }
}
