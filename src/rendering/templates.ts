import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ThemeAssets {
  readonly post: string
  readonly index: string
  readonly cssPath: string
}

/**
 * HTML-escape the five canonical special characters. Ampersand MUST be
 * replaced first, otherwise other replacements introduce ampersands that
 * get doubly-escaped.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render a template string by substituting:
 *   {{{var}}}  → raw value (trust the helper that produced it to have escaped)
 *   {{var}}    → HTML-escaped value
 *
 * Throws if any referenced variable is missing from `vars`. Triple braces
 * are matched FIRST so "{{{a}}}{{b}}" parses as {{{a}}} followed by {{b}}
 * rather than {{ {a}} }{b}}.
 */
export function render(template: string, vars: Record<string, string>): string {
  let out = template.replace(/\{\{\{\s*(\w+)\s*\}\}\}/g, (_m, name: string) => {
    if (!(name in vars)) {
      throw new Error(`Missing template variable: ${name}`)
    }
    return vars[name]
  })
  out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
    if (!(name in vars)) {
      throw new Error(`Missing template variable: ${name}`)
    }
    return escapeHtml(vars[name])
  })
  return out
}

/**
 * Load a theme's three asset files. Works in src/ during dev and in
 * dist/ after build — path is resolved relative to this module via
 * import.meta.url (same pattern as src/db/store.ts uses for migrations).
 */
export function loadTheme(name: 'minimal'): ThemeAssets {
  const here = dirname(fileURLToPath(import.meta.url))
  const themeDir = join(here, '..', 'themes', name)
  return {
    post: readFileSync(join(themeDir, 'post.html'), 'utf8'),
    index: readFileSync(join(themeDir, 'index.html'), 'utf8'),
    cssPath: join(themeDir, 'style.css'),
  }
}
