// How a room's messages are shown (components/rooms/RoomMessages.tsx): another member's words in Markdown (never
// HTML; QA TC-072), the @names they mention stand out, no read count anywhere, deleted and edited messages say so, one avatar and
// name per run of one author, a root's thread line, reactions, and a reply sent to the room too.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { translate } from '../../src/i18n'
import { ANSWER_QUOTES, RoomMessages, sameTimeAsAbove } from '../../src/components/rooms/RoomMessages'
import { groupRuns } from '../../src/lib/rooms'
import { useRooms } from '../../src/store/rooms'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'
import { at, BEN, CY, ME, message } from './rooms-fixtures'
import { uuidv7 } from '@mycel/shared/api'

const R = uuidv7()
const render = (ms: ReturnType<typeof message>[]) => renderToStaticMarkup(<RoomMessages roomId={R} messages={ms} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
const count = (html: string, s: string) => html.split(s).length - 1

test("another member's text: HTML is escaped, line breaks kept, mentions marked (Markdown: QA TC-072)", () => {
  const html = render([message({ roomId: R, seq: 1, body: '<img src=x onerror=alert(1)>\n@Cy Park look', mentions: [CY.id] })])
  expect(html).not.toContain('<img src=x')
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;<br/>')
  expect(html).toContain('data-testid="message-markdown"')
  expect(html).toMatch(/<span class="font-medium text-accent-text">@Cy Park<\/span>/)
})

test('no read count on any message; deleted and edited messages say so', () => {
  const html = render([
    message({ roomId: R, seq: 1, body: 'one' }),
    message({ roomId: R, seq: 2, body: 'two', authorKind: 'ai', author: null, askedBy: BEN }),
    message({ roomId: R, seq: 3, body: 'fixed', editedAt: at(4) }),
    message({ roomId: R, seq: 4, body: '', deletedAt: at(5) }),
  ])
  expect(html).not.toContain('message-unread')
  expect(html).toContain(translate('en', 'rooms.edited'))
  expect(html).toContain(translate('en', 'rooms.deleted'))
  // a deleted message has no menu (nothing to answer, edit or delete)
  expect(count(html, 'data-testid="message-menu"')).toBe(3)
})

test('one name per run of one author', () => {
  const html = render([message({ roomId: R, seq: 1 }), message({ roomId: R, seq: 2 }), message({ roomId: R, seq: 3, author: ME })])
  expect(count(html, 'data-testid="room-run"')).toBe(2)
  expect(count(html, '>Ben<')).toBe(1)
  expect(count(html, 'data-testid="room-message"')).toBe(3)
})

test('phones: a run whose time reads like the one above shows no time; a new minute or a new day does', () => {
  const sec = (s: number) => new Date(Date.parse(at(1)) + s * 1000).toISOString()
  const ms = [
    message({ roomId: R, seq: 1, createdAt: sec(0) }),
    message({ roomId: R, seq: 2, author: CY, createdAt: sec(10) }),
    message({ roomId: R, seq: 3, author: ME, createdAt: sec(20) }),
    message({ roomId: R, seq: 4, createdAt: at(3) }),
  ]
  const html = render(ms)
  const times = html.match(/<time[^>]*>/g) ?? []
  expect(times.length).toBe(4)
  expect(times.map((x) => x.includes('max-md:hidden'))).toEqual([false, true, true, false])
  // the time stays on computers and in the tooltip
  expect(times.every((x) => x.includes('title='))).toBe(true)
  // a date line starts a day: its first run shows the time even when the clock reads the same
  const minute = (iso: string) => iso.slice(11, 16)
  const days = groupRuns([ms[0]!, { ...ms[1]!, createdAt: new Date(Date.parse(ms[0]!.createdAt) + 86_400_000).toISOString() }])
  expect(sameTimeAsAbove(days, minute)).toEqual([false, false])
})

// ---------------- the room AI's earlier answers (docs/DECISIONS.md "Room @트리나 code removed") ----------------
test('an earlier AI answer is shown like a chat answer without its steps: Markdown, who asked', () => {
  const q = message({ roomId: R, seq: 1, author: ME, body: '@Trina what changed?' })
  const a = message({ roomId: R, seq: 2, authorKind: 'ai', author: null, askedBy: ME, body: '## Changes\n\n- **one**', replyTo: { id: q.id, author: ME, excerpt: q.body, fileCount: 0, deleted: false } })
  const html = render([q, a])
  expect(html).toContain('<h2')
  expect(html).toContain('<strong>one</strong>')
  expect(html).toContain(translate('en', 'rooms.aiAskedBy', { name: 'Ada' }))
  expect(html).toContain(translate('en', 'rooms.aiName'))
  expect(html).not.toContain('data-testid="steps"')
  // "@Trina" in the question is plain text. The answer has no quote block of its own
  expect(html).toContain('@Trina what changed?')
  expect(count(html, 'data-testid="message-quote"')).toBe(0)
})

test("an AI answer's team file links are chips only for files the viewer may open; the rest is plain text", () => {
  const body = 'See [plan](/api/files/download?path=acme%2Fplan.md) and [notes](/files/view?path=acme/notes.md) ![chart](/api/files/download?path=acme%2Fchart.png)'
  const a = message({ roomId: R, seq: 4, authorKind: 'ai', author: null, askedBy: BEN, body, openable: ['acme/notes.md'] })
  const html = render([a])
  expect(count(html, 'data-testid="team-file-text"')).toBe(2)
  expect(html).not.toContain('acme%2Fchart.png')
  expect(html).not.toContain('<img')
  expect(html).toContain('>notes<')
  // someone else's answer: no delete for a member
  expect(html).not.toContain('data-testid="message-delete"')
})

test('touch screens: no hover row on every message; a long press opens its menu (reactions, reply in thread, copy, edit and delete my own)', async () => {
  const html = render([message({ roomId: R, seq: 1, author: ME, body: 'mine' })])
  // the hover bar is for the mouse only; the sheet's own button never shows (a long press opens it)
  expect(html).toMatch(/<div[^>]*class="[^"]*max-md:hidden pointer-coarse:hidden[^"]*"[^>]*data-testid="message-hover-bar"/)
  expect(html).toMatch(/<button[^>]*class="[^"]* hidden!"[^>]*data-testid="message-menu"/)
  installDom()
  const m = await mount(<RoomMessages roomId={R} messages={[message({ roomId: R, seq: 1, author: ME, body: 'mine' })]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
  try {
    const press = (type: string, o: Record<string, unknown> = {}) => {
      const e = Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', clientX: 10, clientY: 10, ...o })
      m.get('room-message').dispatchEvent(e)
    }
    // a finger that moves (scrolling) opens nothing
    press('pointerdown')
    press('pointermove', { clientY: 60 })
    await m.settle(700)
    expect(m.find('message-reply-thread')).toBeNull()
    // held still: the menu, with the reactions on top
    press('pointerdown')
    await m.settle(700)
    expect(['message-reply-thread', 'message-copy', 'message-edit', 'message-delete', 'reaction-strip'].map((id) => !!m.find(id))).toEqual([true, true, true, true, true])
  } finally {
    await m.unmount()
    removeDom()
  }
})


test('a room badge: "@" alone when it mentions me, grey for a muted room; a letter avatar is neutral, not the accent', async () => {
  const { UnreadBadge } = await import('../../src/components/nav/RoomsList')
  const { Avatar } = await import('../../src/components/Avatar')
  const { room } = await import('./rooms-fixtures')
  const loud = renderToStaticMarkup(<UnreadBadge room={room({ unreadCount: 2, mentioned: true })} testId="b" />)
  expect(loud).toContain('<span aria-hidden="true">@</span>')
  expect(loud).toContain('bg-accent')
  const quiet = renderToStaticMarkup(<UnreadBadge room={room({ unreadCount: 3, muted: true })} testId="b" />)
  expect(quiet).toContain('<span aria-hidden="true">3</span>')
  expect(quiet).toContain('bg-hover text-muted')
  expect(quiet).not.toContain('bg-accent')
  expect(renderToStaticMarkup(<UnreadBadge room={room({ unreadCount: 0 })} testId="b" />)).toBe('')
  const face = renderToStaticMarkup(<Avatar user={{ id: 'x', name: 'Ada' }} />)
  expect(face).toContain('>A<')
  expect(face).not.toContain('bg-accent')
})

test("a photo's thumbnail takes its own shape once loaded (an older row with a landscape size, a portrait thumbnail)", async () => {
  const { act } = await import('react')
  const { FakeEvent: Ev } = await import('./dom-host')
  const file = { id: uuidv7(), name: 'IMG_0001.jpg', size: 1000, mime: 'image/jpeg', kind: 'image', width: 1600, height: 1200, thumb: true }
  const m0 = message({ roomId: R, seq: 1, author: BEN, body: '', files: [file] as never })
  installDom()
  const m = await mount(<RoomMessages roomId={R} messages={[m0]} pending={[]} meId={ME.id} members={[ME, BEN]} onThread={() => {}} />)
  try {
    const img = m.get('room-image').querySelector('img')!
    // before it loads: the box from the stored size (landscape), a soft box holding the place
    expect([img.style.width, img.style.height]).toEqual(['320px', '240px'])
    expect(img.className).toContain('bg-subtle')
    expect(m.get('room-image').className).not.toContain('bg-')
    // the thumbnail ffmpeg made is upright: 480 x 640
    Object.assign(img, { naturalWidth: 480, naturalHeight: 640 })
    await act(async () => { img.dispatchEvent(new Ev('load')) })
    expect([img.style.width, img.style.height]).toEqual(['180px', '240px'])
    // once it is there nothing is painted behind it: a transparent picture (a seal stamp) sits on the message itself
    expect(img.className).not.toContain('bg-')
  } finally {
    await m.unmount()
    removeDom()
  }
})

test('a name changed since the messages were read shows at once: the directory has it (author, quote, @mention)', async () => {
  const { usePeople } = await import('../../src/store/people')
  const q = message({ roomId: R, seq: 1, author: BEN, body: 'first' })
  const reply = message({ roomId: R, seq: 2, author: CY, body: 'hi @Ben', mentions: [BEN.id], replyTo: { id: q.id, author: BEN, excerpt: 'first', fileCount: 0, deleted: false } })
  installDom()
  const m = await mount(<RoomMessages roomId={R} messages={[q, reply]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
  try {
    expect(m.html()).toMatch(/>Ben</)
    // Ben renames himself: the directory reloads (profile_changed), the messages and the members still say "Ben"
    const { act } = await import('react')
    await act(async () => { usePeople.setState({ byId: { [BEN.id]: { id: BEN.id, name: 'Benjamin Park' } } as never }) })
    const html = m.html()
    // the run's name and the quote's; the @mention keeps the words Cy typed, still marked as a mention
    expect(count(html, 'Benjamin Park')).toBe(2)
    expect(html).not.toMatch(/>Ben</)
    expect(html).toMatch(/<span class="[^"]*font-medium[^"]*">@Ben<\/span>/)
  } finally {
    await m.unmount()
    usePeople.getState().reset()
    removeDom()
  }
})

// ---------------- group chats and room names (docs/DECISIONS.md "그룹 대화와 방 이름") ----------------
test('an event line is one quiet line in the middle: no avatar, menu, reactions or thread; a room name stays text', () => {
  const html = render([
    message({ roomId: R, seq: 1, body: 'hello' }),
    message({ roomId: R, seq: 2, body: '', author: BEN, event: { type: 'renamed', name: '<b>Plan</b>' } }),
    message({ roomId: R, seq: 3, body: '', author: BEN, event: { type: 'added', users: [CY] } }),
    message({ roomId: R, seq: 4, body: 'after' }),
  ])
  expect(count(html, 'data-testid="room-event"')).toBe(2)
  expect(html).not.toContain('<b>Plan</b>')
  expect(html).toContain('&lt;b&gt;Plan&lt;/b&gt;')
  // the lines have no menu and break the run: Ben's two messages are two runs with his name twice
  expect(count(html, 'data-testid="message-menu"')).toBe(2)
  expect(count(html, 'data-testid="room-run"')).toBe(2)
  expect(html).toContain(translate('en', 'rooms.event.invited', { actor: 'Ben', names: 'Cy Park' }))
})

test('phones: the first message after an event line keeps its time unless the message run above has the same one', () => {
  const sec = (s: number) => new Date(Date.parse(at(1)) + s * 1000).toISOString()
  const minute = (iso: string) => iso.slice(11, 16)
  const runs = groupRuns([
    message({ roomId: R, seq: 1, createdAt: at(0) }),
    message({ roomId: R, seq: 2, author: CY, body: '', event: { type: 'left' }, createdAt: sec(0) }),
    message({ roomId: R, seq: 3, author: ME, createdAt: sec(5) }),
    message({ roomId: R, seq: 4, author: CY, body: '', event: { type: 'left' }, createdAt: sec(10) }),
    message({ roomId: R, seq: 5, createdAt: sec(20) }),
  ])
  // seq 3 is a minute after seq 1 (the event line's time does not count): shown; seq 5 has seq 3's minute: once
  expect(sameTimeAsAbove(runs, minute)).toEqual([false, false, false, false, true])
})

// ---------------- threads and reactions (docs/DECISIONS.md "스레드와 반응") ----------------
test("a root's thread line: up to 3 faces, the count, the last reply's time, a dot only for a followed thread with new replies; a tap opens it", async () => {
  const quiet = message({ roomId: R, seq: 1, body: 'root', thread: { replyCount: 3, lastReplyAt: at(9), repliers: [CY, BEN], newReplies: false } })
  const fresh = message({ roomId: R, seq: 2, author: CY, body: 'another root', thread: { replyCount: 1, lastReplyAt: at(10), repliers: [BEN], newReplies: true } })
  const html = render([quiet, fresh, message({ roomId: R, seq: 3, author: ME, body: 'no thread' })])
  expect(count(html, 'data-testid="room-thread-line"')).toBe(2)
  expect(html).toContain(translate('en', 'rooms.threadReplies', { n: 3 }))
  expect(count(html, 'data-new=""')).toBe(1)
  expect(count(html, translate('en', 'rooms.threadNew'))).toBe(1)
  // in the thread itself the root has no line of its own, and replies none
  const inThread = renderToStaticMarkup(<RoomMessages roomId={R} messages={[quiet]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} variant="root" />)
  expect(inThread).not.toContain('room-thread-line')
  expect(inThread).not.toContain('message-thread')
  installDom()
  const opened: [string, boolean | undefined][] = []
  const m = await mount(<RoomMessages roomId={R} messages={[quiet]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={(id, focus) => opened.push([id, focus])} />)
  try {
    await m.click('room-thread-line')
    // the hover row's "reply in thread" puts the cursor in the thread's box
    await m.click('message-thread')
    expect(opened).toEqual([[quiet.id, undefined], [quiet.id, true]])
  } finally {
    await m.unmount()
    removeDom()
  }
})

test('a reply sent to the room too: marked as a thread reply in the timeline (a tap opens its thread), "also sent" in the thread', async () => {
  const root = uuidv7()
  const loud = message({ roomId: R, seq: 5, body: 'to everyone', threadRootId: root, alsoInRoom: true })
  expect(render([loud])).toContain('data-testid="room-thread-reply-mark"')
  // a reply has no thread of its own: no "reply in thread"
  expect(render([loud])).not.toContain('data-testid="message-thread"')
  const inThread = renderToStaticMarkup(<RoomMessages roomId={R} messages={[loud]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} variant="reply" />)
  expect(inThread).toContain(translate('en', 'rooms.alsoSent'))
  expect(inThread).not.toContain('room-thread-reply-mark')
  installDom()
  const opened: string[] = []
  const m = await mount(<RoomMessages roomId={R} messages={[loud]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={(id) => opened.push(id)} />)
  try {
    await m.click('room-thread-reply-mark')
    expect(opened).toEqual([root])
  } finally {
    await m.unmount()
    removeDom()
  }
})

test('reactions: a chip per emoji with its count, mine marked and pressed, who reacted in its tooltip; none on deleted messages or event lines', async () => {
  const reactions = [{ emoji: '👍' as const, count: 12, mine: true, users: [ME, BEN] }, { emoji: '🎉' as const, count: 1, mine: false, users: [CY] }]
  const html = render([
    message({ roomId: R, seq: 1, body: 'liked', reactions }),
    message({ roomId: R, seq: 2, body: '', deletedAt: at(3), reactions }),
    message({ roomId: R, seq: 3, body: '', author: BEN, event: { type: 'left' }, reactions }),
  ])
  expect(count(html, 'data-testid="reaction-chip"')).toBe(2)
  expect(count(html, 'data-mine=""')).toBe(1)
  expect(html).toContain('>12<')
  // the names the server gave and how many more: "Ada, Ben and 10 more"
  expect(html).toContain(translate('en', 'rooms.groupNamesMore', { names: 'Ada, Ben', n: 10 }))
  expect(html).toContain('🎉 Cy Park')
  // the hover row's react button on a message that takes reactions only
  expect(count(html, 'data-testid="message-react"')).toBe(1)
  // a tap puts mine on or takes it off
  installDom()
  const calls: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method} ${new URL(String(input), 'http://team.localhost').pathname} ${init?.body}`)
    return new Response(JSON.stringify({ reactions: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const msg = message({ roomId: R, seq: 1, body: 'liked', reactions })
  const m = await mount(<RoomMessages roomId={R} messages={[msg]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />)
  try {
    const chips = m.container.querySelectorAll('[data-testid="reaction-chip"]')
    await m.click(chips[0] as never)
    await m.click(chips[1] as never)
    await m.settle(10)
    expect(calls).toEqual([
      `PUT /api/rooms/${R}/messages/${msg.id}/reactions ${JSON.stringify({ emoji: '👍', on: false })}`,
      `PUT /api/rooms/${R}/messages/${msg.id}/reactions ${JSON.stringify({ emoji: '🎉', on: true })}`,
    ])
  } finally {
    globalThis.fetch = realFetch
    await m.unmount()
    useRooms.getState().reset()
    removeDom()
  }
})

test("a room's badge counts the threads I follow with new replies; '@' when one of them mentions me", async () => {
  const { UnreadBadge } = await import('../../src/components/nav/RoomsList')
  const { room } = await import('./rooms-fixtures')
  expect(renderToStaticMarkup(<UnreadBadge room={room({ unreadCount: 0, threadsUnread: 2 })} testId="b" />)).toContain('<span aria-hidden="true">2</span>')
  expect(renderToStaticMarkup(<UnreadBadge room={room({ unreadCount: 1, threadsUnread: 2 })} testId="b" />)).toContain('<span aria-hidden="true">3</span>')
  expect(renderToStaticMarkup(<UnreadBadge room={room({ unreadCount: 0, threadsUnread: 1, mentioned: true })} testId="b" />)).toContain('<span aria-hidden="true">@</span>')
})

test('an old answer hidden from me is one faint line: who asked it, no text, menu, reactions, thread or sources', () => {
  const q = message({ roomId: R, seq: 1, body: '@트리나 Q3 spend?' })
  const html = render([
    q,
    message({ roomId: R, seq: 2, body: '', authorKind: 'ai', author: null, askedBy: BEN, withheld: true, replyTo: { id: q.id, author: BEN, excerpt: '@트리나 Q3 spend?', fileCount: 0, deleted: false } }),
    message({ roomId: R, seq: 3, body: '', author: CY, withheld: true }),
  ]).replaceAll('&#x27;', "'")
  expect(count(html, 'data-testid="room-withheld"')).toBe(2)
  expect(html).toContain(translate('en', 'rooms.withheldAnswer'))
  expect(html).toContain(translate('en', 'rooms.withheldMessage'))
  expect(html).toContain(translate('en', 'rooms.aiAskedBy', { name: 'Ben' }))
  // only the first message has a menu; the two lines have none, nor a thread line, reactions or a shared answer
  expect(count(html, 'data-testid="message-menu"')).toBe(1)
  expect(html).not.toContain('room-thread-line')
  expect(html).not.toContain('room-shared-answer')
  expect(html).not.toContain('data-testid="reaction')
})

test('a quote of a hidden answer says so', () => {
  const html = render([message({ roomId: R, seq: 5, body: 'old reply', replyTo: { id: uuidv7(), author: null, excerpt: '', fileCount: 0, deleted: true, withheld: true } })]).replaceAll('&#x27;', "'")
  expect(html).toContain(translate('en', 'rooms.withheldMessage'))
  expect(html).not.toContain(translate('en', 'rooms.deleted'))
})

test('an old private AI message (the server no longer lists one) has no preview line or post action', () => {
  const html = render([message({ roomId: R, seq: 6, body: 'an answer', authorKind: 'ai', author: null, askedBy: ME, visibility: 'private' })])
  expect(html).not.toContain('room-ai-private')
  expect(html).not.toContain('room-ai-share')
})

test('an answer\'s own quotes go without the typography\'s marks: a shared answer in a thread, and the room\'s AI answer (QA 2026-11-11)', () => {
  // the answer quotes a message with its own marks: the room added “ ” around them (“"…"”); the AI chat never did
  const answer = '> "Let\'s move the review to 3 pm"\n\nBen asked to move the review.'
  const note = 'FYI'
  const root = message({ roomId: R, seq: 1, body: 'review at 2?' })
  const html = render([
    message({ roomId: R, seq: 2, author: ME, body: `${note}\n\n${answer}`, sharedAnswer: { at: note.length + 2, cut: false }, threadRootId: root.id }),
    message({ roomId: R, seq: 3, body: answer, authorKind: 'ai', author: null, askedBy: BEN }),
  ])
  const wrappers = [...html.matchAll(/<div class="([^"]*\bprose\b[^"]*)"[^>]*>([\s\S]*?<blockquote>)/g)]
  expect(wrappers.length).toBe(2)
  for (const [, cls] of wrappers) for (const c of ANSWER_QUOTES.split(' ')) expect(cls!.replaceAll('&amp;', '&').split(' ')).toContain(c)
  // the shared answer's quote is inside the "Trina's answer" figure; the words are the answer's, its marks once
  const shared = /data-testid="room-shared-answer"[\s\S]*?<\/figure>/.exec(html)![0]
  expect(shared).toContain('<blockquote>')
  expect(shared).toContain('&quot;Let&#x27;s move the review to 3 pm&quot;')
  expect(shared).not.toMatch(/[“”]/)
})
