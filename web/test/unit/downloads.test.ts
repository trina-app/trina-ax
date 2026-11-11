// Settings → Apps: which desktop installers are shown (none at all inside a Mac App Store or Microsoft Store build, only
// the store's line) and the install steps under each. The rows themselves: apps.test.ts.
import { afterEach, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DESKTOP_BRIDGE_GLOBAL, RELEASE_CHANNEL, type DesktopBridge } from '@mycel/shared'
import { currentLocale, DICTS, translate } from '../../src/i18n'
import { answersFileInputs, storeApp } from '../../src/lib/desktop'
import { archNote, installSteps, offeredDownloads, parseDownloads, showSteps } from '../../src/lib/downloads'
import type { AppClient } from '../../src/lib/apps'
import { ComputerApps, downloadsSourceOf } from '../../src/components/settings/AppList'

const win = { platform: 'windows' as const, file: 'Team-AX-Setup-0.1.0-x64.exe', version: '0.1.0', size: 114304798, signed: false }
const mac = { platform: 'mac' as const, file: 'Team-AX-0.1.0-mac-universal.dmg', version: '0.1.0', signed: false }
/** the desktop bridge as far as the store flag goes; without `store` = a desktop app from before the flag */
const bridge = (o: { store?: boolean; platform?: string } = {}) => ({ bridgeVersion: 1, appVersion: '0.2.14', platform: 'darwin', ...o }) as unknown as DesktopBridge
/** a build without store listings or a download page (self-hosted, another edition) */
const NONE = { page: '', iphone: '', android: '', mac: '', windows: '' }
type Props = Parameters<typeof ComputerApps>[0]
/** the Desktop app part of Settings › Apps in a web browser on `here`, or in a (store) desktop app */
const computer = (o: Partial<Omit<Props, 'client'>> & { here?: AppClient['here']; kind?: AppClient['kind']; store?: boolean } = {}) => {
  const { here = 'mac', kind = o.store ? 'desktop' : 'web', store = false, ...rest } = o
  return renderToStaticMarkup(createElement(ComputerApps, { links: NONE, downloads: 'none', owner: false, ...rest, client: { kind, here, store } }))
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL]
})

