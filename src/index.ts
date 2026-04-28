// Public surface of @slopit/core. Keep this file small and deliberate —
// every export here is a promise to consumers. See ARCHITECTURE.md.

export { createStore } from './db/store.js'
export type { Store, StoreConfig } from './db/store.js'

export * from './schema/index.js'

// Blog primitives
export { createBlog, createApiKey, getBlog, getBlogByName, getBlogsByEmail } from './blogs.js'

// Signup orchestration — single source of truth for REST + MCP signup.
export { signupBlog } from './signup.js'
export type { OnSignupHook, SignupConfig, SignupResult } from './signup.js'

// Recovery primitives — two-step email recovery flow. Platform owns the
// HTTP routes, email sending, and rate limiting; core owns the data
// layer (token storage, validation, atomic key rotation).
export { requestRecoveryByEmail, consumeRecoveryToken } from './recovery.js'
export type { RecoveryRequestResult, RecoveryConsumeResult } from './recovery.js'

// Post primitives
export { createPost, updatePost, deletePost, getPost, listPosts } from './posts.js'

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

// MCP stub — kept exported per v2.1 spec P2 fix. feat/mcp-tools replaces
// the stub body with the real implementation.
export { createMcpServer } from './mcp/server.js'
export type { McpServerConfig } from './mcp/server.js'
