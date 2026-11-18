// Named app links (docs/decisions/20261118-named-app-links.md): which addresses are links to something in this app
// (lib/appLinks.ts appLinkRef), where they open, when a label is the address itself; a person's message and an AI answer
// draw such a link as a chip with the name the server gave this viewer, the generic words without one, and keep a
// Markdown link's own words; code stays code.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7 } from '@mycel/shared/api'
import { appLinkKey, appLinkRef, labelIsAddress } from '../../src/lib/appLinks'
import { linkHosts } from '../../src/lib/messageLinks'
import { loadMarkdown } from '../../src/components/LazyMarkdown'
import { useLinkNames } from '../../src/store/linkNames'
import { RoomMessages } from '../../src/components/rooms/RoomMessages'
import { at, BEN, CY, ME, message } from './rooms-fixtures'

const C = uuidv7(), P = uuidv7(), R = uuidv7(), R2 = uuidv7(), M = uuidv7()
const TOKEN = 'pHIHdVetZ6O1FMvE77jjVg'
const HOSTS = linkHosts('192.168.0.5:8080', 'https://acme.example.com')
const ORIGIN = 'http://192.168.0.5:8080'
const ref = (href: string) => appLinkRef(href, HOSTS, ORIGIN)

const hadLocation = 'location' in globalThis
beforeEach(() => { (globalThis as { location?: unknown }).location = { host: 'localhost', origin: 'http://localhost' } })
afterEach(() => {
  if (!hadLocation) delete (globalThis as { location?: unknown }).location
  useLinkNames.getState().reset()
  Object.assign(useLinkNames.getInitialState(), { byKey: {} })
})

test('the app\'s own pages on this page\'s host or the team address; where each opens', () => {
  expect(ref(`https://acme.example.com/c/${C}`)).toEqual({ kind: 'chat', id: C, to: `/c/${C}` })
  expect(ref(`${ORIGIN}/c/${C}/t/${M}`)).toEqual({ kind: 'chat', id: C, to: `/c/${C}/t/${M}` })
  expect(ref(`/projects/${P}`)).toEqual({ kind: 'project', id: P, to: `/projects/${P}` })
  expect(ref(`https://acme.example.com/projects/${P}/files`)?.kind).toBe('project')
  expect(ref(`https://acme.example.com/rooms/${R}`)).toEqual({ kind: 'room', id: R, to: `/rooms/${R}` })
  expect(ref(`https://acme.example.com/f/${TOKEN}`)).toEqual({ kind: 'share', id: TOKEN, to: `/f/${TOKEN}` })
  expect(ref('https://acme.example.com/files/view?path=shared%2Freports%2Fweek%201.md')).toEqual({ kind: 'file', id: 'shared/reports/week 1.md', to: '/files/view?path=shared%2Freports%2Fweek%201.md', path: 'shared/reports/week 1.md' })
  expect(ref('https://acme.example.com/files?path=shared%2Freports')).toEqual({ kind: 'folder', id: 'shared/reports', to: '/files?path=shared%2Freports' })
  // a file link's place in the file goes with it; a path longer than the server names stays the plain link
  expect(ref('https://acme.example.com/files/view?path=docs%2Fhandbook.pdf&page=3')).toEqual({ kind: 'file', id: 'docs/handbook.pdf', to: '/files/view?path=docs%2Fhandbook.pdf&page=3', path: 'docs/handbook.pdf', at: { kind: 'page', page: 3 } })
  expect(ref('https://acme.example.com/files/view?path=' + 'a/'.repeat(600) + 'b.txt')).toBeNull()
  // ids are compared in one letter case
  expect(ref(`https://acme.example.com/c/${C.toUpperCase()}`)?.id).toBe(C)
})

