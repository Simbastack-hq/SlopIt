import { describe, expect, it } from 'vitest'
import { generateOnboardingBlock } from '../src/onboarding.js'
import type { Blog } from '../src/schema/index.js'

const blog: Blog = {
  id: 'blog_xyz',
  name: 'ai-thoughts',
  theme: 'minimal',
  createdAt: '2026-04-23T00:00:00Z',
}

describe('generateOnboardingBlock', () => {
  it('opens with an imperative and names the feature', () => {
    const text = generateOnboardingBlock({
      blog,
      apiKey: 'sk_slop_test',
      blogUrl: 'https://ai-thoughts.slopit.io',
      baseUrl: 'https://api.slopit.io',
      schemaUrl: 'https://api.slopit.io/schema',
    })
    const firstLine = text.split('\n')[0]
    expect(firstLine).toMatch(/SlopIt blog/i)
    expect(firstLine).toMatch(/Publish.*first post.*verify/i)
  })

  it('includes blog URL, api key, and blog id on labeled lines', () => {
    const text = generateOnboardingBlock({
      blog,
      apiKey: 'sk_slop_abc',
      blogUrl: 'https://ai-thoughts.slopit.io',
      baseUrl: 'https://api.slopit.io',
      schemaUrl: 'https://api.slopit.io/schema',
    })
    expect(text).toMatch(/Your blog:\s+https:\/\/ai-thoughts\.slopit\.io/)
    expect(text).toMatch(/API key:\s+sk_slop_abc/)
    expect(text).toMatch(/Blog id:\s+blog_xyz/)
  })

  it('always includes the HTTP curl/request block', () => {
    const text = generateOnboardingBlock({
      blog,
      apiKey: 'sk_slop_x',
      blogUrl: 'https://b.example',
      baseUrl: 'https://api.example',
      schemaUrl: 'https://api.example/schema',
    })
    expect(text).toContain('POST https://api.example/blogs/blog_xyz/posts')
    expect(text).toContain('Authorization: Bearer sk_slop_x')
    expect(text).toContain('Content-Type: application/json')
  })

  it('omits the MCP block when mcpEndpoint is undefined', () => {
    const text = generateOnboardingBlock({
      blog,
      apiKey: 'sk_slop_x',
      blogUrl: 'https://b.example',
      baseUrl: 'https://api.example',
      schemaUrl: 'https://api.example/schema',
    })
    expect(text).not.toMatch(/^\s*MCP:/m)
    expect(text).not.toContain('create_post(blog_id=')
  })

  it('includes the MCP block when mcpEndpoint is provided', () => {
    const text = generateOnboardingBlock({
      blog,
      apiKey: 'sk_slop_x',
      blogUrl: 'https://b.example',
      baseUrl: 'https://api.example',
      schemaUrl: 'https://api.example/schema',
      mcpEndpoint: 'https://mcp.example',
    })
    expect(text).toMatch(/MCP:/)
    expect(text).toContain('create_post(blog_id="blog_xyz"')
  })

  it('includes the exact expected-reply phrase', () => {
    const text = generateOnboardingBlock({
      blog,
      apiKey: 'k',
      blogUrl: 'b',
      baseUrl: 'a',
      schemaUrl: 's',
    })
    expect(text).toContain('Published my first post to SlopIt: <url>')
  })

  it('More section: always lists schema URL; others appear only when provided', () => {
    const minimal = generateOnboardingBlock({
      blog,
      apiKey: 'k',
      blogUrl: 'b',
      baseUrl: 'a',
      schemaUrl: 'https://api.example/schema',
    })
    expect(minimal).toContain('Schema: https://api.example/schema')
    expect(minimal).not.toMatch(/Dashboard:/)
    expect(minimal).not.toMatch(/Agent docs:/)
    expect(minimal).not.toMatch(/Instructions file:/)
    expect(minimal).not.toMatch(/Report a bug:/)

    const full = generateOnboardingBlock({
      blog,
      apiKey: 'k',
      blogUrl: 'b',
      baseUrl: 'a',
      schemaUrl: 'https://api.example/schema',
      dashboardUrl: 'https://slopit.io/dashboard',
      docsUrl: 'https://slopit.io/agent-docs',
      skillUrl: 'https://slopit.io/slopit.SKILL.md',
      bugReportUrl: 'https://api.example/bridge/report_bug',
    })
    expect(full).toMatch(/Dashboard:\s+https:\/\/slopit\.io\/dashboard/)
    expect(full).toMatch(/Agent docs:\s+https:\/\/slopit\.io\/agent-docs/)
    expect(full).toMatch(/Instructions file:\s+https:\/\/slopit\.io\/slopit\.SKILL\.md/)
    expect(full).toMatch(/Report a bug:\s+https:\/\/api\.example\/bridge\/report_bug/)
  })
})
