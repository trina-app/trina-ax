// Room notification settings in the web app (docs/DECISIONS.md "대화방 알림 설정"): the sound follows the server's level for
// each room and my quiet hours (lib/roomSound.ts shouldRing, the shared rule), the room's bell offers the four levels
// (components/rooms/RoomNotifyMenu.tsx), and Settings › Notifications has 대화 → 작업·연결 알림 → 이 기기 as plain rows
// (components/settings/Notifications.tsx, RoomNotifySettings.tsx).
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7, zonedClock, type Me, type NotificationPreferences, type Room } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { shouldRing, type RingInput } from '../../src/lib/roomSound'
import { dispatch } from '../../src/store/live'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { RoomNotifyMenu } from '../../src/components/rooms/RoomNotifyMenu'
import { Notifications } from '../../src/components/settings/Notifications'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'
import { BEN, ME, message, room } from './rooms-fixtures'

setDefaultTimeout(30_000)
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const ROOM = uuidv7()
const notify = (own: 'all' | 'mentions' | 'off' | null, byDefault: 'all' | 'mentions' | 'off') => ({ own, byDefault, level: own ?? byDefault })
const ring = (o: Omit<Partial<RingInput>, 'message'> & { message?: Partial<RingInput['message']> } = {}) => shouldRing({
  roomId: ROOM, room: { kind: 'dm', muted: false }, meId: ME.id, replay: false, seen: false, viewing: null,
  ...o, message: { ...message({ roomId: ROOM, seq: 1 }), ...o.message },
})
const ALERTS = { threadReplies: true, quietHours: { on: false, start: '22:00', end: '08:00', weekends: false }, timeZone: 'Asia/Seoul' }

describe('the sound follows the level the server sends', () => {
  test('a team room at 모든 메시지 rings for every message; a DM at 멘션만 only for a mention; 끄기 never', () => {
    expect(ring({ room: { kind: 'team', muted: false, notify: notify('all', 'mentions') } })).toBe(true)
    expect(ring({ room: { kind: 'team', muted: false, notify: notify(null, 'mentions') } })).toBe(false)
    expect(ring({ room: { kind: 'all', muted: false, notify: notify(null, 'all') } })).toBe(true) // my default 모든 새 메시지
    expect(ring({ room: { kind: 'dm', muted: false, notify: notify('mentions', 'all') } })).toBe(false)
    expect(ring({ room: { kind: 'dm', muted: false, notify: notify('mentions', 'all') }, message: { mentions: [ME.id] } })).toBe(true)
    expect(ring({ room: { kind: 'dm', muted: false, notify: notify(null, 'off') }, message: { mentions: [ME.id] } })).toBe(false) // 받지 않음
    expect(ring({ room: { kind: 'group', muted: true, notify: notify('off', 'all') }, message: { mentions: [ME.id] } })).toBe(false)
    // my AI answer at 끄기: quiet too
    expect(ring({ room: { kind: 'dm', muted: true, notify: notify('off', 'all') }, message: { authorKind: 'ai', author: null, askedBy: ME, visibility: 'private' } })).toBe(false)
  })

  test('replies in threads I follow ring unless I turned them off; a mention in a reply always', () => {
    const reply = { threadRootId: uuidv7(), following: true as const }
    expect(ring({ alerts: ALERTS, room: { kind: 'team', muted: false, notify: notify(null, 'mentions') }, message: reply })).toBe(true)
    expect(ring({ alerts: { ...ALERTS, threadReplies: false }, room: { kind: 'team', muted: false, notify: notify(null, 'mentions') }, message: reply })).toBe(false)
    expect(ring({ alerts: { ...ALERTS, threadReplies: false }, room: { kind: 'team', muted: false, notify: notify(null, 'mentions') }, message: { ...reply, mentions: [ME.id] } })).toBe(true)
    // not followed, stays in the thread: quiet even at 모든 메시지; sent to the room too: a message of the room
    expect(ring({ room: { kind: 'team', muted: false, notify: notify('all', 'mentions') }, message: { threadRootId: uuidv7() } })).toBe(false)
    expect(ring({ room: { kind: 'team', muted: false, notify: notify('all', 'mentions') }, message: { threadRootId: uuidv7(), alsoInRoom: true } })).toBe(true)
  })

  test('quiet hours: nothing rings inside them, in the team\'s time zone', () => {
    const now = Date.parse('2026-11-05T02:00:00+09:00') // a Thursday night in Seoul
    const night = { ...ALERTS, quietHours: { on: true, start: '22:00', end: '08:00', weekends: false } }
    expect(ring({ alerts: night, now })).toBe(false)
    expect(ring({ alerts: night, now, message: { mentions: [ME.id] } })).toBe(false)
    expect(ring({ alerts: night, now: Date.parse('2026-11-05T09:00:00+09:00') })).toBe(true)
    // the same moment is 09:00 in Los Angeles
    expect(zonedClock(now, 'America/Los_Angeles').minute).toBe(9 * 60)
    expect(ring({ alerts: { ...night, timeZone: 'America/Los_Angeles' }, now })).toBe(true)
    // off: as before
    expect(ring({ alerts: ALERTS, now })).toBe(true)
  })

  test('an older server (no levels, no alerts): today\'s rule', () => {
    expect(ring({ room: { kind: 'team', muted: false } })).toBe(false)
    expect(ring({ room: { kind: 'team', muted: false }, message: { mentions: [ME.id] } })).toBe(true)
    expect(ring({ room: { kind: 'group', muted: false } })).toBe(true)
    expect(ring({ room: { kind: 'dm', muted: true }, message: { mentions: [ME.id] } })).toBe(false)
  })
})

