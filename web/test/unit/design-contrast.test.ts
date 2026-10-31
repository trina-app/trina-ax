// The pairs docs/DESIGN-SYSTEM.md "Contrast" promises, in all four looks (core and edition, light and dark), and the
// component classes that use them: text >= 4.5:1 (WCAG 2.2 AA 1.4.3), the edges and parts that mark a control >= 3:1
// (1.4.11). Each check names where the pair is used, so a token change that breaks one says which screen it hurts.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contrast, LOOKS, over, SRC } from './tokens'

const src = (file: string) => readFileSync(join(SRC, file), 'utf8')
const GROUNDS = ['canvas', 'surface', 'subtle'] as const

describe('contrast in every look', () => {
  for (const [name, t] of Object.entries(LOOKS)) {
    test(`${name}: accent text on its tint (info banners, the office update banner, the accent badge) >= 4.5:1`, () => {
      expect(contrast(t['accent-text']!, t['accent-soft']!)).toBeGreaterThanOrEqual(4.5)
      for (const bg of GROUNDS) expect(contrast(t['accent-text']!, t[bg]!), `accent-text on ${bg} (links)`).toBeGreaterThanOrEqual(4.5)
    })

    test(`${name}: a bordered (secondary) button's edge >= 3:1 where buttons sit (also "Try again" on an error note, "Restore" on the warn-tinted trash notice)`, () => {
      for (const bg of [...GROUNDS, 'danger-soft', 'warn-soft'])
        expect(contrast(t['field-border']!, t[bg]!), `field-border on ${bg}`).toBeGreaterThanOrEqual(3)
    })

    test(`${name}: switch off track and both knobs >= 3:1`, () => {
      for (const bg of GROUNDS) {
        expect(contrast(t['field-border']!, t[bg]!), `off track on ${bg}`).toBeGreaterThanOrEqual(3)
        expect(contrast(t.accent!, t[bg]!), `on track on ${bg}`).toBeGreaterThanOrEqual(3)
      }
      expect(contrast('#ffffff', t['field-border']!), 'white knob on the off track').toBeGreaterThanOrEqual(3)
      expect(contrast(t['accent-ink']!, t.accent!), 'accent-ink knob on the on track').toBeGreaterThanOrEqual(4.5)
    })

    test(`${name}: danger button border (danger at 70 %) >= 3:1 and its label >= 4.5:1`, () => {
      for (const bg of GROUNDS) {
        expect(contrast(over(t.danger!, 0.7, t[bg]!), t[bg]!), `danger/70 on ${bg}`).toBeGreaterThanOrEqual(3)
        expect(contrast(t.danger!, t[bg]!), `danger text on ${bg} (ghost-danger, menu Delete)`).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrast(t.danger!, t['danger-soft']!), 'danger on its hover tint').toBeGreaterThanOrEqual(4.5)
    })
  }
})

describe('components use the pairs', () => {
  const ui = src('components/ui.tsx')
  const variant = (v: string) => ui.match(new RegExp(`variant === '${v}' && '([^']*)'`))?.[1] ?? ''

  test('info banners and the office update banner put accent TEXT (not the fill colour) on the tint', () => {
    expect(src('components/OfficeUpdateBanner.tsx')).toMatch(/bg-accent-soft[^"]*\btext-accent-text\b/)
    expect(src('components/ManagedNoticesBanner.tsx')).toContain("info: 'bg-accent-soft text-accent-text'")
    // nowhere is the fill colour used as text (3.3–3.7:1 in the edition's light look)
    for (const file of ['components/OfficeUpdateBanner.tsx', 'components/ManagedNoticesBanner.tsx', 'pages/admin/Engines.tsx', 'pages/admin/System.tsx', 'pages/admin/Credentials.tsx', 'pages/admin/TeamSettings.tsx'])
      expect(src(file).match(/\btext-accent(?![-\w])/g), file).toBeNull()
  })

  test('Button: secondary edge is --c-field-border, danger border 70 %, a ghost-danger variant (no recolouring)', () => {
    expect(variant('secondary')).toContain('border-field-border')
    expect(variant('secondary')).not.toMatch(/\bborder-line\b/)
    expect(variant('danger')).toContain('border-danger/70')
    expect(variant('ghost-danger')).toContain('text-danger')
    expect(variant('ghost-danger')).not.toContain('text-muted')
    // AskCard's Deny and the other quiet destructive buttons use the variant, not className="text-danger" over ghost
    // (.text-muted is emitted after .text-danger, so the override rendered grey)
    for (const file of ['components/chat/AskCard.tsx', 'pages/Skills.tsx', 'pages/admin/SkillManagers.tsx', 'pages/Projects.tsx']) {
      const lines = src(file).split('\n')
      expect(lines.filter((l) => /variant="ghost"/.test(l) && /text-danger/.test(l)), file).toEqual([])
      expect(lines.some((l) => l.includes('variant="ghost-danger"')), file).toBe(true)
    }
    expect(src('components/chat/AskCard.tsx').split('\n').some((l) => l.includes('variant="ghost-danger"') && l.includes("decision: 'deny'"))).toBe(true)
  })

  test('Switch: --c-field-border off track, --c-accent-ink knob when on, focus ring outside the track', () => {
    const sw = ui.slice(ui.indexOf('export function Switch'))
    expect(sw).toContain('bg-field-border')
    expect(sw).not.toMatch(/bg-line-strong\/\d+/)
    expect(sw).toContain('peer-checked:after:bg-accent-ink')
    expect(sw).toContain('peer-focus-visible:outline-offset-2')
  })

  test('only tokens and the documented layers', () => {
    expect(src('components/chat/Messages.tsx').includes('text-muted-foreground')).toBe(false)
    expect(src('pages/admin/Credentials.tsx').match(/\bz-10\b/g)).toBeNull()
  })

  test('the browser bar colour follows the look in use (no core colours in theme.ts or index.html)', () => {
    const theme = src('lib/theme.ts')
    expect(theme).not.toMatch(/#faf9f6|#1b1a18/i)
    expect(theme).toContain("getPropertyValue('--c-canvas')")
    const html = readFileSync(join(SRC, '../index.html'), 'utf8')
    const edition = LOOKS['edition light']!
    expect(html).toContain(`<meta name="theme-color" content="${edition.canvas}" media="(prefers-color-scheme: light)" />`)
    expect(html).toContain(`<meta name="theme-color" content="${LOOKS['edition dark']!.canvas}" media="(prefers-color-scheme: dark)" />`)
  })

  test('the font stack names only faces that are there: the system face (no web font is shipped)', () => {
    expect(src('index.css')).toMatch(/--font-sans: -apple-system,/)
    expect(src('index.css')).not.toContain('Pretendard')
    expect(src('lib/artifacts.ts')).not.toContain('Pretendard')
  })
})
