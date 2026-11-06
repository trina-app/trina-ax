// Settings → Apps: which desktop installers are shown (none at all inside a Mac App Store build, only the App Store
// line), in which order, and the install steps under each.
import { afterEach, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DESKTOP_BRIDGE_GLOBAL, RELEASE_CHANNEL, type DesktopBridge } from '@mycel/shared'
import { currentLocale, DICTS, translate } from '../../src/i18n'
import { storeApp } from '../../src/lib/desktop'
import { archNote, installSteps, offeredDownloads, orderDownloads, parseDownloads, showSteps } from '../../src/lib/downloads'
import { DesktopDownloads, downloadsSourceOf } from '../../src/pages/Settings'

const win = { platform: 'windows' as const, file: 'Team-AX-Setup-0.1.0-x64.exe', version: '0.1.0', size: 114304798, signed: false }
const mac = { platform: 'mac' as const, file: 'Team-AX-0.1.0-mac-universal.dmg', version: '0.1.0', signed: false }
/** the desktop bridge as far as the store flag goes; without `store` = a desktop app from before the flag */
const bridge = (o: { store?: boolean } = {}) => ({ bridgeVersion: 1, appVersion: '0.2.14', platform: 'darwin', ...o }) as unknown as DesktopBridge

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL]
})

describe('desktop downloads', () => {
  test('index.json: only well-formed items', () => {
    expect(parseDownloads({ items: [win, mac, { platform: 'linux', file: 'x', version: '1' }, { platform: 'mac' }, null, 'x'] })).toEqual([win, mac])
    expect(parseDownloads(null)).toEqual([])
    expect(parseDownloads({ items: 'x' })).toEqual([])
  })
  test("this computer's platform first, otherwise the server's order", () => {
    expect(orderDownloads([win, mac], 'mac')).toEqual([mac, win])
    expect(orderDownloads([win, mac], 'windows')).toEqual([win, mac])
    expect(orderDownloads([win, mac], 'ios')).toEqual([win, mac])
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
      expect(DICTS[l]['apps.noDownloadsOwner']).toContain('teamax desktop add')
    }
  })

  test('inside a Mac App Store build: no installer at all, for the Mac or Windows (the store updates the app)', () => {
    expect(offeredDownloads([win, mac], true)).toEqual([])
    expect(offeredDownloads([win], true)).toEqual([])
    expect(offeredDownloads([win, mac], false)).toEqual([win, mac])
  })
  test('Settings > Apps in a store build: only the App Store line (no installer, steps, empty state or skeleton)', () => {
    type Props = Parameters<typeof DesktopDownloads>[0]
    const view = (o: Partial<Props>) => renderToStaticMarkup(createElement(DesktopDownloads, { downloads: 'none', store: false, owner: true, here: 'mac', ...o }))
    const line = `<p class="text-sm text-muted">${translate(currentLocale(), 'apps.macStore')}</p>`
    const states: Props['downloads'][] = [null, 'none', [win, mac]]
    for (const downloads of states) for (const owner of [true, false]) expect(view({ downloads, store: true, owner })).toBe(line)
    // outside the store build the same states still show the installers, the steps and the owner's empty state
    const list = view({ downloads: [mac, win] })
    expect(list).toContain('/downloads/Team-AX-0.1.0-mac-universal.dmg')
    expect(list).toContain('/downloads/Team-AX-Setup-0.1.0-x64.exe')
    expect(list).toContain('More info → Run anyway') // apps.winSmartScreen
    expect(list).not.toContain(translate(currentLocale(), 'apps.macStore'))
    expect(view({ downloads: 'none' })).toContain('office-install.sh') // apps.noDownloadsOwner
  })
  test("the owner's empty state names what this server does: an office Mac's command, a Linux server's feed or folder, nothing to run on the hosted service (Diagnostics when its feed should have brought it)", () => {
    type Props = Parameters<typeof DesktopDownloads>[0]
    const view = (o: Partial<Props>) => renderToStaticMarkup(createElement(DesktopDownloads, { downloads: 'none', store: false, owner: true, here: 'windows', ...o }))
    const host = new URL(RELEASE_CHANNEL.feed).host
    expect(view({})).toContain('teamax desktop add')
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
  test('the line shown instead names the App Store, in every language, and no .dmg', () => {
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      expect(DICTS[l]['apps.macStore']).toContain('App Store')
      expect(DICTS[l]['apps.macStore']).not.toContain('.dmg')
    }
  })
})
