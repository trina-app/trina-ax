// The edge of a text field (inputs, selects, text areas: --c-field-border) and the focus ring (--c-accent) keep 3:1
// against the backgrounds a field sits on (WCAG 2.2 AA 1.4.11), in light and dark, for the base look (index.css) and
// this edition's (theme.edition.css, which overrides it). Cards and dividers keep the softer --c-line.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contrast, LOOKS as looks, SRC } from './tokens'

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
