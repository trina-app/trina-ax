// A room at "Mentions only" adds no number anywhere (docs/decisions/20261116-mentions-only-no-count.md, QA TC-4171): the
// one rule (shared/src/api/attention.ts roomCounts) and every surface that shows or adds a room's number: the row's
// badge, a folder's pill and bold name, the 대화 count on the rail and the phone tab bar, the messages total, the one
// count n (the tab title, the Dock, the phone icon) and its dot.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Room } from '@mycel/shared/api'
import { attentionCount, roomCounts, roomLightsDot, roomNoticeWanted, roomWantsMe } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { roomBadge, totalUnread } from '../../src/lib/rooms'
import { chatsMark, unreadRooms } from '../../src/components/rail/railBadges'
import { roomFolderBold, roomFolderPill } from '../../src/components/nav/NavFolders'
import { UnreadBadge } from '../../src/components/nav/RoomsList'
import { iconBadge } from '../../src/lib/sessionMarkers'
import { installDom, mount, removeDom } from './dom-host'
import { room } from './rooms-fixtures'

const level = (l: 'all' | 'mentions' | 'off', own = true): Room['notify'] => ({ own: own ? l : null, byDefault: l, level: l })
/** an app channel set to "Mentions only", with 3 plain messages unread */
const quietChannel = (o: Partial<Room> = {}) => room({ kind: 'group', unreadCount: 3, notify: level('mentions'), ...o })
const dmAll = (o: Partial<Room> = {}) => room({ kind: 'dm', unreadCount: 2, notify: level('all'), ...o })
const muted = (o: Partial<Room> = {}) => room({ kind: 'group', unreadCount: 5, muted: true, notify: level('off'), ...o })

describe('roomCounts', () => {
  test('mentions only: plain messages make the row bold and add no number', () => {
    expect(roomCounts(quietChannel())).toEqual({ bold: true, mention: false, number: 0, quiet: false, counts: false })
  })
  test('mentions only: a mention shows "@" and counts', () => {
    expect(roomCounts(quietChannel({ unreadCount: 4, mentioned: true }))).toEqual({ bold: true, mention: true, number: 4, quiet: false, counts: true })
  })
  test('mentions only: a reply in a thread I follow adds nothing to the row (the room\'s thread mark shows it)', () => {
    expect(roomCounts(quietChannel({ threadsUnread: 1 }))).toEqual({ bold: true, mention: false, number: 0, quiet: false, counts: false })
  })
  // QA TC-5363: a room read to its end with a followed thread's new reply left is not bold (Slack: the channel goes by
  // its timeline), on every surface that reads roomCounts; a followed reply that mentions me still shows "@"
  test('read to the end, a followed thread\'s reply left: not bold, no number, at every level', () => {
    for (const r of [quietChannel({ unreadCount: 0, threadsUnread: 1 }), dmAll({ unreadCount: 0, threadsUnread: 2 }), muted({ unreadCount: 0, threadsUnread: 1 })]) {
      expect(roomCounts(r)).toMatchObject({ bold: false, mention: false, number: 0, counts: false })
    }
    expect(roomBadge(dmAll({ unreadCount: 0, threadsUnread: 2 }))).toBe('')
    expect(unreadRooms([dmAll({ unreadCount: 0, threadsUnread: 2 })])).toBe(0)
  })
  test('read to the end, a followed reply that mentions me left: "@", bold, counted', () => {
    expect(roomCounts(quietChannel({ unreadCount: 0, threadsUnread: 1, mentioned: true }))).toEqual({ bold: true, mention: true, number: 0, quiet: false, counts: true })
    expect(roomBadge(dmAll({ unreadCount: 0, threadsUnread: 1, mentioned: true }))).toBe('@')
  })
  test('a followed reply adds to no number (the one count n: tab title, Dock, phone icon) but still gets the desktop notice while its switch is on, and the dot', () => {
    expect(roomWantsMe(dmAll({ unreadCount: 0, threadsUnread: 1 }))).toBe(false)
    expect(attentionCount([], [dmAll({ unreadCount: 0, threadsUnread: 1 })])).toMatchObject({ n: 0, unread: true })
    // one that mentions me counts, as its "@" shows on the row
    expect(roomWantsMe(quietChannel({ unreadCount: 0, threadsUnread: 1, mentioned: true }))).toBe(true)
    expect(roomNoticeWanted(dmAll({ unreadCount: 0, threadsUnread: 1 }))).toBe(true)
    expect(roomNoticeWanted(dmAll({ unreadCount: 0, threadsUnread: 1 }), false)).toBe(false)
    expect(roomNoticeWanted(muted({ unreadCount: 0, threadsUnread: 1 }))).toBe(false)
    expect(roomNoticeWanted(dmAll({ unreadCount: 0, threadsUnread: 1, hidden: true }))).toBe(false)
    expect(roomLightsDot(quietChannel({ unreadCount: 0, threadsUnread: 1 }))).toBe(true)
  })
  test('the one count n and the rows agree: a room wants me exactly when it counts on its row', () => {
    for (const r of [quietChannel(), quietChannel({ mentioned: true }), quietChannel({ unreadCount: 0, threadsUnread: 2 }), dmAll(), dmAll({ unreadCount: 0, threadsUnread: 1 }), dmAll({ unreadCount: 0, threadsUnread: 1, mentioned: true }), muted(), muted({ mentioned: true })]) {
      expect(roomWantsMe(r)).toBe(roomCounts(r).counts)
    }
  })
  test('a team room at its default level is mentions only; DMs and group chats are all messages (an older server too)', () => {
    expect(roomCounts(room({ unreadCount: 3, notify: level('mentions', false) })).counts).toBe(false)
    expect(roomCounts(room({ kind: 'all', unreadCount: 3 })).counts).toBe(false)
    expect(roomCounts(room({ kind: 'group', unreadCount: 3 })).number).toBe(3)
  })
  test('all messages: every unread message of the timeline (a followed reply is not one)', () => {
    expect(roomCounts(dmAll())).toEqual({ bold: true, mention: false, number: 2, quiet: false, counts: true })
    expect(roomCounts(dmAll({ threadsUnread: 1 })).number).toBe(2)
  })
  test('off: grey number, never counted, a mention included', () => {
    expect(roomCounts(muted())).toEqual({ bold: true, mention: false, number: 5, quiet: true, counts: false })
    expect(roomCounts(muted({ mentioned: true })).counts).toBe(false)
  })
  test('nothing unread: nothing', () => {
    expect(roomCounts(quietChannel({ unreadCount: 0 }))).toEqual({ bold: false, mention: false, number: 0, quiet: false, counts: false })
  })
})

