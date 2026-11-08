// A room's AI cards come back when the room is read (store/rooms.ts loadAi with GET /api/rooms/:id/ai/requests): after a
// reload, in another browser or after a reconnect the server could not resume, the turn.request that opened a card is
// not sent again. The cards go where the socket puts them (store/chats.ts requests, which RoomAiStatus shows under my
// run), merged as a chat's are (mergeOpenRequests): the server's list for this room's questions of mine, plus a card that
// came over the socket while the list was on its way; one closed meanwhile stays closed; other rooms' and chats' cards
// are left alone. An older server without the list: the cards that come over the socket, as before.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { uuidv7, type Me, type OpenTurnRequest, type RoomAiRun } from '@mycel/shared/api'
import { mergeOpenRequests, useChats } from '../../src/store/chats'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { at, ME, room } from './rooms-fixtures'

const realFetch = globalThis.fetch
let calls: string[] = []
let routes: Record<string, unknown | (() => Promise<unknown>)> = {}
beforeEach(() => {
  calls = []
  routes = {}
  useRooms.getState().reset()
  useChats.getState().reset()
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as unknown as Me } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://team.localhost').pathname
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    const r = routes[path]
    const body = typeof r === 'function' ? await (r as () => Promise<unknown>)() : r
    return body === undefined ? new Response(JSON.stringify({ error: { code: 'not_found', message: 'gone' } }), { status: 404, headers: { 'content-type': 'application/json' } }) : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  // later files (in Linux CI's file order) expect no half-made session
  useSession.setState({ status: { kind: 'loading' } })
  useRooms.getState().reset()
  useChats.getState().reset()
})

const CHAT = uuidv7()
const runOf = (roomId: string, o: Partial<RoomAiRun> = {}): RoomAiRun => ({ turnId: uuidv7(), roomId, questionId: uuidv7(), state: 'running', position: 0, steps: [], error: null, createdAt: at(1), ...o })
const card = (turnId: string, requestId: string, chatId = CHAT): OpenTurnRequest => ({
  turnId, chatId, messageId: uuidv7(),
  request: { kind: 'ask_user', origin: 'server', requestId, question: '트리나가 영업/견적서에 새 파일을 저장하려고 해요: 견적서_acme.md.', multiple: false, allowText: false, buttons: true, options: [{ label: '이번만 허용', value: 'allow' }, { label: '이 방에서는 항상 허용', value: 'always' }, { label: '허용 안 함', value: 'skip' }] },
})
const ids = () => Object.keys(useChats.getState().requests).sort()

test('opening the room brings back the open card of my question (a reload, another browser)', async () => {
  const r = room()
  const run = runOf(r.id)
  const open = card(run.turnId, 'room-card-1')
  routes[`/api/rooms/${r.id}/ai`] = { answering: 1, mine: [run] }
  routes[`/api/rooms/${r.id}/ai/requests`] = { items: [open] }
  await useRooms.getState().loadAi(r.id)
  expect(calls).toEqual([`GET /api/rooms/${r.id}/ai`, `GET /api/rooms/${r.id}/ai/requests`])
  expect(useRooms.getState().ai[r.id]!.runs.map((x) => x.turnId)).toEqual([run.turnId])
  // where RoomAiStatus finds it: by the run's turn
  expect(useChats.getState().requests['room-card-1']).toEqual(open)
})

test("read again (a reconnect): a card the server no longer lists goes; another room's card and a chat's stay", async () => {
  const r = room()
  const other = room()
  const run = runOf(r.id)
  const elsewhere = runOf(other.id)
  const chatCard = card(uuidv7(), 'chat-card', uuidv7())
  useRooms.setState({ ai: { [r.id]: { answering: 1, runs: [run] }, [other.id]: { answering: 1, runs: [elsewhere] } } })
  useChats.setState({ requests: { gone: card(run.turnId, 'gone'), 'other-room': card(elsewhere.turnId, 'other-room'), 'chat-card': chatCard } })
  routes[`/api/rooms/${r.id}/ai`] = { answering: 1, mine: [run] }
  routes[`/api/rooms/${r.id}/ai/requests`] = { items: [card(run.turnId, 'next')] }
  await useRooms.getState().loadAi(r.id)
  expect(ids()).toEqual(['chat-card', 'next', 'other-room'])
})

test('a card that opens or closes over the socket while the list is on its way is not undone by it', async () => {
  const r = room()
  const run = runOf(r.id)
  let release!: () => void
  const gate = new Promise<void>((x) => (release = x))
  routes[`/api/rooms/${r.id}/ai`] = { answering: 1, mine: [run] }
  // computed before "closing" was answered in another window and before "new" opened
  routes[`/api/rooms/${r.id}/ai/requests`] = async () => { await gate; return { items: [card(run.turnId, 'closing')] } }
  const loading = useRooms.getState().loadAi(r.id)
  await new Promise((x) => setTimeout(x, 0))
  const h = useChats.getState().handleEvent
  h({ type: 'turn.request', seq: 1, at: 0, data: card(run.turnId, 'new') })
  h({ type: 'turn.request.closed', seq: 2, at: 0, data: { turnId: run.turnId, requestId: 'closing', reason: 'answered' } })
  release()
  await loading
  expect(ids()).toEqual(['new'])
})

test('another member: no questions of mine, no cards (the server lists none); an older server without the list leaves the cards alone', async () => {
  const r = room()
  routes[`/api/rooms/${r.id}/ai`] = { answering: 1, mine: [] }
  routes[`/api/rooms/${r.id}/ai/requests`] = { items: [] }
  await useRooms.getState().loadAi(r.id)
  expect(useRooms.getState().ai[r.id]).toEqual({ answering: 1, runs: [] })
  expect(ids()).toEqual([])
  // an older server: /ai answers, the list is a 404
  const run = runOf(r.id)
  useChats.setState({ requests: { live: card(run.turnId, 'live') } })
  delete routes[`/api/rooms/${r.id}/ai/requests`]
  routes[`/api/rooms/${r.id}/ai`] = { answering: 1, mine: [run] }
  await useRooms.getState().loadAi(r.id)
  expect(ids()).toEqual(['live'])
})

test('mergeOpenRequests: a chat by its id, or the cards a scope speaks for', () => {
  const a = uuidv7(), b = uuidv7()
  const current = { x: card(a, 'x'), y: card(b, 'y') }
  // by chat id (both cards are in CHAT): x and y were open, the list has only z
  expect(Object.keys(mergeOpenRequests(current, CHAT, [card(a, 'z')], new Set(['x', 'y']))).sort()).toEqual(['z'])
  // by turn: only turn a's cards are spoken for
  expect(Object.keys(mergeOpenRequests(current, (r) => r.turnId === a, [card(a, 'z')], new Set(['x', 'y']))).sort()).toEqual(['y', 'z'])
  // a listed card outside the scope is not taken
  expect(Object.keys(mergeOpenRequests({}, (r) => r.turnId === a, [card(b, 'w')], new Set()))).toEqual([])
})
