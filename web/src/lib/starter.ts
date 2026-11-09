// Who made the team skill a new member lands on (docs/DECISIONS.md "S — The lead's way becomes a team skill"): the join
// answer's `skillBy`, for the one line above that skill's form ("지훈님이 만든 팀 스킬이에요 · 이 채팅은 민지님만 봐요").
// Held per person in this tab (sessionStorage, so a reload keeps it; another tab or browser never sees it) with a copy in
// memory for when storage is blocked, until the form is closed or run. Signing out forgets it. (The starter a team link
// could carry before, the lead's files and a question for 할 일 정리, went with that skill: docs/DECISIONS.md "DS3".)

/** what an older version kept per person in this tab for a link's starter: only cleared now */
const OLD_STARTER_PREFIX = 'mycel.starter:'
const BY_PREFIX = 'mycel.madeBy:'
const byMemory = new Map<string, { path: string; by: string }>()

const session = (): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** Sign-out: nothing of it stays for the next person in this tab. */
export function forgetStarters() {
  byMemory.clear()
  const s = session()
  try {
    const keys: string[] = []
    for (let i = 0; i < (s?.length ?? 0); i++) {
      const k = s!.key(i)
      if (k?.startsWith(OLD_STARTER_PREFIX) || k?.startsWith(BY_PREFIX)) keys.push(k)
    }
    for (const k of keys) s!.removeItem(k)
  } catch { /* storage blocked */ }
}

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
