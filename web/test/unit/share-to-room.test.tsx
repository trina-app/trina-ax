// "대화방에 보내기" (components/chat/ShareToRoom.tsx, shared/src/api/chats.ts shareAnswerToRoom): the button under a
// finished answer only; the picker's rooms as the "#" list shows them (a 1:1 chat as "<name> · 1:1", the member count for
// the others), filtered as I type, the arrow keys and Enter; the note; the notice that a long answer is cut; the server's
// "confirm" (how many cannot open it, the places by name) and the send again with that count and the same id, asked again
// when more people cannot; never in a confidential chat; sent: a toast with 열기 and the message in the room once. In
// the room (components/rooms/RoomMessages.tsx) such a message is my note, then the answer as a quote headed "<AI> 답변" in
// Markdown, a team file only as a link where I may open it, and no edit.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ANSWER_NOTE_MAX, ROOM_MESSAGE_MAX, uuidv7, type Me, type RoomMessage } from '@mycel/shared/api'
import { AssistantMessage } from '../../src/components/chat/Messages'
import ShareToRoom from '../../src/components/chat/ShareToRoom'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import { translate, useLocaleStore } from '../../src/i18n'
import { setNavigator } from '../../src/lib/nav'
import { aiName } from '../../src/lib/tabs'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { FakeEvent, installDom, mount, removeDom, type FakeElement } from './dom-host'
import { CHAT, msg } from './fixtures'
import { at, BEN, CY, ME, message, room } from './rooms-fixtures'

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const realFetch = globalThis.fetch
let calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] = []
/** answers to POST …/share-to-room, in order (the last one repeats) */
let answers: { status?: number; body: unknown }[] = []

beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterEach(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useRooms.getState().reset()
  useUi.setState({ toasts: [] })
  setNavigator(null)
})
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })

function serve() {
  calls = []
  let n = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://team.localhost').pathname
    const method = init?.method ?? 'GET'
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const json = (body: unknown, s = 200) => new Response(JSON.stringify(body), { status: s, headers: { 'content-type': 'application/json' } })
    if (method === 'POST' && path.endsWith('/share-to-room')) {
      const a = answers[Math.min(n++, answers.length - 1)]!
      return json(a.body, a.status ?? 200)
    }
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as typeof fetch
}

const shares = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/share-to-room'))
const signIn = () => useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as unknown as Me } })
const key = (el: FakeElement, k: string) => act(async () => { el.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: k })) })

const team = room({ name: 'Marketing', memberCount: 6, activityAt: at(5) })
const dm = room({ kind: 'dm', name: null, groupId: null, memberCount: 2, peers: [BEN], activityAt: at(4) })
const group = room({ kind: 'group', name: 'Weekly sync', groupId: null, memberCount: 4, peers: [BEN, CY], activityAt: at(3) })
const everyone = room({ kind: 'all', name: null, groupId: null, memberCount: 14, activityAt: at(2) })

function sharedMessage(o: Partial<RoomMessage> = {}): RoomMessage {
  const note = 'For Monday'
  const answer = 'Here is the plan:\n\n- first step\n- second step\n\nSee [plan](/files/view?path=acme/plan.md) and [budget](/files/view?path=finance/budget.xlsx).'
  return message({ roomId: team.id, seq: 9, author: ME, body: `${note}\n\n${answer}`, sharedAnswer: { at: note.length + 2, cut: false }, openable: ['acme/plan.md'], ...o })
}

