// My list folders on screen (docs/DECISIONS.md "List folders on screen", the navigation plan's phase P4b): the rules
// under the lists. A room shows in one place (pinned › its folder › its kind), every folder shows even when empty, a
// folder that is not one of mine is ignored; a folded room folder keeps one pill, the strongest ("?" › "@" › how many
// rooms are unread, muted ones left out); a name already used is found in any letter case.
import { describe, expect, test } from 'bun:test'
import type { NavFolder, Room } from '@mycel/shared/api'
import { roomFolderPill } from '../../src/components/nav/NavFolders'
import { roomsByKind } from '../../src/components/panels/RoomsByKind'
import { foldersOf, nameTaken } from '../../src/store/navFolders'

const room = (id: string, o: Partial<Room> = {}) => ({ id, kind: 'team', name: id, unreadCount: 0, threadsUnread: 0, mentioned: false, muted: false, activityAt: '2026-11-13T00:00:00.000Z', ...o }) as Room
const folder = (id: string, name: string, position: number, kind: 'chats' | 'rooms' = 'rooms'): NavFolder => ({ id, kind, name, position, count: 0, top: [] })

describe('room folders in 대화', () => {
  test('one place per room: pinned › its folder › its kind; empty folders show; an unknown folder is ignored', () => {
    const rooms = [room('a', { folderId: 'f1' }), room('b', { folderId: 'f1', pinnedAt: '2026-11-13T00:00:00.000Z' }), room('c', { folderId: 'gone' }), room('d', { kind: 'dm' })]
    const s = roomsByKind(rooms, (r) => r.name ?? '', 'ko', [folder('f1', '우리 팀', 0), folder('f2', '빈 폴더', 1)])
    expect(s.map((x) => (x.folder ? `folder:${x.folder.name}` : x.key))).toEqual(['pinned', 'folder:우리 팀', 'folder:빈 폴더', 'team', 'dm'])
    expect(s.map((x) => x.rooms.map((r) => r.id))).toEqual([['b'], ['a'], [], ['c'], ['d']])
  })
  test('no folders: as before', () => {
    expect(roomsByKind([room('a')], (r) => r.name ?? '', 'ko').map((x) => x.key)).toEqual(['team'])
  })
})

describe("a folded room folder's pill", () => {
  test('"?" over "@" over the number of unread rooms; muted rooms are left out; nothing: no pill', () => {
    expect(roomFolderPill([room('a', { unreadCount: 2, mentioned: true }), room('b', { aiWaits: true })])).toEqual({ kind: 'ask' })
    expect(roomFolderPill([room('a', { unreadCount: 2, mentioned: true }), room('b', { unreadCount: 5 })])).toEqual({ kind: 'mention' })
    expect(roomFolderPill([room('a', { unreadCount: 2 }), room('b', { unreadCount: 5 }), room('c')])).toEqual({ kind: 'unread', n: 2 })
    expect(roomFolderPill([room('a', { unreadCount: 2, muted: true, mentioned: true })])).toBeNull()
    expect(roomFolderPill([room('a')])).toBeNull()
  })
})

describe('my folders', () => {
  test('of one kind, in their order; a name taken in any letter case, not by the folder itself', () => {
    const all = [folder('x', 'Ideas', 1, 'chats'), folder('y', 'Weekly', 0, 'chats'), folder('z', 'Team', 0)]
    expect(foldersOf(all, 'chats').map((f) => f.id)).toEqual(['y', 'x'])
    expect(nameTaken(all, 'chats', ' ideas ')).toBe(true)
    expect(nameTaken(all, 'chats', 'Ideas', 'x')).toBe(false)
    expect(nameTaken(all, 'rooms', 'Ideas')).toBe(false)
  })
})

describe("a folder's + opens the new-chat box with the folder", () => {
  test('on a phone with the new tabs at /new, else at /; a / with a folder goes to /new on such a phone', async () => {
    const { newChatPath, homeRoute } = await import('../../src/lib/newChat')
    expect(newChatPath({ folder: 'f1' }, false)).toBe('/?folder=f1')
    expect(homeRoute('/', '?folder=f1', true, true)).toEqual({ to: '/new?folder=f1' })
    expect(homeRoute('/new', '?folder=f1', false, true)).toEqual({ to: '/?folder=f1' })
  })
})
