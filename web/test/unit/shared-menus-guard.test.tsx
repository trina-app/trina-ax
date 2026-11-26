// The one menu list and the one destructive helper stay the only way (docs/decisions/20261126-shared-menus.md):
// - the real builders (an AI chat's row and title menus, a room's "⋯", a project's row menu, a search result's "⋯") give
//   their items in MENU_ORDER (components/menus/entityMenu.tsx), every item with a kind;
// - a menu item labelled with a kind's own words is made only by entityMenu.tsx: the kinds only chats, rooms and projects
//   have anywhere in web/src, and copy link, rename and delete in the files that build those menus;
// - the number of confirm dialogs in web/src never grows (the 11-23 direction: undo, not a new confirm), and the menu
//   action files do not ask by themselves: they go through lib/destructive.ts;
// - an undo toast is made by lib/destructive.ts or a file on the list below (other undos: moves, shares, settings);
// - the words merged into one key per action stay merged in all six locales.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createRef } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { Chat, type Me, type Project } from '@mycel/shared/api'
import { MENU_ORDER, menuItem, orderMenu, type EntityItem, type MenuKind } from '../../src/components/menus/entityMenu'
import { useChatMenuItems } from '../../src/components/chat/chatMenuItems'
import { ChatTitleMenu } from '../../src/components/chat/ChatTitleMenu'
import { roomMenuActions, useRoomMenuItems } from '../../src/components/rooms/RoomMenu'
import { useProjectMenuItems } from '../../src/components/projectActions'
import { translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import { en } from '../../src/i18n/en'
import { ko } from '../../src/i18n/ko'
import { ja } from '../../src/i18n/ja'
import { zh } from '../../src/i18n/zh'
import { es } from '../../src/i18n/es'
import { id as idLocale } from '../../src/i18n/id'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'
import { room } from './rooms-fixtures'

const SRC = join(import.meta.dir, '../../src')
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f)
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : []
})
const sources = files(SRC).filter((p) => !p.includes('/i18n/')).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }))
// (the removed keys: nowhere else either, such as the server's app map, server/src/chat/app-map-keys.ts)
const ROOT = join(import.meta.dir, '../../..')
const elsewhere = ['server/src', 'shared/src', 'desktop/src', 'scripts'].flatMap((d) => files(join(ROOT, d))).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }))

/** Each canonical key and the keys merged into it (removed from every locale). */
export const MERGED: Record<string, string[]> = {
  'rooms.menu.copyLink': ['integrations.requests.copyLink', 'teamLink.copyLink', 'members.copyLink'],
  'rooms.menu.linkCopied': ['auth.linkCopied'],
  'common.copied': ['roomApps.copied'],
  'common.undo': ['shareCard.undo', 'steps.memoryUndo', 'chat.project.undo', 'files.findWork.undo', 'projects.undoRemove', 'postedCard.undo'],
  'common.delete': ['allowances.delete', 'postedCard.delete', 'scheduledCard.delete', 'schedules.delete'],
  'devEnvSite.deny': ['browser.deny'],
  'chat.hide': ['rooms.menu.hide', 'rooms.menu.hideDm'],
  'files.moveToTrash': ['projects.moveToTrash'],
  'chat.rename': ['rooms.info.rename', 'files.rename', 'credentials.rename'],
}
/** Keys package B's files still use (components/rooms/RoomMessages.tsx, components/chat/Messages.tsx …): kept, with the
 * canonical key's words, until B switches them. */
const SAME_WORDS: Record<string, string> = { 'rooms.copied': 'common.copied', 'chat.edit': 'chat.editMessage', 'rooms.editLabel': 'chat.editMessage' }

