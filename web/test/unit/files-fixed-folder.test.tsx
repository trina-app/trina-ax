// Files: a folder the server marks fixed (FileEntry.fixed, QA TC-224). A member of 'sales' can write groups/sales but
// only an admin may rename, move or trash it: the row menu has those three off with the reason under them, the
// selection bar leaves it out of move and trash and says so, and nothing is sent to the server. A plain folder keeps
// them on; an older server (no mark) keeps them on too, and the server decides as before.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { FileEntry, Me, TreeResponse } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import Files from '../../src/pages/Files'
import { FakeElement, installDom, mount, removeDom } from './dom-host'

const me = {
  user: { id: 'mina', username: 'mina', name: '김민아', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const folder = (path: string, o: Partial<FileEntry> = {}): FileEntry => ({ name: path.split('/').pop()!, path, type: 'folder', size: null, mtime: '2026-11-05T00:00:00.000Z', mime: null, access: 'write', ...o })
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

const calls: string[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const statusBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  ;(globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const key = `${init?.method ?? 'GET'} ${url.pathname}`
    calls.push(key)
    if (key === 'GET /api/projects') return json({ items: [] })
    if (key === 'GET /api/files/tree') {
      const path = url.searchParams.get('path') ?? ''
      const entries = path === 'groups' ? [folder('groups/sales', { fixed: 'admin' }), folder('groups/plain'), folder('groups/older')] : []
      return json({ path, access: path === 'groups' ? 'none' : 'write', entries, nextCursor: null } as TreeResponse)
    }
    return json({ error: { code: 'internal', message: `no route ${key}` } }, 500)
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: statusBefore })
})
beforeEach(() => {
  calls.length = 0
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
})

const row = (c: FakeElement, name: string) => c.querySelectorAll('tr[data-testid="file-row"]').find((r) => r.querySelectorAll('button').some((b) => b.textContent?.trim() === name))!
const page = () => mount(<MemoryRouter initialEntries={['/files?path=groups']}><Files /></MemoryRouter>)

test("the group's folder: rename, move and trash are off, with the reason; a plain folder keeps them", async () => {
  const m = await page()
  try {
    await m.until(() => m.find('file-row'), 'the rows')
    await m.click(row(m.container, 'sales').querySelector('[data-testid="file-menu"]')!)
    for (const id of ['file-rename', 'file-move', 'file-trash']) {
      const b = m.get(id)
      expect(b.getAttribute('disabled')).not.toBeNull()
      expect(b.getAttribute('aria-describedby')).toBe(m.get('file-fixed-reason').getAttribute('id'))
    }
    expect(m.get('file-fixed-reason').textContent).toBe('이 폴더는 관리자만 이름을 바꾸거나 옮기거나 지울 수 있어요.')
    // pressing does nothing: no move or delete request
    await m.click('file-trash')
    expect(calls.some((c) => c.startsWith('POST') || c.startsWith('DELETE'))).toBe(false)
  } finally {
    await m.unmount()
  }
  const n = await page()
  try {
    await n.until(() => n.find('file-row'), 'the rows')
    await n.click(row(n.container, 'plain').querySelector('[data-testid="file-menu"]')!)
    for (const id of ['file-rename', 'file-move', 'file-trash']) expect(n.get(id).getAttribute('disabled')).toBeNull()
    expect(n.find('file-fixed-reason')).toBeNull()
  } finally {
    await n.unmount()
  }
})

test('selected, the fixed folder is counted apart and move and trash stay off while only it is selected', async () => {
  const m = await page()
  try {
    await m.until(() => m.find('file-row'), 'the rows')
    // a checkbox click: the browser flips `checked` (past React's value tracker), then the click event
    const tick = async (name: string) => {
      const box = row(m.container, name).querySelector('input[type="checkbox"]')!
      Object.getOwnPropertyDescriptor(FakeElement.prototype, 'checked')!.set!.call(box, true)
      await m.click(box)
    }
    await tick('sales')
    await m.until(() => m.find('bulk-bar'), 'the selection bar')
    expect(m.get('bulk-bar').textContent).toContain('옮길 수 없는 폴더 1개')
    expect(m.get('bulk-move').getAttribute('disabled')).not.toBeNull()
    expect(m.get('bulk-delete').getAttribute('disabled')).not.toBeNull()
    await tick('plain')
    expect(m.get('bulk-move').getAttribute('disabled')).toBeNull()
    expect(m.get('bulk-bar').textContent).not.toContain('읽기 전용')
  } finally {
    await m.unmount()
  }
})
