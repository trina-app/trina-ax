// Two phone screens (below 768 px), rendered and pressed:
// - the 나 tab opens the Settings list (/settings), which starts with the person's photo, name and title (or role)
//   linking to the profile, leaves out its own 프로필 row there and starts on its title (no ring on a ←); a computer
//   starts in the search box;
// - the profile's Save shows only once something changed;
// - Files: a long press on a row selects it (the click that ends it does not open the folder), a tap while something
//   is selected adds or takes a row away, and on a computer a click opens the folder as before.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { Me, TreeResponse } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { BottomTabs } from '../../src/components/BottomTabs'
import SettingsDialog from '../../src/components/settings/SettingsDialog'
import SettingsPane from '../../src/pages/Settings'
import Files from '../../src/pages/Files'
import { FakeEvent, installDom, mount, removeDom, type FakeElement } from './dom-host'

const me = (title?: string): Me =>
  ({
    user: { id: 'mina', username: 'mina', name: '김민아', title, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
    groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
    server: { version: '0', dev: false, deployment: 'hosted' },
  }) as unknown as Me
const folder = (name: string, access: 'write' | 'read' | 'none') => ({ name, path: name, type: 'folder' as const, size: null, mtime: '2026-11-05T00:00:00.000Z', mime: null, access })
const tree = (path: string): TreeResponse => ({ path, access: 'write', entries: path ? [] : [folder('groups', 'none'), folder('shared', 'write'), folder('skills', 'read')], nextCursor: null }) as TreeResponse
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

let phone = false
const calls: string[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const statusBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  // the width only: no touch screen here, so rows can still be dragged
  ;(globalThis as Record<string, unknown>).matchMedia = (q: string) => ({ matches: phone && q === '(max-width: 767.98px)', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (key === 'GET /api/me/credentials') return json({ allowed: false, items: [] })
    if (key === 'GET /api/projects') return json({ items: [] })
    if (key === 'GET /api/files/tree') return json(tree(new URL(url, 'http://x').searchParams.get('path') ?? ''))
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
  useSession.setState({ status: { kind: 'signed-in', me: me('재무 매니저') } } as never)
})

test('the 나 tab opens the Settings list, not the profile', () => {
  const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/rooms']}><BottomTabs /></MemoryRouter>)
  const tab = /<a [^>]*data-testid="tab-me"[^>]*>/.exec(html)?.[0] ?? ''
  expect(tab).toContain('href="/settings"')
})

describe('Settings on a phone', () => {
  const dialog = (path: string) => mount(<MemoryRouter initialEntries={[path]}><Routes><Route path="/settings/:tab?" element={<SettingsDialog onClose={() => {}} />} /></Routes></MemoryRouter>)
  const heading = (m: { container: FakeElement }) => m.container.querySelector('h2')!

  test('the list starts with the photo row, which opens the profile; the list has no 프로필 row of its own there', async () => {
    phone = true
    const m = await dialog('/settings')
    try {
      const row = m.get('settings-me')
      expect(row.getAttribute('href')).toBe('/settings/profile')
      expect(row.textContent).toContain('김민아')
      expect(row.textContent).toContain('재무 매니저')
      const own = m.get('settings-menu').querySelectorAll('a[href="/settings/profile"]').filter((a) => a !== row)
      expect(own.length).toBe(1)
      expect(own[0]!.getAttribute('class')).toContain('max-md:hidden')
      // starts on its title, not on a button that would show a focus ring
      expect(heading(m).getAttribute('data-autofocus')).not.toBeNull()
      expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(heading(m))
    } finally {
      await m.unmount()
    }
  })

  test('no title: the role says who it is', async () => {
    phone = true
    useSession.setState({ status: { kind: 'signed-in', me: me() } } as never)
    const m = await dialog('/settings')
    try {
      expect(m.get('settings-me').textContent).toContain('팀원')
    } finally {
      await m.unmount()
    }
  })

  test('a computer starts in the search box, as before', async () => {
    phone = false
    const m = await dialog('/settings')
    try {
      expect(heading(m).getAttribute('data-autofocus')).toBeNull()
      expect(m.get('settings-me').getAttribute('class')).toContain('md:hidden')
    } finally {
      await m.unmount()
    }
  })
})

test('the profile shows Save only after a change', async () => {
  phone = true
  const m = await mount(<MemoryRouter><SettingsPane tab="profile" /></MemoryRouter>)
  try {
    await m.until(() => m.find('profile-form'), 'the profile')
    expect(m.find('profile-save')).toBeNull()
    const name = m.get('profile-form').querySelectorAll('input').find((i) => i.getAttribute('maxlength') === '100')!
    await m.type(name, '김민아 B')
    expect(m.get('profile-save').textContent).toBe('저장')
    await m.type(name, '김민아')
    expect(m.find('profile-save')).toBeNull()
  } finally {
    await m.unmount()
  }
})

describe('Files rows on a phone', () => {
  const page = () => mount(<MemoryRouter initialEntries={['/files']}><Files /></MemoryRouter>)
  const row = (m: { container: FakeElement }, name: string) => m.container.querySelectorAll('tr[data-testid="file-row"]').find((r) => r.textContent?.includes(name))!
  const nameButton = (r: FakeElement) => r.querySelectorAll('button').find((b) => b.getAttribute('aria-current') === null && !b.getAttribute('data-testid'))!
  const pointer = (el: FakeElement, type: string) => act(async () => void el.dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 20 })))
  const opened = (path: string) => calls.some((c) => c.startsWith(`GET /api/files/tree?path=${path}&`))
  const count = (m: { find(id: string): FakeElement | null }) => m.find('bulk-count')?.textContent ?? null

  test('a long press selects a row and does not open it; a tap then adds or takes rows away; a short tap opens', async () => {
    phone = true
    const m = await page()
    try {
      await m.until(() => m.find('file-row'), 'the rows')
      const shared = nameButton(row(m, 'shared'))
      await pointer(shared, 'pointerdown')
      await m.settle(650)
      await pointer(shared, 'pointerup')
      await m.click(shared) // the click that ends the long press
      expect(count(m)).toBe('1개 선택됨')
      expect(opened('shared')).toBe(false)
      // selecting: a tap adds a row, another takes it away
      await m.click(nameButton(row(m, 'skills')))
      expect(count(m)).toBe('2개 선택됨')
      await m.click(nameButton(row(m, 'skills')))
      expect(count(m)).toBe('1개 선택됨')
      // a folder the person can only pass through is not selected by a long press
      const groups = nameButton(row(m, 'groups'))
      await pointer(groups, 'pointerdown')
      await m.settle(650)
      await pointer(groups, 'pointerup')
      expect(count(m)).toBe('1개 선택됨')
      await m.click(nameButton(row(m, 'shared')))
      expect(count(m)).toBeNull()
      // nothing selected: a short tap opens the folder
      await pointer(shared, 'pointerdown')
      await pointer(shared, 'pointerup')
      await m.click(nameButton(row(m, 'shared')))
      await m.until(() => opened('shared'), 'shared opened')
    } finally {
      await m.unmount()
    }
  })

  test('a computer: no long press, a click opens the folder', async () => {
    phone = false
    const m = await page()
    try {
      await m.until(() => m.find('file-row'), 'the rows')
      const shared = nameButton(row(m, 'shared'))
      await pointer(shared, 'pointerdown')
      await m.settle(650)
      await pointer(shared, 'pointerup')
      expect(count(m)).toBeNull()
      await m.click(shared)
      await m.until(() => opened('shared'), 'shared opened')
    } finally {
      await m.unmount()
    }
  })
})
