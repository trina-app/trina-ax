// "대화방에 보내기" (components/chat/ShareToRoom.tsx, shared/src/api/chats.ts shareAnswerToRoom): the button under a
// finished answer only; the picker's rooms as the "#" list shows them (a 1:1 chat as "<name> · 1:1", the member count for
// the others), filtered as I type, the arrow keys and Enter; the note; the notice that a long answer is cut; the server's
// "confirm": a row per linked file (everyone can open it, how many cannot, nobody else can; the files I cannot open only
// counted), the 첨부 switches (on by default, their captions, at most 10), the provenance line, the primary button's words
// and focus, the note shown; the send again with the same id, the confirmKey and the files switched on; asked again, said
// so; 취소, ✕ and Esc back to the list with the room and the note; never in a confidential chat; sent: a toast with 열기
// (and the number of files) and the message in the room once. In the room (components/rooms/RoomMessages.tsx) such a
// message is my note, then the answer as a quote headed "<AI> 답변" in Markdown, a team file as a link where I may open it
// and its name with a lock where I may not, and no edit.
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

const files = {
  open: { name: 'glossary.md', path: 'shared/glossary.md', missing: false, attach: 'no', unable: 0 },
  some: { name: 'plan.md', path: 'acme/plan.md', missing: false, attach: 'yes', unable: 2 },
  mine: { name: 'quote.xlsx', path: 'users/me/quote.xlsx', missing: false, attach: 'yes', unable: 5 },
  big: { name: 'video.mov', path: 'users/me/video.mov', missing: false, attach: 'too_big', unable: 5 },
  hidden: { name: '', missing: true, attach: 'hidden', unable: 5 },
} as const
const confirm = (o: Record<string, unknown> = {}) => ({ status: 'confirm', people: 5, places: [], otherPlaces: false, files: [], provenance: null, confirmKey: 'key-1', ...o })
const rowTexts = (m: Awaited<ReturnType<typeof mount>>) => m.container.ownerDocument!.body.querySelectorAll('[data-testid="share-room-file"]').map((r) => r.textContent)
const switches = (m: Awaited<ReturnType<typeof mount>>) => m.container.ownerDocument!.body.querySelectorAll('[data-testid="share-room-attach"]') as unknown as (FakeElement & { checked: boolean })[]
/** a click on a checkbox turns it over before its handlers run (the browser's own step, which the fake DOM leaves out) */
const tick = async (m: Awaited<ReturnType<typeof mount>>, box: FakeElement) => {
  const checked = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'checked')!
  checked.set!.call(box, !checked.get!.call(box))
  await m.click(box)
}
/** the dialog with `team` (6 people: 5 others) picked and a note, sent once: the confirm step is on screen */
async function toConfirm(onClose = () => {}) {
  const m = await mount(<ShareToRoom chatId={CHAT} messageId={uuidv7()} answer="Here is the plan" onClose={onClose} />)
  await m.click(m.container.ownerDocument!.body.querySelector(`[data-room-id="${team.id}"]`)!)
  await m.type('share-room-note', 'For Monday')
  await m.click('share-room-send')
  await m.until(() => m.find('share-room-confirm'), 'the confirm step')
  return m
}

