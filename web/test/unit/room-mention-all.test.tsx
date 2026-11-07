// "@전체" in a room's message box (docs/DECISIONS.md "@전체"; components/rooms/useMentionMenu.tsx, RoomComposer.tsx): one
// row right under the AI with how many it notifies, found by every language's word and Slack's (all, channel, everyone);
// picked it is a token and the message goes with mentionsAll (pasted, it is text and goes without); a room of 10 or more
// asks first, in one line inside the box; a DM has no row, the everyone room only for owners and admins; a sent message
// shows it like a mention of me, the sound rings for it, and the edit form keeps it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Me, Room, UserRef } from '@mycel/shared/api'
import { LOCALES, translate, useLocaleStore } from '../../src/i18n'
import { RoomComposer } from '../../src/components/rooms/RoomComposer'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import { MENTION_ALL_WORDS } from '../../src/components/rooms/useMentionMenu'
import { ALL_MENTION_ID, allMatches, allMentionNames, mentionParts, mentionsMe, mentionTokens, tokenMentions, tokenMentionsAll } from '../../src/lib/rooms'
import { shouldRing, type RingInput } from '../../src/lib/roomSound'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { FakeElement, FakeEvent, installDom, mount as mountInDom, removeDom, type Mounted } from './dom-host'
import { BEN, CY, ME, message, room } from './rooms-fixtures'

const ko = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('ko', k, p)

describe('the words and the tokens (lib/rooms.ts)', () => {
  test('each language\'s word and Slack\'s find it; a person\'s name does not', () => {
    expect([...MENTION_ALL_WORDS].sort()).toEqual(['everyone', 'semua', 'todos', '전체', '全員'].sort())
    // the word each language's "@" list writes is one the server takes (ROOM_MENTION_ALL_WORDS)
    for (const l of LOCALES) expect({ l: l.id, known: MENTION_ALL_WORDS.includes(translate(l.id, 'rooms.mentionAll')) }).toEqual({ l: l.id, known: true })
    for (const q of ['', '전', '전체', 'all', 'AL', 'channel', 'chan', 'every', 'everyone', 'Everyone', '全員', 'todos', 'semua']) expect({ q, hit: allMatches(q, MENTION_ALL_WORDS) }).toEqual({ q, hit: true })
    for (const q of ['Ben', 'mia', '전체요', 'alle']) expect({ q, hit: allMatches(q, MENTION_ALL_WORDS) }).toEqual({ q, hit: false })
  })

  test('a picked "@전체" is a token of its own kind and goes as the flag, never as a person', () => {
    const picked = [{ start: 0, end: 3, id: ALL_MENTION_ID, name: '전체' }, { start: 4, end: 8, id: BEN.id, name: BEN.name }]
    const tokens = mentionTokens('@전체 @Ben 봐요', picked, true)
    expect(tokens).toEqual([{ start: 0, end: 3, kind: 'all', id: ALL_MENTION_ID }, { start: 4, end: 8, kind: 'person', id: BEN.id }])
    expect(tokenMentions(tokens)).toEqual([BEN.id])
    expect(tokenMentionsAll(tokens)).toBe(true)
    // broken by an edit, or only typed: no flag
    expect(tokenMentionsAll(mentionTokens('@전채 봐요', picked.slice(0, 1), true))).toBe(false)
    expect(tokenMentionsAll(mentionTokens('@전체 봐요', [], true))).toBe(false)
  })

  test('a sent message: its "@전체" in any language stands out; it mentions everyone but its sender', () => {
    const m = { mentions: [], mentionsAll: true, author: BEN }
    expect(mentionParts('@everyone 3pm', allMentionNames(m, MENTION_ALL_WORDS))).toEqual([{ text: '@everyone', userId: ALL_MENTION_ID }, { text: ' 3pm' }])
    expect(mentionParts('@전체 3시', allMentionNames({ mentionsAll: false }, MENTION_ALL_WORDS))).toEqual([{ text: '@전체 3시' }])
    expect(mentionsMe(m, ME.id)).toBe(true)
    expect(mentionsMe(m, BEN.id)).toBe(false)
    expect(mentionsMe({ mentions: [ME.id], author: BEN }, ME.id)).toBe(true)
    expect(mentionsMe({ mentions: [], author: BEN }, ME.id)).toBe(false)
  })
})

