import { Hono } from 'hono'
import type { Store } from '../db/store.js'
import type { MutationRenderer } from '../rendering/generator.js'
import type { Blog } from '../schema/index.js'
import type { OnSignupHook } from '../signup.js'
import { errorMiddleware } from './errors.js'
import { authMiddleware } from './auth.js'
import { idempotencyMiddleware } from './idempotency.js'
import { mountRoutes } from './routes.js'

export interface ApiRouterConfig {
  store: Store
  /**
   * Per-blog renderer. MUST return a MutationRenderer (not just a
   * Renderer) so mutation primitives (updatePost, deletePost) have
   * file-cleanup available. Shipped `createRenderer` returns
   * MutationRenderer; see spec decision #19 + plan Task 5.4.
   */
  rendererFor: (blog: Blog) => MutationRenderer
  baseUrl: string
  authMode?: 'api_key' | 'none'
  mcpEndpoint?: string
  docsUrl?: string
  skillUrl?: string
  bugReportUrl?: string
  dashboardUrl?: string
  /**
   * Per-file upload cap in bytes. Default 5_000_000 (5 MB) when undefined.
   * Function form lets platform pass plan-tier values per-blog.
   * Platform passes plan-tier values; self-hosted leaves unset.
   */
  mediaMaxBytes?: number | ((blog: Blog) => number)
  /**
   * Per-blog total media cap in bytes. `null` = unlimited (default).
   * Function form lets platform return null for paid tiers and a finite
   * cap for free.
   * Platform passes plan-tier values; self-hosted leaves unset.
   */
  mediaMaxTotalBytesPerBlog?: number | null | ((blog: Blog) => number | null)
  /**
   * Optional hook fired after a blog + API key are created at signup,
   * if (and only if) the caller provided an email. Platform wires this
   * to its email sender (Resend, etc); self-hosters can omit it. Hook
   * failures are best-effort and reported via `email_sent: false` in
   * the signup response — they never fail the signup itself.
   */
  onSignup?: OnSignupHook
}

type Vars = { blog: Blog; apiKeyHash: string }

/**
 * Factory for the core REST router. Consumers mount this under their
 * own Hono instance. See the spec for the full route list + auth model.
 */
export function createApiRouter(config: ApiRouterConfig): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>()
  app.onError(errorMiddleware)
  app.use('*', authMiddleware({ store: config.store, authMode: config.authMode ?? 'api_key' }))
  app.use('*', idempotencyMiddleware({ store: config.store }))
  mountRoutes(app, config)
  return app
}
