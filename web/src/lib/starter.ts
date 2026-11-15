// What older versions kept per person in this tab (sessionStorage) for a team link's starter and for who made the
// link's skill: nothing writes them any more (docs/DECISIONS.md "DS3", "A new member lands on Home"), and signing out
// clears what an older version left.

const OLD_PREFIXES = ['mycel.starter:', 'mycel.madeBy:']

/** Sign-out: nothing an older version kept stays for the next person in this tab. */
export function forgetStarters() {
  try {
    const s = typeof sessionStorage === 'undefined' ? null : sessionStorage
    if (!s) return
    const keys: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k && OLD_PREFIXES.some((p) => k.startsWith(p))) keys.push(k)
    }
    for (const k of keys) s.removeItem(k)
  } catch { /* storage blocked */ }
}
