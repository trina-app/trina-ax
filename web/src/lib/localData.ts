// What this browser keeps for the signed-in person: unsent drafts (per person, so a shared computer never shows one
// person's draft to the next), messages waiting for an answer to end (lib/sendQueue.ts) and remembered unfinished
// uploads; on a phone, the other tabs' stacks (sessionStorage). Signing out clears them all.

const DRAFT_PREFIX = 'mycel.draft:'
/** lib/sendQueue.ts QUEUE_KEY_PREFIX (not imported: this file stays free of the API schemas) */
const QUEUE_PREFIX = 'mycel.queue:'
export const UPLOADS_KEY = 'mycel.uploads'
/** the phone's other tabs' stacks (lib/screenHistory.ts), in sessionStorage: the addresses that person opened */
export const TAB_STACKS_KEY = 'mycel.tabStacks'

/** Why an upload stops when the person signs out or the session ends, as opposed to a cancel: nothing is dropped on the
 * server (a request would be refused), and the same person can go on from the chunks that are there. */
export const SIGNED_OUT = new DOMException('signed out', 'AbortError')

export const draftKey = (userId: string, id: string) => `${DRAFT_PREFIX}${userId}:${id}`

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>
const local = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readDraft(userId: string, id: string, s: Store | null = local()): string {
  try { return s?.getItem(draftKey(userId, id)) ?? '' } catch { return '' }
}

export function writeDraft(userId: string, id: string, text: string, s: Store | null = local()) {
  try {
    if (text) s?.setItem(draftKey(userId, id), text)
    else s?.removeItem(draftKey(userId, id))
  } catch { /* storage full or blocked */ }
}

/** Forget drafts, waiting messages and remembered uploads of everyone on this browser, and this tab's saved phone
 * stacks (sign-out). */
export function clearLocalData(s: Store | null = local()) {
  if (!s) return
  try {
    const keys: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k && (k.startsWith(DRAFT_PREFIX) || k.startsWith(QUEUE_PREFIX) || k === UPLOADS_KEY)) keys.push(k)
    }
    for (const k of keys) s.removeItem(k)
  } catch { /* storage blocked */ }
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(TAB_STACKS_KEY)
  } catch { /* storage blocked */ }
}
