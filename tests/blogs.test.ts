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
