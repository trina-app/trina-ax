// A shared chat's row on a project page (pages/Projects.tsx ProjectChatRow) and in the Trina list, its history and the
// phone's drawer (nav/ChatItem.tsx), with components/chat/SharedChat.tsx ChatFaces (docs/DECISIONS.md "Faces in every
// chat list", amending "The faces on the project page"): the faces of the OTHER people who wrote in it (the server
// leaves me out), the most recent first, overlapping, at most 3 and then "+N" (2 on a phone); on a project page one
// other person with the name. Nobody else yet: the people icon, no face. The pictures say nothing to a screen reader:
// the row reads "공유 채팅 · Bob, Alex"; on a computer the shared tooltip lists the names on the faces, and while the
// row has keyboard focus. A private chat has no face and no icon. In the Trina list's rows no name shows, and the faces
// take the project tag's place (the project is said after the names).
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { Chat, type Me } from '@mycel/shared/api'
import { ProjectChatRow } from '../../src/pages/Projects'
import { ChatItem, useChatPeek } from '../../src/components/nav/ChatItem'
import { useProjects } from '../../src/store/projects'
import { TOOLTIP_DELAY_MS } from '../../src/components/Tooltip'
import { useLocaleStore } from '../../src/i18n'
import { usePeople } from '../../src/store/people'
import { useSession } from '../../src/store/session'
import { FakeEvent, installDom, mount, removeDom, type FakeElement } from './dom-host'

const ALEX = { id: 'alex', name: 'Alex' }
const BOB = { id: 'bob', name: 'Bob' }
const CHO = { id: 'cho', name: 'Cho' }
const DEV = { id: 'dev', name: 'Dev' }
const EVE = { id: 'eve', name: 'Eve' }
const me: Me = {
  user: { id: ALEX.id, username: 'alex', name: ALEX.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me

/** a chat of the project's list, parsed with the contract (a shared one when `shared` is given) */
const chat = (title: string, shared?: { by?: { id: string; name: string }; people?: { id: string; name: string }[]; peopleCount?: number }) => Chat.parse({
  id: '01900000-0000-7000-8000-0000000000c1', projectId: '01900000-0000-7000-8000-000000000001', title, engine: 'claude-code', model: null,
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: new Date(Date.now() - 60_000).toISOString(), deletedAt: null, runState: 'idle',
  ...(shared ? { shared: { by: shared.by ?? ALEX, audience: 5, answering: null, mine: true, canDelete: true, ...(shared.people ? { people: shared.people, peopleCount: shared.peopleCount ?? shared.people.length } : {}) } } : {}),
})

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
/** what GET /api/people answers */
let directory: { id: string; name: string; avatarVersion?: number }[] = []
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const media = (fine: boolean) => {
  ;(window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q: string) => ({ matches: fine && q.includes('fine'), addEventListener() {}, removeEventListener() {} } as never)
}
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).split('?')[0] === '/api/people') return json({ people: directory })
    return json({ error: { code: 'not_found', message: 'not here' } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  usePeople.getState().reset()
  useSession.setState({ status })
  useLocaleStore.setState({ locale: 'ko' })
  media(false)
})
afterAll(() => {
  globalThis.fetch = realFetch
  useLocaleStore.setState({ locale })
  removeDom()
})

const fire = (el: unknown, type: string, o: Record<string, unknown> = {}) => act(() => { (el as { dispatchEvent: (e: unknown) => void }).dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), o)) })
const tip = () => document.body.querySelector('[role="tooltip"]')
async function row(c: Chat) {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const page = await mount(<MemoryRouter><ProjectChatRow chat={c} /></MemoryRouter>)
  // a shared row reads the people directory itself
  if (c.shared?.people?.length) await page.until(() => usePeople.getState().loaded, 'the people directory')
  await page.settle()
  return page
}
/** a stack by its test id prefix */
const stack2 = (root: FakeElement, prefix: string) => {
  const s = root.querySelector(`[data-testid="${prefix}-people"]`)
  return s ? s.children.map((e) => ({ text: e.textContent, img: e.localName === 'img', cls: e.getAttribute('class') ?? '' })) : null
}
/** the faces' stack: its pictures and "+N" tiles, each with its class (which says where it shows) */
const stack = (root: FakeElement) => {
  const s = root.querySelector('[data-testid="project-chat-people"]')
  return s ? s.children.map((e) => ({ text: e.textContent, img: e.localName === 'img', cls: e.getAttribute('class') ?? '' })) : null
}
const label = (root: FakeElement, prefix = 'project-chat') => root.querySelector(`[data-testid="${prefix}-people-label"]`)?.textContent ?? null