test('not a named link: another site, a look-alike, a message link, a batch, unknown pages, odd schemes', () => {
  for (const href of [
    `https://other.example.com/c/${C}`,
    `https://acme.example.com.evil.example/c/${C}`,
    `https://user:pw@acme.example.com/c/${C}`,
    `https://acme.example.com//evil.example/c/${C}`,
    `//acme.example.com/c/${C}`,
    `https://acme.example.com/rooms/${R}?m=${M}`,
    `https://acme.example.com/rooms/${R}/t/${M}`,
    `https://acme.example.com/f/batch/${uuidv7()}`,
    `https://acme.example.com/c/not-an-id`,
    'https://acme.example.com/files',
    'https://acme.example.com/files?path=',
    'https://acme.example.com/admin/users',
    `javascript:alert(1)//acme.example.com/c/${C}`,
    `https://acme.example.com/api/files/download?path=a.txt`,
    '',
  ]) expect(`${href} ${JSON.stringify(ref(href))}`).toBe(`${href} null`)
})

test('a label that is the address itself (autolinked or pasted) vs the author\'s own words', () => {
  expect(labelIsAddress(`https://acme.example.com/c/${C}`, `https://acme.example.com/c/${C}`)).toBe(true)
  expect(labelIsAddress(`acme.example.com/c/${C}/`, `https://acme.example.com/c/${C}`)).toBe(true)
  expect(labelIsAddress('the budget chat', `https://acme.example.com/c/${C}`)).toBe(false)
  expect(labelIsAddress(['x'], 'x')).toBe(false)
  expect(appLinkKey({ kind: 'chat', id: C })).toBe(`chat:${C}`)
})

const render = (body: string) => renderToStaticMarkup(
  <MemoryRouter>
    <RoomMessages roomId={R2} messages={[message({ roomId: R2, seq: 2, body, createdAt: at(1) })]} pending={[]} meId={ME.id} members={[ME, BEN, CY]} onThread={() => {}} />
  </MemoryRouter>,
)
/** what the server said for this link (a static render reads the store's first state, so both) */
const named = (kind: string, id: string, name: string | null, extra: Record<string, unknown> = {}) => {
  const init = useLinkNames.getInitialState()
  Object.assign(init, { byKey: { ...init.byKey, [`${kind}:${id}`]: { name, at: Date.now(), ...extra } } })
  useLinkNames.setState({ byKey: init.byKey })
}

test('a person\'s message: a chip with the name for this viewer; the generic words without one; the label kept', async () => {
  await loadMarkdown()
  named('chat', C, 'Q3 budget notes')
  named('share', TOKEN, null)
  named('room', R, '', { room: { kind: 'team', name: 'design', peers: [], memberCount: 3 } })
  const html = render(`see http://localhost/c/${C} and http://localhost/f/${TOKEN} in http://localhost/rooms/${R} or [the plan](http://localhost/c/${C})\n\n\`\`\`\nhttp://localhost/c/${C}\n\`\`\``)
  expect(html).toContain('Q3 budget notes')
  expect(html).toContain('Trina file')
  expect(html).toContain('#design')
  expect(html.split('data-testid="app-link-chip"').length - 1).toBe(3)
  // the chip with a name opens the chat in the app; the generic one says why there is no name
  const chat = html.match(/<a [^>]*data-kind="chat"[^>]*>/)![0]
  expect(chat).toContain(`href="/c/${C}"`)
  expect(chat).toContain('data-named=""')
  expect(html.match(/<a [^>]*data-kind="share"[^>]*>/)![0]).not.toContain('data-named')
  expect(html).toContain('Only people who can open it see its name.')
  // the author's own words stay; the address in a code block stays text
  expect(html).toContain('>the plan</a>')
  expect(html).toContain(`>http://localhost/c/${C}</code>`)
})

test('an AI answer: a bare address is a chip, a Markdown link keeps its words', async () => {
  const { md } = await loadMarkdown()
  named('project', P, 'Launch plan')
  const html = renderToStaticMarkup(<MemoryRouter><md.Markdown text={`Open http://localhost/projects/${P} or [this one](http://localhost/projects/${P}).`} /></MemoryRouter>)
  expect(html).toContain('Launch plan')
  expect(html.split('data-testid="app-link-chip"').length - 1).toBe(1)
  expect(html).toContain('>this one</a>')
})
