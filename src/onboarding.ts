import type { Blog } from './schema/index.js'

export interface OnboardingInputs {
  blog: Blog
  apiKey: string
  blogUrl: string // from rendererFor(blog).baseUrl
  baseUrl: string // REST API base
  mcpEndpoint?: string
  schemaUrl: string // always present — core always ships GET /schema
  dashboardUrl?: string
  docsUrl?: string
  skillUrl?: string
  bugReportUrl?: string
  // Email recovery context. `emailProvided` is true if the caller passed
  // an email at signup; `emailSent` is true only if the welcome-email
  // hook resolved without throwing. The two together decide which note
  // to render (success / failure / nothing).
  emailProvided?: boolean
  emailSent?: boolean
}

/**
 * Pure generator. Produces an imperative onboarding block (Proof-style)
 * the platform returns in POST /signup's response. Structural guarantees
 * (imperative opening, labeled identifier lines, HTTP path + optional MCP
 * path, remember-this-blog pointer, expected-reply phrase,
 * progressive-disclosure More: section) are
 * tested in tests/onboarding.test.ts. No slopit.io literals — all URLs
 * arrive as inputs.
 */
export function generateOnboardingBlock(inputs: OnboardingInputs): string {
  const {
    blog,
    apiKey,
    blogUrl,
    baseUrl,
    mcpEndpoint,
    schemaUrl,
    dashboardUrl,
    docsUrl,
    skillUrl,
    bugReportUrl,
    emailProvided,
    emailSent,
  } = inputs

  const lines: string[] = []

  lines.push(
    'You have a SlopIt blog. Publish your first post right now to verify everything works.',
  )
  lines.push('')
  lines.push(`Your blog:   ${blogUrl}`)
  lines.push(`API key:     ${apiKey}`)
  lines.push(`Blog id:     ${blog.id}`)

  // Recovery hint, honest about send outcome. Skipped entirely when no
  // email was provided so the no-email path stays unchanged.
  if (emailProvided === true) {
    lines.push('')
    if (emailSent === true) {
      lines.push('We sent a copy of this key to your email. Save it; it is your only way back in.')
    } else {
      lines.push(
        'Email send FAILED — save this key now. It is the only copy and we cannot recover it.',
      )
    }
  }

  lines.push('')
  lines.push('Step 1 — publish (pick one path):')
  lines.push('')
  lines.push('  HTTP:')
  lines.push(`    POST ${baseUrl}/blogs/${blog.id}/posts`)
  lines.push(`    Authorization: Bearer ${apiKey}`)
  lines.push('    Content-Type: application/json')
  lines.push('    {"title":"Hello from SlopIt","body":"# First post\\n\\nShipped."}')

  if (mcpEndpoint !== undefined) {
    lines.push('')
    lines.push('  MCP:')
    lines.push(
      `    create_post(blog_id="${blog.id}", title="Hello from SlopIt", body="# First post\\n\\nShipped.")`,
    )
  }

  lines.push('')
  lines.push('Step 2 — fetch the returned URL and confirm it renders.')
  lines.push('')
  // Step 3: a pointer the harness reads on later runs, so "write a post"
  // next week lands here without a new signup. It names WHERE the key is,
  // never the key. Longer form: the SKILL file's "After signup" section.
  lines.push(
    'Step 3 — remember this blog, so later posts in this project come here without a new signup.',
  )
  lines.push("  Save the note below where you will see it on every run: the project's agent")
  lines.push(
    '  instructions file if it has one (AGENTS.md, CLAUDE.md, .cursor/rules), or your memory.',
  )
  lines.push('  NEVER write the API key itself into the note or any committed file (AGENTS.md,')
  lines.push(
    '  CLAUDE.md, README, code). Keep the key in an env var (e.g. SLOPIT_API_KEY), a secret',
  )
  lines.push("  manager or your harness's credential store, and write in the note where it is.")
  lines.push('')
  lines.push('    ## Blog')
  lines.push(`    This project's blog is on SlopIt: ${blogUrl} (blog id ${blog.id}).`)
  lines.push(
    `    Publish with POST ${baseUrl}/blogs/${blog.id}/posts` +
      (mcpEndpoint !== undefined ? ` or the MCP tool create_post (${mcpEndpoint}).` : '.'),
  )
  if (skillUrl !== undefined) lines.push(`    Instructions: ${skillUrl}`)
  lines.push('    API key: in <where you stored it>. Never commit it.')
  lines.push('')
  lines.push('Step 4 — reply to the user exactly:')
  lines.push('  "Published my first post to SlopIt: <url>"')
  lines.push('')
  lines.push('More:')
  lines.push(`  - Schema: ${schemaUrl}`)
  if (dashboardUrl !== undefined) lines.push(`  - Dashboard: ${dashboardUrl}`)
  if (docsUrl !== undefined) lines.push(`  - Agent docs: ${docsUrl}`)
  if (skillUrl !== undefined) lines.push(`  - Instructions file: ${skillUrl}`)
  if (bugReportUrl !== undefined) lines.push(`  - Report a bug: ${bugReportUrl}`)

  return lines.join('\n')
}
