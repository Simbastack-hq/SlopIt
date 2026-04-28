import { describe, expect, it } from 'vitest'
import { buildLinks } from '../src/api/links.js'
import type { Blog } from '../src/schema/index.js'
import type { Renderer } from '../src/rendering/generator.js'

const blog: Blog = { id: 'b1', name: 'test', theme: 'minimal', createdAt: '2026-04-23T00:00:00Z' }

const API = 'https://slopit.io/api'

const makeRenderer = (baseUrl: string): Renderer => ({
  baseUrl,
  renderPost: () => {},
  renderBlog: () => {},
})

describe('buildLinks', () => {
  it('emits absolute URLs anchored on baseUrl for all API links', () => {
    const links = buildLinks(blog, {
      baseUrl: API,
      rendererFor: () => makeRenderer('https://b1.example'),
    })
    expect(links.view).toBe('https://b1.example')
    expect(links.publish).toBe(`${API}/blogs/b1/posts`)
    expect(links.list_posts).toBe(`${API}/blogs/b1/posts`)
    expect(links.upload_media).toBe(`${API}/blogs/b1/media`)
    expect(links.list_media).toBe(`${API}/blogs/b1/media`)
    expect(links.bridge).toBe(`${API}/bridge/report_bug`)
  })

  it('respects a baseUrl mounted at root (self-hosted scenario)', () => {
    const links = buildLinks(blog, {
      baseUrl: 'https://my-blog.example',
      rendererFor: () => makeRenderer('https://my-blog.example'),
    })
    expect(links.publish).toBe('https://my-blog.example/blogs/b1/posts')
    expect(links.bridge).toBe('https://my-blog.example/bridge/report_bug')
  })

  it('includes dashboard and docs only when configured', () => {
    const minimal = buildLinks(blog, {
      baseUrl: API,
      rendererFor: () => makeRenderer('https://x'),
    })
    expect(minimal.dashboard).toBeUndefined()
    expect(minimal.docs).toBeUndefined()

    const full = buildLinks(blog, {
      baseUrl: API,
      rendererFor: () => makeRenderer('https://x'),
      dashboardUrl: 'https://slopit.io/dashboard',
      docsUrl: 'https://slopit.io/agent-docs',
    })
    expect(full.dashboard).toBe('https://slopit.io/dashboard')
    expect(full.docs).toBe('https://slopit.io/agent-docs')
  })

  it('view URL comes from rendererFor(blog).baseUrl (per-blog)', () => {
    const links = buildLinks(blog, {
      baseUrl: API,
      rendererFor: (b) => makeRenderer(`https://${b.name}.slopit.io`),
    })
    expect(links.view).toBe('https://test.slopit.io')
  })
})
