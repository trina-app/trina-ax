// Files: a file's ⋯ menu says "{AI}에게 물어보기" with the AI's name filled in (pages/Files.tsx, as components/FilePanel.tsx
// does). The item was read without the name, so the menu showed a raw "{name}" (found by phone-app-wording.spec.ts).
// A folder's item ("이 폴더로 대화 시작") has no name in it and stays as it is.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { FileEntry, Me, TreeResponse } from '@mycel/shared/api'
import { DICTS, useLocaleStore } from '../../src/i18n'
import { aiName } from '../../src/lib/tabs'
import { useSession } from '../../src/store/session'
import Files from '../../src/pages/Files'
import { installDom, mount, removeDom } from './dom-host'

const me = {
  user: { id: 'mina', username: 'mina', name: '김민아', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const entry = (path: string, type: 'file' | 'folder'): FileEntry => ({ name: path.split('/').pop()!, path, type, size: type === 'file' ? 10 : null, mtime: '2026-11-05T00:00:00.000Z', mime: type === 'file' ? 'text/plain' : null, access: 'write' })
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

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
    if (key === 'GET /api/projects') return json({ items: [] })
    if (key === 'GET /api/files/tree') {
      const path = url.searchParams.get('path') ?? ''
      const entries = path === 'shared' ? [entry('shared/notes.txt', 'file'), entry('shared/plans', 'folder')] : []
      return json({ path, access: 'write', entries, nextCursor: null } as TreeResponse)
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
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
})

test("a file's ⋯ asks the AI by its name; a folder's starts a chat with the folder", async () => {
  const t = DICTS.ko
  const name = aiName((k) => t[k])
  for (const [file, label] of [['notes.txt', t['files.askAi'].replace('{name}', name)], ['plans', t['files.chatWithFolder']]] as const) {
    const m = await mount(<MemoryRouter initialEntries={['/files?path=shared']}><Files /></MemoryRouter>)
    try {
      await m.until(() => m.find('file-row'), 'the rows')
      const row = m.container.querySelectorAll('tr[data-testid="file-row"]').find((r) => r.textContent?.includes(file))!
      await m.click(row.querySelector('[data-testid="file-menu"]')!)
      expect(m.get('chat-with-file').textContent?.trim()).toBe(label)
      expect(m.get('chat-with-file').textContent).not.toContain('{name}')
    } finally {
      await m.unmount()
    }
  }
})
