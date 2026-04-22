// Pure predicate so the narrow match logic is testable without running the DB.
// better-sqlite3 sets err.code for SQLite constraint violations; the column
// name is only reliably available in err.message.
export function isBlogNameConflict(err: unknown): boolean {
  return (
    err instanceof Error
    && (err as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE'
    && err.message.includes('blogs.name')
  )
}
