// Lists, Search and Settings open at once (docs/DECISIONS.md "Lists, Search and Settings open at once";
// src/store/listCache.ts): a list read once shows at once the next time and is read again behind it; one request at
// a time per list; a change made here or an event while a read is on its way reads once more after it; a read started
// before a sign-out never lands. 팀 스킬 asks for its lists side by side (it was five requests one after another);
// Search asks again only after SEARCH_LIST_AGE_MS or a change; the "paused for review" banner mounting again does not
// read the tasks again; a thread closed a moment ago opens with its replies while its newest page is read.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { markStale, peekCached, putCached, readCached, readSchedules, scheduleKey, SHARED, useListCache } from '../../src/store/listCache'
import { schedulesChanged, skillsChanged } from '../../src/store/live'
import { optimistic } from '../../src/lib/optimistic'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import Skills from '../../src/pages/Skills'
import ScheduleReviewBanner from '../../src/components/ScheduleReviewBanner'
import { installDom, mount, removeDom } from './dom-host'
import { BEN, message, room } from './rooms-fixtures'

setDefaultTimeout(30_000)
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const me = { user: { id: 'mia', username: 'mia', name: 'Mia', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'en' }, session: { id: '01900000-0000-7000-8000-000000000099', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, timeZone: 'Asia/Seoul' } } as unknown as Me

/** every request, as "GET /path?query", with the time it was asked */
const reads: { key: string; at: number }[] = []
/** answers held back until released */
let hold: Promise<void> | null = null
let schedules: unknown[] = []
const overview = { managedFolders: ['skills'], suggestFolders: ['skills'], pendingReview: 0, myPending: 0, sharesToReview: 0 }
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const statusBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    reads.push({ key: `${init?.method ?? 'GET'} ${url.pathname}${url.search}`, at: performance.now() })
    if (hold) await hold
    switch (url.pathname) {
      case '/api/skills/overview': return json(200, overview)
      case '/api/skills/suggestions': return json(200, { items: [], nextCursor: null })
      case '/api/skills/shares': return json(200, { items: [] })
      case '/api/skills/issues': return json(200, { items: [] })
      case '/api/skills/popular': return json(200, { items: [] })
      case '/api/skills': return json(200, { items: [{ path: 'skills/acme-notes/SKILL.md', name: 'acme-notes', description: 'Notes for Acme', title: 'Acme notes' }] })
      case '/api/schedules': return json(200, { items: schedules, timeZone: 'Asia/Seoul' })
      default: return json(404, { error: { code: 'not_found', message: url.pathname } })
    }
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: statusBefore })
})
beforeEach(() => {
  reads.length = 0
  hold = null
  schedules = []
  useListCache.getState().reset()
})
afterEach(() => useListCache.getState().reset())

const count = (re: RegExp) => reads.filter((r) => re.test(r.key)).length
const later = () => new Promise((r) => setTimeout(r, 5))