test('"confirm": a row per linked file, the files I cannot open only counted, the switches on, the note shown, the primary button focused', async () => {
  serve()
  signIn()
  answers = [{ body: confirm({ files: [files.open, files.some, files.mine, files.big, files.hidden, files.hidden] }) }]
  useRooms.setState({ rooms: [team], loaded: true })
  const m = await toConfirm()
  try {
    expect(m.get('share-room-to').textContent).toContain('Marketing')
    expect(m.get('share-room-confirm-note').textContent).toBe('“For Monday”')
    expect(m.find('share-room-again')).toBeNull()
    expect(m.html()).toContain(en('shareRoom.filesHead'))
    // everyone / some / nobody else; switched on: who more will see it; too big: why not; the hidden ones only counted
    expect(rowTexts(m)).toEqual([
      `glossary.md${en('shareRoom.fileAll')}`,
      `plan.md${en('shareRoom.fileSome', { n: 2 })} · ${en('shareRoom.attachWiden', { n: 2 })}${en('shareRoom.attach')}`,
      `quote.xlsx${en('shareRoom.fileNoOne')} · ${en('shareRoom.attachWiden', { n: 5 })}${en('shareRoom.attach')}`,
      `video.mov${en('shareRoom.fileNoOne')} · ${en('shareRoom.tooBig')}`,
    ])
    expect(m.get('share-room-hidden').textContent).toBe(en('shareRoom.hidden', { n: 2 }))
    expect(switches(m).map((x) => x.checked)).toEqual([true, true])
    // the primary button says it attaches and has the focus; 취소 is the other one
    expect(m.get('share-room-confirm-send').textContent).toBe(en('shareRoom.sendAttached'))
    expect(m.container.ownerDocument!.activeElement).toBe(m.get('share-room-confirm-send'))
    expect(m.get('share-room-back').textContent).toBe(en('common.cancel'))
    expect(m.find('share-room-provenance')).toBeNull()
    // one switch off: its caption says the link alone goes; both off: 보내기
    await tick(m, switches(m)[0]!)
    expect(rowTexts(m)[1]).toBe(`plan.md${en('shareRoom.fileSome', { n: 2 })} · ${en('shareRoom.linkOnly')}${en('shareRoom.attach')}`)
    expect(m.get('share-room-confirm-send').textContent).toBe(en('shareRoom.sendAttached'))
    await tick(m, switches(m)[1]!)
    expect(m.get('share-room-confirm-send').textContent).toBe(en('shareRoom.send'))
  } finally {
    await m.unmount()
  }
})

test('the provenance line alone: 보내기 is the focused default; places named, none named, or not all known', async () => {
  serve()
  signIn()
  useRooms.setState({ rooms: [team], loaded: true })
  const line = async (provenance: Record<string, unknown>) => {
    answers = [{ body: confirm({ provenance }) }]
    const m = await toConfirm()
    try {
      expect(m.find('share-room-files')).toBeNull()
      expect(m.get('share-room-confirm-send').textContent).toBe(en('shareRoom.send'))
      expect(m.container.ownerDocument!.activeElement).toBe(m.get('share-room-confirm-send'))
      return m.get('share-room-provenance').textContent
    } finally {
      await m.unmount()
    }
  }
  const places = [{ kind: 'folder', path: 'finance' }, { kind: 'folder', path: '' }, { kind: 'mine' }, { kind: 'service', name: 'Google Drive' }, { kind: 'room', name: 'Sales' }, { kind: 'room', name: '' }, { kind: 'conversation' }]
  expect(await line({ people: 3, places, otherPlaces: true })).toBe(en('shareRoom.provenance', {
    n: 3,
    places: ['finance/', en('rooms.aiRootFolder'), en('shareRoom.placeMine'), 'Google Drive', en('shareRoom.placeRoom', { name: 'Sales' }), en('shareRoom.placeRoom', { name: en('rooms.all') }), en('shareRoom.placeConversation')].join(', '),
  }))
  expect(await line({ people: 2, places: [], otherPlaces: true })).toBe(en('shareRoom.provenanceNoPlace', { n: 2 }))
  expect(await line({ people: 5, places: [], otherPlaces: true, unknown: true })).toBe(en('shareRoom.unknown'))
})

