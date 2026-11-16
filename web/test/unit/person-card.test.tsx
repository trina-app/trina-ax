// A person's card (components/PersonCard.tsx; docs/decisions/20261116-person-card.md): who gets a button (the people
// the directory lists for this viewer), what the card shows (name, title, the Guest tag; never more than the directory
// gives), Message for someone else and "Edit profile" for yourself, and an @mention of a person as that button.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7, type Me, type Person } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { PersonMarkdown } from '../../src/components/Markdown'
import { PersonButton } from '../../src/components/PersonCard'
import { usePeople } from '../../src/store/people'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'
import { BEN, CY, ME } from './rooms-fixtures'

const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'en' }, session: { id: uuidv7(), client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false } } as unknown as Me
const directory = (people: Person[]) => usePeople.setState({ people, loaded: true, byId: Object.fromEntries(people.map((p) => [p.id, p])) })

beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
})
afterEach(() => usePeople.getState().reset())
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }); useSession.setState({ status }) })

const face = (user: { id: string; name: string }) => <MemoryRouter><PersonButton user={user} look="face" boxClassName="box"><i>photo</i></PersonButton></MemoryRouter>

test('someone the directory lists: a button named after them; anyone else: the photo as it was, no button', async () => {
  directory([{ id: BEN.id, name: 'Ben' }])
  const known = await mount(face(BEN))
  try {
    const button = known.get('person-button')
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('aria-label')).toBe('About Ben')
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
  } finally { await known.unmount() }
  const unknown = await mount(face(CY))
  try {
    expect(unknown.container.innerHTML).toBe('<span class="box"><i>photo</i></span>')
  } finally { await unknown.unmount() }
})

test('the card of someone else: name, title, the Guest tag and Message; nothing the directory does not give', async () => {
  directory([{ id: BEN.id, name: 'Ben', title: 'Buyer', guest: true }, { id: ME.id, name: ME.name }])
  const m = await mount(face(BEN))
  try {
    expect(m.find('person-card')).toBeNull()
    await m.click('person-button')
    const card = m.get('person-card')
    expect(m.get('person-card-name').textContent).toBe('Ben')
    expect(m.get('person-card-title').textContent).toBe('Buyer')
    expect(card.querySelector('[data-testid="guest-tag"]')).toBeTruthy()
    expect(m.get('person-card-message').textContent).toBe('Message')
    // the one thing to do is the menu's item: the keyboard lands on it
    expect(m.get('person-card-message').getAttribute('role')).toBe('menuitem')
    expect(m.find('person-card-profile')).toBeNull()
    expect(card.querySelectorAll('button').length).toBe(1)
  } finally { await m.unmount() }
})

test('my own card: no Message, Edit profile instead', async () => {
  directory([{ id: ME.id, name: ME.name }])
  const m = await mount(face(ME))
  try {
    await m.click('person-button')
    expect(m.get('person-card').textContent).toContain('You')
    expect(m.find('person-card-message')).toBeNull()
    expect(m.get('person-card-profile').textContent).toBe('Edit profile')
    expect(m.find('guest-tag')).toBeNull()
    expect(m.find('person-card-title')).toBeNull()
  } finally { await m.unmount() }
})

test('an @mention of a person the directory lists is that button, in a <span> (it sits in a paragraph); "@all" and an unknown name stay words', async () => {
  directory([{ id: BEN.id, name: 'Ben' }])
  const m = await mount(
    <MemoryRouter>
      <PersonMarkdown text="Hi @Ben and @Cy Park and @all" mentions={[{ id: BEN.id, name: 'Ben' }, { id: CY.id, name: 'Cy Park' }, { id: 'all', name: 'all', all: true }]} />
    </MemoryRouter>,
  )
  try {
    const html = m.container.innerHTML
    const button = m.get('room-mention-person')
    expect(button.tagName).toBe('BUTTON')
    expect(button.textContent).toBe('@Ben')
    expect(button.getAttribute('aria-label')).toBe('About Ben')
    // its box is a <span>: a <div> may not stand in a paragraph
    expect(button.parentElement!.tagName).toBe('SPAN')
    expect(html).not.toContain('<div class="relative')
    // not in the directory: the name as words, in the mention's colour
    expect(html).toContain('<span class="font-medium text-accent-text">@Cy Park</span>')
    expect(html).toContain('<span class="font-medium text-accent-text" data-mention="all">@all</span>')
    expect(html.match(/<button/g)?.length).toBe(1)
  } finally { await m.unmount() }
})