// ---------------- the bell and Settings › Notifications ----------------
const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, timeZone: 'Asia/Seoul' } } as unknown as Me
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const sent: { key: string; body: any }[] = []
let prefs: NotificationPreferences
let roomsList: Room[] = []
/** while set, reading the preferences waits for it (a slow server) */
let holdPrefs: Promise<void> | null = null
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const defaults = (): NotificationPreferences => ({ scheduleSuccess: true, scheduleFailure: true, connectionReconnect: true, skillSuggestions: true, roomMessages: true, roomLevel: 'direct', roomThreadReplies: true, quietHours: { on: false, start: '22:00', end: '08:00', weekends: false } })
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    sent.push({ key, body })
    if (key === 'GET /api/notifications') return json({ items: [], nextCursor: null, unreadCount: 0 })
    if (key === 'GET /api/notification-preferences') { if (holdPrefs) await holdPrefs; return json(prefs) }
    if (key === 'PATCH /api/notification-preferences') { prefs = { ...prefs, ...body }; return json(prefs) }
    if (key === 'GET /api/push') return json({ configured: false, enabled: false, publicKey: null, subscriptionId: null })
    if (key === 'GET /api/rooms') return json({ items: roomsList, alerts: ALERTS })
    const patch = /^PATCH \/api\/rooms\/(.+)$/.exec(key)
    if (patch) {
      const r = roomsList.find((x) => x.id === patch[1])!
      const own = body.notifyLevel ?? null
      return json({ ...r, muted: own === 'off', notify: { own, byDefault: r.notify!.byDefault, level: own ?? r.notify!.byDefault } })
    }
    return json({ error: { code: 'not_found', message: key } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  sent.length = 0
  useRooms.getState().reset()
  useSession.setState({ status })
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale })
})