test('the button is under a finished answer only: not while it streams, not after an error or a stop, not without text', async () => {
  const answer = (o: Parameters<typeof msg>[0], shareable = true) => (
    <AssistantMessage m={msg(o)} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} shareable={shareable} />
  )
  const has = async (o: Parameters<typeof msg>[0], shareable = true) => {
    const m = await mount(<MemoryRouter>{answer(o, shareable)}</MemoryRouter>)
    try { return !!m.find('share-to-room') } finally { await m.unmount() }
  }
  expect(await has({ role: 'assistant', content: 'done answer', status: 'done' })).toBe(true)
  // a confidential chat (or one not known yet): the server would refuse it, so there is no button
  expect(await has({ role: 'assistant', content: 'done answer', status: 'done' }, false)).toBe(false)
  expect(await has({ role: 'assistant', content: 'half an answer', status: 'streaming' })).toBe(false)
  expect(await has({ role: 'assistant', content: 'cut short', status: 'error', error: { code: 'engine_unavailable', message: 'x' } })).toBe(false)
  expect(await has({ role: 'assistant', content: 'stopped here', status: 'stopped' })).toBe(false)
  expect(await has({ role: 'assistant', content: '', status: 'done' })).toBe(false)
  // an icon button with its name (and the shared tooltip): the dialog opens from it
  const m = await mount(<MemoryRouter>{answer({ role: 'assistant', content: 'done answer', status: 'done' })}</MemoryRouter>)
  try {
    expect(m.get('share-to-room').getAttribute('aria-label')).toBe(en('chat.shareToRoom'))
    useRooms.setState({ rooms: [team], loaded: true })
    await m.click('share-to-room')
    await m.until(() => m.find('share-room-list'), 'the picker')
    expect(m.html()).toContain(en('chat.shareToRoom'))
  } finally {
    await m.unmount()
  }
})

test('the picker lists my rooms like the "#" list (a 1:1 chat as "<name> · 1:1"), filters as I type; arrows and Enter pick', async () => {
  serve()
  useRooms.setState({ rooms: [team, dm, group, everyone], loaded: true })
  const m = await mount(<ShareToRoom chatId={CHAT} messageId={uuidv7()} answer="short" onClose={() => {}} />)
  try {
    const rows = () => m.container.ownerDocument!.body.querySelectorAll('[data-testid="share-room-option"]')
    // (a 1:1 chat's row starts with the person's picture: here the letter of a name without a photo)
    const texts = rows().map((r) => r.textContent)
    expect(texts).toEqual([
      `Marketing${en('rooms.members', { n: 6 })}`,
      `B${en('composer.roomDm', { name: 'Ben' })}`,
      `Weekly sync${en('rooms.members', { n: 4 })}`,
      `${en('rooms.all')}${en('rooms.members', { n: 14 })}`,
    ])
    // nothing picked yet: nothing to send
    expect(m.get('share-room-send').hasAttribute('disabled')).toBe(true)
    expect(m.get('share-room-note').getAttribute('maxlength')).toBe(String(ANSWER_NOTE_MAX))
    expect(m.get('share-room-note').getAttribute('placeholder')).toBe(en('shareRoom.note'))
    // a 1:1 chat is found by the person's name; a search with no room says so
    await m.type('share-room-search', 'ben')
    expect(rows().map((r) => r.getAttribute('data-room-id'))).toEqual([dm.id, group.id])
    await m.type('share-room-search', 'nobody here')
    expect(m.get('share-room-none').textContent).toBe(en('shareRoom.noMatch'))
    // arrows move the pick (the search keeps the focus), Enter takes it and goes on to the note
    await m.type('share-room-search', '')
    const search = m.get('share-room-search')
    await key(search, 'ArrowDown')
    await key(search, 'ArrowDown')
    expect(m.get('share-room-search').getAttribute('aria-activedescendant')).toBe(rows()[1]!.getAttribute('id'))
    expect(rows()[1]!.getAttribute('aria-selected')).toBe('true')
    await key(search, 'Enter')
    expect(m.container.ownerDocument!.activeElement).toBe(m.get('share-room-note'))
    expect(m.get('share-room-send').hasAttribute('disabled')).toBe(false)
    // a click picks another; a room the search hides is not picked any more
    await m.click(rows()[0]!)
    expect(rows()[0]!.getAttribute('aria-selected')).toBe('true')
    await m.type('share-room-search', 'weekly')
    expect(m.get('share-room-send').hasAttribute('disabled')).toBe(true)
  } finally {
    await m.unmount()
  }
})

test('the rooms are read when the list never was (a phone that never opened the sidebar)', async () => {
  serve()
  const m = await mount(<ShareToRoom chatId={CHAT} messageId={uuidv7()} answer="short" onClose={() => {}} />)
  try {
    await m.until(() => calls.some((c) => c.method === 'GET' && c.path === '/api/rooms'), 'the rooms read')
    await m.settle()
  } finally {
    await m.unmount()
  }
})

