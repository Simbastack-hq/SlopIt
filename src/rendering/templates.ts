import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ThemeAssets {
  readonly post: string
  readonly index: string
  readonly cssPath: string
  readonly faviconPath: string
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
 * One pass over the template: inserted values are never read again as
 * template syntax, so a post whose text holds `{{x}}` or `{{{x}}}` comes
 * out as written. (Two passes used to expand, or throw on, braces inside
 * a post body or title.) Throws if a referenced variable is missing from
 * `vars`. Triple braces are tried first at each position, so
 * "{{{a}}}{{b}}" parses as {{{a}}} followed by {{b}}.
 */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(
    /\{\{\{\s*(\w+)\s*\}\}\}|\{\{\s*(\w+)\s*\}\}/g,
    (_m, raw: string | undefined, escaped: string | undefined) => {
      const name = (raw ?? escaped)!
      if (!(name in vars)) {
        throw new Error(`Missing template variable: ${name}`)
      }
      return raw !== undefined ? vars[name] : escapeHtml(vars[name])
    },
  )
}

/**
 * Load a theme's asset files. Works in src/ during dev and in dist/
 * after build — path is resolved relative to this module via
 * import.meta.url (same pattern as src/db/store.ts uses for migrations).
 */
export function loadTheme(name: 'minimal'): ThemeAssets {
  const here = dirname(fileURLToPath(import.meta.url))
  const themeDir = join(here, '..', 'themes', name)
  return {
    post: readFileSync(join(themeDir, 'post.html'), 'utf8'),
    index: readFileSync(join(themeDir, 'index.html'), 'utf8'),
    cssPath: join(themeDir, 'style.css'),
    faviconPath: join(themeDir, 'favicon.svg'),
  }
}