describe('one word per action', () => {
  const locales = { en, ko, ja, zh, es, id: idLocale } as Record<string, Record<string, string>>
  for (const [canon, gone] of Object.entries(MERGED))
    test(`${canon} is the one key (${gone.join(', ')} are gone)`, () => {
      for (const [l, dict] of Object.entries(locales)) {
        expect(dict[canon], `${l} ${canon}`).toBeTruthy()
        for (const k of gone) expect(dict[k], `${l} still has ${k}`).toBeUndefined()
      }
      for (const s of [...sources, ...elsewhere]) for (const k of gone) expect(s.text.includes(`'${k}'`) || s.text.includes(`"${k}"`), `${s.path} uses ${k}`).toBe(false)
    })
  test("package B's keys say the canonical key's words in every locale", () => {
    for (const [l, dict] of Object.entries(locales)) for (const [k, canon] of Object.entries(SAME_WORDS)) expect(`${l} ${k}: ${dict[k]}`).toBe(`${l} ${k}: ${dict[canon]}`)
  })
  test('undo is 실행 취소 and restore 되돌리기, never the other way round', () => {
    expect(ko['common.undo']).toBe('실행 취소')
    expect(ko['common.restore']).toBe('되돌리기')
  })
})

describe('menu items come from the one list', () => {
  /** kinds no other screen has: their words as an item label only in entityMenu.tsx */
  const ENTITY_ONLY: MessageKey[] = ['chat.pin', 'chat.unpin', 'chat.mute', 'chat.unmute', 'chat.hide', 'rooms.menu.show', 'rooms.menu.notify', 'chat.continuePrivately', 'chat.share.menu', 'projects.settings', 'rooms.menu.search', 'sidebarSections.moveTo', 'sidebarSections.remove', 'rooms.makeProject.menu', 'rooms.menu.makePrivate']
  /** files that build a chat's, room's or project's menu: no item of theirs labels itself */
  const BUILDERS = ['components/chat/ChatTitleMenu.tsx', 'components/chat/chatMenuItems.tsx', 'components/rooms/RoomMenu.tsx', 'components/projectActions.tsx', 'components/LeaveProject.tsx', 'components/nav/SidebarSections.tsx', 'components/SearchDialog.tsx', 'pages/Projects.tsx']
  // (a toast's action button is not a menu item)
  const labelled = (text: string, keys: readonly string[]) => keys.filter((k) => new RegExp(`(?<!action: \\{ )label: t\\(['"]${k.replace(/\./g, '\\.')}['"]\\)`).test(text))
  test("a kind's own words label an item only in entityMenu.tsx", () => {
    for (const s of sources) if (s.path !== 'components/menus/entityMenu.tsx') expect(`${s.path}: ${labelled(s.text, ENTITY_ONLY)}`).toBe(`${s.path}: `)
  })
  test('the menu builders label none of their items themselves', () => {
    for (const path of BUILDERS) {
      const s = sources.find((x) => x.path === path)
      expect(s, path).toBeTruthy()
      expect(s!.text).toContain('menus/entityMenu')
      expect(`${path}: ${labelled(s!.text, ['rooms.menu.copyLink', 'chat.rename', 'common.delete', 'auth.openInApp', 'projects.participants'])}`).toBe(`${path}: `)
    }
  })
  test('orderMenu puts any mix of kinds in MENU_ORDER and keeps two of a kind as given', () => {
    const t = (k: MessageKey) => translate('en', k)
    const kinds = [...MENU_ORDER].reverse()
    const out = orderMenu(kinds.map((k, i) => menuItem(t, k, { onSelect: () => {}, testId: `x${i}`, label: k })))
    expect(out.map((x) => x.kind)).toEqual([...MENU_ORDER])
    const two = orderMenu([menuItem(t, 'leave', { onSelect: () => {}, testId: 'a', label: 'a' }), menuItem(t, 'pin', { onSelect: () => {}, testId: 'p' }), menuItem(t, 'leave', { onSelect: () => {}, testId: 'b', label: 'b' })])
    expect(two.map((x) => x.testId)).toEqual(['p', 'a', 'b'])
    // leave and delete in the danger style, wherever they show
    for (const k of ['leave', 'delete'] as MenuKind[]) expect(menuItem(t, k, { onSelect: () => {}, testId: k, label: k }).danger).toBe(true)
    // every kind with words of its own has them in every locale
    for (const k of MENU_ORDER) {
      const it = menuItem(t, k, { onSelect: () => {}, testId: k })
      if (it.label !== k) expect(it.label.length).toBeGreaterThan(0)
    }
  })
})