describe('the sound', () => {
  const ring = (o: Omit<Partial<RingInput>, 'message'> & { message?: Partial<RingInput['message']> } = {}): boolean => shouldRing({
    roomId: 'r', room: { kind: 'team', muted: false }, meId: ME.id, replay: false, seen: false, viewing: null, ...o,
    message: { ...message({ roomId: '019a5f00-0000-7000-8000-00000000a001', seq: 1 }), ...o.message },
  } as RingInput)
  test('"@전체" from someone else rings where a mention would (a team room by default, 멘션만); not my own, not 끄기, not in quiet hours', () => {
    expect(ring()).toBe(false)
    expect(ring({ message: { mentionsAll: true } })).toBe(true)
    expect(ring({ room: { kind: 'all', muted: false, notify: { own: 'mentions', byDefault: 'mentions', level: 'mentions' } }, message: { mentionsAll: true } })).toBe(true)
    expect(ring({ message: { mentionsAll: true, author: ME } })).toBe(false)
    expect(ring({ room: { kind: 'team', muted: false, notify: { own: 'off', byDefault: 'mentions', level: 'off' } }, message: { mentionsAll: true } })).toBe(false)
    const quiet = { threadReplies: true, quietHours: { on: true, start: '00:00', end: '23:59', weekends: true }, timeZone: 'UTC' }
    expect(ring({ alerts: quiet, message: { mentionsAll: true } })).toBe(false)
  })
})

// ---------------- the box ----------------
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const realFetch = globalThis.fetch
let sent: { body: string; mentions: string[]; mentionsAll?: boolean }[] = []
const live = new Set<Mounted>()
/** a wait for something the page does (never a fixed time), well inside each test's own time (DOM_TEST_MS) */
const WAIT = 4000
/** each DOM test's time: a full suite on a loaded CI machine renders slowly; bun's default (5 s) is no budget for that */
const DOM_TEST_MS = 20_000

beforeAll(() => { installDom() })
beforeEach(() => { useLocaleStore.setState({ locale: 'ko' }) })
afterEach(async () => {
  for (const m of [...live].reverse()) await m.unmount()
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useRooms.getState().reset()
  useLocaleStore.setState({ locale })
})
afterAll(() => { removeDom() })

async function mount(ui: Parameters<typeof mountInDom>[0]): Promise<Mounted> {
  const m = await mountInDom(ui)
  live.add(m)
  const unmount = m.unmount
  m.unmount = async () => {
    if (!live.delete(m)) return
    await unmount()
  }
  return m
}
const setValue = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'value')!.set!
type Box = FakeElement & { value: string; selectionStart: number; selectionEnd: number }

