// The colour tokens of the four looks (core light/dark from index.css, the edition's from theme.edition.css, which
// overrides them) and the WCAG 2 contrast ratio, for the contrast tests.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SRC = join(import.meta.dir, '../../src')
export type Tokens = Record<string, string>

/** the --c-* colours of a file's `:root { }` (light) and `.dark { }` blocks */
export function tokens(file: string): { light: Tokens; dark: Tokens } {
  const css = readFileSync(join(SRC, file), 'utf8')
  const block = (selector: string) => {
    const m = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`))
    if (!m) throw new Error(`${file}: no ${selector} block`)
    return Object.fromEntries([...m[1]!.matchAll(/--c-([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((x) => [x[1]!, x[2]!.toLowerCase()]))
  }
  return { light: block(':root'), dark: block('.dark') }
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return [n >> 16, (n >> 8) & 255, n & 255] as const
}
const channel = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
/** `fg` at `alpha` over `bg` (what Tailwind's `border-danger/70` shows on that background) */
export const over = (fg: string, alpha: number, bg: string) => {
  const f = rgb(fg)
  const b = rgb(bg)
  return '#' + f.map((v, i) => Math.round(v * alpha + b[i]! * (1 - alpha)).toString(16).padStart(2, '0')).join('')
}

const base = tokens('index.css')
const edition = tokens('theme.edition.css')
export const LOOKS: Record<string, Tokens> = {
  'base light': base.light,
  'base dark': base.dark,
  'edition light': { ...base.light, ...edition.light },
  'edition dark': { ...base.dark, ...edition.dark },
}
