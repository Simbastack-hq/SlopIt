import { Hono } from 'hono'
import type { Store } from '../db/store.js'
import type { MutationRenderer } from '../rendering/generator.js'
import type { Blog } from '../schema/index.js'
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
