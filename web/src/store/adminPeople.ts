// What the admin screens read, kept for this window and shared by every admin tab (docs/DECISIONS.md "Admin reads are
// kept for a minute"): the members and groups lists above all (18 screens and dialogs use them), and a few other reads
// that one page asks for in several places (Team settings' AI engines and usage limits, Admin home's cards).
//
// - One request at a time per read: everything that asks while it is on its way waits for that one.
// - An answer is used again for FRESH_MS without asking; after that a screen shows it at once and asks again behind it.
// - Any change this window makes on the server (a request that is not GET or HEAD: lib/api.ts onApiWrite) makes every
//   kept answer old, so the next screen asks again (and still shows the last answer meanwhile). A screen's own Reload
//   after its change asks at once.
// - Signed out, or another person signed in in this window (App.tsx dropPersonStores): everything is dropped, and an
//   answer to a request made before that is thrown away.
import { useCallback, useEffect, useRef, useState } from 'react'
import { API, type Group, type User, type UsersResponse } from '@mycel/shared/api'
import { api, errorText, onApiWrite } from '../lib/api'
import { useLocale, useT } from '../i18n'

/** How long an answer is used again without asking the server. */
export const FRESH_MS = 60_000

interface Entry { data?: unknown; has: boolean; at: number; old: boolean; inflight?: Promise<unknown>; inflightWrites?: number; seq: number }

const entries = new Map<string, Entry>()
const listeners = new Map<string, Set<() => void>>()
/** bumped by resetAdminReads: an answer to a request made before it (the last person's) is dropped */
let generation = 0
let seq = 0
/** counts this window's changes on the server: an answer to a request that left before one is old at once */
let writes = 0

const entry = (key: string): Entry => {
  let e = entries.get(key)
  if (!e) entries.set(key, (e = { has: false, at: 0, old: false, seq: 0 }))
  return e
}
const notify = (key: string) => listeners.get(key)?.forEach((fn) => fn())

/** The kept answer for `key`, or undefined. */
export function keptAdminRead<T>(key: string): T | undefined {
  const e = entries.get(key)
  return e?.has ? (e.data as T) : undefined
}

/**
 * The answer to `fn` under `key`: the one on its way, else the kept one while it is younger than `maxAge` ms and no
 * change was made since, else a new request. `force`: always a new request (a screen's Reload, after its own change).
 * A failed request keeps nothing (the last good answer stays) and fails for every caller that waited for it.
 */
export function readAdmin<T>(key: string, fn: () => Promise<T>, o: { force?: boolean; maxAge?: number } = {}): Promise<T> {
  const e = entry(key)
  if (!o.force) {
    // a request that left before a change of this window may answer with what was there before it: not joined
    if (e.inflight && e.inflightWrites === writes) return e.inflight as Promise<T>
    if (e.has && !e.old && Date.now() - e.at < (o.maxAge ?? FRESH_MS)) return Promise.resolve(e.data as T)
  }
  const gen = generation
  const w = writes
  const mine = ++seq
  e.seq = mine
  const p: Promise<T> = fn().then((d) => {
    // only the latest request of this read sets it (a forced one may have started after this one)
    if (gen === generation && entries.get(key) === e && e.seq === mine) {
      Object.assign(e, { data: d, has: true, at: Date.now(), old: w !== writes })
      notify(key)
    }
    return d
  })
  e.inflight = p
  e.inflightWrites = w
  const done = () => { if (e.inflight === p) e.inflight = undefined }
  p.then(done, done)
  return p
}

/** Keep `data` as the newest answer for `key` (a screen's own save), shown on every screen that shows it: a read still
 * on its way that left before it does not replace it. */
export function putAdminRead<T>(key: string, data: T) {
  const e = entry(key)
  e.seq = ++seq
  Object.assign(e, { data, has: true, at: Date.now(), old: false })
  notify(key)
}

/** Every kept answer is old: the next read asks the server (the answers still show meanwhile). */
export function markAdminReadsOld(match?: (key: string) => boolean) {
  for (const [k, e] of entries) if (!match || match(k)) e.old = true
}

/** Drop kept answers (all, or those `match` picks): a screen that needs one asks again and shows nothing meanwhile. */
export function forgetAdminReads(match?: (key: string) => boolean) {
  if (!match) {
    generation++
    entries.clear()
    return
  }
  for (const k of [...entries.keys()]) if (match(k)) entries.delete(k)
}