test('at most 10 files switched on: the first 10 start on, the others wait until one is turned off', async () => {
  serve()
  signIn()
  const many = Array.from({ length: 12 }, (_, i) => ({ ...files.mine, name: `f${i}.md`, path: `users/me/f${i}.md` }))
  answers = [{ body: confirm({ files: many }) }]
  useRooms.setState({ rooms: [team], loaded: true })
  const m = await toConfirm()
  try {
    expect(switches(m).map((x) => x.checked)).toEqual([...Array(10).fill(true), false, false])
    expect(switches(m).map((x) => x.hasAttribute('disabled'))).toEqual([...Array(10).fill(false), true, true])
    await tick(m, switches(m)[0]!)
    expect(switches(m)[10]!.hasAttribute('disabled')).toBe(false)
  } finally {
    await m.unmount()
  }
})

test('the send again carries the key and the files switched on, with the same id; asked again: said so, my choice kept', async () => {
  serve()
  signIn()
  const sent = sharedMessage({ files: [{ id: uuidv7(), name: 'quote.xlsx', size: 10, mime: 'application/octet-stream', kind: 'other', thumb: false }] })
  answers = [
    { body: confirm({ files: [files.some, files.mine] }) },
    // someone joined meanwhile: asked again with a new key
    { body: confirm({ files: [files.some, { ...files.mine, unable: 6 }], confirmKey: 'key-2' }) },
    { body: { status: 'sent', message: sent, cut: false } },
  ]
  useRooms.setState({ rooms: [team], loaded: true, openRoomId: team.id, timeline: { roomId: team.id, messages: [], nextCursor: null, loading: false, error: null } })
  const went: string[] = []
  setNavigator((to) => went.push(to))
  let closed = 0
  const m = await toConfirm(() => closed++)
  try {
    await tick(m, switches(m)[0]!)
    await m.click('share-room-confirm-send')
    await m.until(() => m.find('share-room-again'), 'asked again')
    expect(m.get('share-room-again').textContent).toBe(en('shareRoom.askedAgain'))
    // plan.md stays off as I left it
    expect(switches(m).map((x) => x.checked)).toEqual([false, true])
    expect(m.container.ownerDocument!.activeElement).toBe(m.get('share-room-confirm-send'))
    await m.click('share-room-confirm-send')
    await m.until(() => closed === 1, 'the dialog closed')
    const [first, second, third] = shares()
    expect(first!.body!.confirmKey).toBeUndefined()
    expect(first!.body!.attach).toBeUndefined()
    expect(second!.body).toMatchObject({ roomId: team.id, note: 'For Monday', confirmKey: 'key-1', attach: ['users/me/quote.xlsx'] })
    expect(third!.body).toMatchObject({ roomId: team.id, note: 'For Monday', confirmKey: 'key-2', attach: ['users/me/quote.xlsx'] })
    for (const c of [second, third]) expect(c!.body!.clientMessageId).toBe(first!.body!.clientMessageId)
    for (const c of [first, second, third]) expect(c!.body!.confirm).toBeUndefined()
    // the toast says where and how many files went; 열기 opens the room
    const toast = useUi.getState().toasts.at(-1)!
    expect(toast).toMatchObject({ level: 'success', text: en('shareRoom.sentFiles', { room: 'Marketing', n: 1 }) })
    toast.action!.run()
    expect(went).toEqual([`/rooms/${team.id}`])
    // in the room once, also when the server's room.message for it comes to this window too
    expect(useRooms.getState().timeline!.messages.map((x) => x.id)).toEqual([sent.id])
    await act(async () => useRooms.getState().handleEvent({ type: 'room.message', data: { roomId: team.id, message: sent } } as never))
    expect(useRooms.getState().timeline!.messages.map((x) => x.id)).toEqual([sent.id])
  } finally {
    await m.unmount()
  }
})

