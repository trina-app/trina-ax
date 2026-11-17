// "Where things are in the app" (server/src/chat/app-map.ts; docs/decisions/20261116-ai-app-map.md): the map names the
// app's real labels and places, so it must not drift from the web app. Its labels are generated from web/src/i18n
// (scripts/app-map-labels.ts) and each place it names must still exist with that label.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { APP_MAP_KEYS, APP_MAP_PLACES, appLabel, appMapSection, appMapView, type AppMapInput } from '../../server/src/chat/app-map'
import { APP_MAP_LABELS } from '../../server/src/chat/app-map-labels'
import { SHARED_PROMPT_SECTIONS } from '../../server/src/chat/prompt'
import { appMapLabelsText, LABELS_FILE } from '../../scripts/app-map-labels'
import { DICTS } from '../../web/src/i18n'
import { settingsTabs } from '../../web/src/pages/settingsTabs'
import { TEAM_SETTINGS_GROUPS } from '../../web/src/pages/admin/teamSettingsGroups'
import { SYSTEM_GROUPS } from '../../web/src/pages/admin/systemGroups'

const ROOT = path.resolve(import.meta.dir, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const base: AppMapInput = { view: 'staff', managed: true, devEnv: false, office: false }

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
    // the ready-made skills' row on the Skills page, without its count ("트리나가 준비한 스킬 · {n}개 더")
    expect(appLabel('skills.catalog.more', 'ko')).not.toMatch(/[{·]/)
    expect(appLabel('roomApps.menuList', 'ko')).toBe(DICTS.ko['roomApps.menuList'].split(' · ')[0])
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
    has('web/src/components/rooms/RoomMenu.tsx', 'roomApps.menuList')
    has('web/src/components/chat/ChatTitleMenu.tsx', 'chat.rename')
    has('web/src/components/nav/NavFolders.tsx', 'navFolders.moveTo')
    has('web/src/components/chat/Messages.tsx', 'chat.regenerate')
    has('web/src/components/chat/Messages.tsx', 'chat.edit')
    has('web/src/pages/admin/Members.tsx', 'handover.menu')
    has('web/src/pages/admin/Guests.tsx', 'guest.admin.title')
    has('web/src/components/GuestInvite.tsx', 'guest.invite.ai')
    has('web/src/components/AvailableSkills.tsx', 'skills.catalog.bring')
    has('web/src/components/AvailableSkills.tsx', 'skills.catalog.more')
    has('web/src/components/settings/RoomNotifySettings.tsx', 'notifications.quiet')
    has('web/src/components/onboarding/FindWorkFiles.tsx', 'files.findWork.entryButton')
    has('web/src/pages/Settings.tsx', 'settings.myEngine.model')
    // the 2026-11-17 catalog's "where is it" misses (ACC-01/02, ROOM-07, CON-04, PRJ-04)
    for (const k of ['chat.pin', 'rooms.info.rename', 'rooms.info.invite']) has('web/src/components/rooms/RoomMenu.tsx', k)
    has('web/src/components/nav/AccountMenu.tsx', 'status.set')
    has('web/src/components/nav/AccountMenu.tsx', 'presence.setAway')
    for (const k of ['members.inviteToTeam', 'members.inviteMore', 'teamLink.title', 'members.resetLinkButton', 'members.reset']) has('web/src/pages/admin/Members.tsx', k)
    has('web/src/pages/admin/Integrations.tsx', 'integrations.requests.add')
    has('web/src/components/rail/Rail.tsx', 'inbox.title')
  })
})

