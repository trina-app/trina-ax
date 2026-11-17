// The move dialog and a chat that would arrive private (QA MAN-003; docs/decisions/20261117-move-dialog-says-only-me.md):
// a move never shares (TC-1075), so when a team project is picked the dialog says the chat stays "Only me" and offers
// "Move and share": it moves the chat, then opens the share confirm (TC-1073: sharing can't be undone, it asks first).
// A personal project, "No project" and a chat already shared show neither.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Chat, Project } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { MoveToProjectDialog } from '../../src/components/chat/ChatProject'
import { ShareChatHost } from '../../src/components/chat/ShareChat'
import { useSession } from '../../src/store/session'
import { act } from 'react'
import { FakeElement, FakeEvent, installDom, mount, removeDom } from './dom-host'

const TEAM = '01900000-0000-7000-8000-0000000000b1', MINE = '01900000-0000-7000-8000-0000000000b2', C1 = '01900000-0000-7000-8000-0000000000b3'
const project = (id: string, name: string, folderPath: string, audience: number): Project =>
  ({ id, name, folderPath, instructions: '', createdBy: null, createdAt: '2026-11-03T00:00:00.000Z', canEdit: true, audience, shareChats: true } as Project)
const chat = (o: Partial<Chat> = {}): Chat =>
  ({ id: C1, projectId: null, title: 'Quote for Hanbit Co laptops', engine: 'claude-code', model: null, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', deletedAt: null, runState: 'idle', ...o } as Chat)
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const en = (k: Parameters<typeof translate>[1]) => translate('en', k)

const calls: { key: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'pras', name: 'pras', role: 'owner' }, groups: [], team: { name: 'QA', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (key === 'GET /api/projects') return json(200, { items: [project(TEAM, 'QA-Quotes', 'projects/QA-Quotes', 3), project(MINE, 'My notes', 'users/pras/projects/notes', 1)] })
    if (key === `PATCH /api/chats/${C1}`) return json(200, chat({ projectId: TEAM }))
    if (key === `POST /api/chats/${C1}/share`) return json(200, { status: 'confirm', confirmKey: 'k1', audience: 3, check: { added: 2, memoryAnswers: 0, fileAnswers: 0, accountAnswers: 0, places: [], otherPlaces: false, roomsUnseen: false, unchecked: 0 } })
    return json(500, { error: { code: 'internal', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status: sessionBefore })
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})

const radios = (m: Awaited<ReturnType<typeof mount>>) => m.get('chat-project-choices').querySelectorAll('input')
/** a click on a radio checks it (past React's value tracker, as a browser does), then React hears the click */
const pick = async (m: Awaited<ReturnType<typeof mount>>, i: number) => {
  const radio = radios(m)[i]!
  await act(async () => {
    Object.getOwnPropertyDescriptor(FakeElement.prototype, 'checked')!.set!.call(radio, true)
    radio.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true }))
  })
}

test('a team project picked: the dialog says the chat stays "Only me" and offers Move and share', async () => {
  const m = await mount(<MemoryRouter><MoveToProjectDialog chat={chat()} onClose={() => {}} onMoved={() => {}} /></MemoryRouter>)
  await m.until(() => m.find('chat-project-choices'), 'the projects', 2000)
  expect(m.find('chat-project-stays-private')).toBeNull()
  expect(m.find('chat-project-save-share')).toBeNull()
  // [No project, QA-Quotes, My notes]
  await pick(m, 1)
  expect(m.get('chat-project-stays-private').textContent).toBe(en('chat.project.staysPrivate'))
  expect(m.get('chat-project-save-share').textContent).toBe(en('chat.project.moveAndShare'))
  expect(en('chat.project.staysPrivate')).toBe("The chat stays “Only me” after the move. The project's people see it only after you share it.")
  // a personal project: nobody else would see it anyway
  await pick(m, 2)
  expect(m.find('chat-project-stays-private')).toBeNull()
  expect(m.find('chat-project-save-share')).toBeNull()
  await m.unmount()
})

test('a chat that is already shared: no line, no button', async () => {
  const m = await mount(<MemoryRouter><MoveToProjectDialog chat={chat({ shared: { count: 3 } } as unknown as Partial<Chat>)} onClose={() => {}} onMoved={() => {}} /></MemoryRouter>)
  await m.until(() => m.find('chat-project-choices'), 'the projects', 2000)
  await pick(m, 1)
  expect(m.find('chat-project-stays-private')).toBeNull()
  expect(m.find('chat-project-save-share')).toBeNull()
  await m.unmount()
})

test('Move and share: the move first, then the share confirm asks (nothing is shared without it)', async () => {
  calls.length = 0
  let closed = 0
  const m = await mount(<MemoryRouter><MoveToProjectDialog chat={chat()} onClose={() => closed++} onMoved={() => {}} /><ShareChatHost /></MemoryRouter>)
  await m.until(() => m.find('chat-project-choices'), 'the projects', 2000)
  await pick(m, 1)
  await m.click('chat-project-save-share')
  expect(closed).toBe(1)
  await m.until(() => calls.some((c) => c.key === `POST /api/chats/${C1}/share`), 'the share check', 2000)
  const order = calls.map((c) => c.key).filter((k) => k !== 'GET /api/projects')
  expect(order[0]).toBe(`PATCH /api/chats/${C1}`)
  expect(calls.find((c) => c.key === `PATCH /api/chats/${C1}`)!.body).toEqual({ projectId: TEAM })
  // the share flow asks first (ask: true), and its confirm shows
  expect(calls.find((c) => c.key === `POST /api/chats/${C1}/share`)!.body).toEqual({ ask: true })
  await m.until(() => m.find('share-chat-confirm'), 'the share confirm', 2000)
  expect(calls.filter((c) => c.key === `POST /api/chats/${C1}/share`).length).toBe(1)
  await m.unmount()
})
