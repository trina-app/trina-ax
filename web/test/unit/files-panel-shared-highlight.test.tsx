// Files' places: Shared with me (/files?view=shared) and the team folder Company-wide (/files?path=shared) both used the
// key `shared`, so with either open both rows were marked (QA TC-3973). Only the open one is marked now, on a computer
// (the panel beside the rail) and on a phone (the Files tab's list, also the drawer), and the links go to the right one.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { FileEntry, Me, TreeResponse } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { useFileLists } from '../../src/store/fileLists'
import { FilesPanel, PhoneFilesHome } from '../../src/components/panels/FilesPanel'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'

const me = {
  user: { id: 'mina', username: 'mina', name: '김민아', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const folder = (path: string): FileEntry => ({ name: path, path, type: 'folder', size: null, mtime: '2026-11-05T00:00:00.000Z', mime: null, access: 'write' })
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
    if (key === 'GET /api/files/tree') return json({ path: '', access: 'write', entries: [folder('groups'), folder('shared'), folder('mine'), folder('recent'), folder('trash')], nextCursor: null } as TreeResponse)
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
  useFileLists.getState().reset()
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
})

const IDS = ['files-panel-recent', 'files-panel-shared', 'files-panel-team', 'files-panel-mine', 'files-panel-trash']
const marked = (m: { container: FakeElement }) =>
  IDS.flatMap((id) => m.container.querySelectorAll(`[data-testid="${id}"]`)).filter((e) => e.getAttribute('aria-current') === 'page').map((e) => `${e.getAttribute('data-testid')}:${e.getAttribute('href')}`)

for (const [where, ui] of [['computer', <FilesPanel />], ['phone', <PhoneFilesHome />]] as const) {
  const at = async (url: string) => {
    const m = await mount(<MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>)
    await m.until(() => m.find('files-panel-team'), 'the team folder rows')
    return m
  }

  test(`${where}: Shared with me open marks only its own row, not Company-wide`, async () => {
    const m = await at('/files?view=shared')
    try {
      expect(marked(m)).toEqual(['files-panel-shared:/files?view=shared'])
    } finally {
      await m.unmount()
    }
  })

  test(`${where}: Company-wide open (a file in it too) marks only that row, not Shared with me`, async () => {
    for (const url of ['/files?path=shared', '/files/view?path=shared%2Fplan.md', '/files?path=shared%2Fsub']) {
      const m = await at(url)
      try {
        expect(marked(m)).toEqual(['files-panel-team:/files?path=shared'])
      } finally {
        await m.unmount()
      }
    }
  })

  test(`${where}: root folders named mine, recent and trash do not light up the own folder or the views`, async () => {
    for (const name of ['mine', 'recent', 'trash']) {
      const m = await at(`/files?path=${name}`)
      try {
        expect(marked(m)).toEqual([`files-panel-team:/files?path=${name}`])
      } finally {
        await m.unmount()
      }
    }
    for (const [url, row] of [['/files?view=recent', 'files-panel-recent'], ['/files?view=trash', 'files-panel-trash'], ['/files?path=users%2Fmina', 'files-panel-mine']] as const) {
      const m = await at(url)
      try {
        expect(marked(m).map((x) => x.split(':')[0])).toEqual([row])
      } finally {
        await m.unmount()
      }
    }
  })

  test(`${where}: 내 파일 is the first place, before 최근 파일 and the team's (docs/decisions/20261125-upload-destination.md)`, async () => {
    const m = await at('/files?path=users%2Fmina')
    try {
      const order = m.container.querySelectorAll('[data-testid^="files-panel-"]').map((e) => e.getAttribute('data-testid')).filter((id) => IDS.includes(id!))
      expect(order[0]).toBe('files-panel-mine')
      expect(order.slice(1, 3)).toEqual(['files-panel-recent', 'files-panel-shared'])
      expect(order.at(-1)).toBe('files-panel-trash')
    } finally {
      await m.unmount()
    }
  })

  test(`${where}: the rows link to their own place`, async () => {
    const m = await at('/files')
    try {
      expect(m.get('files-panel-shared').getAttribute('href')).toBe('/files?view=shared')
      expect(m.get('files-panel-team').getAttribute('href')).not.toBe('/files?view=shared')
      expect(m.container.querySelectorAll('[data-testid="files-panel-team"]').map((e) => e.getAttribute('href'))).toContain('/files?path=shared')
    } finally {
      await m.unmount()
    }
  })
}
