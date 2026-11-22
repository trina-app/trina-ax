// A chat's file in the side panel (components/FilePanel.tsx; QA-B 11-22): the versions list after the cap says why the
// numbers jump (TC-6950), a restore at the cap says which version went (TC-6949), a save beside someone else's names
// them with View (TC-6956), someone's save while I edit shows in the editor at once (TC-6956), and the "Updated by"
// line wraps with its whole text as the title (TC-6952).
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { ChatFileSaved, ChatFileVersion, ChatFileVersions } from '@mycel/shared/api'
import FilePanel from '../../src/components/FilePanel'
import { translate, useLocaleStore } from '../../src/i18n'
import type { PreviewFile } from '../../src/lib/sidePanel'
import { useChats } from '../../src/store/chats'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { DialogHost } from '../../src/components/ui'
import { installDom, mount, removeDom } from './dom-host'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const CHAT = '01900000-0000-7000-8000-00000000c0a1'
const FILE = '01900000-0000-7000-8000-00000000f0a1'
const file: PreviewFile = { source: 'chat', chatId: CHAT, fileId: FILE, name: 'notes.md' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const v = (n: number, o: Partial<ChatFileVersion> = {}): ChatFileVersion => ({ id: `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`, version: n, name: 'notes.md', size: 10, mime: 'text/markdown', createdAt: '2026-11-21T10:00:00.000Z', by: 'mia', byName: 'Mia', ...o })
const list = (ns: number[], canEdit = true): ChatFileVersions => ({ canEdit, items: ns.map((n, i) => v(n, i === ns.length - 1 ? { head: true } : {})) })

let routes: Record<string, (body: unknown, url: string) => Response> = {}
const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
const realRO = (globalThis as Record<string, unknown>).ResizeObserver
beforeAll(() => {
  installDom()
  // the panel measures its width (no layout here)
  ;(globalThis as Record<string, unknown>).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    return routes[key]?.(body, url) ?? json({ error: { code: 'not_found', message: `no route ${key}` } }, 404)
  }) as unknown as typeof fetch
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role: 'member' }, groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
})
afterEach(() => {
  routes = {}
  useUi.setState({ toasts: [] })
  useChats.setState({ threads: {} } as never)
})
afterAll(() => {
  globalThis.fetch = realFetch
  ;(globalThis as Record<string, unknown>).ResizeObserver = realRO
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status })
})
const BASE = `/api/chats/${CHAT}/files/${FILE}`
const withRoutes = (versions: ChatFileVersions, o: Record<string, (body: unknown, url: string) => Response> = {}) => {
  routes = {
    [`GET ${BASE}/versions`]: () => json(versions),
    [`GET ${BASE}`]: () => new Response('# notes', { headers: { 'content-type': 'text/markdown' } }),
    ...o,
  }
}
const open = () => mount(<MemoryRouter><FilePanel file={file} onClose={() => {}} /><DialogHost /></MemoryRouter>)
/** the restore's confirm (the Files screen's, QA TC-v1c-01): yes */
const confirm = async (m: Awaited<ReturnType<typeof mount>>) => m.click(await m.until(() => m.find('dialog-confirm'), 'the confirm'))
/** the chat on screen holds the file's tile, last changed by `updated` */
const tile = (updated?: { by: string; byName: string; at: string; version: number; ai?: true }) =>
  useChats.setState({ threads: { [CHAT]: { messages: [{ id: 'm1', role: 'assistant', attachments: [{ id: FILE, source: 'chat', name: 'notes.md', ...(updated ? { updated } : {}) }] }] } } } as never)

