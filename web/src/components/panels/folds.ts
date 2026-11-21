// Folds a person chose in the lists (a section, a folder, a group), kept on their account (prefs.listFolds, PATCH
// /api/me; docs/decisions/20261116-collapsible-chat-sections.md), so a section folded on the phone is folded on the
// computer too. This browser keeps a copy: a server that does not keep them yet, or a save that failed, still remembers
// here (a private window may refuse: it just forgets). Folds kept only in this browser before (older versions) are sent
// to the account once. Keys: `folder:<id>` (a Trina folder), `room-folder:<id>` (a room folder), `section:<list>:<key>`
// (a section's label).
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { LIST_FOLDS_MAX, ListFoldKey, type ListFolds } from '@mycel/shared/api'
import { useMeStrict, useSession } from '../../store/session'

export type Fold = 'open' | 'folded'
const foldKey = (userId: string) => `mycel.trina.groupFolds.${userId}`
function readLocal(key: string): ListFolds {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, Fold] => (e[1] === 'open' || e[1] === 'folded') && ListFoldKey.safeParse(e[0]).success))
  } catch {
    return {}
  }
}
function writeLocal(key: string, v: ListFolds) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* not kept in this browser */
  }
}

/** `folds` with `group` set to `v` as the newest choice, the oldest dropped past LIST_FOLDS_MAX */
export function withFold(folds: ListFolds, group: string, v: Fold): ListFolds {
  const next = { ...folds }
  delete next[group]
  next[group] = v
  return Object.fromEntries(Object.entries(next).slice(-LIST_FOLDS_MAX))
}

const save = (v: ListFolds) => {
  try {
    void useSession.getState().updatePrefs({ listFolds: v }).catch(() => { /* the browser's copy keeps it here */ })
  } catch {
    /* the same */
  }
}

// this browser's copy, one for every list on screen (a section's header and the list that draws its rows read the same)
const copies = new Map<string, ListFolds>()
const listeners = new Set<() => void>()
const subscribe = (f: () => void) => {
  listeners.add(f)
  return () => void listeners.delete(f)
}
function copyOf(key: string): ListFolds {
  let v = copies.get(key)
  if (!v) copies.set(key, (v = readLocal(key)))
  return v
}
function keepCopy(key: string, v: ListFolds) {
  copies.set(key, v)
  writeLocal(key, v)
  for (const f of listeners) f()
}

/** people whose browser-only folds were sent up in this page's life (once each) */
const sentUp = new Set<string>()

/** The person's folds: the account's, else this browser's copy; `set` keeps a choice on both. */
export function useFolds() {
  const userId = useMeStrict().user.id
  const key = foldKey(userId)
  const account = useSession((s) => (s.status.kind === 'signed-in' ? s.status.me.user.prefs?.listFolds : undefined))
  const local = useSyncExternalStore(subscribe, () => copyOf(key))
  const folds = account ?? local
  // folds chosen in this browser before the account kept them: sent up once (the account then decides)
  useEffect(() => {
    if (account || sentUp.has(userId)) return
    sentUp.add(userId)
    const kept = copyOf(key)
    if (Object.keys(kept).length) save(kept)
  }, [account, key, userId])
  const set = useCallback(
    (group: string, v: Fold) => {
      const st = useSession.getState().status
      const now = (st.kind === 'signed-in' ? st.me.user.prefs?.listFolds : undefined) ?? copyOf(key)
      const next = withFold(now, group, v)
      keepCopy(key, next)
      save(next)
    },
    [key],
  )
  return { folds, set }
}
