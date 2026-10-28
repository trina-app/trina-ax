// Settings > Browser (clinic pilot: the "allow all websites" setting was only in the browser panel's ⚙) and the admin
// switch "members can turn on 'Allow all websites'". The value lives in the desktop app: here a stand-in for the
// desktop bridge (window.mycelDesktop) keeps it and answers like the real main process (desktop/src/main/main.ts):
// "all" changes only when the stand-in's confirmation dialog is confirmed, and a team policy that is off (read from
// GET /api/me, as the app does) turns "all" back to "ask". The real app is covered by desktop/e2e/settings.spec.ts.
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

/** Installed before the app's scripts: a desktop bridge with browserSettings and nothing else of interest. */
function fakeDesktop() {
  type S = { siteAccess: 'ask' | 'all'; always: string[]; privateAlways: string[]; teamAllowsAll: boolean }
  type D = { s: S; dialog: 'confirm' | 'cancel'; dialogs: number; listeners: ((s: S) => void)[] }
  const w = window as unknown as { mycelDesktop: unknown; __desktop: D }
  // the app keeps the value across page loads (here: this tab's sessionStorage)
  const saved = sessionStorage.getItem('fake-desktop')
  const first: S = { siteAccess: 'ask', always: ['naver.com', 'place.map.kakao.com'], privateAlways: ['192.168.0.20'], teamAllowsAll: true }
  const d: D = { s: saved ? (JSON.parse(saved) as S) : first, dialog: 'cancel', dialogs: 0, listeners: [] }
  w.__desktop = d
  const emit = () => {
    sessionStorage.setItem('fake-desktop', JSON.stringify(d.s))
    d.listeners.forEach((f) => f(structuredClone(d.s)))
  }
  const policy = async () => {
    // like AppWindow.refreshTeamInfo: the policy comes from the team server, never from the page
    const r = await fetch('/api/me', { credentials: 'same-origin' }).catch(() => null)
    const me = r && r.ok ? await r.json() : null
    const allow = me?.team?.browserAllowAll
    if (typeof allow !== 'boolean') return
    const before = JSON.stringify(d.s)
    d.s.teamAllowsAll = allow
    if (!allow) d.s.siteAccess = 'ask'
    if (JSON.stringify(d.s) !== before) emit()
  }
  const noop = () => {}
  w.mycelDesktop = {
    bridgeVersion: 1,
    appVersion: '0.2.3',
    platform: 'darwin',
    browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [{ type: 'text', text: 'no pane' }], error: 'no pane' }), cancel: noop },
    pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
    connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: location.origin, fingerprintMismatch: false }), onChange: () => noop },
    notify: noop,
    openTeams: noop,
    setLocale: noop,
    browserSettings: {
      get: async () => {
        void policy()
        return structuredClone(d.s)
      },
      onChange: (cb: (s: S) => void) => {
        d.listeners.push(cb)
        return () => (d.listeners = d.listeners.filter((f) => f !== cb))
      },
      setAccess: async (v: 'ask' | 'all') => {
        if (v === 'ask') {
          if (d.s.siteAccess === 'ask') return 'unchanged'
          d.s.siteAccess = 'ask'
          emit()
          return 'changed'
        }
        await policy()
        if (!d.s.teamAllowsAll) return 'not-allowed'
        d.dialogs++
        await new Promise((r) => setTimeout(r, 300)) // the app's own dialog is up
        if (d.dialog !== 'confirm') return 'cancelled'
        d.s.siteAccess = 'all'
        emit()
        return 'changed'
      },
      removeSite: async (host: string) => {
        d.s.always = d.s.always.filter((h) => h !== host)
        d.s.privateAlways = d.s.privateAlways.filter((h) => h !== host)
        emit()
        return structuredClone(d.s)
      },
      clearSites: async () => {
        d.s.always = []
        d.s.privateAlways = []
        emit()
        return structuredClone(d.s)
      },
    },
  }
}

const desktop = (page: Page) => page.evaluate(() => (window as unknown as { __desktop: { s: { siteAccess: string; always: string[]; privateAlways: string[] }; dialogs: number } }).__desktop)

test('in a normal browser there is no Browser section (the value lives in the desktop app)', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/settings')
  await expect(page.getByRole('link', { name: '보안·기기' })).toBeVisible()
  await expect(page.getByRole('link', { name: '브라우저', exact: true })).toHaveCount(0)
  await page.goto('/settings/browser')
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByTestId('browser-settings')).toHaveCount(0)
})

