// Settings → Apps: which desktop installers are shown (none for the Mac inside a Mac App Store build), in which order,
// and the install steps under each.
import { afterEach, describe, expect, test } from 'bun:test'
import { DESKTOP_BRIDGE_GLOBAL, type DesktopBridge } from '@mycel/shared'
import { DICTS } from '../../src/i18n'
import { storeApp } from '../../src/lib/desktop'
import { archNote, installSteps, offeredDownloads, orderDownloads, parseDownloads, showSteps } from '../../src/lib/downloads'

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

  test('inside a Mac App Store build: no Mac installer (the store updates the app), the Windows ones stay', () => {
    expect(offeredDownloads([win, mac], true)).toEqual([win])
    expect(offeredDownloads([mac], true)).toEqual([])
    expect(offeredDownloads([win, mac], false)).toEqual([win, mac])
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
