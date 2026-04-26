import { createApiKey, createBlog } from './blogs.js'
import { SlopItError } from './errors.js'
import { generateOnboardingBlock } from './onboarding.js'
import type { MutationRenderer } from './rendering/generator.js'
import type { Blog } from './schema/index.js'
import { CreateBlogInputSchema } from './schema/index.js'
import type { Store } from './db/store.js'

/**
 * Hook fired after a blog + API key are created. Platform passes a
 * concrete sender (Resend, SES, SMTP, …); self-hosters can omit the hook
 * entirely. Awaited but its failure does NOT fail the signup — the user
 * still gets their blog + key in the response. `email_sent` reflects
 * whether the hook resolved without throwing.
 */
export type OnSignupHook = (params: { blog: Blog; apiKey: string; email: string }) => Promise<void>

/**
 * Structural subset of ApiRouterConfig / McpServerConfig that
 * `signupBlog` actually depends on. Lets REST and MCP share the same
 * orchestration without dragging in fields neither path uses (authMode,
 * etc). Both consumer configs satisfy this shape via TS structural
 * typing — no casts at the call sites.
 */
export interface SignupConfig {
  store: Store
  rendererFor: (blog: Blog) => MutationRenderer
  baseUrl: string
  mcpEndpoint?: string
  docsUrl?: string
  skillUrl?: string
  bugReportUrl?: string
  dashboardUrl?: string
  onSignup?: OnSignupHook
  /**
   * Optional policy hook for blog names. Runs AFTER core's structural
   * validation (length, regex) but BEFORE persistence. Core treats names
   * as opaque DNS-safe strings; the platform wires this to enforce
   * reserved-subdomain, length-floor, and profanity rules. Skipped when
   * `name` is not provided. A rejection becomes a `BLOG_NAME_RESERVED`
   * error with the validator's `reason` as the message.
   */
  nameValidator?: (name: string) => { ok: true } | { ok: false; reason: string }
}

export interface SignupResult {
  blog: Blog
  apiKey: string
  blogUrl: string
  onboardingText: string
  /** Whether the welcome email was sent successfully. False if no email
   * was provided OR the hook threw OR no hook was wired. */
  emailSent: boolean
}

/**
 * Single source of truth for blog + API key signup. REST `/signup` and
 * MCP `signup` both call this so they cannot drift on validation,
 * persistence, hook semantics, or onboarding text. Returns the assembled
 * response plus `emailSent` — the transport layer adapts shape but
 * never re-implements the steps.
 */
export async function signupBlog(config: SignupConfig, rawInput: unknown): Promise<SignupResult> {
  // Single Zod parse at the boundary. createBlog re-parses defensively;
  // that's cheap and not worth carving out.
  const input = CreateBlogInputSchema.parse(rawInput)
  const email = input.email ?? null

  // Policy check (platform-supplied). Runs only when a name was actually
  // requested — unnamed blogs have nothing to validate. The hook decides
  // its own rules; core just translates a rejection into a structured
  // error so REST and MCP envelopes stay consistent.
  if (input.name !== undefined && config.nameValidator !== undefined) {
    const verdict = config.nameValidator(input.name)
    if (!verdict.ok) {
      throw new SlopItError('BLOG_NAME_RESERVED', verdict.reason, { name: input.name })
    }
  }

  const { blog } = createBlog(config.store, input)
  const { apiKey } = createApiKey(config.store, blog.id)
  const renderer = config.rendererFor(blog)

  let emailSent = false
  if (email !== null && config.onSignup !== undefined) {
    try {
      await config.onSignup({ blog, apiKey, email })
      emailSent = true
    } catch (err) {
      // Hook failures are best-effort; signup still succeeds. Surfaced
      // to the caller via emailSent: false so onboarding copy stays
      // honest ("save this key NOW") instead of falsely claiming a
      // copy was sent.
      const message = err instanceof Error ? err.message : String(err)
      console.error('[slopit] onSignup hook failed; signup continues without email:', message)
    }
  }

  const onboardingText = generateOnboardingBlock({
    blog,
    apiKey,
    blogUrl: renderer.baseUrl,
    baseUrl: config.baseUrl,
    schemaUrl: `${config.baseUrl}/schema`,
    mcpEndpoint: config.mcpEndpoint,
    dashboardUrl: config.dashboardUrl,
    docsUrl: config.docsUrl,
    skillUrl: config.skillUrl,
    bugReportUrl: config.bugReportUrl,
    emailProvided: email !== null,
    emailSent,
  })

  return {
    blog,
    apiKey,
    blogUrl: renderer.baseUrl,
    onboardingText,
    emailSent,
  }
}
