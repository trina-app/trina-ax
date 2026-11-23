// QA TC-f2-d03 (batch 5): after 버전 기록 › 되돌리기 on the Files screen, an open team file's preview kept the old text
// until a reload. The panel (components/FilePanel.tsx) now reads a team file again when files.changed names it (the
// history dialog also says so at once, pages/Files.tsx), and not while it is being edited.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import FilePanel from '../../src/components/FilePanel'
import { useLocaleStore } from '../../src/i18n'
import type { PreviewFile } from '../../src/lib/sidePanel'
import { filesChanged } from '../../src/store/live'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const PATH = 'shared/견적/notes.md'
const file: PreviewFile = { source: 'team', path: PATH, name: 'notes.md' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let text = 'version 3'
let downloads = 0
const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
const realRO = (globalThis as Record<string, unknown>).ResizeObserver
beforeAll(() => {
  installDom()
  ;(globalThis as Record<string, unknown>).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/files/download')) { downloads++; return new Response(text, { headers: { 'content-type': 'text/markdown' } }) }
    if (url.includes('/api/files/content')) return json({ path: PATH, content: '', size: text.length, truncated: true, mime: 'text/markdown', canWrite: false })
    return json({ error: { code: 'not_found', message: 'no route' } }, 404)
  }) as unknown as typeof fetch
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role: 'member' }, groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
})
afterEach(() => { text = 'version 3'; downloads = 0 })
afterAll(() => {
  globalThis.fetch = realFetch
  ;(globalThis as Record<string, unknown>).ResizeObserver = realRO
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status })
})

test('a restore of the open file shows the restored text at once; a change of another file reads nothing again', async () => {
  const m = await mount(<MemoryRouter><FilePanel file={file} onClose={() => {}} /></MemoryRouter>)
  try {
    await m.until(() => (document.body.textContent ?? '').includes('version 3') || null, 'the first text')
    const first = downloads
    // another file changed: nothing read again
    filesChanged.emit([{ path: 'shared/견적/other.md', action: 'update', by: null, turnId: null }])
    await new Promise((r) => setTimeout(r, 50))
    expect(downloads).toBe(first)
    // the open file restored to version 1 (the same path, another Unicode form too)
    text = 'version 1'
    filesChanged.emit([{ path: PATH.normalize('NFD'), action: 'restore', by: null, turnId: null }])
    await m.until(() => (document.body.textContent ?? '').includes('version 1') || null, 'the restored text')
    expect(document.body.textContent).not.toContain('version 3')
    // a delete or a move of it: no read (the panel says it is gone when it next reads)
    const after = downloads
    filesChanged.emit([{ path: PATH, action: 'delete', by: null, turnId: null }])
    await new Promise((r) => setTimeout(r, 50))
    expect(downloads).toBe(after)
  } finally { await m.unmount() }
})
