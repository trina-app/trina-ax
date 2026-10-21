// Settings → Apps: which desktop installers are shown, in which order, and the install steps under each.
import { describe, expect, test } from 'bun:test'
import { DICTS } from '../../src/i18n'
import { archNote, installSteps, orderDownloads, parseDownloads, showSteps } from '../../src/lib/downloads'

const win = { platform: 'windows' as const, file: 'Team-AX-Setup-0.1.0-x64.exe', version: '0.1.0', size: 114304798, signed: false }
const mac = { platform: 'mac' as const, file: 'Team-AX-0.1.0-mac-universal.dmg', version: '0.1.0', signed: false }

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
})
