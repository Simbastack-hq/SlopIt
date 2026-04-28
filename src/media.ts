import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from './db/store.js'
import { SlopItError } from './errors.js'
import { generateShortId } from './ids.js'
import type { MutationRenderer } from './rendering/generator.js'
import type { Blog } from './schema/index.js'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
type AllowedType = (typeof ALLOWED_TYPES)[number]

const EXT_BY_TYPE: Record<AllowedType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export interface MediaRow {
  id: string
  blogId: string
  filename: string
  contentType: AllowedType
  bytes: number
  createdAt: string
}

export interface MediaWithUrl extends MediaRow {
  url: string
}

export interface MediaLimits {
  maxBytes: number
  maxTotalBytesPerBlog: number | null
}

export interface UploadInput {
  filename: string
  contentType: string
  bytes: Uint8Array
}

function isAllowed(ct: string): ct is AllowedType {
  return (ALLOWED_TYPES as readonly string[]).includes(ct)
}

function urlFor(renderer: MutationRenderer, row: MediaRow): string {
  const base = renderer.baseUrl.replace(/\/$/, '')
  return base + '/_media/' + row.id + '.' + EXT_BY_TYPE[row.contentType]
}

export function uploadMedia(
  store: Store,
  renderer: MutationRenderer,
  limits: MediaLimits,
  blog: Blog,
  input: UploadInput,
): MediaWithUrl {
  if (!isAllowed(input.contentType)) {
    throw new SlopItError(
      'MEDIA_TYPE_UNSUPPORTED',
      `Unsupported content_type "${input.contentType}". Allowed: ${ALLOWED_TYPES.join(', ')}.`,
      { content_type: input.contentType, allowed: [...ALLOWED_TYPES] },
    )
  }
  if (input.bytes.length === 0) {
    throw new SlopItError('MEDIA_TOO_LARGE', 'File is empty', { bytes: 0 })
  }
  if (input.bytes.length > limits.maxBytes) {
    throw new SlopItError(
      'MEDIA_TOO_LARGE',
      `File exceeds per-file cap of ${limits.maxBytes} bytes`,
      { max_bytes: limits.maxBytes, bytes: input.bytes.length },
    )
  }

  const id = generateShortId()
  const contentType = input.contentType
  const ext = EXT_BY_TYPE[contentType]
  const now = new Date().toISOString()

  // DB-first transaction (matches posts.ts). Quota check inside.
  const tx = store.db.transaction(() => {
    if (limits.maxTotalBytesPerBlog !== null) {
      const usedRow = store.db
        .prepare('SELECT IFNULL(SUM(bytes), 0) AS used FROM media WHERE blog_id = ?')
        .get(blog.id) as { used: number }
      if (usedRow.used + input.bytes.length > limits.maxTotalBytesPerBlog) {
        throw new SlopItError('MEDIA_QUOTA_EXCEEDED', 'Blog media quota exhausted', {
          used_bytes: usedRow.used,
          quota_bytes: limits.maxTotalBytesPerBlog,
        })
      }
    }
    store.db
      .prepare(
        `INSERT INTO media (id, blog_id, filename, content_type, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, blog.id, input.filename, contentType, input.bytes.length, now)
  })
  tx()

  // File write with compensation on failure (matches posts.ts pattern).
  const dir = renderer.mediaDir(blog.id)
  const finalPath = join(dir, id + '.' + ext)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(finalPath, input.bytes)
  } catch (writeErr) {
    try {
      store.db.prepare('DELETE FROM media WHERE id = ?').run(id)
    } catch {
      /* best-effort */
    }
    try {
      unlinkSync(finalPath)
    } catch {
      /* best-effort */
    }
    throw writeErr
  }

  const row: MediaRow = {
    id,
    blogId: blog.id,
    filename: input.filename,
    contentType,
    bytes: input.bytes.length,
    createdAt: now,
  }
  return { ...row, url: urlFor(renderer, row) }
}

function rowToMedia(r: {
  id: string
  blog_id: string
  filename: string
  content_type: string
  bytes: number
  created_at: string
}): MediaRow {
  if (!isAllowed(r.content_type)) {
    // Type narrowing for TS; row content_type is constrained by the DB writer.
    throw new SlopItError(
      'MEDIA_TYPE_UNSUPPORTED',
      `Stored row has invalid content_type "${r.content_type}"`,
      { content_type: r.content_type },
    )
  }
  return {
    id: r.id,
    blogId: r.blog_id,
    filename: r.filename,
    contentType: r.content_type,
    bytes: r.bytes,
    createdAt: r.created_at,
  }
}

export function listMedia(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
): MediaWithUrl[] {
  const rows = store.db
    .prepare(
      `SELECT id, blog_id, filename, content_type, bytes, created_at
         FROM media WHERE blog_id = ? ORDER BY created_at DESC, rowid DESC`,
    )
    .all(blogId) as Parameters<typeof rowToMedia>[0][]
  return rows.map((r) => {
    const m = rowToMedia(r)
    return { ...m, url: urlFor(renderer, m) }
  })
}

export function getMedia(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  id: string,
): MediaWithUrl {
  const row = store.db
    .prepare(
      `SELECT id, blog_id, filename, content_type, bytes, created_at
         FROM media WHERE blog_id = ? AND id = ?`,
    )
    .get(blogId, id) as Parameters<typeof rowToMedia>[0] | undefined
  if (!row) {
    throw new SlopItError('MEDIA_NOT_FOUND', `Media "${id}" not found`, { id })
  }
  const m = rowToMedia(row)
  return { ...m, url: urlFor(renderer, m) }
}

export function deleteMedia(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  id: string,
): { deleted: true } {
  const m = getMedia(store, renderer, blogId, id) // throws MEDIA_NOT_FOUND
  store.db.prepare('DELETE FROM media WHERE id = ?').run(id)
  const ext = EXT_BY_TYPE[m.contentType]
  const path = join(renderer.mediaDir(blogId), id + '.' + ext)
  try {
    unlinkSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  return { deleted: true }
}
