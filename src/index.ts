// Public surface of @slopit/core. Keep this file small and deliberate —
// every export here is a promise to consumers. See ARCHITECTURE.md.

export { createStore } from './db/store.js'
export type { Store, StoreConfig } from './db/store.js'

export * from './schema/index.js'

// Blog primitives
export {
  createBlog,
  createApiKey,
  getBlog,
  getBlogByName,
  getBlogsByEmail,
  updateBlog,
} from './blogs.js'

// Signup orchestration — single source of truth for REST + MCP signup.
export { signupBlog } from './signup.js'
export type { OnSignupHook, SignupConfig, SignupResult } from './signup.js'

// Recovery primitives — two-step email recovery flow. Platform owns the
// HTTP routes, email sending, and rate limiting; core owns the data
// layer (token storage, validation, atomic key rotation).
export { requestRecoveryByEmail, consumeRecoveryToken } from './recovery.js'
export type { RecoveryRequestResult, RecoveryConsumeResult } from './recovery.js'

// Post primitives
export {
  createPost,
  updatePost,
  deletePost,
  getPost,
  listPosts,
  listBlogLanguages,
} from './posts.js'
export type { TranslationPolicy } from './posts.js'

// Media primitives
export { uploadMedia, listMedia, getMedia, deleteMedia } from './media.js'
export type { MediaRow, MediaWithUrl, MediaLimits, UploadInput } from './media.js'

// Auth
export { verifyApiKey } from './auth/api-key.js'

// Errors
export { SlopItError } from './errors.js'
export type { SlopItErrorCode } from './errors.js'

// Rendering
export { createRenderer } from './rendering/generator.js'
export type { Renderer, MutationRenderer, RendererConfig } from './rendering/generator.js'

// REST router factory
export { createApiRouter } from './api/index.js'
export type { ApiRouterConfig } from './api/index.js'

// Generators (pure; platform serves, core produces)
export { generateOnboardingBlock } from './onboarding.js'
export type { OnboardingInputs } from './onboarding.js'
export { generateSkillFile } from './skill.js'

// MCP server factory. Returns an unattached SDK McpServer with every core
// tool registered; the consumer connects a transport.
export { createMcpServer } from './mcp/server.js'
export type { McpServerConfig } from './mcp/server.js'
// Consumers can register their own tools on the returned server and wrap
// them with wrapTool to get the same auth, cross-blog guard and error envelope.
export { wrapTool } from './mcp/wrap-tool.js'
export type { ToolCtx, WrapToolOpts } from './mcp/wrap-tool.js'
