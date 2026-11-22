// "Where things are in the app" (server/src/chat/app-map.ts; docs/decisions/20261116-ai-app-map.md): the map names the
// app's real labels and places, so it must not drift from the web app. Its labels are generated from web/src/i18n
// (scripts/app-map-labels.ts) and each place it names must still exist with that label.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { APP_MAP_KEYS, APP_MAP_PLACES, appLabel, appMapSection, appMapView, DEV_ENV_WORDS, type AppMapInput } from '../../server/src/chat/app-map'
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
    has('web/src/components/nav/SidebarSections.tsx', 'sidebarSections.moveTo')
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
    for (const k of ['chat.pin', 'rooms.info.rename', 'rooms.info.addPeople']) has('web/src/components/rooms/RoomMenu.tsx', k)
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
  // QA TC-5570: a free-roam demo visitor was sent to pages the demo fences (demo/guard.ts) or hides (web lib/freeRoam.ts
  // FREE_ROAM_HIDDEN_SETTINGS / FREE_ROAM_HIDDEN_PAGES)
  test('a free-roam demo: no fenced or hidden page, in every form and language; a normal install unchanged', () => {
    const LOCALES = ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const named = (t: string, label: string) => new RegExp(`(^|[\\s›,(:])${esc(label)}($|[\\s(.,;:])`, 'm').test(t)
    const gone = ['settings.security', 'settings.devices', 'auth.changePassword', 'settings.apps', 'aiApps.title', 'integrations.title',
      'roomApps.menuAdd', 'roomApps.address', 'openApp.lineLink', 'files.findWork.entryButton', 'handover.menu', 'members.inviteToTeam', 'teamLink.title',
      'admin.members', 'admin.groups', 'admin.integrations', 'admin.usage', 'admin.audit', 'admin.settings', 'admin.plugins', 'admin.providers', 'admin.system',
      'guest.admin.title', 'devEnv.title', 'system.backups'] as const
    for (const L of LOCALES) {
      for (const view of ['staff', 'member', 'shared'] as const) {
        for (const pickModel of [true, false, undefined]) {
          const o: AppMapInput = { ...base, view, freeRoam: true, ...(pickModel === undefined ? {} : { pickModel }) }
          const t = appMapSection(o, L)
          // a label as a place (not inside a longer label: ja "このアプリについて" holds "アプリ")
          for (const k of gone) expect(named(t, appLabel(k, L))).toBe(false)
          for (const no of ['own AI and model', 'Pages of ', "Also the owner's or an admin's", 'Guest AI']) expect(t).not.toContain(no)
          expect(t).toContain(`${appLabel('admin.title', L)} and every page in it are not in the demo: never send anyone there, whatever they ask about.`)
          // what the demo has stays
          for (const k of ['settings.profile', 'settings.about', 'chat.pin', 'notifications.quiet', 'filesPanel.shared', 'projects.share'] as const) expect(t).toContain(appLabel(k, L))
        }
      }
    }
    // a normal install: the same map as before, every place named
    for (const view of ['staff', 'member', 'shared'] as const) {
      const normal = appMapSection({ ...base, view }, 'en')
      expect(appMapSection({ ...base, view, freeRoam: false }, 'en')).toBe(normal)
      for (const k of ['settings.security', 'settings.apps', 'aiApps.title', 'integrations.title', 'roomApps.menuAdd', 'openApp.lineLink'] as const) expect(normal).toContain(appLabel(k, 'en'))
      expect(normal).not.toContain('not in the demo')
      // the place check finds them on a normal install, in every language
      for (const L of LOCALES) for (const k of ['settings.security', 'settings.apps', 'aiApps.title', 'roomApps.menuAdd', 'openApp.lineLink'] as const) expect(named(appMapSection({ ...base, view }, L), appLabel(k, L))).toBe(true)
      if (view !== 'member') for (const k of ['admin.usage', 'admin.providers', 'admin.system', 'handover.menu'] as const) expect(normal).toContain(appLabel(k, 'en'))
    }
  })
  test('the turn gives the map freeRoam only on a free-roam demo (chat/turn.ts)', () => {
    const turn = read('server/src/chat/turn.ts')
    expect(turn).toContain('const freeRoam = isFreeRoam(rt.ctx.config)')
    expect(turn).toContain('...(freeRoam ? { freeRoam: true } : {}) }')
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
    // the setting is on screen on every install, where it is (ADM-03, 2026-11-17): a local one picks only No AI
    for (const x of [managed, local]) expect(x).toContain(`Guest AI (${DICTS.ko['guest.invite.ai']}, at invite or on their row in ${DICTS.ko['guest.admin.title']})`)
    expect(local).toContain(`only ${DICTS.ko['guest.ai.none']} can be picked on this team's ${PRODUCT.displayName}`)
    expect(local).not.toContain(DICTS.ko['guest.ai.team'])
    expect(managed).not.toContain('only ' + DICTS.ko['guest.ai.none'])
    const dev = appMapSection({ ...base, devEnv: true }, 'ko')
    expect(dev).toContain(DICTS.ko['devEnv.title'])
    // without it: the setting is named, not on this team's app, never "does not exist" (PRJ-05, ADM-07), in everyday
    // words: no "server", no "programs" (ADM-07.member, 2026-11-17)
    expect(managed).not.toContain("doesn't have it")
    expect(managed).toContain(`${DICTS.ko['devEnv.title']} (${DEV_ENV_WORDS}): not on this team's`)
    const memberNoDev = appMapSection({ ...base, view: 'member' }, 'ko')
    expect(memberNoDev).not.toContain("doesn't have it")
    expect(memberNoDev).toContain(`${DICTS.ko['devEnv.title']} (${DEV_ENV_WORDS}; not on this team's`)
    expect(memberNoDev).toContain('so nobody can turn it on')
    for (const s of [managed, memberNoDev, dev, appMapSection({ ...base, view: 'member', devEnv: true }, 'ko')]) expect(s).not.toMatch(/\bserver\b|\bprograms?\b/)
    // System's updates: an admin's too only on an office Mac (web systemGroups.ts `office`)
    expect(managed).toContain(`owner also ${DICTS.ko['system.updates']}`)
    expect(appMapSection({ ...base, office: true }, 'ko')).not.toContain(`owner also ${DICTS.ko['system.updates']}`)
  })
  test('CON-07: Settings › Profile names an own AI and model only for someone who may pick one', () => {
    // a member on the computer's own sign-in read "own AI and model, if allowed" and told the asker that Profile might
    // let them pick one (dev f394c9258 rerun, 2026-11-17): the server knows whether this person may (canChooseEngine)
    const profile = `${DICTS.en['settings.profile']} (photo, name`
    const may = appMapSection({ ...base, view: 'member', pickModel: true }, 'en')
    const mayNot = appMapSection({ ...base, view: 'member', pickModel: false }, 'en')
    expect(may).toContain(`${profile}; own AI and model for new chats)`)
    expect(mayNot).toContain(`${profile})`)
    expect(mayNot).not.toMatch(/own AI and model|if allowed/)
    // who may pick is the owner's or an admin's
    expect(mayNot).toContain('who may pick their own AI model')
    expect(may).not.toContain('who may pick their own AI model')
    // an owner or admin always may; a shared chat says nothing about the asker
    expect(appMapSection({ ...base, pickModel: true }, 'en')).toContain(`${profile}; own AI and model for new chats)`)
    expect(appMapSection({ ...base, view: 'shared' }, 'en')).toContain(`${profile}; own AI and model, if allowed)`)
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
        DICTS.ko['rooms.info.rename'], DICTS.ko['rooms.info.addPeople'], DICTS.ko['rooms.react'], `${DICTS.ko['inbox.title']}.`, DICTS.ko['chat.pin'],
        DICTS.ko['integrations.title'], `${DICTS.ko['projects.title']} › ${DICTS.ko['projects.new']}`,
      ]
      for (const w of want) expect({ view, w, there: s.includes(w) }).toEqual({ view, w, there: true })
    }
  })
  test('a room\'s rename and add people are a group chat\'s; project creation can be owners and admins only', () => {
    const s = appMapSection({ ...base, view: 'member' }, 'en')
    expect(s).toContain(`A group chat's also ${DICTS.en['rooms.info.rename']}, ${DICTS.en['rooms.info.addPeople']}; a team room: people follow its group, owners and admins rename`)
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

describe('five places with no line before (catalog rerun 2026-11-17: ACC-04/05/06, CHT-13/14/16, SHR-03, FSH-03, MTG-01/02)', () => {
  const LOCALES = ['ko', 'en', 'ja', 'zh', 'es', 'id'] as const
  const aiNameIn = (L: (typeof LOCALES)[number]) => PRODUCT_NAMED_AFTER_AI ? DICTS[L]['rooms.aiName'] : PRODUCT.shortName
  test('a shared chat: the thread line keeps only the labels and who is told (its instructions say the rest)', () => {
    const s = appMapSection({ ...base, view: 'shared' }, 'en')
    expect(s).toContain(`- Under a finished answer: ${DICTS.en['rooms.replyInThread']}: people's talk`)
    expect(s).toContain('Asker and repliers are told')
    expect(s).not.toContain('not in a private chat')
  })
  test('every form, every language: each place by the label the app shows', () => {
    for (const view of ['staff', 'member', 'shared'] as const) for (const L of LOCALES) {
      const s = appMapSection({ ...base, view }, L)
      const d = DICTS[L] as Record<string, string>
      const want = [
        `${d['sidebar.files']} › ${d['filesPanel.shared']}`, // Files › Shared with me
        d['rooms.replyInThread'], // threads under an answer
        d['openApp.lineLink'], d['openApp.download'], // the desktop app hand-off
        d['folderAccess.menu'], d['fileShare.stop'], d['common.undo'], // folder sharing
      ]
      for (const w of want) expect({ view, L, w, there: s.includes(w) }).toEqual({ view, L, w, there: true })
    }
  })
  test('sharing a chat: Share at the top right of the chat, in every form and language (CHT-04.how, 2026-11-17)', () => {
    for (const view of ['staff', 'member', 'shared'] as const) for (const L of ['ko', 'en', 'ja', 'zh', 'es', 'id'] as const) {
      const s = appMapSection({ ...base, view }, L)
      expect({ view, L, there: s.includes(`top right ${DICTS[L]['projects.share']} (its starter): with people or groups`) }).toEqual({ view, L, there: true })
    }
    // the button is the chat header's (pages/Chat.tsx HeaderShare, labelled projects.share)
    expect(fs.readFileSync(path.resolve(import.meta.dir, '../../web/src/components/HeaderShare.tsx'), 'utf8')).toContain("t('projects.share')")
    expect(fs.readFileSync(path.resolve(import.meta.dir, '../../web/src/pages/Chat.tsx'), 'utf8')).toContain('<HeaderShare')
  })
  test('what each one does, as the decisions say', () => {
    const s = appMapSection({ ...base, view: 'member' }, 'en')
    // chat-answer-threads: shared chats only; the AI there reads it when someone asks
    // (ai-reads-answer-comments, 2026-11-17: it no longer says the AI does not read it; CHT-16)
    expect(s).toContain("Shared chat (a project's or shared with people), under a finished answer")
    expect(s).toContain('the AI there reads it when someone asks')
    // no button sends a thread to the AI (TC-4866)
    expect(s).not.toContain('unsent')
    const shared = appMapSection({ ...base, view: 'shared' }, 'en')
    expect(shared).toContain('which you read when asked')
    expect(shared).not.toContain('unsent')
    expect(shared).not.toMatch(/, then .*Send to/)
    expect(s).not.toContain('the AI does not read')
    expect(s).toContain('not in a private chat')
    // app sign-in: a Mac or Windows browser, no second password, not from a phone
    expect(s).toContain(`Mac or Windows browser ${DICTS.en['openApp.lineLink']} › ${DICTS.en['openApp.mac']} (or Windows)`)
    expect(s).toContain('no password')
    // meeting notes were removed (owner 2026-11-19, docs/decisions/20261119-remove-meeting-notes.md): the map no longer
    // names them
    expect(s).toContain(`desktop app (not the Mac App Store one): ${DICTS.en['files.findWork.entryButton']}; in a Mac`)
    expect(s).not.toContain('sound not kept')
    // folder sharing: view only, later files too, Undo right after (Files' toast; the server keeps it 10 minutes), team
    // folders are the owner's or an admin's
    expect(s).toContain('view only, later files too')
    expect(s).toContain(`${DICTS.en['common.undo']} right after`)
    expect(s).toContain('Team folders: owners and admins share')
    // adding people needs the team's switch for members (files/shares.ts teamOn); taking people off never does
    expect(s).toContain("the team can turn members' sharing off")
  })
  test('the places are where the map says', () => {
    const has = (file: string, key: string) => expect({ file, key, there: read(file).includes(`'${key}'`) }).toEqual({ file, key, there: true })
    has('web/src/components/panels/FilesPanel.tsx', 'filesPanel.shared')
    has('web/src/components/chat/Messages.tsx', 'rooms.replyInThread')
    has('web/src/components/onboarding/OpenAppLine.tsx', 'openApp.lineLink')
    has('web/src/pages/OpenApp.tsx', 'openApp.download')
    has('web/src/pages/OpenApp.tsx', 'openApp.mac')
    has('web/src/pages/Files.tsx', 'folderAccess.menu')
    has('web/src/components/FolderShareParts.tsx', 'fileShare.stop')
    has('web/src/components/FolderShareParts.tsx', 'common.undo')
    // the map says a folder can be shared: folder sharing is always on (its rollout gate was removed on dev)
    // "Open the app" is on My files (Files.tsx)
    expect(read('web/src/pages/Files.tsx')).toContain('<OpenAppLine')
  })
})

describe('size: it is in every turn', () => {
  // a rough count calibrated on the engine's own usage (claude -p, 2026-11-16): Hangul about 1.45 tokens a syllable,
  // other text about 3.6 characters a token
  const tokens = (s: string) => { const h = (s.match(/[가-힣]/g) ?? []).length; return Math.round(h * 1.45 + (s.length - h) / 3.6) }
  // the cap was 900; 1,200 since the five places of 2026-11-17 (docs/decisions/20261117-ai-app-map-five-places.md: the
  // longest form, an owner's or admin's in Korean, measured about 1,189 after the other lines were cut); 1,250 since
  // where a chat is shared (docs/decisions/20261117-ai-facts-and-gaps.md: about 1,241)
  // (fix/answer-slips, 2026-11-17: the longest form, staff in Korean, about 1,242: 8 to spare)
  // (with fix/catalog-1117g in the same batch, 2026-11-18: about 1,248, 2 to spare; the next line added must cut words or
  // raise the cap with a note)
  // (fix/ai-honesty-qa-1122, 2026-11-22: what a file opened in Files does, QA TC-7391 (P1): cap 1,300)
  test('at most 20 lines and about 1,300 tokens in its longest form, in every language', () => {
    for (const view of ['staff', 'member', 'shared'] as const) for (const L of ['ko', 'en', 'ja', 'zh', 'es', 'id'] as const) for (const devEnv of [true, false]) for (const managed of [true, false]) for (const pickModel of view === 'shared' ? [undefined] : view === 'staff' ? [true] : [true, false]) {
      const s = appMapSection({ view, managed, devEnv, office: false, pickModel }, L)
      expect({ view, L, devEnv, lines: s.split('\n').length <= 20 }).toEqual({ view, L, devEnv, lines: true })
      expect({ view, L, devEnv, small: tokens(s) <= 1300 }).toEqual({ view, L, devEnv, small: true })
    }
  })
})
