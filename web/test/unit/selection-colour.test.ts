// Selected text keeps the browser's and system's own colour (QA TC-4592): the app's tint was almost the page's colour and
// the hovered row's, so a dragged range could not be seen. The base styles (src/index.css) may not paint a selection
// again; a surface that needs one for a real reason is named here with the reason.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const WEB = path.join(import.meta.dir, '..', '..')
const css = fs.readFileSync(path.join(WEB, 'src', 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** every ::selection rule: its selector and body */
function selectionRules(): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]*::(?:-moz-)?selection[^{}]*)\{([^}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }))
}

// text drawn by a layer behind the box: the system colour at partial strength so that text stays readable
const SEE_THROUGH = ['.room-ref-field::selection', 'textarea[data-token-input]::selection']

test('no ::selection rule paints the app\'s own colour', () => {
  for (const { selector, body } of selectionRules()) {
    const bg = /background(?:-color)?\s*:\s*([^;]+)/.exec(body)?.[1].trim()
    if (!bg) continue
    expect(SEE_THROUGH, `${selector} paints a selection background`).toContain(selector)
    expect(bg, `${selector} must use the system colour`).toContain('Highlight')
    expect(bg).not.toContain('--c-')
  }
})

test('the page-wide selection has no custom colour', () => {
  const global = selectionRules().filter((r) => r.selector === '::selection' || r.selector === '::-moz-selection')
  expect(global).toEqual([])
})

test('no selection: utility or --selection token in the app\'s source', () => {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(tsx?|css)$/.test(e.name) && /(?:^|[\s"'`])(?:[a-z-]+:)*selection:[a-z\[]|--selection|::selection\s*\{[^}]*(?:background|color)/.test(fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')) && !p.endsWith('index.css')) found.push(path.relative(WEB, p))
    }
  }
  walk(path.join(WEB, 'src'))
  expect(found).toEqual([])
})

test('the page says which colour schemes it draws, so a dark page gets the dark selection', () => {
  expect(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')).toContain('<meta name="color-scheme" content="light dark"')
})
