// Folds a person chose in the lists (a section, a folder, a group), kept on their account (prefs.listFolds, PATCH
// /api/me; docs/decisions/20261116-collapsible-chat-sections.md), so a section folded on the phone is folded on the
// computer too. This browser keeps a copy: a server that does not keep them yet, or a save that failed, still remembers
// here (a private window may refuse: it just forgets). Folds kept only in this browser before (older versions) are sent
// to the account once. Keys: `folder:<id>` (a Trina folder), `room-folder:<id>` (a room folder), `section:<list>:<key>`
// (a section's label).
import { useCallback, useEffect, useState } from 'react'
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

/** people whose browser-only folds were sent up in this page's life (once each) */
const sentUp = new Set<string>()

/** The person's folds: the account's, else this browser's copy; `set` keeps a choice on both. */
export function useFolds() {
  const userId = useMeStrict().user.id
  const key = foldKey(userId)
  const account = useSession((s) => (s.status.kind === 'signed-in' ? s.status.me.user.prefs?.listFolds : undefined))
  // this browser's copy, read again when the person changes (another account in this window)
  const [local, setLocal] = useState(() => ({ key, folds: readLocal(key) }))
  const folds = account ?? (local.key === key ? local.folds : readLocal(key))
  // folds chosen in this browser before the account kept them: sent up once (the account then decides)
  useEffect(() => {
    if (account || sentUp.has(userId)) return
    sentUp.add(userId)
    const local = readLocal(key)
    if (Object.keys(local).length) save(local)
  }, [account, key, userId])
  const set = useCallback(
    (group: string, v: Fold) => {
      const st = useSession.getState().status
      const now = (st.kind === 'signed-in' ? st.me.user.prefs?.listFolds : undefined) ?? readLocal(key)
      const next = withFold(now, group, v)
      writeLocal(key, next)
      setLocal({ key, folds: next })
      save(next)
    },
    [key],
  )
  return { folds, set }
}
