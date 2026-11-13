// The first paint in the chosen look (web/public/theme-boot.js, loaded in index.html's <head>): the same look on <html>
// as lib/theme.ts gives once the app runs (applyTheme: drawnDark of storedTheme()), for every saved choice and phone
// look, so a person who chose Dark gets no white frame before the bundle (QA "swipe-back dark flash").
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { drawnDark, storedTheme, THEME_KEY } from '../../src/lib/theme'

const WEB = path.join(import.meta.dir, '..', '..')
const boot = fs.readFileSync(path.join(WEB, 'public', 'theme-boot.js'), 'utf8')
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')

type Root = { classes: Set<string>; colorScheme: string }
let systemDark = false
const media = { get matches() { return systemDark } }

/** a page with this saved value (undefined: none; 'blocked': storage throws) and phone look */
function page(saved: string | undefined | 'blocked') {
  const root: Root = { classes: new Set(), colorScheme: '' }
  const element = {
    classList: {
      add: (c: string) => root.classes.add(c), remove: (c: string) => root.classes.delete(c),
      toggle: (c: string, on: boolean) => (on ? root.classes.add(c) : root.classes.delete(c)),
    },
    style: { set colorScheme(v: string) { root.colorScheme = v }, get colorScheme() { return root.colorScheme } },
  }
  const localStorage = {
    getItem: (k: string) => { if (saved === 'blocked') throw new Error('blocked'); return k === THEME_KEY ? saved ?? null : null },
    setItem() {},
  }
  const window = { localStorage, matchMedia: () => media }
  // index.html's two browser bar colours
  const metas = [['light', '#fcfbf8'], ['dark', '#0e0c0b']].map(([look, content]) => {
    const a: Record<string, string> = { media: `(prefers-color-scheme: ${look})`, content: content! }
    return { getAttribute: (k: string) => a[k] ?? null, setAttribute: (k: string, v: string) => { a[k] = v } }
  })
  const document = { documentElement: element, querySelectorAll: () => metas }
  return { root, window, document, localStorage, metas }
}

const saved = (globalThis as Record<string, unknown>)
const keep = { localStorage: saved.localStorage }
afterEach(() => { for (const [k, v] of Object.entries(keep)) { if (v === undefined) Reflect.deleteProperty(saved, k); else saved[k] = v } })

for (const choice of ['light', 'dark', 'system', undefined, 'sepia', 'blocked'] as const) {
  for (const phoneDark of [false, true]) {
    test(`saved ${String(choice)}, phone ${phoneDark ? 'dark' : 'light'}: the same look as the app`, () => {
      systemDark = phoneDark
      const first = page(choice)
      new Function('window', 'document', boot)(first.window, first.document)

      saved.localStorage = page(choice).localStorage
      const dark = drawnDark(storedTheme(), phoneDark)

      expect(first.root.classes.has('dark')).toBe(dark)
      expect(first.root.colorScheme).toBe(dark ? 'dark' : 'light')
      // both browser bar colours are the chosen look's
      for (const m of first.metas) expect(m.getAttribute('content')).toBe(dark ? '#0e0c0b' : '#fcfbf8')
      expect(first.root.classes.has('dark')).toBe(choice === 'dark' || (choice !== 'light' && phoneDark))
    })
  }
}

test('index.html: the boot script is a classic script in <head>, before the bundle, and no script is inline (CSP)', () => {
  const head = html.slice(0, html.indexOf('</head>'))
  expect(head).toContain('<script src="/theme-boot.js"></script>')
  expect(html.indexOf('/theme-boot.js')).toBeLessThan(html.indexOf('/src/main.tsx'))
  expect(boot).toContain(`'${THEME_KEY}'`)
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toMatch(/\ssrc="/)
  // <html> gets the page colour of the look before the stylesheet is in
  expect(head).toMatch(/html\.dark \{ background: var\(--c-canvas, #0e0c0b\); \}/)
})
