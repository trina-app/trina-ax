// Two phone screens (below 768 px), rendered and pressed:
// - the 나 tab opens the Settings list (/settings), which starts with the person's photo, name and title (or role)
//   linking to the profile, leaves out its own 프로필 row there and starts on its title (no ring on a ←); a computer
//   keeps its start;
// - the profile's Save shows only once something changed;
// - 보안·기기: rows (Change password and the other devices open pages under it); on the devices page a tap on another
//   device asks first; this device has no sign-out, only its "지금 이 기기" label; a computer keeps the worded button
//   (no question, as before);
// - Files: a long press on a row selects it (the click that ends it does not open the folder), a tap while something
//   is selected adds or takes a row away, and on a computer a click opens the folder as before.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom'
import type { Me, TreeResponse } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { BottomTabs } from '../../src/components/BottomTabs'
import SettingsDialog from '../../src/components/settings/SettingsDialog'
import SettingsPane from '../../src/pages/Settings'
import { DialogHost } from '../../src/components/ui'
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
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const session = (n: number, current = false) => ({ id: `01900000-0000-7000-8000-00000000000${n}`, client: 'web', userAgent: UA, createdAt: '2026-11-05T00:00:00.000Z', lastSeenAt: '2026-11-05T00:00:00.000Z', expiresAt: '2026-12-05T00:00:00.000Z', current })
const sessions = [session(1, true), session(2)]
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
    if (key === 'GET /api/me/sessions') return json({ items: sessions })
    if (key.startsWith('DELETE /api/me/sessions/')) return json({ ok: true })
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
      // the phone's list (phone/PhoneList.tsx) has no 프로필 row of its own: the photo row is it
      const own = m.get('settings-menu').querySelectorAll('a[href="/settings/profile"]').filter((a) => a !== row)
      expect(own.length).toBe(0)
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

  // the phone's own Back must return to the list (docs/DECISIONS.md "Admin and Settings on phones"): a phone's row pushes;
  // a computer's keeps replacing, so closing the dialog steps back once (App.tsx useSettingsOverlay counts pushes)
  test('a phone\'s row pushes its section; a computer\'s replaces it', async () => {
    let seen: { path: string; type: string } | null = null
    function Where() {
      const l = useLocation()
      seen = { path: l.pathname, type: useNavigationType() }
      return null
    }
    const click = async (el: FakeElement) => {
      const ev = new FakeEvent('click', { bubbles: true, cancelable: true })
      Object.assign(ev, { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })
      await act(async () => void el.dispatchEvent(ev))
    }
    for (const [isPhone, type] of [[true, 'PUSH'], [false, 'REPLACE']] as const) {
      phone = isPhone
      const m = await mount(<MemoryRouter initialEntries={['/settings']}><Routes><Route path="/settings/:tab?" element={<><SettingsDialog onClose={() => {}} /><Where /></>} /></Routes></MemoryRouter>)
      try {
        const row = m.get('settings-menu').querySelectorAll('a[href="/settings/security"]')[0]!
        await click(row)
        expect(seen as unknown).toEqual({ path: '/settings/security', type })
      } finally {
        await m.unmount()
      }
    }
  })

  test('a computer keeps its start (the first button) and has no photo row', async () => {
    phone = false
    const m = await dialog('/settings')
    try {
      expect(heading(m).getAttribute('data-autofocus')).toBeNull()
      // a computer's list is the sections only (the phone list with the photo row is drawn on a phone only)
      expect(m.find('settings-me')).toBeNull()
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

describe('보안·기기: signing another device out', () => {
  const page = (tab = 'security') => mount(<MemoryRouter><SettingsPane tab={tab} /><DialogHost /></MemoryRouter>)
  const signedOut = () => calls.filter((c) => c.startsWith('DELETE /api/me/sessions/'))

  test('a phone: the section is rows (password, this device with its label, the others as one row with their count)', async () => {
    phone = true
    const m = await page()
    try {
      await m.until(() => m.find('devices-more'), 'the devices')
      expect(m.get('password-open').getAttribute('href')).toBe('/settings/security/password')
      const rows = m.container.querySelectorAll('[data-testid="device-row"]')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.textContent).toContain('지금 이 기기')
      expect(m.find('device-sign-out')).toBeNull()
      expect(m.get('devices-more').getAttribute('href')).toBe('/settings/security/devices')
      expect(m.get('devices-more').textContent).toContain('1')
      // no "n more" text button and no inline password form
      expect(m.container.textContent).not.toContain('더 보기')
      expect(m.container.querySelector('input[type="password"]')).toBeNull()
    } finally {
      await m.unmount()
    }
  })

  test('a phone: on the devices page a tap on another device asks first; this device has no sign-out', async () => {
    phone = true
    const m = await page('security-devices')
    try {
      await m.until(() => m.find('device-sign-out'), 'the devices')
      const rows = m.container.querySelectorAll('[data-testid="device-row"]')
      expect(rows).toHaveLength(2)
      expect(rows[0]!.textContent).toContain('지금 이 기기')
      expect(rows[0]!.querySelector('[data-testid="device-sign-out"]')).toBeNull()
      const row = rows[1]!
      expect(row.tagName).toBe('BUTTON')
      // its name is what it shows, then what a tap does (axe: label in name)
      expect(row.getAttribute('aria-label')).toBeNull()
      expect(row.textContent).toContain('로그아웃')
      // "No": nothing is signed out
      await m.click(row)
      await m.until(() => m.find('dialog-confirm'), 'the question')
      const dialog = () => m.get('dialog-confirm').closest('[role="dialog"]')!
      expect(dialog().textContent).toContain('macOS의 Chrome에서 로그아웃할까요?')
      expect(signedOut()).toEqual([])
      await m.click(dialog().querySelectorAll('button').find((b) => b.textContent === '취소')!)
      expect(m.find('dialog-confirm')).toBeNull()
      expect(signedOut()).toEqual([])
      // "Sign out": that device only
      await m.click(row)
      await m.until(() => m.find('dialog-confirm'), 'the question')
      await m.click(m.get('dialog-confirm'))
      await m.until(() => signedOut().length > 0, 'the sign-out')
      expect(signedOut()).toEqual([`DELETE /api/me/sessions/${sessions[1]!.id}`])
    } finally {
      await m.unmount()
    }
  })

  test('a computer: the worded button signs out at once, as before', async () => {
    phone = false
    const m = await page()
    try {
      await m.until(() => m.find('device-sign-out'), 'the devices')
      expect(m.get('device-sign-out').textContent).toBe('로그아웃')
      await m.click('device-sign-out')
      await m.until(() => signedOut().length > 0, 'the sign-out')
      expect(m.find('dialog-confirm')).toBeNull()
    } finally {
      await m.unmount()
    }
  })
})

describe('Files rows on a phone', () => {
  const page = () => mount(<MemoryRouter initialEntries={['/files']}><Files /></MemoryRouter>)
  // a top folder's row shows its word (docs/DECISIONS.md "Team folder basics"): found by it, opened by its path
  const WORD: Record<string, string> = { shared: '전사 공유', skills: '팀 스킬', groups: '부서' }
  const row = (m: { container: FakeElement }, name: string) => m.container.querySelectorAll('tr[data-testid="file-row"]').find((r) => r.textContent?.includes(WORD[name] ?? name))!
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
      // the team root in its fixed order (the server listed groups, shared, skills): 전사 공유, 부서, 팀 스킬
      // (부서 is pass-through here: its row also carries the "이동만" badge after the name)
      const names = m.container.querySelectorAll('tr[data-testid="file-row"]').map((r) => nameButton(r).textContent?.trim() ?? '')
      expect(names.map((n, i) => n.startsWith(['전사 공유', '부서', '팀 스킬'][i]!))).toEqual([true, true, true])
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
