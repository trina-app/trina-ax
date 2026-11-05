// How a room's messages are shown (components/rooms/RoomMessages.tsx): another member's words as plain text (never
// HTML), the @names they mention stand out, the unread number only while someone has not read it, deleted and edited
// messages say so, and one avatar and name per run of one author.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { translate } from '../../src/i18n'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
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

test('a private preview says why only I see it, names the folders, and has exactly one action', () => {
  const a = message({ roomId: R, seq: 3, authorKind: 'ai', author: null, askedBy: ME, visibility: 'private', body: 'mine only', preview: { folders: ['acme/finance', ''], personal: false, outside: true } })
  const html = render([a])
  expect(count(html, 'data-testid="room-ai-preview"')).toBe(1)
  expect(html).toContain(translate('en', 'rooms.aiPrivate'))
  expect(html).toContain(translate('en', 'rooms.aiPrivateFolders', { folders: `acme/finance/, ${translate('en', 'rooms.aiRootFolder')}` }))
  expect(html).toContain(translate('en', 'rooms.aiPrivateOutside'))
  expect(html).not.toContain(translate('en', 'rooms.aiPrivatePersonal'))
  expect(count(html, '<button')).toBe(1)
  expect(html).toContain(translate('en', 'rooms.aiShare'))
  // no reply, edit or delete menu on a preview
  expect(html).not.toContain('data-testid="message-menu"')
})