/** the box of a room of this kind with these members, me signed in with this role */
async function open(o: { kind?: Room['kind']; role?: 'owner' | 'admin' | 'member'; members?: UserRef[] } = {}) {
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name, role: o.role ?? 'member' } } as unknown as Me } })
  const members = o.members ?? [ME, BEN, CY]
  const r = room({ kind: o.kind ?? 'team', ...(o.kind === 'dm' || o.kind === 'all' || o.kind === 'group' ? { groupId: null, name: null } : {}), memberCount: members.length })
  sent = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://team.localhost').pathname
    if (init?.method === 'POST' && path === `/api/rooms/${r.id}/messages`) {
      const b = JSON.parse(String(init.body))
      sent.push(b)
      return new Response(JSON.stringify(message({ roomId: r.id, seq: 9, author: ME, body: b.body, mentions: b.mentions, ...(b.mentionsAll ? { mentionsAll: true } : {}) })), { status: 201, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id })
  const m = await mount(<RoomComposer roomId={r.id} members={members} meId={ME.id} onSent={() => {}} />)
  const box = m.get('room-input') as Box
  await act(async () => {
    box.focus()
    box.dispatchEvent(new FakeEvent('focusin', { bubbles: true }))
  })
  return { m, box }
}
async function typeText(box: Box, s: string, inputType = 'insertText') {
  await act(async () => {
    const at = box.selectionEnd ?? box.value.length
    box.setSelectionRange(at, at)
    const b = Object.assign(new FakeEvent('beforeinput', { bubbles: true, cancelable: true }), { inputType })
    box.dispatchEvent(b)
    setValue.call(box, box.value.slice(0, at) + s + box.value.slice(at))
    box.setSelectionRange(at + s.length, at + s.length)
    box.dispatchEvent(new FakeEvent('input', { bubbles: true }))
    box.dispatchEvent(new FakeEvent('keyup', { bubbles: true }))
  })
}
async function key(box: Box, k: string) {
  let ok = true
  await act(async () => { ok = box.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: k })) })
  return ok
}
/** the rows of the "@" list: "all:…", "ai:…" or a person's (the avatar's letter, then the name) */
const rows = (m: Mounted) => (m.find('mention-menu')?.querySelectorAll('[data-testid="mention-option"]') ?? []).map((b) => (b.hasAttribute('data-all') ? 'all:' : b.hasAttribute('data-ai') ? 'ai:' : '') + b.textContent)
const tokens = (m: Mounted) => m.get('token-layer').querySelectorAll('[data-token]').map((el) => `${el.getAttribute('data-token')}:${el.textContent}`)
/** what the layer over the box draws: the text the box's state holds */
const layer = (m: Mounted) => m.get('token-layer').textContent.replace(/\u200b$/, '')
/** A message's edit form, opened as a mouse does it (its ⋯ menu, then 수정), each step waiting for what the page shows,
 * never for time; the box is used once React has put the message's text in it. */
async function openEdit(m: Mounted, text: string): Promise<Box> {
  await m.click('message-more')
  await m.until(() => m.find('message-edit'), 'the message menu', WAIT)
  await m.click('message-edit')
  const box = (await m.until(() => m.find('room-edit-input'), 'the edit form', WAIT)) as Box
  await act(async () => { box.focus(); box.dispatchEvent(new FakeEvent('focusin', { bubbles: true })) })
  await m.until(() => box.value === text && layer(m) === text, 'the message text in the edit box', WAIT)
  return box
}
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `사람${i + 1}` }))

test('the row right under the AI: its word and how many it notifies; found by any word, not by a person\'s name', async () => {
  const { m, box } = await open()
  await typeText(box, '@')
  await m.until(() => m.find('mention-menu'), 'the @ list', WAIT)
  expect(rows(m)).toEqual([`ai:${ko('rooms.aiName')}${ko('rooms.aiMention')}`, `all:전체${ko('rooms.mentionAllHint', { n: 2 })}`, 'BBen', 'CCy Park'])
  expect(ko('rooms.mentionAllHint', { n: 2 })).toBe('이 방의 2명에게 알림')
  for (const q of ['all', 'channel', 'everyone', '전체']) {
    await act(async () => { setValue.call(box, ''); box.setSelectionRange(0, 0); box.dispatchEvent(new FakeEvent('input', { bubbles: true })); box.dispatchEvent(new FakeEvent('keyup', { bubbles: true })) })
    await typeText(box, '@' + q)
    await m.until(() => m.find('mention-menu'), `the @ list for ${q}`, WAIT)
    expect({ q, rows: rows(m).filter((r) => r.startsWith('all:')).length }).toEqual({ q, rows: 1 })
  }
  await act(async () => { setValue.call(box, ''); box.setSelectionRange(0, 0); box.dispatchEvent(new FakeEvent('input', { bubbles: true })); box.dispatchEvent(new FakeEvent('keyup', { bubbles: true })) })
  await typeText(box, '@Be')
  await m.until(() => m.find('mention-menu'), 'the @ list for Be', WAIT)
  expect(rows(m)).toEqual(['BBen'])
}, DOM_TEST_MS)

