import { describe, expect, it } from 'vitest'
import {
  BlogAnalyticsSchema,
  BlogPatchSchema,
  BlogSchema,
  PostPatchSchema,
  type PostPatchInput,
} from '../src/schema/index.js'

describe('PostPatchSchema', () => {
  it('accepts an empty object (no-op patch)', () => {
    expect(() => PostPatchSchema.parse({})).not.toThrow()
  })

  it('accepts patching title only', () => {
    const parsed = PostPatchSchema.parse({ title: 'New title' })
    expect(parsed.title).toBe('New title')
  })

  it('accepts patching status and body', () => {
    const parsed = PostPatchSchema.parse({ status: 'draft', body: 'new body' })
    expect(parsed.status).toBe('draft')
    expect(parsed.body).toBe('new body')
  })

  it('rejects slug in the patch', () => {
    // Zod `.omit({ slug: true })` strips the field; passing it is a strict-mode failure
    // via superRefine-style check. We expect either strip or reject; spec mandates reject.
    const result = PostPatchSchema.safeParse({ slug: 'renamed' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid status values', () => {
    const result = PostPatchSchema.safeParse({ status: 'scheduled' })
    expect(result.success).toBe(false)
  })

  it('trims title whitespace', () => {
    const parsed = PostPatchSchema.parse({ title: '  hello  ' })
    expect(parsed.title).toBe('hello')
  })

  it('PostPatchInput type is compatible', () => {
    const patch: PostPatchInput = { title: 'x' }
    expect(patch.title).toBe('x')
  })
})

describe('BlogAnalyticsSchema', () => {
  it('accepts a Umami-only config', () => {
    const parsed = BlogAnalyticsSchema.parse({
      umami: { siteId: 'abc-123' },
    })
    expect(parsed?.umami?.siteId).toBe('abc-123')
  })

  it('accepts a Plausible-only config', () => {
    const parsed = BlogAnalyticsSchema.parse({
      plausible: { domain: 'example.com' },
    })
    expect(parsed?.plausible?.domain).toBe('example.com')
  })

  it('accepts a Google Analytics config with G- prefix measurement id', () => {
    const parsed = BlogAnalyticsSchema.parse({ googleAnalytics: { measurementId: 'G-ABC123XYZ' } })
    expect(parsed?.googleAnalytics?.measurementId).toBe('G-ABC123XYZ')
  })

  it('accepts multiple providers in one config', () => {
    const parsed = BlogAnalyticsSchema.parse({
      umami: { siteId: 'u' },
      plausible: { domain: 'p.example' },
    })
    expect(parsed?.umami?.siteId).toBe('u')
    expect(parsed?.plausible?.domain).toBe('p.example')
  })

  it('rejects unknown provider keys (strict)', () => {
    expect(() => BlogAnalyticsSchema.parse({ fathom: { siteId: 'y' } })).toThrow()
  })

  it('rejects malformed measurement id', () => {
    expect(() =>
      BlogAnalyticsSchema.parse({ googleAnalytics: { measurementId: 'UA-123' } }),
    ).toThrow()
  })

  // The legacy `scriptUrl` field was an arbitrary-script injection vector
  // (a caller pointed it at an attacker-controlled file). It is removed;
  // the strict provider objects must now reject it as an unknown key so a
  // stale client or a hand-edited payload can't smuggle a script URL back in.
  it('rejects the legacy scriptUrl field (strict)', () => {
    expect(() =>
      BlogAnalyticsSchema.parse({
        umami: { scriptUrl: 'https://evil.example/x.js', siteId: 'x' },
      }),
    ).toThrow()
    expect(() =>
      BlogAnalyticsSchema.parse({
        plausible: { scriptUrl: 'https://evil.example/x.js', domain: 'd' },
      }),
    ).toThrow()
  })

  it('accepts undefined (no analytics configured)', () => {
    expect(BlogAnalyticsSchema.parse(undefined)).toBeUndefined()
  })
})

describe('BlogSchema with analytics', () => {
  it('parses a blog with analytics set', () => {
    const blog = BlogSchema.parse({
      id: 'b1',
      name: 'x',
      theme: 'minimal',
      createdAt: '2026-05-06T00:00:00Z',
      parentSiteUrl: null,
      analytics: { umami: { siteId: 's' } },
    })
    expect(blog.analytics?.umami).toBeDefined()
  })

  it('parses a blog without analytics (backwards-compat)', () => {
    const blog = BlogSchema.parse({
      id: 'b1',
      name: 'x',
      theme: 'minimal',
      createdAt: '2026-05-06T00:00:00Z',
      parentSiteUrl: null,
    })
    expect(blog.analytics).toBeUndefined()
  })
})

describe('BlogSchema with parentSiteUrl', () => {
  it('parses null parentSiteUrl as the unset state', () => {
    const blog = BlogSchema.parse({
      id: 'b1',
      name: 'x',
      theme: 'minimal',
      createdAt: '2026-05-06T00:00:00Z',
      parentSiteUrl: null,
    })
    expect(blog.parentSiteUrl).toBeNull()
  })

  it('parses a configured parentSiteUrl', () => {
    const blog = BlogSchema.parse({
      id: 'b1',
      name: 'x',
      theme: 'minimal',
      createdAt: '2026-05-06T00:00:00Z',
      parentSiteUrl: 'https://example.com',
    })
    expect(blog.parentSiteUrl).toBe('https://example.com')
  })

  it('rejects a non-URL parentSiteUrl', () => {
    expect(() =>
      BlogSchema.parse({
        id: 'b1',
        name: 'x',
        theme: 'minimal',
        createdAt: '2026-05-06T00:00:00Z',
        parentSiteUrl: 'not-a-url',
      }),
    ).toThrow()
  })
})

describe('BlogPatchSchema', () => {
  it('accepts an analytics patch', () => {
    const parsed = BlogPatchSchema.parse({
      analytics: { plausible: { domain: 'd' } },
    })
    expect(parsed.analytics?.plausible?.domain).toBe('d')
  })

  it('accepts an explicit null to clear analytics', () => {
    const parsed = BlogPatchSchema.parse({ analytics: null })
    expect(parsed.analytics).toBeNull()
  })

  it('accepts a parentSiteUrl patch', () => {
    const parsed = BlogPatchSchema.parse({ parentSiteUrl: 'https://example.com' })
    expect(parsed.parentSiteUrl).toBe('https://example.com')
  })

  it('accepts an explicit null to clear parentSiteUrl', () => {
    const parsed = BlogPatchSchema.parse({ parentSiteUrl: null })
    expect(parsed.parentSiteUrl).toBeNull()
  })

  it('rejects a non-URL parentSiteUrl in the patch', () => {
    expect(() => BlogPatchSchema.parse({ parentSiteUrl: 'not-a-url' })).toThrow()
  })

  it('accepts an empty patch (no-op)', () => {
    const parsed = BlogPatchSchema.parse({})
    expect(Object.keys(parsed)).toHaveLength(0)
  })

  it('rejects unknown patch fields (strict)', () => {
    expect(() => BlogPatchSchema.parse({ theme: 'minimal', extra: 1 })).toThrow()
  })
})