describe('who gets which map', () => {
  test('an owner or admin: the Admin pages; a member: one line saying the owner or an admin does it', () => {
    const staff = appMapSection(base, 'ko')
    const member = appMapSection({ ...base, view: 'member' }, 'ko')
    expect(staff).toContain(`${DICTS.ko['admin.settings']}: ${DICTS.ko['teamSettings.section.general']}`)
    expect(staff).toContain(DICTS.ko['handover.menu'])
    expect(member).not.toContain(DICTS.ko['handover.menu'])
    expect(member).toContain(`Also the owner's or an admin's, in ${DICTS.ko['admin.title']}`)
    // what is everyone's is in both
    for (const s of [staff, member]) for (const k of ['roomApps.menuAdd', 'notifications.quiet', 'settings.apps', 'skills.catalog.bring', 'files.findWork.entryButton'] as const) expect(s).toContain(DICTS.ko[k])
  })
  test('the form by role: owner and admin the full one, member the short one, any shared chat the neutral one', () => {
    expect([appMapView('owner', false), appMapView('admin', false), appMapView('member', false)]).toEqual(['staff', 'staff', 'member'])
    expect([appMapView('owner', true), appMapView('member', true)]).toEqual(['shared', 'shared'])
  })
  test('a shared chat: the Admin pages headed "owners and admins only", nothing about the asker', () => {
    const shared = appMapSection({ ...base, view: 'shared' }, 'ko')
    expect(shared).toContain('(owners and admins only)')
    expect(shared).not.toContain("Also the owner's or an admin's")
    expect(SHARED_PROMPT_SECTIONS.appMap).toBe(true)
  })
  test('install facts: guest AI only on a managed install, the dev environment only where the server has it', () => {
    const managed = appMapSection(base, 'ko')
    const local = appMapSection({ ...base, managed: false }, 'ko')
    expect(managed).toContain(DICTS.ko['guest.ai.team'])
    expect(local).toContain("Guest AI: not on this team's")
    expect(managed).not.toContain("Guest AI: not on")
    const dev = appMapSection({ ...base, devEnv: true }, 'ko')
    expect(dev).toContain(DICTS.ko['devEnv.title'])
    // without it: the setting is named, only on a server set up for it, never "does not exist" (PRJ-05, ADM-07)
    expect(managed).not.toContain("doesn't have it")
    expect(managed).toContain(`${DICTS.ko['devEnv.title']} (the AI runs programs): only on a server set up for it, not this one`)
    const memberNoDev = appMapSection({ ...base, view: 'member' }, 'ko')
    expect(memberNoDev).not.toContain("doesn't have it")
    expect(memberNoDev).toContain(`${DICTS.ko['devEnv.title']} (the AI runs programs; only on a server set up for it, not this one)`)
    // System's updates: an admin's too only on an office Mac (web systemGroups.ts `office`)
    expect(managed).toContain(`owner also ${DICTS.ko['system.updates']}`)
    expect(appMapSection({ ...base, office: true }, 'ko')).not.toContain(`owner also ${DICTS.ko['system.updates']}`)
  })
  test('the person\'s language: an English answer gets the English labels', () => {
    const en = appMapSection(base, 'en')
    expect(en).toContain(`Settings: ${DICTS.en['settings.profile']}`)
    expect(en).not.toMatch(/[가-힣]/)
  })
})

describe('the places people asked about (scenario catalog 2026-11-17)', () => {
  test('everyone: password, devices, photo, status, room menu, reactions, mentions, pinning, own connections, new project', () => {
    for (const view of ['staff', 'member', 'shared'] as const) {
      const s = appMapSection({ ...base, view }, 'ko')
      const want = [
        `${DICTS.ko['settings.security']} (${DICTS.ko['auth.changePassword']}; ${DICTS.ko['settings.devices']}`, DICTS.ko['status.set'], DICTS.ko['presence.setAway'],
        DICTS.ko['rooms.info.rename'], DICTS.ko['rooms.info.invite'], DICTS.ko['rooms.react'], `${DICTS.ko['inbox.title']}.`, DICTS.ko['chat.pin'],
        DICTS.ko['integrations.title'], `${DICTS.ko['projects.title']} › ${DICTS.ko['projects.new']}`,
      ]
      for (const w of want) expect({ view, w, there: s.includes(w) }).toEqual({ view, w, there: true })
    }
  })
  test('a room\'s rename and add people are a group chat\'s; project creation can be owners and admins only', () => {
    const s = appMapSection({ ...base, view: 'member' }, 'en')
    expect(s).toContain(`A group chat's also ${DICTS.en['rooms.info.rename']}, ${DICTS.en['rooms.info.invite']}; a team room: people follow its group, owners and admins rename`)
    expect(s).toContain('the team may keep team projects to owners and admins')
  })
  test('owners and admins: invites and the team link, a forgotten password, groups, the team\'s connections and asking a member to connect', () => {
    for (const view of ['staff', 'shared'] as const) {
      const s = appMapSection({ ...base, view }, 'ko')
      for (const k of ['members.inviteToTeam', 'teamLink.title', 'members.resetLinkButton', 'members.reset', 'admin.groups', 'admin.integrations', 'integrations.requests.add'] as const) expect({ view, k, there: s.includes(DICTS.ko[k]) }).toEqual({ view, k, there: true })
    }
    // a member: who does it, not the Admin page's buttons
    const member = appMapSection({ ...base, view: 'member' }, 'ko')
    expect(member).toContain('invites, roles (admins: the owner only), a forgotten password (they make a reset link)')
    // making someone an admin is the owner's (admin/users.ts ownerOnlyAdmins)
    expect(appMapSection(base, 'en')).toContain('roles (admins: owner only)')
    expect(member).not.toContain(DICTS.ko['members.resetLinkButton'])
  })
})

describe('size: it is in every turn', () => {
  // a rough count calibrated on the engine's own usage (claude -p, 2026-11-16): Hangul about 1.45 tokens a syllable,
  // other text about 3.6 characters a token
  const tokens = (s: string) => { const h = (s.match(/[가-힣]/g) ?? []).length; return Math.round(h * 1.45 + (s.length - h) / 3.6) }
  test('at most 20 lines and about 900 tokens in its longest form', () => {
    for (const view of ['staff', 'member', 'shared'] as const) for (const L of ['ko', 'en', 'ja'] as const) for (const devEnv of [true, false]) {
      const s = appMapSection({ view, managed: true, devEnv, office: false }, L)
      expect({ view, L, devEnv, lines: s.split('\n').length <= 20 }).toEqual({ view, L, devEnv, lines: true })
      expect({ view, L, devEnv, small: tokens(s) <= 900 }).toEqual({ view, L, devEnv, small: true })
    }
  })
})
