// The type scale in the source (docs/DESIGN-SYSTEM.md "Typography"): text sizes come from the tokens in index.css, so a
// screen follows the scale on both screen sizes and the person's text size. This fails a pull request that adds a
// one-off size (`text-[13px]`, `text-[0.8125rem]`), switches a text's size per screen size (`max-md:text-sm` on a
// hint), or gives a setting row its own sizes instead of the shared one (components/settings/SettingRow.tsx). The
// computed sizes on the screens are checked by web/test/e2e/type-scale.spec.ts and web/scripts/type-audit.ts.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(import.meta.dir, '../../src')
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name)
  return d.isDirectory() ? files(p) : /\.tsx?$/.test(d.name) ? [p] : []
})
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/')
const sources = files(SRC).map((p) => ({ file: rel(p), text: fs.readFileSync(p, 'utf8') }))

/** where a fixed size is the point: pictures drawn small (the install steps' phone and browser, aria-hidden) */
const PICTURES = new Set(['components/settings/InstallPictures.tsx'])
/** a per-screen-size switch that stays, with its reason: the chat header's project is a chip on a phone and words
 * beside the title on a computer */
const SWITCHES = new Set(['components/chat/ChatProject.tsx'])

function hits(re: RegExp, skip: Set<string>) {
  const out: string[] = []
  for (const { file, text } of sources) {
    if (skip.has(file)) continue
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(re)) out.push(`${file}:${i + 1} ${m[0]}`)
    })
  }
  return out
}

describe('text sizes come from the tokens', () => {
  test('no one-off size under a heading’s (text-[…px] at all; text-[…rem] under 1.25rem)', () => {
    const px = hits(/\btext-\[\d+(?:\.\d+)?px\]/g, PICTURES)
    const small = hits(/\btext-\[(\d*\.?\d+)rem\]/g, PICTURES).filter((h) => Number(/\[(\d*\.?\d+)rem\]/.exec(h)![1]) < 1.25)
    expect([...px, ...small]).toEqual([])
  })

  test('no text size switched per screen size (the tokens already differ on a phone)', () => {
    expect(hits(/(?:^|[\s'"`])(?:max-)?(?:sm|md|lg):text-(?:xs|sm|base|label|micro|nano|meta|row|reading)\b/g, SWITCHES)).toEqual([])
  })
})

describe('settings rows: one component, the lists’ sizes', () => {
  test('the shared row names a setting at the row size and its line at the meta size', () => {
    const row = sources.find((s) => s.file === 'components/settings/SettingRow.tsx')!.text
    expect(row).toContain("export const settingName = 'text-row font-medium text-ink'")
    expect(row).toContain("export const settingDesc = 'text-meta text-muted'")
  })

  test('Settings, Notifications and Admin use it (no row of their own with its own sizes)', () => {
    const common = sources.find((s) => s.file === 'pages/admin/common.tsx')!.text
    expect(common).toContain("export { SettingRow } from '../../components/settings/SettingRow'")
    expect(common).not.toMatch(/export function SettingRow\b/)
    const pref = sources.find((s) => s.file === 'components/settings/PrefRows.tsx')!.text
    expect(pref).toMatch(/<SettingRow inline belowFull \{\.\.\.props\} \/>/)
    const settings = sources.find((s) => s.file === 'pages/Settings.tsx')!.text
    expect(settings).toMatch(/function Row\([^)]*\)[^{]*\{\s*return <SettingRow divided /)
  })

  test('no setting drawn by hand: a name in text-sm medium ink with a text-sm muted line under it', () => {
    // the pattern the three old rows used; a setting's name and line come from SettingRow (or settingName/settingDesc)
    const out: string[] = []
    for (const { file, text } of sources) {
      if (!/^(components\/settings\/|pages\/admin\/|pages\/Settings\.tsx|components\/integrations\/)/.test(file)) continue
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        if (/className="[^"]*\btext-sm font-medium text-ink\b[^"]*"/.test(line) && /className="[^"]*\btext-sm text-muted\b/.test(lines[i + 1] ?? '')) out.push(`${file}:${i + 1}`)
      })
    }
    expect(out).toEqual([])
  })

  test('the list tokens: rows 15px on a computer and 16px / 22px at 400 on a phone, 32px tiles and faces, 48px rows, meta 13px', () => {
    const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8')
    const [computer, phone] = [css.slice(0, css.indexOf('@media (max-width: 767.98px)')), css.slice(css.indexOf('/* The shared lists on phones'))]
    expect(computer).toMatch(/--text-row: 0\.9375rem;/)
    expect(computer).toMatch(/--text-meta: 0\.8125rem;/)
    expect(computer).toMatch(/--text-xs: 0\.8125rem;/)
    expect(computer).toMatch(/--text-sm: 0\.9375rem;/)
    expect(phone).toMatch(/--text-row: 1rem;/)
    expect(phone).toMatch(/--text-row--line-height: 1\.375rem;/)
    expect(phone).toMatch(/--font-weight-row-read: 400;/)
    expect(phone).toMatch(/--spacing-row-min: 3rem;/)
    expect(phone).toMatch(/--spacing-list-icon: 2rem;/)
    expect(phone).toMatch(/--spacing-list-glyph: 1\.125rem;/)
    expect(phone).toMatch(/--spacing-list-face: 2rem;/)
    expect(phone).not.toMatch(/--text-meta:/)
    // a ListRow's tap target stays 44px or more on a phone (48px rows)
    expect(Number(/--spacing-row-min: ([\d.]+)rem;/.exec(phone)![1]) * 16).toBeGreaterThanOrEqual(44)
  })
})