test('an answer too long for one room message is said to be cut before it is sent, counting the note', async () => {
  serve()
  useRooms.setState({ rooms: [team], loaded: true })
  const long = 'x'.repeat(ROOM_MESSAGE_MAX - 10)
  const m = await mount(<ShareToRoom chatId={CHAT} messageId={uuidv7()} answer={long} onClose={() => {}} />)
  try {
    expect(m.find('share-room-cut')).toBeNull()
    await m.type('share-room-note', 'a note that makes it too long')
    expect(m.get('share-room-cut').textContent).toBe(en('shareRoom.cut', { history: en('sidebar.aiChats', { name: aiName((k) => en(k)) }) }))
  } finally {
    await m.unmount()
  }
})

test('"confirm": how many cannot open it and the places by name; 그래도 보내기 sends that count with the same id, more people ask again', async () => {
  serve()
  signIn()
  const sent = sharedMessage()
  answers = [
    {
      body: {
        status: 'confirm', people: 2, otherPlaces: true,
        places: [{ kind: 'folder', path: 'finance' }, { kind: 'folder', path: '' }, { kind: 'mine' }, { kind: 'service', name: 'Google Drive' }, { kind: 'room', name: 'Sales' }, { kind: 'room', name: '' }, { kind: 'conversation' }],
      },
    },
    { body: { status: 'confirm', people: 2, otherPlaces: false, places: [{ kind: 'folder', path: 'finance' }] } },
    // someone joined meanwhile: three people now, asked again
    { body: { status: 'confirm', people: 3, otherPlaces: false, places: [{ kind: 'folder', path: 'finance' }] } },
    { body: { status: 'sent', message: sent, cut: false } },
  ]
  // the room is open in this window: the message takes its place there once
  useRooms.setState({ rooms: [team, dm], loaded: true, openRoomId: team.id, timeline: { roomId: team.id, messages: [], nextCursor: null, loading: false, error: null } })
  const went: string[] = []
  setNavigator((to) => went.push(to))
  let closed = 0
  const answerId = uuidv7()
  const m = await mount(<ShareToRoom chatId={CHAT} messageId={answerId} answer="Here is the plan" onClose={() => closed++} />)
  try {
    await m.click(m.container.ownerDocument!.body.querySelector(`[data-room-id="${team.id}"]`)!)
    await m.type('share-room-note', '  For\nMonday  ')
    // Enter in the note sends
    await key(m.get('share-room-note'), 'Enter')
    await m.until(() => m.find('share-room-confirm'), 'the confirm step')
    expect(shares()[0]!.path).toBe(`/api/chats/${CHAT}/messages/${answerId}/share-to-room`)
    expect(shares()[0]!.body).toMatchObject({ roomId: team.id, note: 'For Monday' })
    expect(shares()[0]!.body!.confirm).toBeUndefined()
    expect(m.get('share-room-to').textContent).toContain('Marketing')
    expect(m.get('share-room-people').textContent).toBe(en('shareRoom.confirm', { n: 2 }))
    const places = [...m.container.ownerDocument!.body.querySelectorAll('[data-testid="share-room-place"]')].map((x) => x.textContent)
    expect(places).toEqual([
      'finance/', en('rooms.aiRootFolder'), en('shareRoom.placeMine'), 'Google Drive', en('shareRoom.placeRoom', { name: 'Sales' }),
      en('shareRoom.placeRoom', { name: en('rooms.all') }), en('shareRoom.placeConversation'), en('shareRoom.placeOther'),
    ])
    // 취소 goes back to the list with the room and the note as they were
    await m.click('share-room-back')
    expect((m.get('share-room-note') as unknown as { value: string }).value).toBe('  For\nMonday  ')
    expect(m.container.ownerDocument!.body.querySelector(`[data-room-id="${team.id}"]`)!.getAttribute('aria-selected')).toBe('true')
    await m.click('share-room-send')
    await m.until(() => m.find('share-room-confirm'), 'the confirm step again')
    await m.click('share-room-anyway')
    await m.until(() => m.find('share-room-people')?.textContent === en('shareRoom.confirm', { n: 3 }), 'the confirm step with three people')
    expect(closed).toBe(0)
    await m.click('share-room-anyway')
    await m.until(() => closed === 1, 'the dialog closed')
    const [first, second, third, fourth] = shares()
    expect(second!.body!.confirm).toBeUndefined()
    // the count I said yes to, each time
    expect(third!.body).toMatchObject({ roomId: team.id, note: 'For Monday', confirm: 2 })
    expect(fourth!.body).toMatchObject({ roomId: team.id, note: 'For Monday', confirm: 3 })
    // one id for one room and note: the server gives back the first message if this one is sent again
    for (const c of [second, third, fourth]) expect(c!.body!.clientMessageId).toBe(first!.body!.clientMessageId)
    // the toast says where, and 열기 opens the room
    const toast = useUi.getState().toasts.at(-1)!
    expect(toast).toMatchObject({ level: 'success', text: en('shareRoom.sent', { room: 'Marketing' }) })
    expect(toast.action!.label).toBe(en('shareRoom.open'))
    toast.action!.run()
    expect(went).toEqual([`/rooms/${team.id}`])
    // in the room once, also when the server's room.message for it comes to this window too
    expect(useRooms.getState().timeline!.messages.map((x) => x.id)).toEqual([sent.id])
    await act(async () => useRooms.getState().handleEvent({ type: 'room.message', data: { roomId: team.id, message: sent } } as never))
    expect(useRooms.getState().timeline!.messages.map((x) => x.id)).toEqual([sent.id])
    expect(useRooms.getState().rooms.find((r) => r.id === team.id)!.lastMessage!.id).toBe(sent.id)
  } finally {
    await m.unmount()
  }
})

