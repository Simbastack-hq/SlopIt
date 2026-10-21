// SQLite's `datetime('now')` (the column defaults in 001_core_init.sql)
// writes `2026-10-21 00:00:53`: UTC, but with a space and no zone. Rows
// created that way reached the sitemap as <lastmod>2026-10-21 00:00:53
// (not a valid W3C datetime) and JSON-LD as a zone-less dateModified.
// Rows written by the app are already ISO 8601. Normalise on read so
// every consumer sees one format: `2026-10-21T00:00:53.000Z`.
const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/

export function isoTimestamp(value: string): string
export function isoTimestamp(value: string | null): string | null
export function isoTimestamp(value: string | null): string | null {
  if (value === null) return null
  const m = SQLITE_UTC.exec(value)
  if (!m) return value
  const ms = (m[3] ?? '.000').padEnd(4, '0').slice(0, 4)
  return `${m[1]}T${m[2]}${ms}Z`
}
