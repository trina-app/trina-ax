// How a room's messages are shown (components/rooms/RoomMessages.tsx): another member's words as plain text (never
// HTML), the @names they mention stand out, the unread number only while someone has not read it, deleted and edited
// messages say so, and one avatar and name per run of one author.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { translate } from '../../src/i18n'
import { previewWhy, RoomMessages } from '../../src/components/rooms/RoomMessages'
import { useRooms } from '../../src/store/rooms'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'
import { at, BEN, CY, ME, message } from './rooms-fixtures'
import { uuidv7 } from '@mycel/shared/api'

const R = uuidv7()
const render = (ms: ReturnType<typeof message>[]) => renderToStaticMarkup(<RoomMessages roomId={R} messages={ms} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onReply={() => {}} />)
const count = (html: string, s: string) => html.split(s).length - 1

test("another member's text stays text: HTML is escaped, line breaks kept, mentions marked", () => {
  const html = render([message({ roomId: R, seq: 1, body: '<img src=x onerror=alert(1)>\n@Cy Park look', mentions: [CY.id] })])
  expect(html).not.toContain('<img src=x')
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(html).toContain('whitespace-pre-wrap')
  expect(html).toMatch(/<span class="font-medium text-accent-text">@Cy Park<\/span>/)
})

test('the unread number shows only above 0; deleted and edited messages say so', () => {
  const html = render([
    message({ roomId: R, seq: 1, body: 'two have not read', unread: 2 }),
    message({ roomId: R, seq: 2, body: 'all read', unread: 0 }),
    message({ roomId: R, seq: 3, body: 'fixed', editedAt: at(4) }),
    message({ roomId: R, seq: 4, body: '', deletedAt: at(5) }),
  ])
  expect(count(html, 'data-testid="message-unread"')).toBe(1)
  expect(html).toContain(translate('en', 'rooms.unreadBy', { n: 2 }))
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

// ---------------- the AI in a room (docs/DECISIONS.md "대화방의 트리나") ----------------
test('an AI answer is shown like a chat answer without its steps: Markdown, who asked, the files it used', () => {
  const q = message({ roomId: R, seq: 1, author: ME, body: '@Trina what changed?' })
  const a = message({ roomId: R, seq: 2, authorKind: 'ai', author: null, askedBy: ME, body: '## Changes\n\n- **one**', replyTo: { id: q.id, author: ME, excerpt: q.body, fileCount: 0, deleted: false }, sourceCount: 2 })
  const html = render([q, a])
  expect(html).toContain('<h2')
  expect(html).toContain('<strong>one</strong>')
  expect(html).toContain(translate('en', 'rooms.aiAskedBy', { name: 'Ada' }))
  expect(html).toContain(translate('en', 'rooms.aiName'))
  expect(html).toContain(translate('en', 'sources.title', { n: 2 }))
  expect(html).not.toContain('data-testid="steps"')
  // "@Trina" in the question stands out like a person's name; the answer has no quote block of its own
  expect(html).toMatch(/<span class="font-medium text-accent-text">@Trina<\/span>/)
  expect(count(html, 'data-testid="message-quote"')).toBe(0)
  expect(html).not.toContain('data-testid="room-ai-preview"')
})

test('a private preview says at its top that only I see it, with one text action and why in short sentences', () => {
  const a = message({ roomId: R, seq: 3, authorKind: 'ai', author: null, askedBy: ME, visibility: 'private', body: 'mine only', preview: { folders: ['acme/finance', '', 'skills/marketing', 'shared/teams/finance'], personal: true, outside: true } })
  const html = render([a])
  expect(count(html, 'data-testid="room-ai-preview"')).toBe(1)
  // the top line: mine only, in place of "asked by", with "Post" on it as a text action (no framed button)
  expect(html).toContain('data-testid="room-ai-private"')
  expect(html).toContain(translate('en', 'rooms.aiPrivate'))
  expect(html).not.toContain(translate('en', 'rooms.aiAskedBy', { name: 'Ada' }))
  expect(html.indexOf('room-ai-private')).toBeLessThan(html.indexOf('mine only'))
  const line = html.slice(html.indexOf('data-testid="room-ai-private"'))
  const own = line.slice(0, line.indexOf('</p>'))
  expect(count(own, '<button')).toBe(1)
  expect(own).toContain('data-testid="room-ai-share"')
  expect(own).toContain(`>${translate('en', 'rooms.aiPost')}<`)
  expect(own).not.toContain('border-field-border')
  expect(own).not.toContain('bg-accent')
  // the reason right under it, before the answer: one short sentence per reason, the folders by the last parts of
  // their paths, once each, no skills folder, never a full path; my own folder; the web
  expect(html.indexOf('room-ai-preview')).toBeLessThan(html.indexOf('mine only'))
  const folders = ['finance', translate('en', 'rooms.aiRootFolder')].join(', ')
  expect(html).toContain([translate('en', 'rooms.aiWhyFolders', { folders }), translate('en', 'rooms.aiWhyMine'), translate('en', 'rooms.aiWhyOutside')].join(' '))
  expect(html).not.toContain('acme/finance')
  expect(html).not.toContain('marketing')
  // nothing repeated under the answer; putting the preview away is in the "…" menu
  expect(count(html, 'data-testid="room-ai-share"')).toBe(1)
  expect(count(html, 'data-testid="message-menu"')).toBe(1)
})

test('a private preview without a folder to name says so without names, or gives the other reasons', () => {
  const reason = (preview: NonNullable<ReturnType<typeof message>['preview']>) => {
    const html = render([message({ roomId: R, seq: 3, authorKind: 'ai', author: null, askedBy: ME, visibility: 'private', body: 'x', preview })])
    const note = html.slice(html.indexOf('data-testid="room-ai-preview"'))
    return note.slice(0, note.indexOf('</p>'))
  }
  // a skills folder or one the person cannot open: "folders some people here cannot open", no name
  expect(reason({ folders: ['skills/marketing'], personal: false, outside: true })).toContain([translate('en', 'rooms.aiWhySomeFolders'), translate('en', 'rooms.aiWhyOutside')].join(' '))
  expect(reason({ folders: [], otherFolders: true, personal: false, outside: false })).toContain(translate('en', 'rooms.aiWhySomeFolders'))
  expect(reason({ folders: [], personal: true, outside: false })).toContain(translate('en', 'rooms.aiWhyMine'))
  expect(reason({ folders: [], personal: false, outside: false, joinedLater: ['Cy Park'] })).toContain(translate('en', 'rooms.aiWhyJoined', { names: 'Cy Park' }))
  expect(reason({ folders: [], personal: false, outside: false })).toContain(translate('en', 'rooms.aiPrivateAll'))
  // the Korean reads as plain short sentences, not a list after a colon
  expect(translate('ko', 'rooms.aiWhySomeFolders')).toBe('방 사람 중 일부가 열 수 없는 폴더를 읽었어요.')
  expect(translate('ko', 'rooms.aiWhyMine')).toBe('내 폴더를 읽었어요.')
})

test('in a 1:1 room the reasons name the other person, never "the room"', () => {
  const t = (k: string, v?: Record<string, string | number>) => translate('ko', k as never, v)
  expect(previewWhy({ folders: ['acme/finance'], personal: false, outside: false }, t as never, true)).toBe(translate('ko', 'rooms.aiWhyFoldersDm', { folders: 'finance' }))
  expect(previewWhy({ folders: [], otherFolders: true, personal: false, outside: false }, t as never, true)).toBe(translate('ko', 'rooms.aiWhySomeFoldersDm'))
  expect(previewWhy(undefined, t as never, true)).toBe(translate('ko', 'rooms.aiPrivateAllDm'))
  for (const k of ['rooms.aiWhyFoldersDm', 'rooms.aiWhySomeFoldersDm', 'rooms.aiPrivateAllDm', 'rooms.aiPost']) expect(translate('ko', k as never, { folders: 'x' })).not.toContain('대화방')
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

test("someone else's question answered privately says so under the question, naming only who asked", async () => {
  // the server marks the question (RoomMessage.answeredPrivately): after a reload as well as live
  const q = message({ roomId: R, seq: 1, author: BEN, body: '@Trina budget?', answeredPrivately: true })
  const later = message({ roomId: R, seq: 2, author: CY, body: 'meanwhile' })
  installDom()
  const m = await mount(<RoomMessages roomId={R} messages={[q, later]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onReply={() => {}} />)
  try {
    const html = m.html()
    expect(count(html, 'data-testid="room-ai-private-for"')).toBe(1)
    expect(m.get('room-ai-private-for').textContent).toBe(translate('en', 'rooms.aiAnsweredTo', { name: 'Ben' }))
    // right under the question, not at the end of the room
    expect(html.indexOf('room-ai-private-for')).toBeLessThan(html.indexOf('meanwhile'))
  } finally {
    await m.unmount()
    useRooms.getState().reset()
    removeDom()
  }
})

test('touch screens: no "…" on every message; a long press opens its menu (reply, copy, edit and delete my own)', async () => {
  const html = render([message({ roomId: R, seq: 1, author: ME, body: 'mine' })])
  // the button stays for the mouse (on hover) and goes on phones and touch screens
  expect(html).toMatch(/<button[^>]*class="[^"]*pointer-coarse:hidden max-sm:hidden[^"]*"[^>]*data-testid="message-menu"/)
  installDom()
  const m = await mount(<RoomMessages roomId={R} messages={[message({ roomId: R, seq: 1, author: ME, body: 'mine' })]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onReply={() => {}} />)
  try {
    const press = (type: string, o: Record<string, unknown> = {}) => {
      const e = Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', clientX: 10, clientY: 10, ...o })
      m.get('room-message').dispatchEvent(e)
    }
    // a finger that moves (scrolling) opens nothing
    press('pointerdown')
    press('pointermove', { clientY: 60 })
    await m.settle(700)
    expect(m.find('message-reply')).toBeNull()
    // held still: the menu
    press('pointerdown')
    await m.settle(700)
    expect(['message-reply', 'message-copy', 'message-edit', 'message-delete'].map((id) => !!m.find(id))).toEqual([true, true, true, true])
  } finally {
    await m.unmount()
    removeDom()
  }
})

test("an AI answer's unread number sits by its time, not on a line of its own under the answer", () => {
  const a = message({ roomId: R, seq: 2, authorKind: 'ai', author: null, askedBy: BEN, body: 'long **answer**', unread: 2 })
  const html = render([a])
  expect(count(html, 'data-testid="message-unread"')).toBe(1)
  expect(html.indexOf('data-testid="message-unread"')).toBeLessThan(html.indexOf('<strong>answer</strong>'))
  expect(html).toMatch(/<\/time><span[^>]*data-testid="message-unread"/)
})

test('my stopped question says so under that question, not at the end of the room', async () => {
  const q = message({ roomId: R, seq: 1, author: ME, body: '@Trina table please' })
  const later = message({ roomId: R, seq: 2, author: BEN, body: 'meanwhile' })
  installDom()
  useRooms.setState({ ai: { [R]: { answering: 0, runs: [{ turnId: uuidv7(), roomId: R, questionId: q.id, state: 'stopped', position: 0, steps: [], error: null, createdAt: q.createdAt }] } } })
  const m = await mount(<RoomMessages roomId={R} messages={[q, later]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onReply={() => {}} />)
  try {
    const html = m.html()
    expect(count(html, 'data-testid="room-ai-ended"')).toBe(1)
    expect(m.get('room-ai-ended').textContent).toContain(translate('en', 'rooms.aiStopped'))
    expect(html.indexOf('room-ai-ended')).toBeLessThan(html.indexOf('meanwhile'))
  } finally {
    await m.unmount()
    useRooms.getState().reset()
    removeDom()
  }
})

test('a room badge: "@" alone when it mentions me, grey for a muted room; a letter avatar is neutral, not the accent', async () => {
  const { UnreadBadge } = await import('../../src/components/rooms/SidebarRooms')
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

test("a preview's folders the asker cannot open themselves are never named, only said to be there", () => {
  const why = (preview: NonNullable<ReturnType<typeof message>['preview']>) => render([message({ roomId: R, seq: 3, authorKind: 'ai', author: null, askedBy: ME, visibility: 'private', body: 'x', preview })])
  expect(why({ folders: [], otherFolders: true, personal: false, outside: false })).toContain(translate('en', 'rooms.aiWhySomeFolders'))
  // with one the person may open: that one is named, the sentence already says "some folders", nothing more is hinted
  const both = why({ folders: ['acme/finance'], otherFolders: true, personal: false, outside: false })
  expect(both).toContain(translate('en', 'rooms.aiWhyFolders', { folders: 'finance' }))
  expect(both).not.toContain(translate('en', 'rooms.aiWhySomeFolders'))
})

test("a photo's thumbnail takes its own shape once loaded (an older row with a landscape size, a portrait thumbnail)", async () => {
  const { act } = await import('react')
  const { FakeEvent: Ev } = await import('./dom-host')
  const file = { id: uuidv7(), name: 'IMG_0001.jpg', size: 1000, mime: 'image/jpeg', kind: 'image', width: 1600, height: 1200, thumb: true }
  const m0 = message({ roomId: R, seq: 1, author: BEN, body: '', files: [file] as never })
  installDom()
  const m = await mount(<RoomMessages roomId={R} messages={[m0]} pending={[]} meId={ME.id} members={[ME, BEN]} onReply={() => {}} />)
  try {
    const img = m.get('room-image').querySelector('img')!
    // before it loads: the box from the stored size (landscape)
    expect([img.style.width, img.style.height]).toEqual(['320px', '240px'])
    // the thumbnail ffmpeg made is upright: 480 x 640
    Object.assign(img, { naturalWidth: 480, naturalHeight: 640 })
    await act(async () => { img.dispatchEvent(new Ev('load')) })
    expect([img.style.width, img.style.height]).toEqual(['180px', '240px'])
  } finally {
    await m.unmount()
    removeDom()
  }
})
