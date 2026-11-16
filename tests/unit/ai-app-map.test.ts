// "Where things are in the app" (server/src/chat/app-map.ts; docs/decisions/20261116-ai-app-map.md): the map names the
// app's real labels and places, so it must not drift from the web app. Its labels are generated from web/src/i18n
// (scripts/app-map-labels.ts) and each place it names must still exist with that label.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { APP_MAP_KEYS, APP_MAP_PLACES, appLabel, appMapSection, type AppMapInput } from '../../server/src/chat/app-map'
import { APP_MAP_LABELS } from '../../server/src/chat/app-map-labels'
import { SHARED_PROMPT_SECTIONS } from '../../server/src/chat/prompt'
import { appMapLabelsText, LABELS_FILE } from '../../scripts/app-map-labels'
import { DICTS } from '../../web/src/i18n'
import { settingsTabs } from '../../web/src/pages/settingsTabs'
import { TEAM_SETTINGS_GROUPS } from '../../web/src/pages/admin/teamSettingsGroups'
import { SYSTEM_GROUPS } from '../../web/src/pages/admin/systemGroups'

const ROOT = path.resolve(import.meta.dir, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const base: AppMapInput = { view: 'staff', managed: true, devEnv: false }

/** Every .ts/.tsx file of the web app outside its dictionaries, as one text. */
function webSource(): string {
  const dir = path.join(ROOT, 'web/src')
  return fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f) && !f.startsWith('i18n/')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
}

describe('the labels come from the web app', () => {
  test('app-map-labels.ts is what scripts/app-map-labels.ts writes from web/src/i18n (run it when this fails)', () => {
    expect(fs.readFileSync(LABELS_FILE, 'utf8')).toBe(appMapLabelsText())
  })
  test('every key is in every dictionary and the app still shows it somewhere', () => {
    const src = webSource()
    for (const k of APP_MAP_KEYS) {
      for (const [l, d] of Object.entries(DICTS)) expect({ k, l, has: typeof (d as Record<string, string>)[k] === 'string' }).toEqual({ k, l, has: true })
      // the guest AI choices' keys are built from the mode (GuestInvite.tsx t(`guest.ai.${m}`))
      const used = src.includes(`'${k}'`) || src.includes(`"${k}"`) || (/^guest\.ai\.(none|own|team)$/.test(k) && src.includes('t(`guest.ai.${m}`)'))
      expect({ k, used }).toEqual({ k, used: true })
    }
  })
  test('a label reads as the screen does: the product name filled in, Korean in a Korean answer', () => {
    expect(appLabel('aiApps.title', 'ko')).not.toContain('{')
    expect(appLabel('skills.catalog.title', 'ko')).not.toContain('{')
    expect(appLabel('admin.system', 'ko')).toBe(DICTS.ko['admin.system'])
    expect(APP_MAP_LABELS['roomApps.menuAdd']!.en).toBe(DICTS.en['roomApps.menuAdd'])
  })
})

describe('the places it names still exist', () => {
  test('Settings tabs, with these labels', () => {
    const tabs = settingsTabs(true, true, true)
    for (const [id, key] of Object.entries(APP_MAP_PLACES.settings)) {
      const tab = tabs.find((x) => x.id === id)
      expect({ id, there: !!tab }).toEqual({ id, there: true })
      // the allowances tab is named after the AI where the product is (settingsTabs.ts)
      const want = id === 'allowances' && !PRODUCT_NAMED_AFTER_AI ? 'settings.allowancesAi' : key
      expect({ id, label: tab?.label }).toEqual({ id, label: want })
    }
  })
  test('Admin pages, with these labels (AdminLayout.tsx MENU)', () => {
    const layout = read('web/src/pages/admin/AdminLayout.tsx')
    for (const [id, key] of Object.entries(APP_MAP_PLACES.admin)) expect({ id, there: layout.includes(`{ id: '${id}', label: '${key}'`) }).toEqual({ id, there: true })
  })
  test('Team settings and System groups, with these labels', () => {
    for (const [id, key] of Object.entries(APP_MAP_PLACES.teamSettings)) expect({ id, label: TEAM_SETTINGS_GROUPS.find((g) => g.id === id)?.label }).toEqual({ id, label: key })
    for (const [id, key] of Object.entries(APP_MAP_PLACES.system)) expect({ id, label: SYSTEM_GROUPS.find((g) => g.id === id)?.label }).toEqual({ id, label: key })
    // the owner's parts of System, as the map says ("owner also …")
    expect(SYSTEM_GROUPS.filter((g) => g.owner).map((g) => g.id)).toEqual(expect.arrayContaining(['backups', 'export', 'connection']))
    expect(SYSTEM_GROUPS.filter((g) => !g.owner).map((g) => g.id)).toEqual(expect.arrayContaining(['storage', 'updates']))
    // the dev environment's group only where the server has it, as the map says
    expect(TEAM_SETTINGS_GROUPS.find((g) => g.id === 'dev-env')?.devEnv).toBe(true)
  })
  test('the routes behind them (App.tsx)', () => {
    const app = read('web/src/App.tsx')
    for (const r of ['path="admin/:section"', 'path="skills"', 'path="files"', 'path="rooms/:roomId"', 'path="/settings/:tab?"']) expect({ r, there: app.includes(r) }).toEqual({ r, there: true })
  })
  test('the menus and buttons it names are where it says', () => {
    const has = (file: string, key: string) => expect({ file, key, there: read(file).includes(`'${key}'`) }).toEqual({ file, key, there: true })
    has('web/src/components/rooms/RoomMenu.tsx', 'roomApps.menuAdd')
    has('web/src/components/rooms/RoomMenu.tsx', 'rooms.menu.notify')
    has('web/src/components/rooms/apps/AppsDialog.tsx', 'roomApps.listTitle')
    has('web/src/components/chat/ChatTitleMenu.tsx', 'chat.rename')
    has('web/src/components/nav/NavFolders.tsx', 'navFolders.moveTo')
    has('web/src/components/chat/Messages.tsx', 'chat.regenerate')
    has('web/src/components/chat/Messages.tsx', 'chat.edit')
    has('web/src/pages/admin/Members.tsx', 'handover.menu')
    has('web/src/pages/admin/Guests.tsx', 'guest.admin.title')
    has('web/src/components/GuestInvite.tsx', 'guest.invite.ai')
    has('web/src/components/AvailableSkills.tsx', 'skills.catalog.bring')
    has('web/src/pages/Skills.tsx', 'skills.tabSkills')
    has('web/src/components/settings/RoomNotifySettings.tsx', 'notifications.quiet')
    has('web/src/components/onboarding/FindWorkFiles.tsx', 'files.findWork.entryButton')
    has('web/src/pages/Settings.tsx', 'settings.myEngine.model')
  })
})