describe('the cache', () => {
  test('one request at a time per key; a screen joins a read on its way; what was read stays when a read fails', async () => {
    let n = 0
    const read = () => Promise.resolve(++n)
    await Promise.all([readCached('acme', read), readCached('acme', read)])
    expect(n).toBe(1)
    expect(peekCached<unknown>('acme')).toBe(1)
    await expect(readCached('acme', () => Promise.reject(new Error('down')))).rejects.toThrow('down')
    expect(peekCached<unknown>('acme')).toBe(1)
  })

  test('asked again with `fresh` while a read is on its way: once more after it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let n = 0
    const read = async () => { const mine = ++n; if (mine === 1) await gate; return mine }
    const first = readCached('acme', read)
    void readCached('acme', read, { fresh: true })
    void readCached('acme', read, { fresh: true })
    release()
    await first
    while (peekCached<unknown>('acme') !== 2) await later()
    expect(n).toBe(2)
  })

  test('a change made here while a read is on its way: that answer is dropped and read again', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let server = ['a', 'b']
    let n = 0
    const read = async () => { if (++n === 1) await gate; return server.slice() }
    await readCached('acme', () => Promise.resolve(['a', 'b']))
    const p = readCached('acme', read)
    // deleted here: shown at once; the read on its way answered with it still there
    putCached<string[]>('acme', (cur) => cur!.filter((x) => x !== 'b'))
    expect(peekCached<unknown>('acme')).toEqual(['a'])
    const answered = server
    server = ['a']
    release()
    await p
    expect(answered).toEqual(['a', 'b'])
    expect(n).toBe(2)
    expect(peekCached<unknown>('acme')).toEqual(['a'])
  })

  test('`minAgeMs`: a read that recent is enough until something marks it stale', async () => {
    let n = 0
    const read = () => Promise.resolve(++n)
    await readCached('search:acme', read, { minAgeMs: 60_000 })
    await readCached('search:acme', read, { minAgeMs: 60_000 })
    expect(n).toBe(1)
    markStale('search:')
    await readCached('search:acme', read, { minAgeMs: 60_000 })
    expect(n).toBe(2)
    // an event the stores hear whether a screen shows the list or not
    await readCached('skills:list', read, { minAgeMs: 60_000 })
    skillsChanged.emit()
    await readCached('skills:list', read, { minAgeMs: 60_000 })
    expect(n).toBe(4)
  })

  test('a read started before a sign-out never lands, and the sign-out empties every list', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    await readCached('kept', () => Promise.resolve('mia\'s'))
    const p = readCached('late', async () => { await gate; return 'mia\'s' })
    useListCache.getState().reset()
    release()
    await p
    expect(peekCached<unknown>('late')).toBeUndefined()
    expect(peekCached<unknown>('kept')).toBeUndefined()
  })
})

describe('팀 스킬', () => {
  test('the lists are asked side by side, and a visit after the first shows them at once with one read behind', async () => {
    let release!: () => void
    hold = new Promise((r) => (release = r))
    let m = await mount(<MemoryRouter><Skills /></MemoryRouter>)
    await m.settle(30)
    // nothing answered yet: the overview, my suggestions, the skills and their issues are all on their way
    for (const re of [/\/api\/skills\/overview/, /scope=mine/, /\/api\/skills\?shadowed=1/, /\/api\/skills\/issues/]) expect(count(re), String(re)).toBe(1)
    expect(m.html()).toContain('animate-pulse')
    release()
    hold = null
    await m.until(() => m.find('skill-search'), 'the skills tab')
    // what the overview said there is to review comes after it, in the second round
    await m.until(() => count(/scope=review/) === 1, 'the review list')
    await m.unmount()

    reads.length = 0
    hold = new Promise((r) => (release = r))
    m = await mount(<MemoryRouter><Skills /></MemoryRouter>)
    // the last lists at once, before any answer
    expect(m.find('skill-search')).toBeTruthy()
    expect(m.html()).not.toContain('animate-pulse')
    expect(m.html()).toContain('Acme notes')
    release()
    hold = null
    await m.until(() => count(/scope=review/) === 1, 'the read behind it')
    expect(count(/\/api\/skills\/overview/)).toBe(1)
    await m.unmount()
  })
})

describe('the "paused for review" banner', () => {
  test('mounting again (Settings opening) does not read the tasks again; a change of a task does', async () => {
    schedules = [{ id: 's1', title: 'Acme report', prompt: 'x', repeat: 'daily', time: '09:00', date: null, weekday: null, day: null, projectId: null, enabled: false, needsReview: true,
      nextRunAt: null, lastRunAt: null, lastChatId: null, resumeBlockedReason: null }]
    let m = await mount(<MemoryRouter initialEntries={['/']}><ScheduleReviewBanner /></MemoryRouter>)
    await m.until(() => m.find('schedule-review-banner'), 'the banner')
    await m.unmount()
    m = await mount(<MemoryRouter initialEntries={['/settings/profile']}><ScheduleReviewBanner /></MemoryRouter>)
    // shown at once from what was read
    expect(m.find('schedule-review-banner')).toBeTruthy()
    await m.settle(50)
    expect(count(/\/api\/schedules/)).toBe(1)
    schedules = []
    schedulesChanged.emit()
    await m.until(() => !m.find('schedule-review-banner'), 'the banner gone after the task was checked')
    expect(count(/\/api\/schedules/)).toBe(2)
    await m.unmount()
  })
})