test('after the cap pruned versions, one quiet line says why the numbers jump; none without a gap (TC-6950, TC-6948)', async () => {
  withRoutes(list([1, ...Array.from({ length: 19 }, (_, i) => i + 9)]))
  let m = await open()
  try {
    await m.click(await m.until(() => m.find('file-versions-toggle'), 'Versions'))
    await m.until(() => m.find('file-versions'), 'the list')
    expect(m.get('file-versions-pruned').textContent).toBe(en('chatFile.olderRemoved', { n: 19 }))
    // where the numbers jump: between version 9 and version 1 (newest first)
    const order = [...m.get('file-versions').children].map((li) => li.getAttribute('data-version') ?? 'note')
    expect(order.slice(-3)).toEqual(['9', 'note', '1'])
    expect(en('chatFile.olderRemoved', { n: 19 })).toBe('Older versions were removed: only the first version and the 19 newest are kept.')
    // no small fixed box: the list may take most of the panel
    expect(m.get('file-versions').getAttribute('class')).not.toContain('max-h-64')
  } finally { await m.unmount() }
  withRoutes(list([1, 2, 3]))
  m = await open()
  try {
    await m.click(await m.until(() => m.find('file-versions-toggle'), 'Versions'))
    await m.until(() => m.find('file-versions'), 'the list')
    expect(m.find('file-versions-pruned')).toBeNull()
  } finally { await m.unmount() }
})

test('a restore at the cap says which version went to keep 20; below it, "Nothing was deleted" (TC-6949)', async () => {
  const twenty = list([1, ...Array.from({ length: 19 }, (_, i) => i + 9)])
  let pruned: number[] | undefined = [9]
  withRoutes(twenty, { [`POST ${BASE}/versions/20/restore`]: () => json({ version: v(28, { head: true }), beside: false, ...(pruned ? { pruned } : {}) } satisfies ChatFileSaved) })
  const m = await open()
  try {
    await m.click(await m.until(() => m.find('file-versions-toggle'), 'Versions'))
    const row = await m.until(() => m.container.querySelectorAll('[data-testid="file-version-row"]').find((r) => r.getAttribute('data-version') === '20'), 'version 20')
    await m.click(row.querySelector('[data-testid="file-version-restore"]')!)
    await confirm(m)
    await m.until(() => useUi.getState().toasts.length > 0, 'the toast')
    expect(useUi.getState().toasts.at(-1)!.text).toBe('Version 20 restored as the newest. Version 9 was removed to keep 20 versions.')
    useUi.setState({ toasts: [] })
    pruned = undefined
    // (the list stays open after a restore)
    const again = await m.until(() => m.container.querySelectorAll('[data-testid="file-version-row"]').find((r) => r.getAttribute('data-version') === '20'), 'version 20')
    await m.click(again.querySelector('[data-testid="file-version-restore"]')!)
    await confirm(m)
    await m.until(() => useUi.getState().toasts.length > 0, 'the toast')
    expect(useUi.getState().toasts.at(-1)!.text).toBe(en('chatFile.restored', { n: 20 }))
    // restoring the oldest kept one at the cap: its own old entry is what went, said so (not "version 20 was removed")
    useUi.setState({ toasts: [] })
    pruned = [20]
    const third = await m.until(() => m.container.querySelectorAll('[data-testid="file-version-row"]').find((r) => r.getAttribute('data-version') === '20'), 'version 20')
    await m.click(third.querySelector('[data-testid="file-version-restore"]')!)
    await confirm(m)
    await m.until(() => useUi.getState().toasts.length > 0, 'the toast')
    expect(useUi.getState().toasts.at(-1)!.text).toBe('Version 20 restored as the newest. Its old entry in the list was removed to keep 20 versions.')
  } finally { await m.unmount() }
})