describe('who gets which map', () => {
  test('an owner or admin: the Admin pages; a member: one line saying the owner or an admin does it', () => {
    const staff = appMapSection(base, 'ko')
    const member = appMapSection({ ...base, view: 'member' }, 'ko')
    expect(staff).toContain(`${DICTS.ko['admin.settings']}: ${DICTS.ko['teamSettings.section.general']}`)
    expect(staff).toContain(DICTS.ko['handover.menu'])
    expect(member).not.toContain(DICTS.ko['handover.menu'])
    expect(member).toContain(`Owner or admin, in ${DICTS.ko['admin.title']}`)
    // what is everyone's is in both
    for (const s of [staff, member]) for (const k of ['roomApps.menuAdd', 'notifications.quiet', 'settings.apps', 'skills.catalog.bring', 'files.findWork.entryButton'] as const) expect(s).toContain(DICTS.ko[k])
  })
  test('a shared chat: the Admin pages headed "owners and admins only", nothing about the asker', () => {
    const shared = appMapSection({ ...base, view: 'shared' }, 'ko')
    expect(shared).toContain('(owners and admins only)')
    expect(shared).not.toContain('Owner or admin, in')
    expect(SHARED_PROMPT_SECTIONS.appMap).toBe(true)
  })
  test('install facts: guest AI only on a managed install, the dev environment only where the server has it', () => {
    const managed = appMapSection(base, 'ko')
    const local = appMapSection({ ...base, managed: false }, 'ko')
    expect(managed).toContain(DICTS.ko['guest.ai.team'])
    expect(local).not.toContain(DICTS.ko['guest.ai.team'])
    expect(local).toContain('Guest AI: none on this install')
    const dev = appMapSection({ ...base, devEnv: true }, 'ko')
    expect(dev).toContain(DICTS.ko['devEnv.title'])
    expect(managed).not.toContain(DICTS.ko['devEnv.title'])
    expect(managed).toContain('No dev environment')
    expect(appMapSection({ ...base, view: 'member', devEnv: true }, 'ko')).not.toContain('No dev environment')
  })
  test('the person\'s language: an English answer gets the English labels', () => {
    const en = appMapSection(base, 'en')
    expect(en).toContain(`Settings › ${DICTS.en['settings.apps']}`)
    expect(en).not.toMatch(/[가-힣]/)
  })
})

describe('size: it is in every turn', () => {
  // a rough count (Hangul about 1 token a syllable, other text about 3.6 characters a token); the PR says the measured cost
  const tokens = (s: string) => { const h = (s.match(/[가-힣]/g) ?? []).length; return Math.round(h + (s.length - h) / 3.6) }
  test('at most 20 lines and about 650 tokens in its longest form', () => {
    for (const view of ['staff', 'member', 'shared'] as const) for (const L of ['ko', 'en', 'ja'] as const) {
      const s = appMapSection({ view, managed: true, devEnv: true }, L)
      expect({ view, L, lines: s.split('\n').length <= 20 }).toEqual({ view, L, lines: true })
      expect({ view, L, small: tokens(s) <= 650 }).toEqual({ view, L, small: true })
    }
  })
})
