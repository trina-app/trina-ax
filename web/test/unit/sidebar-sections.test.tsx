// My sidebar sections (docs/decisions/20261121-personal-sidebar-sections.md): the rules under the Chats list. A
// conversation shows in one place (pinned › its section › its kind), Channels and Direct messages stay even when every
// conversation of theirs is in a section (their header holds the "+" and takes a dragged row out), and the words say
// "section" in every language, never "folder".
import { describe, expect, test } from 'bun:test'
import type { NavFolder, Room } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { foldOf, roomsByKind, withKinds } from '../../src/components/panels/RoomsByKind'
import { canSection } from '../../src/components/nav/SidebarSections'

const room = (id: string, o: Partial<Room> = {}) => ({ id, kind: 'team', name: id, unreadCount: 0, threadsUnread: 0, mentioned: false, muted: false, activityAt: '2026-11-21T00:00:00.000Z', ...o }) as Room
const section = (id: string, name: string, position: number): NavFolder => ({ id, kind: 'rooms', name, position, count: 0, top: [] })

describe('sections in the Chats list', () => {
  test('pinned › my sections (in their order, empty ones too) › Channels › Direct messages; a DM goes in a section too', () => {
    const rooms = [room('ch'), room('dm1', { kind: 'dm', folderId: 's1' }), room('ch2', { folderId: 's1' }), room('p', { pinnedAt: '2026-11-21T00:00:00.000Z', folderId: 's2' })]
    const s = withKinds(roomsByKind(rooms, (r) => r.name ?? '', 'en', [section('s2', 'Empty', 1), section('s1', 'Bots', 0)].sort((a, b) => a.position - b.position)))
    expect(s.map((x) => (x.folder ? `section:${x.folder.name}` : x.key))).toEqual(['pinned', 'section:Bots', 'section:Empty', 'team', 'dm'])
    expect(s.map((x) => x.rooms.map((r) => r.id))).toEqual([['p'], ['dm1', 'ch2'], [], ['ch'], []])
  })
  test('Channels and Direct messages stay when every conversation is in a section, in their place', () => {
    const s = withKinds(roomsByKind([room('a', { folderId: 's1' }), room('b', { kind: 'dm', folderId: 's1' })], (r) => r.name ?? '', 'en', [section('s1', 'All', 0)]))
    expect(s.map((x) => x.key)).toEqual(['folder', 'team', 'dm'])
    expect(s.filter((x) => !x.folder).every((x) => x.rooms.length === 0)).toBe(true)
  })
  test("a section folds with the phone's key; the kinds with their own", () => {
    expect(foldOf({ key: 'folder', rooms: [], folder: section('s1', 'Bots', 0) })).toBe('room-folder:s1')
    expect(foldOf({ key: 'team', rooms: [] })).toBe('section:chats:team')
  })
  test('a hidden conversation cannot be moved (it is shown again first)', () => {
    expect(canSection(room('a'))).toBe(true)
    expect(canSection(room('a', { hidden: true }))).toBe(false)
  })
})

describe('the words', () => {
  const keys = ['new', 'newFromMove', 'nameLabel', 'onlyYou', 'create', 'rename', 'addTitle', 'addButton', 'skip', 'add', 'addNone', 'search', 'inOther', 'emptyComputer', 'emptyPhone', 'moveTo', 'remove', 'heading', 'moved', 'movedMany', 'removed', 'delete', 'deleteTitle', 'deleteBody', 'nameTaken', 'menu', 'addMenu'] as const
  test('every key in every language, filled in, and never a folder', () => {
    for (const l of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const)
      for (const k of keys) {
        const v = translate(l, `sidebarSections.${k}`, { name: 'Bots', n: 3 })
        expect(v).not.toBe(`sidebarSections.${k}`)
        expect(v).not.toContain('{')
        expect(v.toLowerCase()).not.toMatch(/folder|폴더|carpeta|フォルダ|文件夹/)
      }
  })
  test('en first, ko as planned', () => {
    expect(translate('en', 'sidebarSections.moveTo')).toBe('Move to section')
    expect(translate('ko', 'sidebarSections.moveTo')).toBe('섹션으로 옮기기')
    expect(translate('en', 'sidebarSections.deleteBody', { n: 1 })).toBe('Its conversation goes back to Channels and Direct messages. Only your sidebar changes.')
    expect(translate('en', 'sidebarSections.addButton', { n: 2 })).toBe('Add 2 conversations')
    expect(translate('ko', 'sidebarSections.new')).toBe('새 섹션')
  })
})
