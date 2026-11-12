// Files: 더 보기 belongs to the folder on screen when it was pressed (QA TC-240). On a slow network a person pressed
// 더 보기 in a folder of 400 files and opened a subfolder before the next page came back: the subfolder showed its own
// files plus the parent's next 200 rows. Here the page of the folder left behind arrives last and is dropped; the
// subfolder lists only its own files, and its 더 보기 (if any) is not left busy.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me, TreeResponse } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import Files from '../../src/pages/Files'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'

const me = {
  user: { id: 'mina', username: 'mina', name: '김민아', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const entry = (path: string, type: 'file' | 'folder') => ({ name: path.split('/').pop()!, path, type, size: type === 'file' ? 10 : null, mtime: '2026-11-05T00:00:00.000Z', mime: type === 'file' ? 'text/plain' : null, access: 'write' as const })
const BIG = 'shared/big'
const SUB = 'shared/big/sub'
const files = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => entry(`${BIG}/doc_${String(from + i).padStart(3, '0')}.txt`, 'file'))
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

/** the parent's second page, held until the test lets it go */
let release: (() => void) | null = null
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
    calls.push(`${key}?${url.searchParams}`)
    if (key === 'GET /api/projects') return json({ items: [] })
    if (key === 'GET /api/files/tree') {
      const path = url.searchParams.get('path') ?? ''
      if (path === SUB) return json({ path: SUB, access: 'write', entries: [entry(`${SUB}/a.txt`, 'file'), entry(`${SUB}/b.txt`, 'file')], nextCursor: null } as TreeResponse)
      if (path === BIG && url.searchParams.get('cursor')) {
        await new Promise<void>((r) => { release = r })
        return json({ path: BIG, access: 'write', entries: files(200, 400), nextCursor: null } as TreeResponse)
      }
      if (path === BIG) return json({ path: BIG, access: 'write', entries: [entry(SUB, 'folder'), ...files(0, 199)], nextCursor: 'c1' } as TreeResponse)
      return json({ path, access: 'write', entries: [], nextCursor: null } as TreeResponse)
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
  release = null
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
})

const rows = (c: FakeElement) => c.querySelectorAll('tr[data-testid="file-row"]').map((r) => r.textContent ?? '')
const button = (c: FakeElement, text: string) => c.querySelectorAll('button').find((b) => b.textContent?.trim() === text) ?? null

test('a subfolder opened while 더 보기 loads lists only its own files', async () => {
  const m = await mount(<MemoryRouter initialEntries={[`/files?path=${encodeURIComponent(BIG)}`]}><Files /></MemoryRouter>)
  try {
    await m.until(() => rows(m.container).length === 200, 'the first 200 rows')
    await m.click(await m.until(() => button(m.container, '더 보기'), 'the 더 보기 button'))
    await m.until(() => release, 'the second page asked for')
    // the subfolder opens before the page arrives
    const sub = m.container.querySelectorAll('tr[data-testid="file-row"]').find((r) => r.textContent?.includes('sub'))!
    await m.click(sub.querySelectorAll('button').find((b) => b.textContent?.trim().startsWith('sub'))!)
    await m.until(() => rows(m.container).length === 2, "the subfolder's rows")
    release!()
    await m.settle(100)
    const now = rows(m.container)
    expect(now.length).toBe(2)
    expect(now.some((r) => r.includes('doc_'))).toBe(false)
    expect(calls.filter((c) => c.includes('cursor=')).length).toBe(1)
  } finally {
    await m.unmount()
  }
})

test('without leaving the folder, 더 보기 still adds the next page', async () => {
  const m = await mount(<MemoryRouter initialEntries={[`/files?path=${encodeURIComponent(BIG)}`]}><Files /></MemoryRouter>)
  try {
    await m.until(() => rows(m.container).length === 200, 'the first 200 rows')
    await m.click(await m.until(() => button(m.container, '더 보기'), 'the 더 보기 button'))
    await m.until(() => release, 'the second page asked for')
    release!()
    await m.until(() => rows(m.container).length === 400, 'all 400 rows')
    expect(button(m.container, '더 보기')).toBeNull()
  } finally {
    await m.unmount()
  }
})
