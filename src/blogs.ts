import { randomBytes } from 'node:crypto'
import type { Store } from './db/store.js'
import { SlopItError } from './errors.js'
import {
  CreateBlogInputSchema,
  type Blog,
  type CreateBlogInput,
} from './schema/index.js'

// 32 URL-safe characters (no I/l/o/0/1). Power of 2 → modulo is unbiased.
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

function generateShortId(): string {
  const bytes = randomBytes(8)
  return Array.from(bytes, (b) => ID_ALPHABET[b % 32]).join('')
}

// Pure predicate so the narrow match logic is testable without running the DB.
export function isBlogNameConflict(err: unknown): boolean {
  return (
    err instanceof Error
    && (err as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE'
    && err.message.includes('blogs.name')
  )
}

export function createBlog(
  store: Store,
  input: CreateBlogInput,
): { blog: Blog } {
  const parsed = CreateBlogInputSchema.parse(input)
  const id = generateShortId()
  const name = parsed.name ?? null
  const theme = parsed.theme

  const insert = store.db.prepare(
    'INSERT INTO blogs (id, name, theme) VALUES (?, ?, ?)',
  )

  try {
    insert.run(id, name, theme)
  } catch (e) {
    if (isBlogNameConflict(e)) {
      throw new SlopItError(
        'BLOG_NAME_CONFLICT',
        `Blog name "${name}" is already taken`,
      )
    }
    throw e
  }

  const row = store.db
    .prepare('SELECT id, name, theme, created_at FROM blogs WHERE id = ?')
    .get(id) as {
      id: string
      name: string | null
      theme: 'minimal' | 'classic' | 'zine'
      created_at: string
    }

  const blog: Blog = {
    id: row.id,
    name: row.name,
    theme: row.theme,
    createdAt: row.created_at,
  }

  return { blog }
}
