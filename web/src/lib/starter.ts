// What a new member lands on after joining with a team link that carries a starter (docs/DECISIONS.md "M — One meeting
// note, everyone's own tasks"; shared/src/api/team-links.ts JoinStarter): the team files the lead put in, the skill and
// the question. The join page holds it for the new account, Home reads it (pages/Home.tsx: one line, the box filled in,
// the files attached) until the first message is sent. Kept per person in this tab (sessionStorage, so a reload before
// sending keeps it; another tab or browser never sees it) with a copy in memory for when storage is blocked. Signing out
// forgets it.
import { JoinStarter } from '@mycel/shared/api'

const PREFIX = 'mycel.starter:'

interface Held { starter: JoinStarter; attached: boolean }
const memory = new Map<string, Held>()

const session = (): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function write(userId: string, h: Held) {
  memory.set(userId, h)
  try { session()?.setItem(PREFIX + userId, JSON.stringify(h)) } catch { /* storage full or blocked: the copy in memory stays */ }
}

function read(userId: string): Held | null {
  const mem = memory.get(userId)
  if (mem) return mem
  try {
    const raw = session()?.getItem(PREFIX + userId)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<Held>
    const s = JoinStarter.safeParse(v?.starter)
    if (!s.success) return null
    const h = { starter: s.data, attached: v.attached === true }
    memory.set(userId, h)
    return h
  } catch {
    return null
  }
}

/** The join page: keep the starter for the new account (it replaces one held before). */
export function holdStarter(userId: string, starter: JoinStarter) {
  write(userId, { starter, attached: false })
}

/** The starter held for this person, or null. */
export const heldStarter = (userId: string): JoinStarter | null => read(userId)?.starter ?? null

/** Its files went into the box once: a page shown again (a reload keeps the box's chips by itself) does not add them
 * again. */
export const starterAttached = (userId: string): boolean => read(userId)?.attached ?? false
export function markStarterAttached(userId: string) {
  const h = read(userId)
  if (h && !h.attached) write(userId, { ...h, attached: true })
}

/** The first message went out: Home is the usual Home again. */
export function clearStarter(userId: string) {
  memory.delete(userId)
  try { session()?.removeItem(PREFIX + userId) } catch { /* storage blocked */ }
}

/** Sign-out: nothing of it stays for the next person in this tab. */
export function forgetStarters() {
  memory.clear()
  byMemory.clear()
  const s = session()
  try {
    const keys: string[] = []
    for (let i = 0; i < (s?.length ?? 0); i++) {
      const k = s!.key(i)
      if (k?.startsWith(PREFIX) || k?.startsWith(BY_PREFIX)) keys.push(k)
    }
    for (const k of keys) s!.removeItem(k)
  } catch { /* storage blocked */ }
}

// Who made the team skill a new member lands on (docs/DECISIONS.md "S — The lead's way becomes a team skill"): the join
// answer's `skillBy`, for the one line above that skill's form ("지훈님이 만든 팀 스킬이에요 · 이 채팅은 민지님만 봐요").
// Held per person in this tab like the starter, until the form is closed or run.
const BY_PREFIX = 'mycel.madeBy:'
const byMemory = new Map<string, { path: string; by: string }>()

/** The join page: the maker of the link's skill, for its form. */
export function holdMadeBy(userId: string, path: string, by: string) {
  byMemory.set(userId, { path, by })
  try { session()?.setItem(BY_PREFIX + userId, JSON.stringify({ path, by })) } catch { /* the copy in memory stays */ }
}

/** The maker held for this person and this skill, or null. */
export function heldMadeBy(userId: string, path: string): string | null {
  let h = byMemory.get(userId) ?? null
  if (!h) {
    try {
      const v = JSON.parse(session()?.getItem(BY_PREFIX + userId) ?? 'null') as { path?: unknown; by?: unknown } | null
      if (v && typeof v.path === 'string' && typeof v.by === 'string' && v.by.trim()) h = { path: v.path, by: v.by }
    } catch { h = null }
  }
  return h && h.path === path ? h.by : null
}

export function clearMadeBy(userId: string) {
  byMemory.delete(userId)
  try { session()?.removeItem(BY_PREFIX + userId) } catch { /* storage blocked */ }
}
