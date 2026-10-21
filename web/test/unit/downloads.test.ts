// Settings → Apps: which desktop installers are shown, in which order, and the install steps under each.
import { describe, expect, test } from 'bun:test'
import { DICTS } from '../../src/i18n'
import { installSteps, orderDownloads, parseDownloads } from '../../src/lib/downloads'

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
})
