// The room AI's failed answers after a reconnect or a reload (store/rooms.ts loadAi; QA TC-241): a run a restart cut ended
// while nobody was connected, so the server lists my failed ones of the last day (GET /api/rooms/:id/ai) and the window
// shows "답하지 못했어요" under the question (EndedRun); one I closed stays closed in this browser after the next read.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { uuidv7, type Me, type RoomAiRun } from '@mycel/shared/api'
import { closedRuns, useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { at, ME, room } from './rooms-fixtures'

const realFetch = globalThis.fetch
const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const stored = new Map<string, string>()
let answer: { answering: number; mine: RoomAiRun[] } = { answering: 0, mine: [] }
beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) } })
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as unknown as Me } })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://team.localhost').pathname
    const body = path.endsWith('/ai') ? answer : path.endsWith('/ai/requests') ? { items: [] } : null
    return body ? new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response(JSON.stringify({ error: { code: 'not_found', message: 'gone' } }), { status: 404 })
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage')
  useSession.setState({ status: { kind: 'loading' } })
  useRooms.getState().reset()
})

test('a failed answer the server lists shows after the read; closed, it stays closed after the next read (and a reload)', async () => {
  const r = room()
  const run: RoomAiRun = { turnId: uuidv7(), roomId: r.id, questionId: uuidv7(), state: 'error', position: 0, steps: [], error: { code: 'unavailable', message: '서버가 다시 시작되어 답변이 중단됐어요.' }, createdAt: at(1) }
  answer = { answering: 0, mine: [run] }
  useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id })
  await useRooms.getState().loadAi(r.id)
  expect(useRooms.getState().ai[r.id]!.runs.map((x) => [x.turnId, x.state])).toEqual([[run.turnId, 'error']])
  useRooms.getState().dismissAi(r.id, run.turnId)
  expect(useRooms.getState().ai[r.id]!.runs).toEqual([])
  await useRooms.getState().loadAi(r.id)
  expect(useRooms.getState().ai[r.id]!.runs).toEqual([])
  // a reload: the window's own state is gone, the browser still knows it was closed
  useRooms.getState().reset()
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as unknown as Me } })
  useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id })
  await useRooms.getState().loadAi(r.id)
  expect(useRooms.getState().ai[r.id]!.runs).toEqual([])
  expect(closedRuns(ME.id).has(run.turnId)).toBe(true)
  // another person on this browser has their own list
  expect(closedRuns('someone-else').size).toBe(0)
})
