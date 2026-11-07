// Settings › Apps install pictures (src/components/settings/InstallPictures.tsx): the installed app's icon in them (the
// install sheets, the home screen, the Dock or taskbar, the app's window) is the team logo only when it is also the app
// icon (GET /api/me team.appIcon: square, at least 512 px), as the real one is; the browser's tab keeps the logo.
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

describe('the installed app icon in the install pictures', () => {
  test('no logo: the default app icon; the tab shows what /team-icon serves', async () => {
    signedIn({ iconVersion: null })
    const { app, tab } = await icons()
    // the iPhone add sheet and home screen, Android's install sheet and home screen, Chrome's install sheet, Safari's
    // Add to Dock sheet, and each installed app's window and taskbar or Dock
    expect(app.length).toBe(10)
    expect(new Set(app)).toEqual(new Set(['/icons/icon-512.png']))
    expect(new Set(tab)).toEqual(new Set(['/team-icon']))
  })
  test('a logo under 512 px or not square (no team.appIcon): the default app icon, the logo in the tab', async () => {
    signedIn({ iconVersion: '0123456789abcdef' })
    const { app, tab } = await icons()
    expect(new Set(app)).toEqual(new Set(['/icons/icon-512.png']))
    expect(new Set(tab)).toEqual(new Set(['/team-icon']))
  })
  test('a square of at least 512 px: the logo at its version as the app icon too', async () => {
    signedIn({ iconVersion: '0123456789abcdef', appIcon: true })
    const { app } = await icons()
    expect(new Set(app)).toEqual(new Set(['/team-icon?v=0123456789abcdef']))
  })
})
