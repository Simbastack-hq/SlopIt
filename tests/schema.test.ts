import { describe, expect, it } from 'vitest'
import { PostPatchSchema, type PostPatchInput } from '../src/schema/index.js'

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
