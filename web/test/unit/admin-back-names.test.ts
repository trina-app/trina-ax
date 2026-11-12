// Every page pushed under Admin on a phone (an item's page /admin/<section>/<id>, a group of Team settings or System)
// names the page its ‹ returns to (pages/admin/AdminLayout.tsx pageName, adminScreens.ts adminParent), and the bar shows
// that name whole beside the title (components/phone/PhonePageBar.tsx barFit): an engine's page under "Team AI
// accounts" and Team settings' "Members and AI" and "Company profile" under "Team settings" showed ‹ alone (QA TC-381).
import { describe, expect, test } from 'bun:test'
import { DICTS, translate, type MessageKey } from '../../src/i18n'
import { pageName } from '../../src/pages/admin/AdminLayout'
import { ADMIN_DETAILS, adminParent } from '../../src/pages/admin/adminScreens'
import { TEAM_SETTINGS_GROUPS } from '../../src/pages/admin/teamSettingsGroups'
import { SYSTEM_GROUPS } from '../../src/pages/admin/systemGroups'
import { barFit } from '../../src/components/phone/PhonePageBar'

const t = (key: MessageKey) => translate('en', key)
const owner = { owner: true, features: {} as never }
/** each section's name on a phone: the team's pages that 나 also has are "Team …" there */
const SECTION_NAME: Record<string, MessageKey> = {
  connectors: 'admin.team.integrations', plugins: 'admin.plugins', providers: 'admin.team.providers', members: 'admin.members',
  groups: 'admin.groups', audit: 'admin.audit', settings: 'admin.settings', system: 'admin.system',
}

describe('every pushed Admin page has the page above it named', () => {
  const pages = [
    ...Object.keys(ADMIN_DETAILS).map((s) => `/admin/${s}/some-item`),
    ...TEAM_SETTINGS_GROUPS.map((g) => `/admin/settings/${g.id}`),
    ...SYSTEM_GROUPS.map((g) => `/admin/system/${g.id}`),
  ]
  for (const to of pages) {
    test(to, () => {
      const up = adminParent(to)!
      const section = to.split('/')[2]!
      expect(up).toBe(`/admin/${section}`)
      expect(SECTION_NAME[section]).toBeDefined()
      expect(pageName(up, t, true, owner)).toBe(t(SECTION_NAME[section]!))
    })
  }
  test('the sections themselves under Admin', () => {
    for (const section of Object.keys(SECTION_NAME)) expect(pageName(adminParent(`/admin/${section}`)!, t, true, owner)).toBe(t('admin.title'))
  })
  test('each name is in every language', () => {
    for (const key of [...Object.values(SECTION_NAME), 'admin.title' as const]) for (const dict of Object.values(DICTS)) expect((dict as Record<string, string>)[key]).toBeTruthy()
  })
})

describe('barFit: the label whole, the title centred when both fit', () => {
  // a 390 px phone: the bar is 382 px inside its padding; ‹ with a label needs 42 px more than the label
  const bar = 382
  const back = (label: number) => 42 + label
  test('a short label beside a centred title', () => {
    expect(barFit({ bar, back: back(43), title: 96, right: 44 })).toBe('centred') // ‹ Admin · Activity log
    expect(barFit({ bar, back: back(121), title: 54, right: 44 })).toBe('centred') // ‹ Team AI accounts · Codex
  })
  test('a long label: the title moves over, the label stays whole', () => {
    expect(barFit({ bar, back: back(121), title: 100, right: 44 })).toBe('moved') // ‹ Team AI accounts · Claude Code
    expect(barFit({ bar, back: back(96), title: 120, right: 44 })).toBe('moved') // ‹ Team settings · Members and AI
    expect(barFit({ bar, back: back(151), title: 123, right: 44 })).toBe('moved') // ‹ Team connected apps · Google Calendar
  })
  test('no room for both: ‹ alone, the title whole', () => {
    expect(barFit({ bar, back: back(200), title: 140, right: 44 })).toBe('alone')
  })
  test('a wide right side counts', () => {
    expect(barFit({ bar, back: back(43), title: 190, right: 100 })).toBe('moved')
    expect(barFit({ bar, back: back(43), title: 190, right: 44 })).toBe('centred')
  })
})