test('someone saves while I edit: a quiet line names them with View; my save beside theirs names them and opens theirs (TC-6956)', async () => {
  tile({ by: 'mia', byName: 'Mia', at: '2026-11-21T10:00:00.000Z', version: 2 })
  let saved: unknown = null
  withRoutes(list([1, 2]), {
    [`GET ${BASE}`]: (_b, url) => new Response(url.includes('version=3') ? '# bob was here' : '# notes', { headers: { 'content-type': 'text/markdown' } }),
    [`PUT ${BASE}/content`]: (body) => { saved = body; return json({ version: v(4, { head: true }), beside: true, besideOf: v(3, { by: 'bob', byName: 'Bob' }) } satisfies ChatFileSaved) },
  })
  const m = await open()
  try {
    await m.click(await m.until(() => m.find('file-edit'), 'the pencil'))
    await m.until(() => m.find('file-editor'), 'the editor')
    expect(m.find('file-editor-newer')).toBeNull()
    // my own save reaching the chat late is no news (the version I opened, by me)
    tile({ by: 'mia', byName: 'Mia', at: '2026-11-21T10:00:00.000Z', version: 2 })
    await Bun.sleep(20)
    expect(m.find('file-editor-newer')).toBeNull()
    // Bob saves: the chat's tile changes while I am editing
    tile({ by: 'bob', byName: 'Bob', at: '2026-11-21T10:05:00.000Z', version: 3 })
    await m.until(() => m.find('file-editor-newer'), 'the newer line')
    expect(m.get('file-editor-newer').textContent).toContain(en('chatFile.newerWhileEditing', { name: 'Bob' }))
    expect(en('chatFile.newerWhileEditing', { name: 'Bob' })).toBe('Bob saved a newer version.')
    await m.click('file-editor-newer-view')
    await m.until(() => m.find('file-editor-theirs'), 'their text')
    expect(m.get('file-editor-theirs').textContent).toBe('# bob was here')
    // my draft is untouched
    expect((m.get('file-editor') as unknown as { value: string }).value).toBe('# notes')
    await m.type('file-editor', '# mine')
    await m.click('file-save')
    await m.until(() => useUi.getState().toasts.length > 0, 'the toast')
    expect(saved).toMatchObject({ content: '# mine' })
    const t = useUi.getState().toasts.at(-1)!
    expect(t.text).toBe('Saved. Bob saved while you were editing; their version is kept in Versions.')
    expect(t.action?.label).toBe(en('chatFile.view'))
  } finally { await m.unmount() }
})

test('"Updated by" wraps with its whole text as the title, never cut at the name (TC-6952)', async () => {
  withRoutes({ canEdit: true, items: [v(1), v(2, { head: true, ai: true, byName: 'QA Member Two' })] })
  const m = await open()
  try {
    const line = await m.until(() => m.find('file-panel-updated'), 'the line')
    expect(line.textContent).toContain('Updated by Trina for QA Member Two')
    expect(line.getAttribute('title')).toContain('Updated by Trina for QA Member Two')
    expect(line.getAttribute('class')).not.toContain('truncate')
  } finally { await m.unmount() }
})

