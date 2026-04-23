import { randomBytes } from 'node:crypto'

// 32 URL-safe characters (no I/l/o/0/1). Power of 2 → modulo is unbiased.
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

/**
 * Generate an 8-char URL-safe id.
 *
 * Used for `blogs.id` and `api_keys.id` and `posts.id`. 32^8 ≈ 1.1 trillion
 * combinations — astronomically safe against random collision at any scale we'll hit.
 */
export function generateShortId(): string {
  const bytes = randomBytes(8)
  return Array.from(bytes, (b) => ID_ALPHABET[b % 32]).join('')
}

/**
 * Kebab-case a title into a DNS-safe slug:
 * - NFKD-normalize and strip combining marks (é → e, naïve → naive)
 * - Lowercase
 * - Replace any run of non-[a-z0-9] characters with a single hyphen
 * - Trim leading/trailing hyphens
 * - Truncate to 100 characters and re-trim a trailing hyphen that the slice may have introduced
 *
 * Returns an empty string when the title has no slug-compatible characters
 * (e.g. pure punctuation, emojis, or non-Latin scripts that NFKD can\'t
 * decompose into ASCII). Callers using auto-slug must check for empty
 * output — the input schema enforces this via superRefine.
 */
export function generateSlug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/, '')
}