/** Signed out, or another person signed in in this window: nothing of the last person's admin reads stays. */
export const resetAdminReads = () => forgetAdminReads()

// any change this window makes on the server: what is kept may be old now
onApiWrite(() => {
  writes++
  markAdminReadsOld()
})

/**
 * useLoad (pages/admin/common.tsx) over a kept read: starts from the kept answer (no skeleton on a revisit) and asks
 * the server only when that answer is old (readAdmin). `key` names what is read, and must change with whatever `fn`
 * depends on. `reload` asks at once; `setData` changes the kept answer for every screen that shows it.
 */
export function useAdminRead<T>(key: string, fn: () => Promise<T>, o: { maxAge?: number } = {}) {
  const t = useT()
  const locale = useLocale()
  const [data, setLocal] = useState<T | null>(() => keptAdminRead<T>(key) ?? null)
  const now = useRef(data)
  now.current = data
  const [error, setError] = useState<string | null>(null)
  const [cause, setCause] = useState<unknown>(null)
  const run = useCallback(async (force: boolean) => {
    try {
      const d = await readAdmin(key, fn, { force, maxAge: o.maxAge })
      // the kept answer when there is one: newer than `d` when a screen's own save came in meanwhile
      setLocal(keptAdminRead<T>(key) ?? d)
      setError(null)
      setCause(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
      setCause(e)
    }
    // `fn` is named by `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, o.maxAge])
  useEffect(() => {
    const kept = keptAdminRead<T>(key)
    setLocal(kept ?? null)
    let set = listeners.get(key)
    if (!set) listeners.set(key, (set = new Set()))
    const on = () => { const d = keptAdminRead<T>(key); if (d !== undefined) { setLocal(d); setError(null); setCause(null) } }
    set.add(on)
    void run(false)
    return () => { set.delete(on) }
  }, [key, run])
  const reload = useCallback(() => run(true), [run])
  const setData = useCallback((v: T | null | ((d: T | null) => T | null)) => {
    const next = typeof v === 'function' ? (v as (d: T | null) => T | null)(now.current) : v
    now.current = next
    setLocal(next)
    if (next === null) return
    // the screen's own answer (a save's) is the newest, on every screen that shows it (this one included)
    putAdminRead(key, next)
  }, [key])
  return { data, error, cause, reload, setData }
}

// ---------------- the people lists ----------------

const usersNoAi = () => api.call(API.listUsers, { query: { noAi: '1' } })
/** Every member (GET /api/admin/users). */
export const loadAdminUsers = async () => {
  // the list with "No AI" has the same people: a fresh one is used as it is
  const e = entries.get('users:noAi')
  if (e?.has && !e.old && Date.now() - e.at < FRESH_MS) return (e.data as UsersResponse).items
  return (await api.call(API.listUsers)).items
}
/** Every group with its members (GET /api/admin/groups). */
export const loadAdminGroups = async () => (await api.call(API.listGroups)).items

/** Open invites (GET /api/admin/invites): Admin › Members, Admin home, the owner's checklist. */
export const loadAdminInvites = async () => (await api.call(API.listInvites)).items
/** The AI engines as the admin sees them (GET /api/admin/engines): Team settings, Admin home, the owner's checklist. */
export const loadAdminEngines = () => api.call(API.engines)

/** Admin › Members, Admin home: everyone, with who cannot use AI now ("No AI") and who asked to be deleted. */
export const useAdminUsersNoAi = () => useAdminRead<UsersResponse>('users:noAi', usersNoAi)

/** Every member of the team (admin list). `on` false: nothing is read and the list stays empty (an admin who may not
 * see it). */
export function useAdminUsers(on = true) {
  const r = useAdminRead<User[]>(on ? 'users' : 'users:none', on ? loadAdminUsers : async () => [])
  return r
}

/** Every group with its members (admin list). `on` false: nothing is read and the list stays empty. */
export function useAdminGroups(on = true) {
  return useAdminRead<Group[]>(on ? 'groups' : 'groups:none', on ? loadAdminGroups : async () => [])
}

/** Start reading the people lists now (a page whose parts that need them show only after its own read). */
export function preloadAdminPeople() {
  void readAdmin('users', loadAdminUsers).catch(() => {})
  void readAdmin('groups', loadAdminGroups).catch(() => {})
}