test('a line that changed with my own choice of files is shown as it now reads, without "changed meanwhile"', async () => {
  serve()
  signIn()
  answers = [
    { body: confirm({ files: [files.mine] }) },
    { body: confirm({ files: [files.mine], provenance: { people: 5, places: [{ kind: 'mine' }], otherPlaces: false }, confirmKey: 'key-2', reason: 'choice' }) },
  ]
  useRooms.setState({ rooms: [team], loaded: true })
  const m = await toConfirm()
  try {
    await tick(m, switches(m)[0]!)
    await m.click('share-room-confirm-send')
    await m.until(() => m.find('share-room-provenance'), 'the line for my choice')
    expect(m.find('share-room-again')).toBeNull()
    expect(switches(m).map((x) => x.checked)).toEqual([false])
    expect(m.get('share-room-confirm-send').textContent).toBe(en('shareRoom.send'))
    expect(shares()[1]!.body).toMatchObject({ confirmKey: 'key-1', attach: [] })
  } finally {
    await m.unmount()
  }
})

test('취소, ✕ and Esc all go back to the list with the room and the note; ✕ and Esc on the list close it', async () => {
  serve()
  signIn()
  answers = [{ body: confirm({ files: [files.mine] }) }]
  useRooms.setState({ rooms: [team, dm], loaded: true })
  let closed = 0
  const m = await toConfirm(() => closed++)
  const body = () => m.container.ownerDocument!.body
  /** the open dialog's ✕ (one dialog at a time) */
  const closeButton = () => body().querySelectorAll('[aria-label="Close"]').find((b) => b.closest('[role="dialog"]'))!
  const backAtList = async (what: string) => {
    await m.until(() => m.find('share-room-list'), `the list after ${what}`)
    expect(m.find('share-room-confirm')).toBeNull()
    expect((m.get('share-room-note') as unknown as { value: string }).value).toBe('For Monday')
    expect(body().querySelector(`[data-room-id="${team.id}"]`)!.getAttribute('aria-selected')).toBe('true')
    expect(closed).toBe(0)
  }
  const again = async () => {
    await m.click('share-room-send')
    await m.until(() => m.find('share-room-confirm'), 'the confirm step again')
  }
  try {
    await m.click('share-room-back')
    await backAtList('취소')
    await again()
    await m.click(closeButton())
    await backAtList('✕')
    await again()
    await act(async () => { m.container.ownerDocument!.activeElement!.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })) })
    await backAtList('Esc')
    // on the list, ✕ closes the dialog
    await m.click(closeButton())
    expect(closed).toBe(1)
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

test('in the room: my note, then the answer as a quote headed "<AI> 답변" in Markdown; a file I may not open has a lock', () => {
  const html = renderToStaticMarkup(<RoomMessages roomId={team.id} messages={[sharedMessage({ author: BEN })]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
  // the note first, as plain text, then the quote
  expect(html.indexOf('For Monday')).toBeLessThan(html.indexOf('data-testid="room-shared-answer"'))
  expect(html.replace(/&#x27;/g, "'")).toContain(`${en('shareRoom.quoteHead', { ai: aiName((k) => en(k)) })}</figcaption>`)
  // Markdown: a list, a link to a file I may open; the other file's name after a lock, and why for a screen reader
  expect(html).toMatch(/<ul>\s*<li>first step<\/li>/)
  expect(html).toMatch(/data-testid="team-file-text"><svg[^]*?data-testid="team-file-lock"[^]*?<\/svg>budget<span class="sr-only"> \(Can(&#x27;|')t open: moved, deleted or no access\)<\/span><\/button>/)
  expect(html).not.toContain('finance%2Fbudget')
  // the note's text does not show the answer's Markdown, and the answer is not in the note's paragraph
  expect(html).not.toContain('- first step')
})

test('the lock says why on a tap or click (touch has no tooltip), and opens nothing', async () => {
  const m = await mount(<MemoryRouter><RoomMessages roomId={team.id} messages={[sharedMessage({ author: BEN })]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} /></MemoryRouter>)
  try {
    expect(m.get('team-file-text').getAttribute('type')).toBe('button')
    await m.click('team-file-text')
    expect(useUi.getState().toasts.at(-1)).toMatchObject({ level: 'info', text: en('rooms.fileNoAccess') })
  } finally {
    await m.unmount()
  }
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