test('one other person: their face and their name on a computer, no people icon; nobody else yet: the icon, no face', async () => {
  directory = [ALEX, BOB]
  let page = await row(chat('출시 일정', { by: BOB, people: [BOB] }))
  try {
    const link = page.get('project-chat')
    expect(stack(link)).toBeNull()
    expect(page.get('project-chat-by').textContent).toBe('Bob')
    // a phone keeps the face only (the name cut to "B.." said nothing; QA TC-1081); a screen reader reads the label
    expect(page.get('project-chat-by').className).toContain('max-md:hidden')
    expect(page.get('project-chat-by').getAttribute('aria-hidden')).toBe('true')
    expect(label(link)).toBe('공유 채팅 · Bob')
    // the letter on its tile, decorative
    expect(link.querySelectorAll('[aria-hidden="true"]').map((e) => e.textContent)).toContain('B')
    expect(page.find('project-chat-more')).toBeNull()
    // the faces take the people icon's place
    expect(page.find('shared-icon')).toBeNull()
  } finally { await page.unmount() }
  // nobody else wrote yet (or a chat that came without people): the people icon, no face, no name
  for (const c of [chat('빈 채팅', { by: BOB, people: [] }), chat('빈 채팅', { by: BOB })]) {
    page = await row(c)
    try {
      expect(page.find('project-chat-by')).toBeNull()
      expect(stack(page.get('project-chat'))).toBeNull()
      expect(label(page.get('project-chat'))).toBeNull()
      expect(page.get('shared-icon').getAttribute('aria-label')).toBe('공유 채팅')
    } finally { await page.unmount() }
  }
})

test('two people: two faces, the most recent first, no name and no "+N"; the row reads both names once', async () => {
  directory = [ALEX, { ...BOB, avatarVersion: 4 }]
  const page = await row(chat('출시 일정', { people: [BOB, ALEX] }))
  try {
    const link = page.get('project-chat')
    const faces = stack(link)!
    expect(faces.map((f) => f.img ? 'photo' : f.text)).toEqual(['photo', 'A'])
    expect(link.querySelector('img')!.getAttribute('src')).toContain('/api/people/bob/avatar')
    // overlapping, the first on top, each with a ring of the page's colour
    expect(faces[0]!.cls).toContain('z-[3]')
    expect(faces[1]!.cls).toMatch(/(^| )-ml-1( |$)/)
    expect(faces.every((f) => f.cls.includes('ring-canvas'))).toBe(true)
    expect(page.get('project-chat-people').getAttribute('aria-hidden')).toBe('true')
    expect(page.find('project-chat-by')).toBeNull()
    expect(page.find('shared-icon')).toBeNull()
    expect(label(link)).toBe('공유 채팅 · Bob, Alex')
    expect(link.textContent.match(/Bob/g)).toHaveLength(1)
  } finally { await page.unmount() }
})

test('three people: three faces on a computer, two and "+1" on a phone', async () => {
  directory = [ALEX, BOB, CHO]
  const page = await row(chat('출시 일정', { people: [CHO, BOB, ALEX] }))
  try {
    const faces = stack(page.get('project-chat'))!
    expect(faces.map((f) => f.text)).toEqual(['C', 'B', 'A', '+1'])
    // the third face is not on a phone; the "+1" only there
    expect(faces[2]!.cls).toContain('max-sm:hidden')
    expect(faces[3]!.cls).toContain('sm:hidden')
    expect(faces[3]!.cls).not.toContain('max-sm:hidden')
    expect(page.find('project-chat-more')).toBeNull()
    expect(label(page.get('project-chat'))).toBe('공유 채팅 · Cho, Bob, Alex')
  } finally { await page.unmount() }
})