test('the bell: four levels, the chosen one ticked, the default saying what it gives; a choice is sent and shown', async () => {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const r = room({ kind: 'team', notify: notify(null, 'mentions') })
  roomsList = [r]
  useRooms.setState({ rooms: [r], loaded: true })
  const Bell = () => <RoomNotifyMenu room={useRooms((s) => s.rooms[0]!)} />
  const m = await mount(<MemoryRouter><Bell /></MemoryRouter>)
  try {
    expect(m.get('room-notify').getAttribute('aria-label')).toBe(ko('rooms.notify.button', { level: ko('rooms.notify.mentions') }))
    await m.click('room-notify')
    const items = m.container.ownerDocument!.body.querySelectorAll('[role="menuitemradio"]')
    expect(items.map((x) => x.textContent)).toEqual([`${ko('rooms.notify.default')}· ${ko('rooms.notify.mentions')}`, ko('rooms.notify.all'), ko('rooms.notify.mentions'), ko('rooms.notify.off')])
    expect(items.map((x) => x.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false'])
    expect(m.html()).toContain(ko('rooms.notify.heading'))
    await m.click('room-notify-off')
    await m.until(() => sent.some((s) => s.key === `PATCH /api/rooms/${r.id}`), 'the PATCH')
    expect(sent.find((s) => s.key === `PATCH /api/rooms/${r.id}`)!.body).toEqual({ notifyLevel: 'off' })
    await m.until(() => useRooms.getState().rooms[0]!.notify?.own === 'off', 'the room updated')
    expect(m.get('room-notify').getAttribute('aria-label')).toBe(ko('rooms.notify.button', { level: ko('rooms.notify.off') }))
    // back to the default
    await m.click('room-notify')
    await m.click('room-notify-default')
    await m.until(() => sent.filter((s) => s.key === `PATCH /api/rooms/${r.id}`).length === 2, 'the second PATCH')
    expect(sent.filter((s) => s.key === `PATCH /api/rooms/${r.id}`)[1]!.body).toEqual({ notifyLevel: null })
  } finally { await m.unmount() }
})

test('Settings › Notifications: 대화 → 작업·연결 알림 → 이 기기, plain rows; each choice saves', async () => {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  prefs = defaults()
  const muted = room({ kind: 'group', name: '출시 준비', groupId: null, muted: true, notify: notify('off', 'all') })
  const loud = room({ kind: 'team', notify: notify('all', 'mentions') })
  roomsList = [muted, loud]
  const m = await mount(<MemoryRouter><Notifications /></MemoryRouter>)
  try {
    await m.until(() => m.find('notifications-rooms'), 'the 대화 section')
    const body = m.container.ownerDocument!.body
    // the order, and no frames
    const ids = body.querySelectorAll('[data-testid]').map((e) => e.getAttribute('data-testid')).filter((x) => ['notifications-inbox', 'notifications-rooms', 'notifications-work', 'notifications-device'].includes(x!))
    expect(ids).toEqual(['notifications-inbox', 'notifications-rooms', 'notifications-work', 'notifications-device'])
    expect(m.html()).not.toContain('<fieldset class="space-y-3 md:rounded-xl')
    expect(m.html()).not.toContain('md:rounded-xl md:border')
    expect(m.get('notifications-rooms').textContent).toContain(ko('notifications.section.rooms'))
    // 알림 받을 메시지: three choices, the default chosen
    expect((m.get('notification-room-level-direct') as unknown as { checked: boolean }).checked).toBe(true)
    expect(m.get('notification-room-level').textContent).toContain(ko('notifications.roomLevel.direct'))
    await press(m, 'notification-room-level-all')
    await m.until(() => sent.some((s) => s.key === 'PATCH /api/notification-preferences'), 'the PATCH')
    expect(sent.filter((s) => s.key === 'PATCH /api/notification-preferences').map((s) => s.body)).toEqual([{ roomLevel: 'all' }])
    // thread replies
    await press(m, 'notification-thread-replies')
    await m.until(() => sent.filter((s) => s.key === 'PATCH /api/notification-preferences').length === 2, 'the second PATCH')
    expect(sent.filter((s) => s.key === 'PATCH /api/notification-preferences')[1]!.body).toEqual({ roomThreadReplies: false })
    // quiet hours: off with no hours shown; on shows the hours (team time zone in the line) and saves them whole
    expect(m.find('notification-quiet-start')).toBeNull()
    expect(m.get('notification-quiet-row').textContent).toContain('Asia/Seoul')
    await press(m, 'notification-quiet')
    await m.until(() => m.find('notification-quiet-start'), 'the hours')
    await m.until(() => sent.filter((s) => s.key === 'PATCH /api/notification-preferences').length === 3, 'the third PATCH')
    expect(sent.filter((s) => s.key === 'PATCH /api/notification-preferences')[2]!.body).toEqual({ quietHours: { on: true, start: '22:00', end: '08:00', weekends: false } })
    expect((m.get('notification-quiet-start') as unknown as { value: string }).value).toBe('22:00')
    // the same start and end: said, not saved
    await m.type('notification-quiet-end', '22:00')
    await m.settle()
    expect(m.find('notification-quiet-row')!.textContent).toContain(ko('notifications.quietBad'))
    expect(sent.filter((s) => s.key === 'PATCH /api/notification-preferences')).toHaveLength(3)
    await m.type('notification-quiet-end', '07:30')
    await m.until(() => sent.filter((s) => s.key === 'PATCH /api/notification-preferences').length === 4, 'the fourth PATCH')
    expect(sent.filter((s) => s.key === 'PATCH /api/notification-preferences')[3]!.body).toEqual({ quietHours: { on: true, start: '22:00', end: '07:30', weekends: false } })
    // the rooms I turned off: one row with its level; another level sends it and keeps the row in place
    await m.until(() => m.find('notification-muted-rooms'), 'the muted rooms')
    expect(m.get('notification-muted-rooms').textContent).toContain(ko('notifications.mutedRooms', { count: 1 }))
    expect(body.querySelectorAll('[data-testid="notification-muted-room"]')).toHaveLength(1)
    expect(m.get('notification-muted-room').textContent).toContain('출시 준비')
    const select = m.get('notification-muted-room-level')
    await act(select, 'mentions')
    await m.until(() => sent.some((s) => s.key === `PATCH /api/rooms/${muted.id}`), 'the room PATCH')
    expect(sent.find((s) => s.key === `PATCH /api/rooms/${muted.id}`)!.body).toEqual({ notifyLevel: 'mentions' })
    await m.until(() => m.get('notification-muted-rooms').textContent!.includes(ko('notifications.mutedRooms', { count: 0 })), 'the count')
    expect(body.querySelectorAll('[data-testid="notification-muted-room"]')).toHaveLength(1)
    // 작업·연결 알림: one switch a row with its line; 이 기기: the sound and push
    for (const k of ['scheduleSuccess', 'scheduleFailure', 'connectionReconnect', 'skillSuggestions']) expect(m.find(`notification-pref-${k}`)).toBeTruthy()
    expect(m.get('notifications-work').textContent).toContain(ko('notifications.scheduleSuccessDesc'))
    expect(m.get('notifications-device').textContent).toContain(ko('notifications.sound'))
    expect(m.find('notification-sound')).toBeTruthy()
    expect(m.find('push-notifications')).toBeTruthy()
  } finally { await m.unmount() }
})

test('changes made while one saves or while the page reads the settings again are all sent, in order', async () => {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  prefs = defaults()
  roomsList = []
  const m = await mount(<MemoryRouter><Notifications /></MemoryRouter>)
  try {
    await m.until(() => m.find('notification-thread-replies'), 'the rows')
    const patches = () => sent.filter((s) => s.key === 'PATCH /api/notification-preferences').map((s) => s.body)
    // the read after the first save is slow; the second change comes meanwhile
    let release!: () => void
    holdPrefs = new Promise<void>((r) => { release = r })
    await press(m, 'notification-thread-replies')
    await m.until(() => patches().length === 1, 'the first PATCH')
    // the save is done and the page is reading the settings again (held): now the second change
    await m.until(() => sent.findLastIndex((s) => s.key === 'GET /api/notification-preferences') > sent.findIndex((s) => s.key === 'PATCH /api/notification-preferences'), 'the read after the save')
    await press(m, 'notification-room-level-all')
    await m.until(() => patches().length === 2, 'the second PATCH')
    holdPrefs = null
    release()
    await m.settle(50)
    expect(patches()).toEqual([{ roomThreadReplies: false }, { roomLevel: 'all' }])
    expect(prefs).toMatchObject({ roomThreadReplies: false, roomLevel: 'all' })
    // what shows is what was chosen
    expect((m.get('notification-room-level-all') as unknown as { checked: boolean }).checked).toBe(true)
    expect((m.get('notification-thread-replies') as unknown as { checked: boolean }).checked).toBe(false)
  } finally { holdPrefs = null; await m.unmount() }
})

test('an older server (one switch for rooms): one row, the old switch', async () => {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  prefs = { scheduleSuccess: true, scheduleFailure: true, connectionReconnect: true, skillSuggestions: true, roomMessages: true }
  roomsList = []
  const m = await mount(<MemoryRouter><Notifications /></MemoryRouter>)
  try {
    await m.until(() => m.find('notification-pref-roomMessages'), 'the room switch')
    expect(m.find('notification-room-level')).toBeNull()
    expect(m.find('notification-quiet')).toBeNull()
  } finally { await m.unmount() }
})

test('a change of my settings on another device reloads the rooms (their levels and my quiet hours)', async () => {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  roomsList = [room({ kind: 'dm', groupId: null, notify: notify(null, 'all') })]
  dispatch({ type: 'notice', data: { level: 'info', code: 'room_alerts_changed', message: '' } } as never, { replay: false } as never)
  const until = Date.now() + 2000
  while (!useRooms.getState().loaded && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
  expect(sent.some((s) => s.key === 'GET /api/rooms')).toBe(true)
  expect(useRooms.getState().alerts).toEqual(ALERTS)
})

/** a browser checks a box or a radio before the click's listeners run, past React's value tracker (this small DOM does
 * not): the click a person makes */
async function press(m: Awaited<ReturnType<typeof mount>>, id: string) {
  const input = m.get(id)
  const radio = input.getAttribute('type') === 'radio'
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'checked')!.set!.call(input, radio ? true : !(input as unknown as { checked: boolean }).checked)
  await m.click(input)
}
/** choose an option of a <select> as a person does */
async function act(select: ReturnType<Awaited<ReturnType<typeof mount>>['get']>, value: string) {
  const { act: reactAct } = await import('react')
  await reactAct(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')!.set!.call(select, value)
    select.dispatchEvent(new FakeEvent('change', { bubbles: true }))
  })
}
void BEN
