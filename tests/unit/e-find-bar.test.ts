// The desktop app's find bar (Cmd/Ctrl+F, desktop/src/common/find-bar.ts): which view it searches, where it sits, the
// text it opens with, its keys and its count; and how it is wired (menu, IPC, its own view). The window itself is
// checked in the desktop e2e (desktop/e2e/find-bar.spec.ts).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIND_BAR, FIND_PREFILL_MAX, findBarRect, findCount, findKey, findPrefill, findTarget, type FindScene } from '../../desktop/src/common/find-bar'
import { STRINGS } from '../../desktop/src/common/i18n'

type V = 'page' | 'list' | 'toolbar' | 'tab' | 'strip' | 'bar'
const read = (p: string) => readFileSync(join(import.meta.dir, '../..', p), 'utf8')

const scene = (over: Partial<FindScene<V>> = {}): FindScene<V> => ({
  shown: ['page', 'toolbar', 'tab'],
  bar: 'bar',
  toolbar: 'toolbar',
  paneTab: 'tab',
  strip: 'strip',
  page: 'page',
  screen: 'list',
  ...over,
})

describe('findTarget', () => {
  test('the view with the keyboard: the team page or the in-app browser tab', () => {
    expect(findTarget(scene({ last: 'page' }))).toBe('page')
    expect(findTarget(scene({ last: 'tab' }))).toBe('tab')
  })
  test('the browser toolbar (its address field) means its tab; the host strip means the team page', () => {
    expect(findTarget(scene({ last: 'toolbar' }))).toBe('tab')
    expect(findTarget(scene({ shown: ['strip', 'page'], last: 'strip' }))).toBe('page')
  })
  test('the toolbar with no tab drawn yet: the team page, not the toolbar itself', () => {
    expect(findTarget(scene({ shown: ['page', 'toolbar'], last: 'toolbar', paneTab: undefined }))).toBe('page')
  })
  test('Cmd+F in the open bar keeps the view it searches', () => {
    expect(findTarget(scene({ shown: ['page', 'toolbar', 'tab', 'bar'], last: 'bar', searching: 'tab' }))).toBe('tab')
  })
  test('nothing had the keyboard, or it left the window: the team page, else the app\'s own screen', () => {
    expect(findTarget(scene())).toBe('page')
    expect(findTarget(scene({ last: 'tab', shown: ['page'] }))).toBe('page')
    expect(findTarget(scene({ shown: ['list'], page: undefined }))).toBe('list')
    expect(findTarget(scene({ shown: [], page: undefined }))).toBeNull()
  })
  test('the bar never searches itself', () => {
    expect(findTarget(scene({ shown: ['page', 'bar'], last: 'bar' }))).toBe('page')
  })
})

describe('findBarRect', () => {
  test('the top-right corner of the searched view, inset from its right edge', () => {
    const r = findBarRect({ x: 0, y: 36, width: 1000, height: 800 })
    expect(r).toEqual({ x: 1000 - FIND_BAR.inset - FIND_BAR.width, y: 36, width: FIND_BAR.width, height: FIND_BAR.height })
  })
  test('a narrow view (a narrow window, or the in-app browser beside the page): as wide as fits, inside the view', () => {
    const v = { x: 700, y: 44, width: 300, height: 800 }
    const r = findBarRect(v)
    expect(r.width).toBe(300 - 2 * FIND_BAR.inset)
    expect(r.x).toBe(700 + FIND_BAR.inset)
    expect(r.x + r.width).toBeLessThanOrEqual(v.x + v.width)
    expect(findBarRect({ x: 0, y: 0, width: 0, height: 0 }).width).toBe(0)
  })
})

describe('findPrefill', () => {
  test('the first non-empty line of the selection, spaces squeezed', () => {
    expect(findPrefill('  quarterly   report ')).toBe('quarterly report')
    expect(findPrefill('\n\n  first line\nsecond line')).toBe('first line')
    expect(findPrefill('a\tb')).toBe('a b')
  })
  test('nothing selected: null (the bar keeps its last text)', () => {
    expect(findPrefill('')).toBeNull()
    expect(findPrefill(' \n ')).toBeNull()
    expect(findPrefill(undefined)).toBeNull()
    expect(findPrefill(42)).toBeNull()
  })
  test('a long selection is cut, never in the middle of a character', () => {
    expect(findPrefill('x'.repeat(5000))!.length).toBe(FIND_PREFILL_MAX)
    const emoji = findPrefill('😀'.repeat(300))!
    expect([...emoji].length).toBe(FIND_PREFILL_MAX)
    expect(emoji.endsWith('😀')).toBe(true)
  })
})

