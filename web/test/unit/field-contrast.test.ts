// The edge of a text field (inputs, selects, text areas: --c-field-border) and the focus ring (--c-accent) keep 3:1
// against the backgrounds a field sits on (WCAG 2.2 AA 1.4.11), in light and dark, for the base look (index.css) and
// this edition's (theme.edition.css, which overrides it). Cards and dividers keep the softer --c-line.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '../../src')
type Tokens = Record<string, string>

/** the --c-* colours of a file's `:root { }` (light) and `.dark { }` blocks */
function tokens(file: string): { light: Tokens; dark: Tokens } {
  const css = readFileSync(join(SRC, file), 'utf8')
  const block = (selector: string) => {
    const m = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`))
    if (!m) throw new Error(`${file}: no ${selector} block`)
    return Object.fromEntries([...m[1]!.matchAll(/--c-([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((x) => [x[1]!, x[2]!.toLowerCase()]))
  }
  return { light: block(':root'), dark: block('.dark') }
}

const channel = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const base = tokens('index.css')
const edition = tokens('theme.edition.css')
const looks = {
  'base light': base.light,
  'base dark': base.dark,
  'edition light': { ...base.light, ...edition.light },
  'edition dark': { ...base.dark, ...edition.dark },
}
const BACKGROUNDS = ['canvas', 'surface', 'subtle'] as const

describe('text field edges and focus rings', () => {
  for (const [name, t] of Object.entries(looks)) {
    test(`${name}: --c-field-border and --c-accent ≥ 3:1 on canvas, surface and subtle`, () => {
      for (const bg of BACKGROUNDS) {
        expect(t['field-border'], `${name} field-border`).toMatch(/^#[0-9a-f]{6}$/)
        expect(contrast(t['field-border']!, t[bg]!), `${name}: field-border on ${bg}`).toBeGreaterThanOrEqual(3)
        expect(contrast(t.accent!, t[bg]!), `${name}: accent (focus ring) on ${bg}`).toBeGreaterThanOrEqual(3)
      }
    })
  }

  test('the measured problem: --c-line (cards, dividers) is far below 3:1, so fields no longer use it', () => {
    expect(contrast(looks['edition light'].line!, looks['edition light'].surface!)).toBeLessThan(1.5)
    const ui = readFileSync(join(SRC, 'components/ui.tsx'), 'utf8')
    const inputCls = ui.match(/export const inputCls =\s*'([^']*)'/)?.[1] ?? ''
    expect(inputCls).toContain('border-field-border')
    expect(inputCls).not.toMatch(/\bborder-line\b/)
    // focus: a 2px accent edge (border + 1px ring), not a faint glow
    expect(inputCls).toContain('focus:border-accent')
    expect(inputCls).toContain('focus:ring-accent')
    expect(inputCls).not.toMatch(/focus:ring-accent\//)
  })

  test('a text area framed by its form (edit and queued message) draws no ring of its own: one edge, on the form', () => {
    for (const file of ['components/chat/Messages.tsx', 'components/chat/QueuedMessages.tsx']) {
      const src = readFileSync(join(SRC, file), 'utf8')
      expect(src, file).toContain('has-[textarea:focus]:ring-accent')
      // inputCls's focus:ring-1 is emitted after focus:ring-0, so only the important form takes the ring away
      expect(src, file).toMatch(/clsx\(inputCls, '[^']*\bborder-0\b[^']*\bfocus:ring-0!/)
    }
  })
})
