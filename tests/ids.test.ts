import { describe, expect, it } from 'vitest'
import { generateShortId, generateSlug } from '../src/ids.js'

describe('generateShortId', () => {
  const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

  it('produces an 8-char string from the expected alphabet', () => {
    const id = generateShortId()
    expect(id).toHaveLength(8)
    for (const ch of id) {
      expect(ALPHABET).toContain(ch)
    }
  })

  it('excludes visually ambiguous characters (I, l, o, 0, 1)', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateShortId()
      expect(id).not.toMatch(/[Ilo01]/)
    }
  })

  it('returns different values on repeated calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generateShortId())
    }
    expect(ids.size).toBeGreaterThan(95)
  })
})

describe('generateSlug', () => {
  it('kebab-cases a standard English title', () => {
    expect(generateSlug('Why AI Slop is the Future')).toBe('why-ai-slop-is-the-future')
  })

  it('strips punctuation', () => {
    expect(generateSlug('Why AI Slop is the Future!')).toBe('why-ai-slop-is-the-future')
    expect(generateSlug('AI & the Creator Economy')).toBe('ai-the-creator-economy')
  })

  it('collapses multiple separators into one hyphen', () => {
    expect(generateSlug('hello   world---foo')).toBe('hello-world-foo')
  })

  it('trims leading and trailing hyphens', () => {
    expect(generateSlug('!!!hello')).toBe('hello')
    expect(generateSlug('hello!!!')).toBe('hello')
    expect(generateSlug('---hello---')).toBe('hello')
  })

  it('strips diacritics (NFKD normalize + combining marks)', () => {
    expect(generateSlug('Café résumé')).toBe('cafe-resume')
    expect(generateSlug('naïve')).toBe('naive')
  })

  it('returns empty string for titles with no slug-compatible characters', () => {
    expect(generateSlug('!!!')).toBe('')
    expect(generateSlug('   ')).toBe('')
    expect(generateSlug('日本語のタイトル')).toBe('')
  })

  it('truncates to 100 chars and re-trims trailing hyphen', () => {
    const long = 'a'.repeat(200)
    expect(generateSlug(long)).toHaveLength(100)

    const longBoundary = 'a'.repeat(99) + '-' + 'b'.repeat(50)
    const result = generateSlug(longBoundary)
    expect(result.endsWith('-')).toBe(false)
  })

  it('lowercases uppercase input', () => {
    expect(generateSlug('HELLO WORLD')).toBe('hello-world')
  })
})