describe('findKey', () => {
  const k = (key: string, o: Partial<{ shift: boolean; meta: boolean; ctrl: boolean; alt: boolean; mac: boolean; composing: boolean }> = {}) =>
    findKey({ key, shift: false, meta: false, ctrl: false, alt: false, mac: true, ...o })
  test('Enter: next; Shift+Enter: the one before; Esc: close', () => {
    expect(k('Enter')).toBe('next')
    expect(k('Enter', { shift: true })).toBe('prev')
    expect(k('Escape')).toBe('close')
  })
  test('Cmd+G / Shift+Cmd+G on the Mac, Ctrl+G / Shift+Ctrl+G elsewhere', () => {
    expect(k('g', { meta: true })).toBe('next')
    expect(k('G', { meta: true, shift: true })).toBe('prev')
    expect(k('g', { ctrl: true })).toBeNull()
    expect(k('g', { ctrl: true, mac: false })).toBe('next')
    expect(k('G', { ctrl: true, shift: true, mac: false })).toBe('prev')
    expect(k('g', { meta: true, mac: false })).toBeNull()
  })
  test('Enter that ends a Korean or Japanese composition is the composition\'s, not a step', () => {
    expect(k('Enter', { composing: true })).toBeNull()
    expect(k('Escape', { composing: true })).toBeNull()
  })
  test('other keys are the field\'s own', () => {
    expect(k('g')).toBeNull()
    expect(k('a', { meta: true })).toBeNull()
    expect(k('Enter', { meta: true })).toBeNull()
  })
})

describe('findCount', () => {
  test('empty field or no answer yet: nothing; no match: "No results"; else N of M', () => {
    expect(findCount('', { active: 1, matches: 3 })).toEqual({ kind: 'empty' })
    expect(findCount('x', null)).toEqual({ kind: 'empty' })
    expect(findCount('x', { active: 0, matches: 0 })).toEqual({ kind: 'none' })
    expect(findCount('x', { active: 2, matches: 5 })).toEqual({ kind: 'count', n: 2, m: 5 })
  })
  test('an answer before the active match is known still reads 1 of M', () => {
    expect(findCount('x', { active: 0, matches: 4 })).toEqual({ kind: 'count', n: 1, m: 4 })
  })
  test('every language has the bar\'s words, "N of M" keeps both numbers', () => {
    for (const s of Object.values(STRINGS)) {
      for (const key of ['menu.find', 'menu.findNext', 'menu.findPrev', 'find.label', 'find.none', 'find.prev', 'find.next', 'find.close'] as const) expect(s[key].length).toBeGreaterThan(0)
      expect(s['find.count']).toContain('{n}')
      expect(s['find.count']).toContain('{m}')
    }
  })
})

describe('wiring', () => {
  const main = read('desktop/src/main/main.ts')
  const win = read('desktop/src/main/app-window.ts')
  const bar = read('desktop/src/main/find-bar.ts')
  test('Edit › Find…, Find Next, Find Previous with CmdOrCtrl+F, CmdOrCtrl+G, Shift+CmdOrCtrl+G', () => {
    expect(main).toContain("accelerator: 'CmdOrCtrl+F', click: () => win?.find('open')")
    expect(main).toContain("accelerator: 'CmdOrCtrl+G', click: () => win?.find('next')")
    expect(main).toContain("accelerator: 'Shift+CmdOrCtrl+G', click: () => win?.find('prev')")
  })
  test('only the bar\'s own view may drive it', () => {
    for (const ch of ['ui:find-state', 'ui:find-query', 'ui:find-step', 'ui:find-close']) expect(main).toMatch(new RegExp(`'${ch}', \\(e[^)]*\\) => \\(?fromFindBar\\(e\\)`))
  })
  test('the bar is its own view (its text is never in the page it searches) and holds the keyboard like the others', () => {
    expect(bar).toContain('`${UI_ORIGIN}/findbar.html`')
    expect(bar).toContain('new WebContentsView(')
    expect(win).toContain('this.watchKeys(this.findBar.view, false)')
    expect(win).toMatch(/shownViews\(\)[^]*this\.findBar\.view\]/)
  })
  test('the selection is read where the page cannot change what it says', () => {
    expect(bar).toContain('executeJavaScriptInIsolatedWorld(')
  })
})