test('once something is typed it comes after the people it fits: "@전" and Enter picks 전지현, not everyone', async () => {
  const { m, box } = await open({ members: [ME, BEN, { id: 'jh', name: '전지현' }] })
  await typeText(box, '@전')
  await m.until(() => m.find('mention-menu'), 'the @ list', WAIT)
  expect(rows(m)).toEqual(['전전지현', `all:전체${ko('rooms.mentionAllHint', { n: 2 })}`])
  await key(box, 'Enter')
  await m.settle()
  expect(box.value).toBe('@전지현 ')
  expect(tokens(m)).toEqual(['person:@전지현'])
}, DOM_TEST_MS)

test('a send the server gave back keeps its "@전체" as a token', async () => {
  const { m } = await open()
  const roomId = useRooms.getState().rooms[0]!.id
  await act(async () => {
    useRooms.setState({ returned: { [roomId]: { clientMessageId: 'c-1', body: '@전체 다시', mentions: [], mentionsAll: true, files: [], threadRootId: null, alsoInRoom: false, state: 'failed', createdAt: new Date().toISOString() } } })
  })
  await m.until(() => tokens(m).length > 0, 'the token back', WAIT)
  expect(tokens(m)).toEqual(['all:@전체'])
}, DOM_TEST_MS)

test('picked it is a token and the message goes with mentionsAll; pasted it is text and goes without', async () => {
  const { m, box } = await open()
  await typeText(box, '@전')
  await m.until(() => rows(m)[0]?.startsWith('all:'), 'the row', WAIT)
  expect(await key(box, 'Enter')).toBe(false)
  await m.settle()
  expect(box.value).toBe('@전체 ')
  expect(tokens(m)).toEqual(['all:@전체'])
  // right after it the list stays closed
  expect(m.find('mention-menu')).toBeNull()
  await typeText(box, '3시에 회의해요')
  await m.click('room-send')
  await m.until(() => sent.length > 0, 'the send', WAIT)
  expect(sent[0]).toMatchObject({ body: '@전체 3시에 회의해요', mentions: [], mentionsAll: true })
  // pasted: plain, no flag
  await typeText(box, '@전체 붙여 넣은 글', 'insertFromPaste')
  expect(tokens(m)).toEqual([])
  await m.click('room-send')
  await m.until(() => sent.length > 1, 'the second send', WAIT)
  expect(sent[1]!.mentionsAll).toBeUndefined()
}, DOM_TEST_MS)

test('10 people or more: the send asks first, in one line in the box (취소 keeps the text; 보내기, Enter or the button send)', async () => {
  const members = [ME, ...people(11)]
  const { m, box } = await open({ members })
  const pickAll = async () => {
    await typeText(box, '@all')
    await m.until(() => rows(m)[0]?.startsWith('all:'), 'the row', WAIT)
    await key(box, 'Enter')
    await m.settle()
    await typeText(box, '공지')
  }
  await pickAll()
  await m.click('room-send')
  expect(sent).toEqual([])
  expect(m.get('room-mention-all-confirm').textContent).toContain(ko('rooms.mentionAllConfirm', { n: 11 }))
  expect(ko('rooms.mentionAllConfirm', { n: 11 })).toBe('11명에게 알림이 가요. 보낼까요?')
  await m.click('room-mention-all-cancel')
  expect(m.find('room-mention-all-confirm')).toBeNull()
  expect(box.value).toBe('@전체 공지')
  // asked again: 보내기 sends
  await m.click('room-send')
  await m.click('room-mention-all-send')
  await m.until(() => sent.length === 1, 'the send', WAIT)
  expect(sent[0]).toMatchObject({ mentionsAll: true })
  expect(m.find('room-mention-all-confirm')).toBeNull()
  // Enter asks, Enter again answers 보내기; Esc puts the question away
  await pickAll()
  expect(await key(box, 'Enter')).toBe(false)
  expect(m.find('room-mention-all-confirm')).not.toBeNull()
  expect(await key(box, 'Escape')).toBe(false)
  expect(m.find('room-mention-all-confirm')).toBeNull()
  await key(box, 'Enter')
  await key(box, 'Enter')
  await m.until(() => sent.length === 2, 'the second send', WAIT)
  // without "@전체" nothing is asked
  await typeText(box, '그냥 글')
  await m.click('room-send')
  await m.until(() => sent.length === 3, 'a plain send', WAIT)
}, DOM_TEST_MS)

