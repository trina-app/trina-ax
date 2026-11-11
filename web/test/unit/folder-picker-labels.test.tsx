// The move / save-to folder picker (components/FolderPicker.tsx): a folder listed with no access of its own is one you
// pass through to folders inside that are open to you (a project you are in, under projects/). It says so as the Files
// screen does ("Only some folders"), not "No access", which read as a dead end (QA TC-157). Read-only folders keep
// "Read only"; folders you can write carry no label.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { translate, useLocaleStore } from '../../src/i18n'
import FolderPicker from '../../src/components/FolderPicker'
import { installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
const before = useLocaleStore.getState().locale
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const folder = (name: string, access: 'none' | 'read' | 'write') => ({ name, path: name, type: 'folder', size: null, mtime: '2026-11-11T00:00:00.000Z', mime: null, access })
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/files/tree')) return json({ path: '', access: 'none', entries: [folder('projects', 'none'), folder('skills', 'read'), folder('users', 'write')], nextCursor: null })
    return json({ error: { code: 'internal', message: 'no route' } }, 500)
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before })
})

test('a pass-through folder says "Only some folders", a read-only one "Read only", and nothing says "No access"', async () => {
  const m = await mount(<FolderPicker open title="Move" confirmLabel="Move here" onPick={() => {}} onClose={() => {}} />)
  try {
    await m.until(() => document.querySelector('[data-testid="picker-pass-through"]'), 'the folder list')
    // one pass-through badge (projects/), one "Read only" (skills/), none on the folder I can write (users/)
    expect(document.querySelectorAll('[data-testid="picker-pass-through"]')).toHaveLength(1)
    const text = document.body.textContent ?? ''
    expect(text).toContain(translate('en', 'files.passThroughShort'))
    expect(text.split(translate('en', 'files.readOnly')).length - 1).toBe(1)
    expect(document.body.textContent).not.toContain('No access')
    expect(document.querySelector('[data-testid="picker-pass-through"]')?.getAttribute('title')).toBe(translate('en', 'files.navigationOnly'))
  } finally { await m.unmount() }
})