describe('desktop downloads', () => {
  test('index.json: only well-formed items', () => {
    expect(parseDownloads({ items: [win, mac, { platform: 'linux', file: 'x', version: '1' }, { platform: 'mac' }, null, 'x'] })).toEqual([win, mac])
    expect(parseDownloads(null)).toEqual([])
    expect(parseDownloads({ items: 'x' })).toEqual([])
  })
  test("Settings > Apps on a Mac with only the Windows app (no store listing): the Mac row says so, Windows is its own row", () => {
    const l = currentLocale()
    const browserTab = computer({ downloads: [win], installHere: true })
    expect(browserTab).toContain(translate(l, 'apps.noMacApp'))
    expect(browserTab).toContain(translate(l, 'apps.installInstead'))
    expect(browserTab).toContain('data-testid="app-row-windows"')
    expect(browserTab).toContain('/downloads/Team-AX-Setup-0.1.0-x64.exe')
    // the steps are for the computer they install on: not under the Windows row on a Mac
    expect(browserTab).not.toContain('More info → Run anyway')
    // already installed (or the desktop app): no pointer to the guide below
    const installed = computer({ downloads: [win], installHere: false })
    expect(installed).toContain(translate(l, 'apps.noMacApp'))
    expect(installed).not.toContain(translate(l, 'apps.installInstead'))
    // a Windows PC with the same server: its installer, with its steps, marked as this computer's; no Mac row
    const pc = computer({ downloads: [win], here: 'windows' })
    expect(pc).toContain('/downloads/Team-AX-Setup-0.1.0-x64.exe')
    expect(pc).toContain('More info → Run anyway')
    expect(pc).toContain(translate(l, 'apps.thisComputer'))
    expect(pc).not.toContain('app-row-mac')
    expect(pc).not.toContain(translate(l, 'apps.noWindowsApp'))
    // a Mac with both: its image with its steps, Windows without
    const both = computer({ downloads: [mac, win] })
    expect(both).toContain('/downloads/Team-AX-0.1.0-mac-universal.dmg')
    expect(both).toContain('/downloads/Team-AX-Setup-0.1.0-x64.exe')
    expect(both).toContain('System Settings → Privacy &amp; Security')
    expect(both).not.toContain('More info → Run anyway')
    expect(both).not.toContain(translate(l, 'apps.noMacApp'))
    // a phone lists them all, with no steps (they are for the computer)
    const phone = computer({ downloads: [mac, win], here: 'ios' })
    expect(phone).toContain('/downloads/Team-AX-0.1.0-mac-universal.dmg')
    expect(phone).toContain('/downloads/Team-AX-Setup-0.1.0-x64.exe')
    expect(phone).not.toContain('<ol')
    expect(phone).not.toContain(translate(l, 'apps.thisComputer'))
  })
  test('unsigned builds say what to click past the one warning (SmartScreen, Gatekeeper)', () => {
    expect(installSteps(win)).toEqual(['apps.winHow', 'apps.winSmartScreen'])
    expect(installSteps({ ...win, signed: true })).toEqual(['apps.winHow'])
    expect(installSteps(mac)).toEqual(['apps.macHow', 'apps.macGatekeeper'])
    expect(installSteps({ ...mac, signed: true })).toEqual(['apps.macHow'])
    expect(DICTS.ko['apps.winSmartScreen']).toContain('추가 정보 → 실행')
    expect(DICTS.ko['apps.macGatekeeper']).toContain('시스템 설정 → 개인정보 보호 및 보안')
    expect(DICTS.ko['apps.macGatekeeper']).toContain('그래도 열기')
    expect(DICTS.en['apps.winSmartScreen']).toContain('More info → Run anyway')
    expect(DICTS.id['apps.macGatekeeper']).toContain('Tetap Buka')
  })
  test('a Mac image for one kind of Mac says so (arch from the server, else the file name)', () => {
    expect(archNote(mac)).toBeNull()
    expect(archNote({ ...mac, arch: 'arm64' })).toBe('apps.macArm64Only')
    expect(archNote({ ...mac, file: 'Team-AX-0.1.0-mac-arm64.dmg' })).toBe('apps.macArm64Only')
    expect(archNote({ ...mac, file: 'Team-AX-0.1.0-mac-x64.dmg' })).toBe('apps.macIntelOnly')
    expect(archNote(win)).toBeNull()
    expect(DICTS.ko['apps.macArm64Only']).toContain('Apple Silicon')
  })
  test('with two Windows versions offered (--keep) the steps show once, under the first', () => {
    const older = { ...win, file: 'Team-AX-Setup-0.0.9-x64.exe', version: '0.0.9' }
    const list = [win, older, mac]
    expect(list.filter((d) => showSteps(list, d)).map((d) => d.file)).toEqual([win.file, mac.file])
  })
  test("the owner's empty state does not tell the owner to ask the owner, and names office-install.sh", () => {
    for (const l of ['ko', 'en', 'id'] as const) {
      expect(DICTS[l]['apps.noDownloadsYet']).not.toMatch(/팀장|owner/i)
      expect(DICTS[l]['apps.noDownloadsOwner']).toContain('office-install.sh')
      // no office path with the core product's name in it (QA TC-262: "~/TeamAX/teamax desktop add")
      expect(DICTS[l]['apps.noDownloadsOwner']).not.toMatch(/TeamAX|teamax/)
      expect(DICTS[l]['apps.noDownloadsOwnerWindows']).toContain('office-install.sh')
      expect(DICTS[l]['apps.noDownloadsOwnerWindows']).not.toMatch(/TeamAX|teamax/)
    }
  })

  test('inside a Mac App Store build: no installer at all, for the Mac or Windows (the store updates the app)', () => {
    expect(offeredDownloads([win, mac], true)).toEqual([])
    expect(offeredDownloads([win], true)).toEqual([])
    expect(offeredDownloads([win, mac], false)).toEqual([win, mac])
  })
  test('Settings > Apps in a store build: its row is "This app" with the App Store line (no installer, steps, empty state or skeleton)', () => {
    const l = currentLocale()
    const states: Props['downloads'][] = [null, 'none', [win, mac]]
    for (const downloads of states) for (const owner of [true, false]) {
      const view = computer({ downloads, store: true, owner })
      expect(view).toContain(translate(l, 'apps.macStore'))
      expect(view).toContain(translate(l, 'apps.thisApp'))
      expect(view).not.toContain('/downloads/')
      expect(view).not.toMatch(/<ol|animate-pulse|office-install|teamax/)
      expect(view).not.toContain(translate(l, owner ? 'apps.noDownloadsYet' : 'apps.noDownloads'))
      // no store listing or page in this build: no Windows row either
      expect(view).not.toContain('app-row-windows')
    }
    // outside the store build the same states still show the installers, the steps and the owner's empty state
    const list = computer({ downloads: [mac, win] })
    expect(list).toContain('/downloads/Team-AX-0.1.0-mac-universal.dmg')
    expect(computer({ downloads: [mac, win], here: 'windows' })).toContain('/downloads/Team-AX-Setup-0.1.0-x64.exe')
    expect(computer({ downloads: [mac, win], here: 'windows' })).toContain('More info → Run anyway') // apps.winSmartScreen
    expect(list).not.toContain(translate(l, 'apps.macStore'))
    expect(computer({ owner: true })).toContain('office-install.sh') // apps.noDownloadsOwner
  })
  test('a Microsoft Store build on Windows shows the Microsoft Store line instead', () => {
    const l = currentLocale()
    for (const o of [{ downloads: [win, mac] as Props['downloads'], owner: true }, { downloads: 'none' as const, owner: false }]) {
      const view = computer({ ...o, here: 'windows', store: true })
      expect(view).toContain(translate(l, 'apps.windowsStore'))
      expect(view).not.toContain('/downloads/')
      expect(view).not.toContain('app-row-mac')
    }
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      expect(DICTS[l]['apps.windowsStore']).toContain('Microsoft Store')
      expect(DICTS[l]['apps.windowsStore']).not.toMatch(/\.exe|SmartScreen/)
    }
  })
  test("the owner's empty state names what this server does: an office Mac's command, a Linux server's feed or folder, nothing to run on the hosted service (Diagnostics when its feed should have brought it)", () => {
    const view = (o: Partial<Props>) => computer({ owner: true, here: 'windows', ...o })
    const host = new URL(RELEASE_CHANNEL.feed).host
    expect(view({})).toContain('office-install.sh')
    const feed = view({ server: 'feed' })
    expect(feed).toContain(translate(currentLocale(), 'apps.noDownloadsFeed'))
    expect(feed).toContain(host)
    expect(feed).toContain('INSTALL-LINUX')
    expect(feed).not.toMatch(/teamax|office-install/)
    const folder = view({ server: 'folder' })
    expect(folder).toContain('desktop-refresh --from')
    expect(folder).not.toMatch(/teamax|office-install/)
    const hosted = view({ server: 'hosted' })
    expect(hosted).toContain('You haven&#x27;t put a desktop app') // apps.noDownloadsYet, without the owner's second line
    expect(hosted).not.toContain('mt-2')
    // a hosted tenant that takes it from the feed: "appears by itself", and Diagnostics, not a command
    const hostedFeed = view({ server: 'hosted-feed' })
    expect(hostedFeed).toContain(translate(currentLocale(), 'apps.noDownloadsFeed'))
    expect(hostedFeed).toContain('Diagnostics')
    expect(hostedFeed).not.toMatch(/teamax|desktop-refresh|INSTALL-LINUX|office-install/)
    for (const server of ['office', 'feed', 'folder', 'hosted', 'hosted-feed'] as const) expect(view({ server, owner: false })).toBe(`<p class="text-sm text-muted">${translate(currentLocale(), 'apps.noDownloads')}</p>`)
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) expect(DICTS[l]['apps.noDownloadsOwnerHosted']).not.toMatch(/trina_admin|desktop-refresh|INSTALL-LINUX/)
    // what /api/me says picks the hint: a hosted tenant never gets a self-installed server's hint
    expect(downloadsSourceOf({ deployment: 'hosted', windowsApp: 'feed' })).toBe('hosted-feed')
    expect(downloadsSourceOf({ deployment: 'hosted' })).toBe('hosted')
    expect(downloadsSourceOf({ deployment: 'hosted', windowsApp: 'folder' })).toBe('hosted')
    expect(downloadsSourceOf({ deployment: 'self', windowsApp: 'feed' })).toBe('feed')
    expect(downloadsSourceOf({ deployment: 'self', windowsApp: 'folder' })).toBe('folder')
    expect(downloadsSourceOf({})).toBe('office') // an office Mac, or an older server
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      expect(translate(l, 'apps.noDownloadsOwnerFeed', { feed: host })).toContain(host)
      expect(DICTS[l]['apps.noDownloadsOwnerLinux']).toContain('desktop-refresh --from')
    }
  })
  test('a store build is what the desktop bridge says; a web browser or an older desktop app (no flag) is not one', () => {
    expect(storeApp()).toBe(false)
    expect(storeApp(null)).toBe(false)
    expect(storeApp(bridge())).toBe(false)
    expect(storeApp(bridge({ store: false }))).toBe(false)
    expect(storeApp(bridge({ store: true }))).toBe(true)
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] = bridge({ store: true })
    expect(storeApp()).toBe(true)
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] = bridge()
    expect(storeApp()).toBe(false)
  })
  test('only the Mac App Store build answers the page\'s file inputs itself; the Microsoft Store build picks like a browser', () => {
    expect(answersFileInputs(null)).toBe(false)
    expect(answersFileInputs(bridge({ store: true }))).toBe(true)
    expect(answersFileInputs(bridge({ store: true, platform: 'win32' }))).toBe(false)
    expect(answersFileInputs(bridge({ store: false }))).toBe(false)
    expect(answersFileInputs(bridge())).toBe(false)
  })
  test('the line shown instead names the App Store, in every language, and no .dmg', () => {
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      expect(DICTS[l]['apps.macStore']).toContain('App Store')
      expect(DICTS[l]['apps.macStore']).not.toContain('.dmg')
    }
  })
})
