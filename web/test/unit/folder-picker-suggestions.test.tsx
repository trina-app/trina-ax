// The Move picker's "Suggested" and "Recent" (components/FolderPicker.tsx `suggestFor`; docs/DECISIONS.md "Move picker:
// suggested and recent folders"): asked once per opening with the paths being moved; a row picks its folder (the
// picker opens it, "Move here" moves there), ✕ takes a suggestion away and tells the server; nothing shows without
// hints, and a picker that is not a move never asks.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { translate, useLocaleStore } from '../../src/i18n'
import FolderPicker from '../../src/components/FolderPicker'
import { installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
const before = useLocaleStore.getState().locale
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
let calls: { url: string; body: unknown }[] = []
let hints: unknown = { suggested: [{ path: 'shared/quotes', confidence: 0.9 }], recent: [{ path: 'shared/minutes' }] }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.startsWith('/api/files/tree')) {
      const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
      return json({ path, access: 'write', entries: [], nextCursor: null })
    }
    if (url === '/api/files/move-suggestions') return json(hints)
    if (url === '/api/files/move-suggestions/dismiss') return new Response(null, { status: 204 })
    return json({ error: { code: 'internal', message: 'no route' } }, 500)
  }) as unknown as typeof fetch
})
beforeEach(() => { calls = [] })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before })
})

test('suggested on top with ✕, then recent; a row picks the folder; ✕ hides it and tells the server', async () => {
  let picked = null as string | null
  const m = await mount(<FolderPicker open title="Move" confirmLabel="Move here" initial="shared" suggestFor={['shared/q1.xlsx']} onPick={(p) => { picked = p }} onClose={() => {}} />)
  try {
    await m.until(() => m.find('move-suggested'), 'the suggestions')
    expect(calls.find((c) => c.url === '/api/files/move-suggestions')?.body).toEqual({ paths: ['shared/q1.xlsx'] })
    const text = m.get('move-hints').textContent ?? ''
    expect(text.indexOf(translate('en', 'files.suggestedFolders'))).toBeLessThan(text.indexOf(translate('en', 'files.recentFolders')))
    expect(text.indexOf(translate('en', 'files.recentFolders'))).toBeLessThan(text.indexOf(translate('en', 'files.allFolders')))
    // only the suggestion has ✕
    expect(m.get('move-suggested').querySelectorAll('[data-testid="move-hint-dismiss"]')).toHaveLength(1)
    expect(m.get('move-recent').querySelectorAll('[data-testid="move-hint-dismiss"]')).toHaveLength(0)
    // a row picks: pressed, the picker opens that folder, and Move here moves there
    const hint = m.get('move-suggested').querySelector('[data-testid="move-hint"]')!
    await m.click(hint as never)
    await m.until(() => calls.some((c) => c.url.includes('path=shared%2Fquotes')), 'the folder opened')
    expect(m.get('move-suggested').querySelector('[data-testid="move-hint"]')!.getAttribute('aria-pressed')).toBe('true')
    await m.click('folder-pick')
    expect(picked).toBe('shared/quotes')
    // ✕
    await m.click(m.get('move-suggested').querySelector('[data-testid="move-hint-dismiss"]') as never)
    await m.until(() => !m.find('move-suggested'), 'the suggestion gone')
    // the focus goes to "All folders" (Recent is still there), never to the page
    await m.until(() => document.activeElement === m.find('all-folders'), 'the focus on All folders')
    expect(calls.find((c) => c.url === '/api/files/move-suggestions/dismiss')?.body).toEqual({ paths: ['shared/q1.xlsx'], folder: 'shared/quotes' })
    expect(m.find('move-recent')).not.toBeNull()
  } finally { await m.unmount() }
})

test('✕ also takes the folder out of Recent, where it would still read as suggested (QA 2026-11-13)', async () => {
  hints = { suggested: [{ path: 'shared/quotes', confidence: 0.9 }], recent: [{ path: 'shared/quotes' }, { path: 'shared/minutes' }] }
  const m = await mount(<FolderPicker open title="Move" confirmLabel="Move here" initial="shared" suggestFor={['shared/q1.xlsx']} onPick={() => {}} onClose={() => {}} />)
  try {
    await m.until(() => m.find('move-suggested'), 'the suggestions')
    await m.click(m.get('move-suggested').querySelector('[data-testid="move-hint-dismiss"]') as never)
    await m.until(() => !m.find('move-suggested'), 'the suggestion gone')
    expect(m.get('move-recent').textContent).not.toContain('quotes')
    expect(m.get('move-recent').querySelectorAll('[data-testid="move-hint"]')).toHaveLength(1)
  } finally { await m.unmount() }
})

test('no hints: no sections; not a move: never asked', async () => {
  hints = { suggested: [], recent: [] }
  let m = await mount(<FolderPicker open title="Move" confirmLabel="Move here" suggestFor={['shared/x.bin']} onPick={() => {}} onClose={() => {}} />)
  try {
    await m.until(() => calls.some((c) => c.url === '/api/files/move-suggestions'), 'asked')
    await m.settle(50)
    expect(m.find('move-hints')).toBeNull()
  } finally { await m.unmount() }
  calls = []
  m = await mount(<FolderPicker open title="Save" confirmLabel="Save here" onPick={() => {}} onClose={() => {}} />)
  try {
    await m.until(() => calls.some((c) => c.url.startsWith('/api/files/tree')), 'the tree')
    await m.settle(50)
    expect(calls.some((c) => c.url.includes('move-suggestions'))).toBe(false)
  } finally { await m.unmount() }
})