test('desktop app: Settings > Browser shows the same setting; "all" only after the app\'s confirmation; the admin can turn the choice off', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await page.addInitScript(fakeDesktop)
  await signIn(page)
  await page.goto('/settings')
  await page.getByRole('link', { name: '브라우저', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/browser$/)
  const section = page.getByTestId('browser-settings')
  await expect(section).toContainText('AI가 열 수 있는 사이트')
  await expect(page.getByTestId('browser-access-ask')).toBeChecked()
  await expect(page.getByTestId('browser-site')).toHaveCount(3)
  await expect(section).toContainText('사내망')

  // "all": the page only asks; cancelled in the app's dialog, nothing changes
  await page.getByTestId('browser-access-all').check({ force: true }).catch(() => {})
  await expect(page.getByTestId('browser-access-ask')).toBeChecked()
  expect((await desktop(page)).dialogs).toBe(1)
  expect((await desktop(page)).s.siteAccess).toBe('ask')
  await expect(page.getByTestId('browser-all-on')).toHaveCount(0)

  // confirmed there: on, and shown
  await page.evaluate(() => ((window as unknown as { __desktop: { dialog: string } }).__desktop.dialog = 'confirm'))
  await page.getByTestId('browser-access-all').click()
  await expect(page.getByTestId('browser-access-all')).toBeChecked()
  await expect(page.getByTestId('browser-all-on')).toBeVisible()
  expect((await desktop(page)).s.siteAccess).toBe('all')

  // a change made in the panel's ⚙ (the app tells the page): the page follows at once
  await page.evaluate(() => {
    const d = (window as unknown as { __desktop: { s: { siteAccess: string }; listeners: ((s: unknown) => void)[] } }).__desktop
    d.s.siteAccess = 'ask'
    d.listeners.forEach((f) => f(structuredClone(d.s)))
  })
  await expect(page.getByTestId('browser-access-ask')).toBeChecked()
  await expect(page.getByTestId('browser-all-on')).toHaveCount(0)

  // remove one site, then clear the rest (asks first)
  await page.getByRole('button', { name: '삭제 naver.com' }).click()
  await expect(page.getByTestId('browser-site')).toHaveCount(2)
  expect((await desktop(page)).s.always).toEqual(['place.map.kakao.com'])
  await page.getByTestId('browser-sites-clear').click()
  await page.getByRole('dialog').getByRole('button', { name: '모두 지우기' }).click()
  await expect(page.getByTestId('browser-sites-none')).toBeVisible()

  // turn "all" on again, then the admin (the owner here) switches the team choice off in Admin > Team settings
  await page.getByTestId('browser-access-all').click()
  await expect(page.getByTestId('browser-all-on')).toBeVisible()
  await page.goto('/admin/settings')
  const sw = page.getByTestId('team-browser-allow-all')
  await expect(sw).toHaveAttribute('data-on', 'true')
  await sw.getByRole('checkbox').uncheck({ force: true })
  await expect(sw).toHaveAttribute('data-on', 'false')
  await page.getByRole('button', { name: '저장' }).click()
  await expect.poll(async () => (await (await page.request.get('/api/me')).json()).team.browserAllowAll).toBe(false)

  // the desktop side reads the policy from the team server: "all" went back to "ask"; the choice is disabled with the reason
  await page.goto('/settings/browser')
  await expect(page.getByTestId('browser-policy-off')).toBeVisible()
  await expect(page.getByTestId('browser-access-all')).toBeDisabled()
  await expect(page.getByTestId('browser-access-ask')).toBeChecked()
  await expect.poll(async () => (await desktop(page)).s.siteAccess).toBe('ask')

  // back on: the choice is possible again, nothing turns "all" on by itself
  await page.goto('/admin/settings')
  await page.getByTestId('team-browser-allow-all').getByRole('checkbox').check({ force: true })
  await page.getByRole('button', { name: '저장' }).click()
  await expect.poll(async () => (await (await page.request.get('/api/me')).json()).team.browserAllowAll).toBe(true)
  await page.goto('/settings/browser')
  await expect(page.getByTestId('browser-access-all')).toBeEnabled()
  await expect(page.getByTestId('browser-policy-off')).toHaveCount(0)
  await expect(page.getByTestId('browser-access-ask')).toBeChecked()
  expect(realErrors(errors)).toEqual([])
})