describe('the real builders give the one order', () => {
  const ME = { user: { id: 'ada', username: 'ada', name: 'Ada', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, deployment: 'hosted' } } as unknown as Me
  const sorted = (kinds: MenuKind[]) => [...kinds].sort((a, b) => MENU_ORDER.indexOf(a) - MENU_ORDER.indexOf(b))
  const statusBefore = useSession.getState().status
  const localeBefore = useLocaleStore.getState().locale
  beforeAll(() => installDom())
  beforeEach(() => {
    useLocaleStore.setState({ locale: 'ko' })
    useSession.setState({ status: { kind: 'signed-in', me: ME } } as never)
  })
  afterAll(() => {
    useSession.setState({ status: statusBefore })
    useLocaleStore.setState({ locale: localeBefore })
    removeDom()
  })
  const chat = (o: Partial<Chat> = {}) => Chat.parse({ id: '01900000-0000-7000-8000-0000000000c2', projectId: null, title: 'Board summary', engine: 'claude-code', model: null, createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', deletedAt: null, runState: 'idle', ...o })
  const project = (o: Partial<Project> = {}): Project => ({ id: '01900000-0000-7000-8000-000000000011', name: 'Acme', folderPath: 'projects/acme', instructions: '', createdBy: null, createdAt: '2026-11-03T00:00:00.000Z', canEdit: true, membersEditable: true, leave: 'yes', ...o }) as Project

  async function kindsOf(use: () => EntityItem[] | ReturnType<typeof useRoomMenuItems>): Promise<string[]> {
    const out: { items: { testId?: string; kind?: MenuKind }[] } = { items: [] }
    function Probe() {
      out.items = use() as { testId?: string; kind?: MenuKind }[]
      return null
    }
    const m = await mount(<MemoryRouter><Probe /></MemoryRouter>)
    await m.unmount()
    return out.items.map((x) => x.kind ?? `(no kind: ${x.testId})`)
  }

  test("an AI chat's row: mine, shared with people and muted, with sections", async () => {
    const c = chat({ shared: { by: { id: 'ada', name: 'Ada' }, audience: 3, answering: null, mine: true, canDelete: true }, muted: true } as Partial<Chat>)
    const section = [menuItem((k) => translate('ko', k), 'section', { onSelect: () => {}, testId: 'row-section-move' })]
    const kinds = await kindsOf(() => useChatMenuItems(c, { testId: 'chat-row', more: createRef(), onMove: () => {}, extra: section }))
    expect(kinds).toEqual(sorted(kinds as MenuKind[]))
    expect(kinds.slice(0, 4)).toEqual(['pin', 'section', 'unmute', 'copyLink'])
    expect(kinds.at(-1)).toBe('delete')
  })

  test("an AI chat's title menu: the same order as its row", async () => {
    const c = chat({ shared: { by: { id: 'ben', name: 'Ben' }, audience: 3, answering: null, mine: false, canDelete: false }, pinnedAt: '2026-11-09T00:00:00.000Z' } as Partial<Chat>)
    const m = await mount(<MemoryRouter><ChatTitleMenu chat={c} title={c.title} onPin={() => {}} onMute={() => {}} onRename={() => {}} onHide={() => {}} onLeave={() => {}} onDelete={() => {}} /></MemoryRouter>)
    try {
      await m.click('chat-menu')
      const ids = (m.container.ownerDocument!.body.querySelectorAll('[role="menuitem"]') as unknown as FakeElement[]).map((e) => e.getAttribute('data-testid'))
      expect(ids.slice(0, 4)).toEqual(['chat-unpin', 'chat-mute', 'chat-copy-link', 'chat-rename'])
      expect(ids.at(-1)).toBe('chat-delete')
    } finally {
      await m.unmount()
    }
  })

  for (const kind of ['group', 'dm', 'team'] as const)
    test(`a room's "⋯" (${kind}): search first, then the one order`, async () => {
      const r = room({ kind, name: kind === 'team' ? 'design' : null, canRename: true })
      const kinds = await kindsOf(() => useRoomMenuItems(r, () => {}, undefined, () => {}, () => {}))
      expect(kinds[0]).toBe('search')
      expect(kinds).toEqual(sorted(kinds as MenuKind[]))
      expect(kinds.indexOf('copyLink')).toBeLessThan(kinds.indexOf(kind === 'group' ? 'makePrivate' : 'rename'))
      // the pure list is in the same order
      const actions = roomMenuActions(r)
      expect(actions.indexOf('notify')).toBeLessThan(actions.indexOf('copyLink'))
    })

  test("a phone room header has rename too (QA TC-257's rule superseded), after the status rows", async () => {
    const r = room({ kind: 'team', name: 'design', canRename: true })
    const first = [{ label: 'threads', onSelect: () => {}, testId: 'room-menu-threads' }]
    const out: { items: { testId?: string }[] } = { items: [] }
    function Probe() {
      out.items = useRoomMenuItems(r, () => {}, { first })
      return null
    }
    const m = await mount(<MemoryRouter><Probe /></MemoryRouter>)
    await m.unmount()
    expect(out.items[0]!.testId).toBe('room-menu-threads')
    expect(out.items.map((x) => x.testId)).toContain('room-menu-rename')
  })

  test("a project's row: link, rename, members, leave, delete; leave in the danger style", async () => {
    const out: { items: EntityItem[] } = { items: [] }
    function Probe() {
      out.items = useProjectMenuItems(project({ canManage: true } as Partial<Project>), { testId: 'p', select: (fn) => () => void fn(), onDeleted: () => {}, onMembers: () => {} })
      return null
    }
    const m = await mount(<MemoryRouter><Probe /></MemoryRouter>)
    await m.unmount()
    expect(out.items.map((x) => x.kind)).toEqual(['copyLink', 'rename', 'members', 'leave', 'delete'])
    expect(out.items.find((x) => x.kind === 'leave')!.danger).toBe(true)
  })
})

describe('destructive actions go through lib/destructive.ts', () => {
  /** confirm dialogs in web/src after 2026-11-26 (74 before, 5 now asked by the helper's one call): never more (undo, not
   * a new confirm) */
  const CONFIRMS = 69
  const count = sources.reduce((n, s) => n + (s.text.match(/confirmDialog\(/g)?.length ?? 0), 0)
  test(`web/src asks at most ${CONFIRMS} confirms (now ${count})`, () => {
    expect(count).toBeLessThanOrEqual(CONFIRMS)
  })
  test('the menu action files ask and offer undo only through the helper', () => {
    for (const path of ['components/chat/chatActions.ts', 'components/rooms/RoomMenu.tsx', 'components/LeaveProject.tsx', 'components/projectActions.tsx', 'pages/Scheduled.tsx']) {
      const s = sources.find((x) => x.path === path)!
      expect(`${path} confirmDialog: ${/\bconfirmDialog\b/.test(s.text)}`).toBe(`${path} confirmDialog: false`)
      expect(`${path} undo: ${s.text.includes("t('common.undo')")}`).toBe(`${path} undo: false`)
      expect(s.text).toContain('lib/destructive')
    }
  })
  /** files with an undo toast of their own (a move, a share, a setting: not a delete or a leave), 2026-11-26 */
  const UNDO_OK = ['components/ArtifactPanel.tsx', 'components/FolderShareParts.tsx', 'components/FilePanel.tsx', 'components/chat/ChatProject.tsx', 'components/chat/ShareToRoom.tsx', 'components/chat/ChatShareDialog.tsx', 'components/nav/SidebarSections.tsx', 'components/rooms/SendHere.tsx', 'components/onboarding/SetupRow.tsx', 'components/onboarding/CardHide.tsx', 'components/onboarding/WelcomeResume.tsx', 'pages/Files.tsx', 'pages/admin/FolderSharing.tsx']
  test('an undo toast is made by the helper or a file on the list', () => {
    const makers = sources.filter((s) => /action: \{ label: t\('common\.undo'\)/.test(s.text)).map((s) => s.path)
    expect(makers.filter((p) => !UNDO_OK.includes(p))).toEqual([])
  })
})