test('a deck (not text): Restore on an earlier version and on the opened one when the server says canRestore; none without it (TC-7040)', async () => {
  const deck: PreviewFile = { source: 'chat', chatId: CHAT, fileId: FILE, name: 'deck.pptx' }
  const items = [v(1, { name: 'deck.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), v(2, { head: true, ai: true, name: 'deck.pptx' })]
  let restored = 0
  // the deck's viewer watches its links (no MutationObserver in this DOM)
  const g = globalThis as Record<string, unknown>
  const realMO = g.MutationObserver
  g.MutationObserver ??= class { observe() {} disconnect() {} takeRecords() { return [] } }
  try {
    for (const [versions, shows] of [[{ canEdit: false, canRestore: true, items }, true], [{ canEdit: false, canRestore: false, items }, false], [{ canEdit: false, items }, false]] as const) {
      withRoutes(versions as ChatFileVersions, { [`POST ${BASE}/versions/1/restore`]: () => { restored++; return json({ version: v(3, { head: true }), beside: false } satisfies ChatFileSaved) } })
      const m = await mount(<MemoryRouter><FilePanel file={deck} onClose={() => {}} /><DialogHost /></MemoryRouter>)
      try {
        await m.click(await m.until(() => m.find('file-versions-toggle'), 'Versions'))
        const row = await m.until(() => m.container.querySelectorAll('[data-testid="file-version-row"]').find((r) => r.getAttribute('data-version') === '1'), 'version 1')
        expect(!!row.querySelector('[data-testid="file-version-open"]')).toBe(true)
        expect(!!row.querySelector('[data-testid="file-version-restore"]')).toBe(shows)
        // no pencil for a deck either way
        expect(m.container.querySelector('[data-testid="file-edit"]')).toBeNull()
        await m.click(row.querySelector('[data-testid="file-version-open"]')!)
        await m.until(() => m.find('file-version-shown'), 'the opened version')
        expect(!!m.container.querySelector('[data-testid="file-version-restore-shown"]')).toBe(shows)
        if (shows) {
          await m.click('file-version-restore-shown')
          await confirm(m)
          await m.until(() => useUi.getState().toasts.length > 0, 'the toast')
          expect(useUi.getState().toasts.at(-1)!.text).toBe(en('chatFile.restored', { n: 1 }))
        }
      } finally { await m.unmount(); useUi.setState({ toasts: [] }) }
    }
  } finally { g.MutationObserver = realMO }
  expect(restored).toBe(1)
})

test('a restore asks first, naming whose later versions drop out and who in the chat sees it (QA TC-v1c-01)', async () => {
  let restored = 0
  const versions: ChatFileVersions = { canEdit: true, canRestore: true, items: [v(1), v(2, { by: 'jiwoo', byName: 'Jiwoo' }), v(3, { by: 'junho', byName: 'Junho', head: true })] }
  withRoutes(versions, {
    [`POST ${BASE}/versions/1/restore`]: () => { restored++; return json({ version: v(4, { head: true }), beside: false } satisfies ChatFileSaved) },
    [`GET /api/chats/${CHAT}/audience`]: () => json({ kind: 'people', canEdit: false, by: { id: 'junho', name: 'Junho' }, subjects: [], mentionable: [{ id: 'junho', name: 'Junho' }, { id: 'jiwoo', name: 'Jiwoo' }] }),
  })
  const m = await open()
  try {
    await m.click(await m.until(() => m.find('file-versions-toggle'), 'Versions'))
    const row = await m.until(() => m.container.querySelectorAll('[data-testid="file-version-row"]').find((r) => r.getAttribute('data-version') === '1'), 'version 1')
    await m.click(row.querySelector('[data-testid="file-version-restore"]')!)
    const dialog = await m.until(() => m.container.ownerDocument!.body.querySelector('[role="dialog"]'), 'the confirm')
    expect(dialog.textContent).toContain(en('files.restoreTitle', { version: 1 }))
    expect(dialog.textContent).toContain(en('files.restoreBodyNames', { names: 'Junho and Jiwoo' }))
    expect(dialog.textContent).toContain(en('chatFile.restoreSeen', { names: 'Junho and Jiwoo' }))
    // no: nothing restored
    await m.click('dialog-cancel')
    await m.until(() => !m.container.ownerDocument!.body.querySelector('[role="dialog"]'), 'the dialog to close')
    expect(restored).toBe(0)
    await m.click(row.querySelector('[data-testid="file-version-restore"]')!)
    await confirm(m)
    await m.until(() => restored === 1, 'the restore')
  } finally { await m.unmount() }
})

test('a guest without AI gets no "Ask Trina" on a file; a member does (QA TC-f2-b01)', async () => {
  const ROOM = '01900000-0000-7000-8000-00000000a0a1'
  const roomFile: PreviewFile = { source: 'room', roomId: ROOM, fileId: FILE, name: 'notes.md' }
  routes = { [`GET /api/rooms/${ROOM}/files/${FILE}`]: () => new Response('# notes', { headers: { 'content-type': 'text/markdown' } }) }
  const member = useSession.getState().status
  try {
    let m = await mount(<MemoryRouter><FilePanel file={roomFile} onClose={() => {}} /></MemoryRouter>)
    try { await m.until(() => m.find('file-ask-trina'), 'the member\'s Ask Trina') } finally { await m.unmount() }
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'gus', name: 'Gus', role: 'guest' }, groups: [], guest: { places: [], ai: { mode: 'none' } }, team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
    m = await mount(<MemoryRouter><FilePanel file={roomFile} onClose={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('file-panel-title'), 'the panel')
      expect(m.find('file-ask-trina')).toBeNull()
      expect(m.find('file-ask-ai')).toBeNull()
    } finally { await m.unmount() }
  } finally { useSession.setState({ status: member }) }
})
