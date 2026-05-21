import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Drift catcher for an inexplicably recurring bug. Three separate
// reviewer rounds have caught literal control bytes (BEL 0x07, NUL
// 0x00) paste-bombed into source files — usually `tests/frontmatter.test.ts`
// because that suite legitimately tests how the renderer handles
// control bytes in post bodies, and someone copies sample-string output
// from a terminal into the test, picking up the raw bytes instead of
// `'\x07'` escape sequences.
//
// The bug is invisible in some editors and causes the file to render as
// binary in `git diff`, breaks grep, and confuses prettier. JavaScript
// escape sequences like `'\x07'` are 4 ASCII characters in the source
// file (`\`, `x`, `0`, `7`) — only interpreted as 0x07 at parse time.
// This check reads raw file bytes via readFileSync(..., 'utf8') and only
// fails when a forbidden byte appears literally.
//
// If a new test ever legitimately requires a literal control byte in
// source (very unlikely — Buffer.from / String.fromCharCode are the
// right tools), add the file path to ALLOWED_FILES. Don't widen the
// regex.

// 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F.
// Explicitly allows 0x09 (tab), 0x0A (LF), 0x0D (CR).
const FORBIDDEN_BYTES = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

const ALLOWED_FILES = new Set<string>([
  // Empty — no file has a legitimate reason for raw control bytes today.
])

// Recursive walk; skips node_modules, dist, dot-dirs.
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue
      }
      yield* walk(full)
    } else if (/\.(ts|js|md|sql|json|yml|yaml)$/.test(entry.name)) {
      yield full
    }
  }
}

describe('source files contain no literal control bytes', () => {
  it('every tracked source/test file is free of literal control bytes (except tab/LF/CR)', () => {
    const offenders: Array<{ path: string; byte: string; offset: number }> = []
    for (const dir of ['src', 'tests', 'docs']) {
      for (const file of walk(dir)) {
        if (ALLOWED_FILES.has(file)) continue
        const content = readFileSync(file, 'utf8')
        const match = FORBIDDEN_BYTES.exec(content)
        if (match) {
          offenders.push({
            path: file,
            byte: `0x${match[0].charCodeAt(0).toString(16).padStart(2, '0')}`,
            offset: match.index,
          })
        }
      }
    }
    expect(
      offenders,
      `Literal control bytes found. Use JavaScript escape sequences (e.g. '\\x07') instead. ` +
        `Offenders: ${offenders.map((o) => `${o.path} @ offset ${o.offset} (byte ${o.byte})`).join('; ')}`,
    ).toEqual([])
  })
})