describe('every surface that sums', () => {
  const rooms = [quietChannel(), quietChannel(), dmAll(), muted()]
  test('the row badge: no number for plain messages at mentions only, "@" for a mention', () => {
    expect(roomBadge(quietChannel())).toBe('')
    expect(roomBadge(quietChannel({ mentioned: true }))).toBe('@')
    expect(roomBadge(dmAll())).toBe('2')
  })
  test('the messages total', () => {
    expect(totalUnread(rooms)).toBe(2)
    expect(totalUnread([...rooms, quietChannel({ unreadCount: 4, mentioned: true })])).toBe(6)
  })
  test('the 대화 count on the rail and the phone tab bar', () => {
    expect(unreadRooms(rooms)).toBe(1)
    expect(chatsMark([quietChannel(), muted()])).toBeNull()
    expect(chatsMark([quietChannel({ mentioned: true })])).toEqual({ kind: 'count', n: 1 })
  })
  test("a folder's pill and its bold name", () => {
    expect(roomFolderPill([quietChannel(), quietChannel()])).toBeNull()
    expect(roomFolderBold([quietChannel()])).toBe(true)
    expect(roomFolderBold([muted()])).toBe(false)
    expect(roomFolderPill([quietChannel(), quietChannel({ mentioned: true })])).toEqual({ kind: 'mention' })
    expect(roomFolderPill([quietChannel(), dmAll()])).toEqual({ kind: 'unread', n: 1 })
  })
  test('the one count n (tab title, Dock, phone icon): not counted, the icon only a dot', () => {
    expect(roomWantsMe(quietChannel())).toBe(false)
    expect(roomLightsDot(quietChannel())).toBe(true)
    const a = attentionCount([], [quietChannel(), muted()])
    expect(a).toMatchObject({ n: 0, unread: true })
    expect(iconBadge(a)).toBe('dot')
    // the DM by its row's number (2); the mentioned channel at 멘션만 once, not its row's 3 (review of #108, finding 1)
    expect(attentionCount([], [quietChannel({ mentioned: true }), dmAll()]).n).toBe(3)
  })
})

describe('the row badge', () => {
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'en' })
  })
  afterAll(() => removeDom())
  test('mentions only: no pill, a screen reader still hears there are unread messages', async () => {
    const m = await mount(<UnreadBadge room={quietChannel()} testId="room-unread" />)
    expect(m.find('room-unread')).toBeNull()
    expect(m.find('room-unread-bold')?.textContent).toBe(translate('en', 'rooms.unreadNoCount'))
    await m.unmount()
  })
  test('a mention: the "@" pill', async () => {
    const m = await mount(<UnreadBadge room={quietChannel({ mentioned: true })} testId="room-unread" />)
    expect(m.find('room-unread')?.textContent).toContain('@')
    await m.unmount()
  })
  test('muted: the grey number, as before', async () => {
    const m = await mount(<UnreadBadge room={muted()} testId="room-unread" />)
    const pill = m.find('room-unread')
    expect(pill?.getAttribute('data-muted')).toBe('')
    expect(pill?.textContent).toContain('5')
    await m.unmount()
  })
})