test('five people: three faces and "+2" on a computer, two and "+3" on a phone; the names and the rest counted', async () => {
  directory = [ALEX, BOB, CHO, DEV, EVE]
  const page = await row(chat('출시 일정', { people: [EVE, DEV, CHO], peopleCount: 5 }))
  try {
    const faces = stack(page.get('project-chat'))!
    expect(faces.map((f) => f.text)).toEqual(['E', 'D', 'C', '+2', '+3'])
    expect(page.get('project-chat-more').getAttribute('class')).toContain('max-sm:hidden')
    expect(page.get('project-chat-more-phone').getAttribute('class')).toContain('sm:hidden')
    expect(label(page.get('project-chat'))).toBe('공유 채팅 · Eve, Dev, Cho 외 2명')
  } finally { await page.unmount() }
  // in English
  useLocaleStore.setState({ locale: 'en' })
  const en = await row(chat('Launch', { people: [EVE, DEV, CHO], peopleCount: 5 }))
  try { expect(label(en.get('project-chat'))).toBe('Shared chat · Eve, Dev, Cho and 2 more') } finally { await en.unmount() }
})

test('the tooltip lists the names: a mouse on the faces, or keyboard focus on the row; a click or blur takes it away', async () => {
  media(true)
  directory = [ALEX, BOB, CHO, DEV, EVE]
  const page = await row(chat('출시 일정', { people: [EVE, DEV, CHO], peopleCount: 5 }))
  try {
    const faces = page.get('project-chat-people')
    fire(faces, 'pointerover', { pointerType: 'mouse', relatedTarget: null })
    await page.settle(TOOLTIP_DELAY_MS + 50)
    expect(tip()?.textContent).toBe('Eve, Dev, Cho 외 2명')
    fire(faces, 'pointerout', { pointerType: 'mouse', relatedTarget: null })
    await page.settle(10)
    expect(tip()).toBeNull()
    // the row's link takes the focus (the faces take none): its keyboard focus shows the names at once
    const link = page.get('project-chat')
    fire(link, 'focusin')
    await page.settle(10)
    expect(tip()?.textContent).toBe('Eve, Dev, Cho 외 2명')
    fire(link, 'focusout')
    await page.settle(10)
    expect(tip()).toBeNull()
    // a press on the row (it opens the chat): no tip for the focus that comes with it
    fire(link, 'pointerdown', { pointerType: 'mouse' })
    fire(link, 'focusin')
    await page.settle(10)
    expect(tip()).toBeNull()
  } finally { await page.unmount() }
  // a finger: never
  media(false)
  const phone = await row(chat('출시 일정', { people: [BOB, ALEX] }))
  try {
    fire(phone.get('project-chat'), 'focusin')
    fire(phone.get('project-chat-people'), 'pointerover', { pointerType: 'touch', relatedTarget: null })
    await phone.settle(TOOLTIP_DELAY_MS + 50)
    expect(tip()).toBeNull()
  } finally { await phone.unmount() }
})

test('the names and photos are the directory\'s now; my photo from /api/me; a private chat has no face', async () => {
  directory = [{ ...BOB, name: 'Robert' }]
  useSession.setState({ status: { kind: 'signed-in', me: { ...me, user: { ...me.user, avatarVersion: 9 } } } } as never)
  let page = await mount(<MemoryRouter><ProjectChatRow chat={chat('출시 일정', { people: [BOB, ALEX] })} /></MemoryRouter>)
  try {
    await page.until(() => label(page.get('project-chat')) === '공유 채팅 · Robert, Alex', 'the directory\'s name')
    // Bob has no photo: his letter, now R; mine from /api/me
    expect(stack(page.get('project-chat'))!.map((f) => (f.img ? 'photo' : f.text))).toEqual(['R', 'photo'])
    expect(page.get('project-chat').querySelector('img')!.getAttribute('src')).toContain('/api/people/alex/avatar')
  } finally { await page.unmount() }
  page = await row(chat('내 메모'))
  try {
    const link = page.get('project-chat')
    expect(link.getAttribute('data-shared')).toBeNull()
    expect(stack(link)).toBeNull()
    expect(page.find('project-chat-by')).toBeNull()
    expect(page.find('shared-icon')).toBeNull()
    expect(link.querySelectorAll('[aria-hidden="true"]').map((e) => e.textContent)).toEqual([])
  } finally { await page.unmount() }
})

// ---- the Trina list's row (nav/ChatItem.tsx): the same faces, no name, in the list panel's colours ----

const P = '01900000-0000-7000-8000-000000000001'
function TrinaRow({ c, projectTag }: { c: Chat; projectTag?: boolean }) {
  const peek = useChatPeek()
  return <ul><ChatItem chat={c} onNavigate={() => {}} peek={peek} onMove={() => {}} projectTag={projectTag} /></ul>
}
async function trinaRow(c: Chat, projectTag = false) {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  const page = await mount(<MemoryRouter><TrinaRow c={c} projectTag={projectTag} /></MemoryRouter>)
  if (c.shared?.people?.length) await page.until(() => usePeople.getState().loaded, 'the people directory')
  await page.settle()
  return page
}
const projectsBefore = useProjects.getState()

