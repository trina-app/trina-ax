// Message links in the web app (docs/DECISIONS.md "Message links and their previews"): the hosts that are this team's,
// the address Copy link gives, how a place reads; a link with a preview is a chip and a card under the message (a
// snapshot says who shared it, a deleted original says so, a link in a card's words never makes a card inside it), a link
// without one stays the plain link it was; the box asks only about this team's links into another room.
import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { RoomLinkPreview, uuidv7, type RoomLinkPreview as Preview } from '@mycel/shared/api'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import { askableLinks } from '../../src/components/rooms/MessageLinkChoice'
import { copyLinkOf, linkHosts, messagePath, ownMessageLink, placeLabel } from '../../src/lib/messageLinks'
import { at, BEN, CY, ME, message } from './rooms-fixtures'

const R = uuidv7(), R2 = uuidv7(), M2 = uuidv7(), M3 = uuidv7(), ROOT = uuidv7()
// (a static render reads the stores' first state: this page's own host stands for the team's, as in the browser)
const hadLocation = 'location' in globalThis
const signIn = (_address: string) => { (globalThis as { location?: unknown }).location = { host: 'localhost', origin: 'http://localhost' } }
afterEach(() => { if (!hadLocation) delete (globalThis as { location?: unknown }).location })

const preview = (o: Partial<Preview> = {}): Preview => RoomLinkPreview.parse({
  roomId: R2, messageId: M2, rootId: null, place: { kind: 'team', name: 'design', peers: [] }, author: BEN, authorKind: 'user',
  mentions: [], createdAt: at(1), editedAt: null, deleted: false, body: 'the brief is ready', files: { count: 0 }, ...o,
})
const render = (body: string, linkPreviews?: Preview[]) => renderToStaticMarkup(
  <MemoryRouter>
    <RoomMessages roomId={R} messages={[message({ roomId: R, seq: 2, body, ...(linkPreviews ? { linkPreviews } : {}) })]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />
  </MemoryRouter>,
)
const count = (html: string, id: string) => html.split(`data-testid="${id}"`).length - 1

test('this team\'s hosts, its message links, where they open and what Copy link gives', () => {
  const hosts = linkHosts('192.168.0.5:8080', 'https://acme.trina.app')
  expect([...hosts].sort()).toEqual(['192.168.0.5:8080', 'acme.trina.app'])
  expect(ownMessageLink(`https://acme.trina.app/rooms/${R2}?m=${M2}`, hosts)?.messageId).toBe(M2)
  // another team's address, a look-alike, an old name: an ordinary link
  expect(ownMessageLink(`https://other.trina.app/rooms/${R2}?m=${M2}`, hosts)).toBeNull()
  expect(ownMessageLink(`https://acme.trina.app.evil.example/rooms/${R2}?m=${M2}`, hosts)).toBeNull()
  expect(messagePath({ roomId: R2, messageId: M2, rootId: null })).toBe(`/rooms/${R2}?m=${M2}`)
  expect(messagePath({ roomId: R2, messageId: M2, rootId: ROOT })).toBe(`/rooms/${R2}/t/${ROOT}?m=${M2}`)
  // the team address wins over this page's (a LAN address in the desktop app); none: this page's
  expect(copyLinkOf(R2, M2, null, 'https://acme.trina.app', 'http://192.168.0.5:8080')).toBe(`https://acme.trina.app/rooms/${R2}?m=${M2}`)
  expect(copyLinkOf(R2, M2, ROOT, null, 'http://192.168.0.5:8080')).toBe(`http://192.168.0.5:8080/rooms/${R2}/t/${ROOT}?m=${M2}`)
})

test('a place in words: #team, a person, a group; a snapshot by its kind only', () => {
  const o = { title: (p: Preview['place']) => p.name ?? p.peers.map((x) => x.name).join(', '), dm: 'Direct message', group: 'Group chat' }
  expect(placeLabel(preview(), o)).toBe('#design')
  expect(placeLabel(preview({ place: { kind: 'dm', name: null, peers: [BEN] } }), o)).toBe('Ben')
  expect(placeLabel(preview({ place: { kind: 'group', name: null, peers: [BEN, CY] } }), o)).toBe('Ben, Cy Park')
  expect(placeLabel(preview({ place: { kind: 'dm', name: null, peers: [] }, sharedBy: BEN }), o)).toBe('Direct message')
  expect(placeLabel(preview({ place: { kind: 'group', name: null, peers: [] }, sharedBy: null }), o)).toBe('Group chat')
})

test('a link with a preview: a chip with the place and a card under the words; without one: the plain link', () => {
  signIn('http://localhost')
  const url = `http://localhost/rooms/${R2}?m=${M2}`
  const html = render(`look ${url}`, [preview()])
  expect(count(html, 'message-link-chip')).toBe(1)
  expect(html).toContain('#design')
  expect(count(html, 'message-link-card')).toBe(1)
  expect(html).toContain('the brief is ready')
  expect(html).toContain(`href="/rooms/${R2}?m=${M2}"`)
  // no preview from the server: the address as it was, no chip, no card
  const plain = render(`look ${url}`)
  expect(count(plain, 'message-link-chip')).toBe(0)
  expect(count(plain, 'message-link-card')).toBe(0)
  expect(plain).toContain('data-testid="room-link"')
  // another site's host, even with a preview from the server (it reads ids on any host): no chip and no card
  const other = render(`look https://other.example/rooms/${R2}?m=${M2}`, [preview()])
  expect(count(other, 'message-link-chip')).toBe(0)
  expect(count(other, 'message-link-card')).toBe(0)
})

test('a reply, a snapshot, a deleted original, files, edited; a link in a card never makes a card inside it', () => {
  signIn('http://localhost')
  const reply = render(`http://localhost/rooms/${R2}/t/${ROOT}?m=${M2}`, [preview({ rootId: ROOT })])
  expect(reply).toContain('Thread in #design')
  const snap = render(`http://localhost/rooms/${R2}?m=${M2}`, [preview({ place: { kind: 'dm', name: null, peers: [] }, sharedBy: BEN })])
  expect(snap).toContain('Direct message')
  expect(count(snap, 'message-link-card-shared-by')).toBe(1)
  expect(snap).toContain('Shared by Ben')
  expect(snap).toContain('data-snapshot=""')
  const gone = render(`http://localhost/rooms/${R2}?m=${M2}`, [preview({ deleted: true, body: '' })])
  expect(gone).toContain('This message was deleted')
  expect(count(gone, 'message-link-card-text')).toBe(0)
  const files = render(`http://localhost/rooms/${R2}?m=${M2}`, [preview({ files: { count: 2, first: { name: 'report.pdf', kind: 'pdf' } }, editedAt: at(3) })])
  expect(files).toContain('2 files · report.pdf')
  expect(files).toContain('(edited)')
  // no card, only the chip: removed by its sender, or a message with more than five links (QA TC-2356)
  const chipOnly = render(`http://localhost/rooms/${R2}?m=${M2} https://a.x https://b.x https://c.x https://d.x https://e.x`, [preview({ removed: true, body: '', files: { count: 0 } })])
  expect(count(chipOnly, 'message-link-chip')).toBe(1)
  expect(count(chipOnly, 'message-link-card')).toBe(0)
  const nested = render(`http://localhost/rooms/${R2}?m=${M2}`, [preview({ body: `see http://localhost/rooms/${R2}?m=${M3}` })])
  expect(count(nested, 'message-link-card')).toBe(1)
  // the card's name for screen readers says who, where and when
  expect(render(`http://localhost/rooms/${R2}?m=${M2}`, [preview()])).toMatch(/aria-label="Message from Ben in #design, /)
})

test('the box asks only about this team\'s links into another room, none with more than five links', () => {
  const hosts = new Set(['acme.example'])
  const l = (room: string, m: string, host = 'acme.example') => `https://${host}/rooms/${room}?m=${m}`
  expect(askableLinks(`${l(R2, M2)} and ${l(R, M3)}`, R, hosts)).toEqual([{ roomId: R2, messageId: M2 }])
  expect(askableLinks(l(R2, M2, 'other.example'), R, hosts)).toEqual([])
  expect(askableLinks(`${l(R2, M2)} https://a.x https://b.x https://c.x https://d.x https://e.x`, R, hosts)).toEqual([])
  expect(askableLinks('no links', R, hosts)).toEqual([])
})
