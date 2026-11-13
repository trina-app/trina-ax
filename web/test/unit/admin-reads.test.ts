// The admin screens' kept reads (store/adminPeople.ts) against a fake REST server (global fetch): one request for
// everyone who asks at once, a fresh answer used again, any change made from this window makes the kept answers old,
// sign-out drops them (and an answer that arrives after it), and room picture addresses carry the sign-in's media key.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { api, API, roomFileUrl, setMediaKey } from '../../src/lib/api'
import { FRESH_MS, keptAdminRead, loadAdminGroups, loadAdminUsers, readAdmin, resetAdminReads } from '../../src/store/adminPeople'

const realFetch = globalThis.fetch
const realNow = Date.now
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
let calls: string[] = []
let gate: Promise<void> | null = null
const G1 = '01a1d005-df10-72c9-b9b1-a29d6ec204f3'
let groups = [{ id: G1, name: 'acme', description: null, memberIds: [] as string[] }]

beforeEach(() => {
  calls = []
  gate = null
  resetAdminReads()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}${url.search}`)
    if (gate) await gate
    if (method !== 'GET') return new Response(null, { status: 204 })
    if (url.pathname === '/api/admin/groups') return json({ items: groups })
    if (url.pathname === '/api/admin/users') return json({ items: [] })
    return json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  Date.now = realNow
  setMediaKey(null)
})

test('everyone who asks at once shares one request; a fresh answer is used again without asking', async () => {
  const [a, b] = await Promise.all([readAdmin('groups', loadAdminGroups), readAdmin('groups', loadAdminGroups)])
  expect(a).toEqual(b)
  expect(calls).toEqual(['GET /api/admin/groups'])
  await readAdmin('groups', loadAdminGroups)
  expect(calls).toHaveLength(1)
  // older than FRESH_MS: asked again
  const t0 = realNow()
  Date.now = () => t0 + FRESH_MS + 1
  await readAdmin('groups', loadAdminGroups)
  expect(calls).toHaveLength(2)
  // a screen's Reload asks at once
  await readAdmin('groups', loadAdminGroups, { force: true })
  expect(calls).toHaveLength(3)
})

test('a change made from this window makes every kept answer old (still shown until the new one is in)', async () => {
  await readAdmin('groups', loadAdminGroups)
  groups = [{ id: G1, name: 'acme sales', description: null, memberIds: [] }]
  await api.call(API.updateGroup, { params: { id: G1 }, body: { name: 'acme sales' } }).catch(() => {})
  expect(keptAdminRead<typeof groups>('groups')?.[0]?.name).toBe('acme')
  expect((await readAdmin('groups', loadAdminGroups))[0]?.name).toBe('acme sales')
  expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(2)
})

test('an answer to a request that left before a change is not taken as fresh', async () => {
  let open!: () => void
  gate = new Promise((r) => { open = r })
  const first = readAdmin('groups', loadAdminGroups)
  const change = api.call(API.updateGroup, { params: { id: G1 }, body: { name: 'x' } }).catch(() => {})
  open()
  await Promise.all([first, change])
  gate = null
  await readAdmin('groups', loadAdminGroups)
  expect(calls.filter((c) => c === 'GET /api/admin/groups')).toHaveLength(2)
})

test('sign-out drops every kept answer, and an answer that arrives after it is thrown away', async () => {
  await readAdmin('users', loadAdminUsers)
  expect(keptAdminRead('users')).toEqual([])
  resetAdminReads()
  expect(keptAdminRead('users')).toBeUndefined()
  let open!: () => void
  gate = new Promise((r) => { open = r })
  const late = readAdmin('groups', loadAdminGroups)
  resetAdminReads()
  open()
  await late
  expect(keptAdminRead('groups')).toBeUndefined()
})

test('a failed read keeps nothing and the next one asks again', async () => {
  const fail = () => Promise.reject(new Error('down'))
  await expect(readAdmin('budgets', fail)).rejects.toThrow('down')
  expect(keptAdminRead('budgets')).toBeUndefined()
  expect(await readAdmin('budgets', async () => [1])).toEqual([1])
})

test('room picture addresses carry the sign-in\'s media key; a download never does; signed out none', () => {
  expect(roomFileUrl('r1', 'f1', { thumb: '1' })).toBe('/api/rooms/r1/files/f1?thumb=1')
  setMediaKey('abcDEF_-0123456789abcd')
  expect(roomFileUrl('r1', 'f1', { thumb: '1' })).toBe('/api/rooms/r1/files/f1?thumb=1&k=abcDEF_-0123456789abcd')
  expect(roomFileUrl('r1', 'f1')).toBe('/api/rooms/r1/files/f1?k=abcDEF_-0123456789abcd')
  expect(roomFileUrl('r1', 'f1', { download: '1' })).toBe('/api/rooms/r1/files/f1?download=1')
  setMediaKey(null)
  expect(roomFileUrl('r1', 'f1')).toBe('/api/rooms/r1/files/f1')
})
