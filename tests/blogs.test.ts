import { describe, expect, it } from 'vitest'
import { isBlogNameConflict } from '../src/blogs.js'

function sqliteUniqueError(constraint: string): Error {
  const e = new Error(`UNIQUE constraint failed: ${constraint}`) as NodeJS.ErrnoException
  e.code = 'SQLITE_CONSTRAINT_UNIQUE'
  return e
}

describe('isBlogNameConflict', () => {
  it('is true for UNIQUE errors on blogs.name', () => {
    expect(isBlogNameConflict(sqliteUniqueError('blogs.name'))).toBe(true)
  })

  it('is false for UNIQUE errors on other columns', () => {
    expect(isBlogNameConflict(sqliteUniqueError('blogs.id'))).toBe(false)
    expect(isBlogNameConflict(sqliteUniqueError('api_keys.id'))).toBe(false)
    expect(isBlogNameConflict(sqliteUniqueError('api_keys.key_hash'))).toBe(false)
  })

  it('is false for non-UNIQUE DB errors, plain Errors, and non-errors', () => {
    const fkErr = new Error('FOREIGN KEY constraint failed') as NodeJS.ErrnoException
    fkErr.code = 'SQLITE_CONSTRAINT_FOREIGNKEY'
    expect(isBlogNameConflict(fkErr)).toBe(false)

    // Missing code field — bare message match is not enough
    expect(isBlogNameConflict(new Error('UNIQUE constraint failed: blogs.name'))).toBe(false)

    expect(isBlogNameConflict(null)).toBe(false)
    expect(isBlogNameConflict(undefined)).toBe(false)
    expect(isBlogNameConflict('not an error')).toBe(false)
    expect(isBlogNameConflict({ code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'blogs.name' })).toBe(false)
  })
})

import { CreateBlogInputSchema } from '../src/schema/index.js'

describe('CreateBlogInputSchema', () => {
  it('accepts empty input; name undefined, theme defaults to minimal', () => {
    const parsed = CreateBlogInputSchema.parse({})
    expect(parsed.name).toBeUndefined()
    expect(parsed.theme).toBe('minimal')
  })

  it('accepts valid DNS-safe names', () => {
    for (const name of ['ai', 'ai-thoughts', 'hot-takes-2026', 'abc', 'a2b', 'a'.repeat(63)]) {
      expect(() => CreateBlogInputSchema.parse({ name })).not.toThrow()
    }
  })

  it('accepts all three valid themes', () => {
    for (const theme of ['minimal', 'classic', 'zine'] as const) {
      expect(CreateBlogInputSchema.parse({ theme }).theme).toBe(theme)
    }
  })

  it('rejects invalid theme', () => {
    expect(() => CreateBlogInputSchema.parse({ theme: 'fancy' })).toThrow()
  })

  it.each([
    ['too short (1 char)', 'a'],
    ['leading hyphen', '-abc'],
    ['trailing hyphen', 'abc-'],
    ['uppercase', 'AiThoughts'],
    ['underscore', 'ai_thoughts'],
    ['space', 'ai thoughts'],
    ['too long (64 chars)', 'a'.repeat(64)],
    ['empty string', ''],
    ['only hyphens', '---'],
  ])('rejects name: %s', (_, name) => {
    expect(() => CreateBlogInputSchema.parse({ name })).toThrow()
  })
})