describe('a task switched on or off while the answer is on its way', () => {
  test('a Search read of the tasks does not bring the old value back; the list keeps the new one', async () => {
    const task = { id: 'acme-report', title: 'Acme report', prompt: 'x', repeat: 'daily', time: '09:00', date: null, weekday: null, day: null, projectId: null, enabled: true, needsReview: false,
      nextRunAt: null, lastRunAt: null, lastChatId: null, resumeBlockedReason: null }
    schedules = [task]
    putCached(SHARED.schedules, () => ({ items: [task], timeZone: 'Asia/Seoul' }))
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const done = optimistic({
      key: scheduleKey(task.id), from: true, to: false,
      show: (v) => putCached<{ items: typeof task[] }>(SHARED.schedules, (d) => ({ ...d!, items: d!.items.map((x) => ({ ...x, enabled: v })) })),
      send: async () => { await gate; return { ...task, enabled: false } },
      confirmed: (u) => u.enabled,
      settle: () => {},
    })
    // the server still says "on": Search reads the shared list the way it does
    await readCached(SHARED.schedules, readSchedules, { fresh: true })
    expect(peekCached<{ items: typeof task[] }>(SHARED.schedules)?.items[0]?.enabled).toBe(false)
    release()
    await done
  })
})

describe('a thread closed a moment ago', () => {
  const r = room()
  const root = message({ roomId: r.id, seq: 1, body: 'the plan for acme' })
  const reply = message({ roomId: r.id, seq: 2, threadRootId: root.id, body: 'looks good', author: BEN })
  beforeEach(() => {
    useRooms.getState().reset()
    useRooms.setState({ rooms: [r], loaded: true })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      reads.push({ key: `GET ${url.pathname}`, at: performance.now() })
      if (url.pathname.endsWith('/thread')) {
        if (hold) await hold
        return json(200, { root, items: [reply], nextCursor: null })
      }
      return json(404, { error: { code: 'not_found', message: url.pathname } })
    }) as unknown as typeof fetch
  })
  afterEach(() => useRooms.getState().reset())
  const view = () => useRooms.getState().threadViews[`${r.id}/${root.id}`]

  test('opens with its root and replies while its newest page is read', async () => {
    useRooms.getState().openThread(r.id, root.id)
    while (view()!.loading) await later()
    useRooms.getState().closeThread(r.id, root.id)
    let release!: () => void
    hold = new Promise((res) => (release = res))
    useRooms.getState().openThread(r.id, root.id)
    expect(view()).toMatchObject({ loading: true, root: { id: root.id } })
    expect(view()!.replies.map((m) => m.body)).toEqual(['looks good'])
    release()
    hold = null
    while (view()!.loading) await later()
    expect(count(/\/thread$/)).toBe(2)
  })

  test('a change in it meanwhile (an edit) forgets it: it opens from the server as before', async () => {
    useRooms.getState().openThread(r.id, root.id)
    while (view()!.loading) await later()
    useRooms.getState().closeThread(r.id, root.id)
    useRooms.getState().handleEvent({ type: 'room.message.updated', data: { roomId: r.id, message: { ...reply, body: '', deletedAt: reply.createdAt } } } as never)
    let release!: () => void
    hold = new Promise((res) => (release = res))
    useRooms.getState().openThread(r.id, root.id)
    expect(view()!.replies).toEqual([])
    release()
    hold = null
    while (view()!.loading) await later()
  })

  test('a sign-out forgets it', async () => {
    useRooms.getState().openThread(r.id, root.id)
    while (view()!.loading) await later()
    useRooms.getState().closeThread(r.id, root.id)
    useRooms.getState().reset()
    useRooms.setState({ rooms: [r], loaded: true })
    let release!: () => void
    hold = new Promise((res) => (release = res))
    useRooms.getState().openThread(r.id, root.id)
    expect(view()!.replies).toEqual([])
    release()
    hold = null
    while (view()!.loading) await later()
  })
})
