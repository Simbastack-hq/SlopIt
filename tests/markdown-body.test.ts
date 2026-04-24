import { describe, expect, it } from 'vitest'
import { parseMarkdownBody } from '../src/api/markdown-body.js'

describe('parseMarkdownBody', () => {
  it('parses minimal input: title from query, body from raw', () => {
    const parsed = parseMarkdownBody({
      body: '# Hello\n\nBody text.',
      query: new URLSearchParams({ title: 'Hello' }),
    })
    expect(parsed.title).toBe('Hello')
    expect(parsed.body).toBe('# Hello\n\nBody text.')
    expect(parsed.status).toBeUndefined() // default applied by Zod later
  })

  it('parses all supported query params', () => {
    const parsed = parseMarkdownBody({
      body: 'body',
      query: new URLSearchParams({ title: 'T', status: 'draft', slug: 's', tags: 'a,b,c' }),
    })
    expect(parsed.title).toBe('T')
    expect(parsed.status).toBe('draft')
    expect(parsed.slug).toBe('s')
    expect(parsed.tags).toEqual(['a', 'b', 'c'])
  })

  it('splits tags on comma and trims whitespace', () => {
    const parsed = parseMarkdownBody({
      body: 'b',
      query: new URLSearchParams({ title: 'T', tags: 'a, b ,c' }),
    })
    expect(parsed.tags).toEqual(['a', 'b', 'c'])
  })

  it('throws when title is missing', () => {
    expect(() => parseMarkdownBody({ body: 'b', query: new URLSearchParams() })).toThrow(/title/i)
  })

  it('throws when body is empty', () => {
    expect(() =>
      parseMarkdownBody({ body: '', query: new URLSearchParams({ title: 'T' }) }),
    ).toThrow()
  })

  it('ignores unknown query params (e.g. seoTitle) silently', () => {
    const parsed = parseMarkdownBody({
      body: 'b',
      query: new URLSearchParams({ title: 'T', seoTitle: 'ignored' }),
    })
    expect((parsed as Record<string, unknown>).seoTitle).toBeUndefined()
  })
})
