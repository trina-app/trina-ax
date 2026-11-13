// Lists and small reads as this window last had them, by a key (docs/DECISIONS.md "Lists, Search and Settings open
// at once"): 팀 스킬, Search's lists, Settings › Connectors and Notifications, Scheduled tasks, 활동 and the
// conversations' 멘션·스레드. Going back to one shows what was there at once and reads it again behind it (the
// placeholder shows only on the very first read), as the rooms (#611) and the Projects and Files lists (#698) do.
//
// Two ways in:
// - readCached(key, read): one request at a time per key. A screen that shows joins a read already on its way; asked
//   with `fresh` (after an event, or a change made here) while one is on its way, it reads once more after it; with
//   `minAgeMs`, a read that recent is enough (Search, which opens many times a minute). An answer to a read started
//   before a change made here (putCached) is dropped and read again: it may not have that change. markStale(prefix)
//   (an event while the screen is not shown) makes the next `minAgeMs` read go to the server.
// - peekCached / rememberCached: a screen that keeps its own state (a sign-in under way, paging) starts from what it
//   showed last time and writes back what it shows; it still reads again itself when it mounts.
//
// Emptied on sign-out and when another person signs in (App.tsx dropPersonStores): nothing of one person's lists stays
// for the next, and a read started before that never lands.
import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { api, API } from '../lib/api'
import { isSkillsPath } from '../lib/skillIssues'
import { accessChanged, chatChanged, enginesChanged, filesChanged, integrationsChanged, reloadAsked, schedulesChanged, skillsChanged } from './live'

interface ListCacheState {
  data: Readonly<Record<string, unknown>>
  reset: () => void
}

/** a read started before a reset (another person signed in since) never lands */
let generation = 0
const inFlight = new Map<string, Promise<void>>()
/** asked again with `fresh` while a read was on its way: once more after it */
const again = new Set<string>()
/** changes made here (putCached), per key: an answer to a read started before one may not have it */
const edits = new Map<string, number>()
/** when each key was last read from the server (absent: never, or marked stale since) */
const readAt = new Map<string, number>()

export const useListCache = create<ListCacheState>((set) => ({
  data: {},
  reset: () => {
    generation++
    inFlight.clear()
    again.clear()
    edits.clear()
    readAt.clear()
    set({ data: {} })
  },
}))

/** What is kept for `key` (undefined: nothing yet). */
export const peekCached = <T,>(key: string): T | undefined => useListCache.getState().data[key] as T | undefined

/** Keep what a screen shows now (no request; undefined forgets it). */
export function rememberCached<T>(key: string, value: T | undefined): void {
  const cur = useListCache.getState().data
  if (cur[key] === value) return
  if (value === undefined) {
    if (!(key in cur)) return
    const next = { ...cur }
    delete next[key]
    useListCache.setState({ data: next })
    return
  }
  useListCache.setState({ data: { ...cur, [key]: value } })
}

/** A change made here (a task saved, a list item gone): shown at once; a read already on its way is read again. */
export function putCached<T>(key: string, f: (cur: T | undefined) => T | undefined): void {
  edits.set(key, (edits.get(key) ?? 0) + 1)
  rememberCached(key, f(peekCached<T>(key)))
}

/** Something changed on the server for every key starting with `prefix`: the next read with `minAgeMs` asks again. */
export function markStale(prefix: string): void {
  for (const k of [...readAt.keys()]) if (k.startsWith(prefix)) readAt.delete(k)
}

/** Read `key` from the server (rejects when it fails; what was kept stays). */
export function readCached<T>(key: string, read: () => Promise<T>, o: { fresh?: boolean; minAgeMs?: number } = {}): Promise<void> {
  const running = inFlight.get(key)
  if (running) {
    if (o.fresh) again.add(key)
    return running
  }
  if (!o.fresh && o.minAgeMs) {
    const at = readAt.get(key)
    if (at !== undefined && Date.now() - at < o.minAgeMs && peekCached(key) !== undefined) return Promise.resolve()
  }
  const mine = generation
  const before = edits.get(key) ?? 0
  const started = Date.now()
  const p: Promise<void> = read()
    .then((value) => {
      if (mine !== generation) return
      // changed here meanwhile: this answer may be from before that change
      if ((edits.get(key) ?? 0) !== before) {
        again.add(key)
        return
      }
      readAt.set(key, started)
      rememberCached(key, value)
    })
    .finally(() => {
      if (inFlight.get(key) === p) inFlight.delete(key)
    })
  inFlight.set(key, p)
  return p.then(
    () => {
      if (mine !== generation || !again.has(key)) return
      again.delete(key)
      return readCached(key, read)
    },
    (e: unknown) => {
      again.delete(key)
      throw e
    },
  )
}

/**
 * A screen's cached read: what was kept for `key` at once, read again when the screen shows (and when `key` changes).
 * `failed`: the last read of this screen failed (what was kept still shows). `reload(fresh)`: read again (after an
 * event: `fresh`). `key` null: nothing is read.
 */
export function useCachedRead<T>(key: string | null, read: () => Promise<T>, o: { minAgeMs?: number } = {}) {
  const data = useListCache((s) => (key ? (s.data[key] as T | undefined) : undefined))
  const [failed, setFailed] = useState<unknown>(null)
  const fn = useRef(read)
  fn.current = read
  const life = useRef(0)
  const minAgeMs = o.minAgeMs
  const reload = useCallback((fresh = true): Promise<void> => {
    if (!key) return Promise.resolve()
    const mine = life.current
    return readCached(key, () => fn.current(), { fresh, minAgeMs: fresh ? undefined : minAgeMs }).then(
      () => { if (mine === life.current) setFailed(null) },
      (e: unknown) => { if (mine === life.current) setFailed(e ?? new Error('failed')) },
    )
  }, [key, minAgeMs])
  useEffect(() => {
    life.current++
    setFailed(null)
    void reload(false)
    return () => void life.current++
  }, [reload])
  return { data, failed, reload }
}

/** The reads more than one screen keeps under one key: Scheduled tasks and its banner and Search; Settings ›
 * Connectors and Search; the person's skills ("/name" order) for Search. */
export const SHARED = { schedules: 'schedules', integrations: 'integrations:list', skills: 'skills:list' } as const
export const readSchedules = () => api.call(API.listSchedules)
export const readIntegrations = () => api.call(API.listIntegrations)
export const readSkillList = () => api.call(API.listSkills).then((r) => r.items)

// what makes a kept list stale whether a screen shows it or not, so the next read with `minAgeMs` asks the server
skillsChanged.on(() => markStale('skills:'))
filesChanged.on((changes) => { if (changes.some((c) => isSkillsPath(c.path) || (c.from && isSkillsPath(c.from)))) markStale('skills:') })
schedulesChanged.on(() => markStale(SHARED.schedules))
integrationsChanged.on(() => markStale('integrations'))
chatChanged.on(() => markStale('search:recent'))
enginesChanged.on(() => markStale('settings:'))
accessChanged.on(() => markStale(''))
reloadAsked.on(() => markStale(''))
