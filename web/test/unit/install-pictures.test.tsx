// Settings › Apps install pictures (src/components/settings/InstallPictures.tsx): the installed app's icon in them (the
// install sheets, the home screen, the Dock or taskbar, the app's window) and the browser's tab are the product's,
// whatever logo the team has, as the real ones are (the logo shows only in the computer's sidebar header).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Me } from '@mycel/shared/api'
import { ComputerPictures, InstallPictures } from '../../src/components/settings/InstallPictures'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const me = (team: Partial<Me['team']>): Me =>
  ({
    user: { id: 'mina', username: 'mina', name: 'Mina', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
    groups: [], team: { name: 'Acme', defaultLocale: 'ko', ...team }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
    server: { version: '0', dev: false, deployment: 'hosted' },
  }) as unknown as Me
const signedIn = (team: Partial<Me['team']>) => useSession.setState({ status: { kind: 'signed-in', me: me(team) } } as never)

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })

async function icons() {
  const m = await mount(<>
    <InstallPictures platform="ios" />
    <InstallPictures platform="android" />
    <ComputerPictures flow="chromium" os="windows" />
    <ComputerPictures flow="safari" os="mac" />
  </>)
  try {
    const all = m.container.querySelectorAll('img')
    const app = all.filter((i) => i.getAttribute('data-testid') === 'install-app-icon').map((i) => i.getAttribute('src'))
    const tab = all.filter((i) => i.getAttribute('data-testid') !== 'install-app-icon').map((i) => i.getAttribute('src'))
    return { app, tab }
  } finally {
    await m.unmount()
  }
}

describe('the icons in the install pictures', () => {
  // an older server may still send appIcon (a square logo of 512 px or more was the app icon until 2026-11-07)
  for (const [name, team] of [
    ['no logo', { iconVersion: null }],
    ['a logo', { iconVersion: '0123456789abcdef' }],
    ['a logo an older server called the app icon', { iconVersion: '0123456789abcdef', appIcon: true }],
  ] as const) {
    test(`${name}: the product's app icon and tab icon`, async () => {
      signedIn(team as Partial<Me['team']>)
      const { app, tab } = await icons()
      // the iPhone add sheet and home screen, Android's install sheet and home screen, Chrome's install sheet, Safari's
      // Add to Dock sheet, and each installed app's window and taskbar or Dock
      expect(app.length).toBe(10)
      expect(new Set(app)).toEqual(new Set(['/icons/icon-512.png']))
      expect(tab.length).toBeGreaterThan(0)
      expect(new Set(tab)).toEqual(new Set(['/favicon.svg']))
    })
  }
})

describe('the address in the install pictures', () => {
  // the desktop app over the office network opens the page at the office's own address: the pictures must still name
  // the team's (GET /api/me team.address), or a phone would be told to open 192.168.x.x
  const g = globalThis as Record<string, unknown>
  async function text() {
    const m = await mount(<>
      <InstallPictures platform="ios" />
      <ComputerPictures flow="chromium" os="windows" />
    </>)
    try { return m.html() } finally { await m.unmount() }
  }
  test('the team address when the server names one, else the page\'s own host', async () => {
    const was = Object.getOwnPropertyDescriptor(g, 'location')
    Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { host: '192.168.0.10:8443', origin: 'https://192.168.0.10:8443' } })
    try {
      signedIn({ iconVersion: null, address: 'https://acme.trina.app' })
      const named = await text()
      expect(named).toContain('acme.trina.app')
      expect(named).not.toContain('192.168.0.10')
      signedIn({ iconVersion: null })
      expect(await text()).toContain('192.168.0.10:8443')
    } finally {
      if (was) Object.defineProperty(g, 'location', was)
      else delete g.location
    }
  })
})
