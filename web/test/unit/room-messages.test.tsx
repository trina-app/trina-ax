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
