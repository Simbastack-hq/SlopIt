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
export type { BlogWriteOptions, BrandPolicy } from './blogs.js'

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
// Scheduled publishing: hosts call publishDuePosts on a timer.
export { publishDuePosts } from './schedule.js'
export type { DuePublishResult } from './schedule.js'

// Live-fact primitives. drainPendingFactRenders is for hosts to call at
// boot: it finishes fact re-renders a crash or failure left pending.
export { setFact, listFacts, getFact, deleteFact, drainPendingFactRenders } from './facts.js'
export type {
  AffectedPost,
  Fact,
  FactUse,
  FactWithUses,
  SetFactInput,
  SetFactResult,
} from './facts.js'

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
// A blog's brand re-checked for rendering (bad stored values → unset), for
// consumers that render their own pages for a blog (platform's 404 page).
export { renderableBrand } from './rendering/brand.js'
// The safe markdown renderer posts use (raw HTML stripped, heading ids,
// scrollable tables), for hosts rendering their own pages from markdown
// (platform's /docs page renders the SKILL file with it).
export { renderMarkdown } from './rendering/markdown.js'

// REST router factory
export { createApiRouter } from './api/index.js'
export { previewFields, type PreviewUrlFor } from './preview.js'
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