test('a refusal (too many messages, a room I left) is a toast in my language; the dialog stays to try again', async () => {
  serve()
  answers = [{ status: 429, body: { error: { code: 'rate_limited', message: 'Too many messages. Wait a moment.' } } }]
  useRooms.setState({ rooms: [team], loaded: true })
  let closed = 0
  const m = await mount(<ShareToRoom chatId={CHAT} messageId={uuidv7()} answer="short" onClose={() => closed++} />)
  try {
    await m.click(m.container.ownerDocument!.body.querySelector(`[data-room-id="${team.id}"]`)!)
    await m.click('share-room-send')
    await m.until(() => useUi.getState().toasts.length > 0, 'the toast')
    expect(useUi.getState().toasts.at(-1)).toMatchObject({ level: 'error', text: 'Too many messages. Wait a moment.' })
    expect(closed).toBe(0)
    expect(m.get('share-room-send').hasAttribute('disabled')).toBe(false)
  } finally {
    await m.unmount()
  }
})

test('in the room: my note, then the answer as a quote headed "<AI> 답변" in Markdown; a file I may not open is text', () => {
  const html = renderToStaticMarkup(<RoomMessages roomId={team.id} messages={[sharedMessage({ author: BEN })]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
  // the note first, as plain text, then the quote
  expect(html.indexOf('For Monday')).toBeLessThan(html.indexOf('data-testid="room-shared-answer"'))
  expect(html.replace(/&#x27;/g, "'")).toContain(`${en('shareRoom.quoteHead', { ai: aiName((k) => en(k)) })}</figcaption>`)
  // Markdown: a list, a link to a file I may open; the other file's name only as text
  expect(html).toMatch(/<ul>\s*<li>first step<\/li>/)
  expect(html).toContain('data-testid="team-file-text">budget<')
  expect(html).not.toContain('finance%2Fbudget')
  // the note's text does not show the answer's Markdown, and the answer is not in the note's paragraph
  expect(html).not.toContain('- first step')
})

test('my shared answer can be copied and deleted, never edited', async () => {
  const m = await mount(<RoomMessages roomId={team.id} messages={[sharedMessage()]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
  try {
    const press = (type: string) => m.get('room-message').dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', clientX: 10, clientY: 10 }))
    press('pointerdown')
    await m.settle(700)
    expect(['message-copy', 'message-delete', 'message-edit'].map((id) => !!m.find(id))).toEqual([true, true, false])
  } finally {
    await m.unmount()
  }
  // a plain message of mine keeps its edit
  const plain = await mount(<RoomMessages roomId={team.id} messages={[message({ roomId: team.id, seq: 1, author: ME, body: 'mine' })]} pending={[]} meId={ME.id} members={[ME, BEN]} onThread={() => {}} />)
  try {
    plain.get('room-message').dispatchEvent(Object.assign(new FakeEvent('pointerdown', { bubbles: true, cancelable: true }), { pointerType: 'touch', clientX: 10, clientY: 10 }))
    await plain.settle(700)
    expect(!!plain.find('message-edit')).toBe(true)
  } finally {
    await plain.unmount()
  }
})