test('fewer than 10: no question', async () => {
  const { m, box } = await open({ members: [ME, ...people(8)] })
  await typeText(box, '@전체')
  await m.until(() => rows(m)[0]?.startsWith('all:'), 'the row', WAIT)
  await key(box, 'Enter')
  await m.settle()
  await m.click('room-send')
  await m.until(() => sent.length === 1, 'the send', WAIT)
  expect(m.find('room-mention-all-confirm')).toBeNull()
}, DOM_TEST_MS)

test('a DM has no row; the everyone room has it for owners and admins only', async () => {
  const shown = async (o: Parameters<typeof open>[0]) => {
    const { m, box } = await open(o)
    await typeText(box, '@')
    await m.until(() => m.find('mention-menu'), 'the @ list', WAIT)
    const has = rows(m).some((r) => r.startsWith('all:'))
    await m.unmount()
    return has
  }
  expect(await shown({ kind: 'dm', members: [ME, BEN] })).toBe(false)
  expect(await shown({ kind: 'all', role: 'member' })).toBe(false)
  expect(await shown({ kind: 'all', role: 'admin' })).toBe(true)
  expect(await shown({ kind: 'all', role: 'owner' })).toBe(true)
  expect(await shown({ kind: 'group', role: 'member' })).toBe(true)
}, DOM_TEST_MS)

test('a sent message: "@전체" stands out as a mention of me (not for its sender); the edit form keeps it', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name, role: 'member' } } as unknown as Me } })
  const r = room()
  const theirs = message({ roomId: r.id, seq: 1, author: BEN, body: '@everyone 3pm', mentionsAll: true })
  const html = renderToStaticMarkup(<RoomMessages roomId={r.id} messages={[theirs]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
  expect(html).toMatch(/<span class="font-medium text-accent-text rounded bg-accent-soft px-0.5" data-mention="all">@everyone<\/span>/)
  const mine = message({ roomId: r.id, seq: 2, author: ME, body: '@전체 회의', mentionsAll: true })
  const own = renderToStaticMarkup(<RoomMessages roomId={r.id} messages={[mine]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
  expect(own).toMatch(/<span class="font-medium text-accent-text" data-mention="all">@전체<\/span>/)
  // the edit form: the token is there, and the edit keeps the flag
  useRooms.setState({ rooms: [r], loaded: true })
  const patches: { body: string; mentions: string[]; mentionsAll?: boolean }[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const b = JSON.parse(String(init!.body))
    patches.push(b)
    return new Response(JSON.stringify({ ...mine, body: b.body, mentionsAll: b.mentionsAll }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const m = await mount(<RoomMessages roomId={r.id} messages={[mine]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
  const box = await openEdit(m, '@전체 회의')
  expect(tokens(m)).toEqual(['all:@전체'])
  Object.assign(box, { selectionStart: box.value.length, selectionEnd: box.value.length })
  await typeText(box, ' 3시')
  await m.until(() => box.value === '@전체 회의 3시' && layer(m) === '@전체 회의 3시', 'the typed text in the form', WAIT)
  await m.click('room-edit-save')
  await m.until(() => patches.length > 0, 'the edit', WAIT)
  expect(patches[0]).toEqual({ body: '@전체 회의 3시', mentions: [], mentionsAll: true })
  await m.unmount()
  // a message without it: the edit form offers no "@전체" (an edit notifies nobody, so it cannot add one)
  const plain = message({ roomId: r.id, seq: 3, author: ME, body: '회의' })
  const m2 = await mount(<RoomMessages roomId={r.id} messages={[plain]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
  const box2 = await openEdit(m2, '회의')
  Object.assign(box2, { selectionStart: box2.value.length, selectionEnd: box2.value.length })
  await typeText(box2, ' @')
  await m2.until(() => m2.find('mention-menu'), 'the @ list', WAIT)
  expect(rows(m2).some((x) => x.startsWith('all:'))).toBe(false)
}, DOM_TEST_MS)
