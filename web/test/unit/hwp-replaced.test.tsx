// The HWP preview shows pages of one document (QA TC-226). Pages are asked for by path: after someone replaced the file,
// 다음 brought the NEW file's page 3 ("3 / 5쪽") right after page 2 of the old one. Each page carries the sourceHash of
// the document it was drawn from: a page of another document is not shown in its place, the preview starts again at
// page 1 of the new version and says so, until the person turns a page.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { Me } from '@mycel/shared/api'
import HwpView from '../../src/components/viewers/HwpView'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const me = {
  user: { id: 'mina', username: 'mina', name: '김민아', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const OLD = 'a'.repeat(64)
const NEW = 'b'.repeat(64)
/** the document on the server now: its hash and page count */
let doc = { hash: OLD, pages: 3 }
const asked: number[] = []
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const statusBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://x')
    if (url.pathname !== '/api/files/hwp-preview') return json({ error: { code: 'internal', message: url.pathname } }, 500)
    const page = Number(url.searchParams.get('page'))
    asked.push(page)
    return json({ page, pageCount: doc.pages, width: 10, height: 14, sourceHash: doc.hash, engine: 'test', fonts: 'test', warnings: [], id: crypto.randomUUID(), png: btoa('png') })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: statusBefore })
})
beforeEach(() => {
  doc = { hash: OLD, pages: 3 }
  asked.length = 0
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
})

/** the page line in the page buttons' row (the first status on the panel) */
const status = (m: { container: { querySelectorAll(s: string): { textContent: string | null }[] } }) => m.container.querySelectorAll('[role="status"]')[0]?.textContent ?? ''

test('the file replaced between two pages: page 1 of the new version, with a notice; turning a page clears it', async () => {
  const m = await mount(<HwpView source={{ kind: 'team', path: 'shared/Docs/plan.hwpx' }} download={() => {}} />)
  try {
    await m.until(() => status(m) === '1 / 3쪽', 'page 1 of the old version')
    await m.click('hwp-next')
    await m.until(() => status(m) === '2 / 3쪽', 'page 2 of the old version')
    expect(m.find('hwp-replaced')).toBeNull()
    // B replaces the file with a 5-page version
    doc = { hash: NEW, pages: 5 }
    await m.click('hwp-next')
    await m.until(() => status(m) === '1 / 5쪽', 'page 1 of the new version')
    expect(asked).toEqual([1, 2, 3, 1])
    expect(m.get('hwp-replaced').textContent).toBe('문서가 바뀌어서 첫 쪽부터 다시 보여 드려요.')
    await m.click('hwp-next')
    await m.until(() => status(m) === '2 / 5쪽', 'page 2 of the new version')
    expect(m.find('hwp-replaced')).toBeNull()
  } finally {
    await m.unmount()
  }
})

test('the same document page after page: no notice, the pages asked for in order', async () => {
  const m = await mount(<HwpView source={{ kind: 'team', path: 'shared/Docs/plan.hwpx' }} download={() => {}} startPage={2} />)
  try {
    await m.until(() => status(m) === '2 / 3쪽', 'page 2')
    await m.click('hwp-next')
    await m.until(() => status(m) === '3 / 3쪽', 'page 3')
    await m.click('hwp-previous')
    await m.until(() => status(m) === '2 / 3쪽', 'page 2 again')
    expect(asked).toEqual([2, 3, 2])
    expect(m.find('hwp-replaced')).toBeNull()
  } finally {
    await m.unmount()
  }
})