test('a Trina list row: the others\' faces in place of the people icon, no name; the names in the label', async () => {
  directory = [ALEX, BOB, CHO, DEV, EVE]
  const page = await trinaRow(chat('출시 일정', { by: BOB, people: [EVE, DEV, CHO], peopleCount: 4 }))
  try {
    const li = page.container.querySelector('[data-chat-id]')!
    const faces = stack2(li, 'chat-row')!
    expect(faces.map((f) => f.text)).toEqual(['E', 'D', 'C', '+1', '+2'])
    // a list panel's colour around each face (not the page's)
    expect(faces.every((f) => f.cls.includes('ring-subtle'))).toBe(true)
    expect(li.querySelector('[data-testid="shared-icon"]')).toBeNull()
    expect(li.querySelector('[data-testid="chat-row-by"]')).toBeNull()
    expect(label(li, 'chat-row')).toBe('공유 채팅 · Eve, Dev, Cho 외 1명')
    // the pictures say nothing; each name is read once (in the label)
    expect(li.querySelector('[data-testid="chat-row-people"]')!.getAttribute('aria-hidden')).toBe('true')
    expect(li.textContent.match(/Eve/g)).toHaveLength(1)
  } finally { await page.unmount() }
})

test('a Trina list row: one other writer is a face only; nobody else: the people icon; a private chat: neither', async () => {
  directory = [ALEX, BOB]
  let page = await trinaRow(chat('출시 일정', { by: ALEX, people: [BOB] }))
  try {
    const li = page.container.querySelector('[data-chat-id]')!
    expect(stack2(li, 'chat-row')!.map((f) => f.text)).toEqual(['B'])
    expect(li.querySelector('[data-testid="chat-row-by"]')).toBeNull()
    expect(label(li, 'chat-row')).toBe('공유 채팅 · Bob')
    expect(li.querySelector('[data-testid="shared-icon"]')).toBeNull()
  } finally { await page.unmount() }
  // a shared chat only I wrote in: the icon as before, no face
  page = await trinaRow(chat('주간 보고', { people: [], peopleCount: 0 }))
  try {
    const li = page.container.querySelector('[data-chat-id]')!
    expect(li.querySelector('[data-testid="shared-icon"]')).toBeTruthy()
    expect(li.querySelector('[data-testid="chat-row-people"]')).toBeNull()
    expect(label(li, 'chat-row')).toBeNull()
  } finally { await page.unmount() }
  page = await trinaRow(chat('내 메모'))
  try {
    const li = page.container.querySelector('[data-chat-id]')!
    expect(li.querySelector('[data-testid="shared-icon"]')).toBeNull()
    expect(li.querySelector('[data-testid="chat-row-people"]')).toBeNull()
  } finally { await page.unmount() }
})

test('a Trina list row with its project tag: the faces take its place, the project after the names', async () => {
  directory = [ALEX, BOB, CHO]
  useProjects.setState({ byId: { [P]: { id: P, name: 'Board', folderPath: 'projects/board', inTrash: false } as never }, listed: null })
  try {
    let page = await trinaRow(chat('출시 일정', { people: [CHO, BOB], peopleCount: 2 }), true)
    try {
      const li = page.container.querySelector('[data-chat-id]')!
      expect(li.querySelector('[data-testid="chat-row-project"]')).toBeNull()
      expect(stack2(li, 'chat-row')!.map((f) => f.text)).toEqual(['C', 'B'])
      expect(label(li, 'chat-row')).toBe('공유 채팅 · Cho, Bob · Board')
      expect(li.textContent.match(/Board/g)).toHaveLength(1)
    } finally { await page.unmount() }
    // no faces (private, or nobody else wrote): the tag as before
    for (const c of [chat('내 메모'), chat('주간 보고', { people: [], peopleCount: 0 })]) {
      page = await trinaRow(c, true)
      try { expect(page.container.querySelector('[data-testid="chat-row-project"]')!.textContent).toBe('Board') } finally { await page.unmount() }
    }
  } finally { useProjects.setState(projectsBefore) }
})
