// Unsaved changes kept in memory when a phone leaves a page that saves with a button (docs/DECISIONS.md "Admin and
// Settings on phones", the form pages): Team settings' groups are pages of their own there, so Back to the list, or out
// of Team settings, would otherwise drop a half-made change without a word. What was kept comes back when the page
// opens again, in this tab, for the same person and session, and never undoes a value saved since:
// - a form whose fields save together (Team settings' form): only the changed fields are kept, laid over what is saved
//   when the page opens again (keepChanges / takeChanges);
// - a part that saves on its own (AI defaults, who picks the engine, the dev environment): its whole draft, put back
//   only when what is saved is still what it was edited from (keepDraft / takeDraft / useKeptDraft).
// Kept until the page opens again or the app reloads; computers keep nothing (as before).
import { useEffect, useRef } from 'react'
import { useMediaQuery } from '../components/ui'
import { useMeStrict } from '../store/session'

const kept = new Map<string, { who: string; saved: string | null; draft: unknown }>()

/** The fields of `draft` that differ from `saved`. */
export const changesOf = <T extends object>(draft: T, saved: T): Partial<T> =>
  Object.fromEntries(Object.entries(draft).filter(([k, v]) => saved[k as keyof T] !== v)) as Partial<T>

/** Keep the changed fields of a form (nothing to keep: forget what was kept). */
export function keepChanges<T extends object>(id: string, who: string, saved: T, draft: T) {
  const changes = changesOf(draft, saved)
  if (Object.keys(changes).length) kept.set(id, { who, saved: null, draft: changes })
  else kept.delete(id)
}

/** What was kept, laid over `fresh` (what is saved now), once; null when nothing was kept by this person and session. */
export function takeChanges<T extends object>(id: string, who: string, fresh: T): T | null {
  const k = kept.get(id)
  kept.delete(id)
  return k && k.who === who ? { ...fresh, ...(k.draft as Partial<T>) } : null
}

/** Keep a part's whole draft, with the saved value it was edited from (the same as saved: forget what was kept). */
export function keepDraft(id: string, who: string, saved: unknown, draft: unknown) {
  const s = JSON.stringify(saved)
  if (JSON.stringify(draft) !== s) kept.set(id, { who, saved: s, draft })
  else kept.delete(id)
}

/** The kept draft, once, when the same person and session kept it over the same saved value; else null. */
export function takeDraft<T>(id: string, who: string, saved: unknown): T | null {
  const k = kept.get(id)
  kept.delete(id)
  return k && k.who === who && k.saved === JSON.stringify(saved) ? (k.draft as T) : null
}

/** Tests only. */
export const forgetKeptDrafts = () => kept.clear()

/** "user:session", the key a kept draft belongs to. */
export function useDraftOwner(): string {
  const me = useMeStrict()
  return `${me.user.id}:${me.session.id}`
}

/**
 * A part that saves on its own: on a phone its draft is kept when it goes away and put back when it shows again (see
 * the top). Call it after the effect that resets the draft from `saved`, so the draft put back wins on the first render.
 */
export function useKeptDraft<T>(id: string, saved: T, draft: T, setDraft: (d: T) => void) {
  const who = useDraftOwner()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const latest = useRef({ saved, draft, who, phone })
  latest.current = { saved, draft, who, phone }
  useEffect(() => {
    const d = takeDraft<T>(id, who, saved)
    if (d) setDraft(d)
    return () => {
      const l = latest.current
      if (l.phone) keepDraft(id, l.who, l.saved, l.draft)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
