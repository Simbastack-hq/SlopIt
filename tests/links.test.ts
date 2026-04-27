import { describe, expect, it } from 'vitest'
import { buildLinks } from '../src/api/links.js'
import type { Blog } from '../src/schema/index.js'
import type { Renderer } from '../src/rendering/generator.js'

const blog: Blog = { id: 'b1', name: 'test', theme: 'minimal', createdAt: '2026-04-23T00:00:00Z' }

const makeRenderer = (baseUrl: string): Renderer => ({
  baseUrl,
  renderPost: () => {},
  renderBlog: () => {},
})

describe('buildLinks', () => {
  it('always includes view, publish, list_posts, bridge', () => {
    const links = buildLinks(blog, {
      rendererFor: () => makeRenderer('https://b1.example'),
    })
    expect(links.view).toBe('https://b1.example')
    expect(links.publish).toBe('/blogs/b1/posts')
    expect(links.list_posts).toBe('/blogs/b1/posts')
    expect(links.bridge).toBe('/bridge/report_bug')
  })

  it('includes dashboard and docs only when configured', () => {
    const minimal = buildLinks(blog, {
      rendererFor: () => makeRenderer('https://x'),
    })
    expect(minimal.dashboard).toBeUndefined()
    expect(minimal.docs).toBeUndefined()

    const full = buildLinks(blog, {
      rendererFor: () => makeRenderer('https://x'),
      dashboardUrl: 'https://slopit.io/dashboard',
      docsUrl: 'https://slopit.io/agent-docs',
    })
    expect(full.dashboard).toBe('https://slopit.io/dashboard')
    expect(full.docs).toBe('https://slopit.io/agent-docs')
  })

  it('view URL comes from rendererFor(blog).baseUrl (per-blog)', () => {
    const links = buildLinks(blog, {
      rendererFor: (b) => makeRenderer(`https://${b.name}.slopit.io`),
    })
    expect(links.view).toBe('https://test.slopit.io')
  })

  it('includes upload_media and list_media paths', () => {
    const links = buildLinks(blog, {
      rendererFor: () => makeRenderer('https://b1.example'),
    })
    expect(links.upload_media).toBe('/blogs/b1/media')
    expect(links.list_media).toBe('/blogs/b1/media')
  })
})
