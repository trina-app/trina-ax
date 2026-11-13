// Folds a person chose in the panels' lists (a section, a folder, a group), remembered per person in this browser (a
// private window may refuse: it just forgets). Keys: `folder:<id>` (a Trina folder), `room-folder:<id>` (a room
// folder), `section:<panel>:<key>` (a section's label).
import { useCallback, useState } from 'react'
import { useMeStrict } from '../../store/session'

/** at most this many chosen folds are remembered (the latest first) */
const FOLDS_MAX = 200

export type Fold = 'open' | 'folded'
const foldKey = (userId: string) => `mycel.trina.groupFolds.${userId}`
function readFolds(key: string): Record<string, Fold> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, Fold] => e[1] === 'open' || e[1] === 'folded'))
  } catch {
    return {}
  }
}

/** The person's chosen folds in this browser (a private window may refuse: it just forgets). */
export function useFolds() {
  const key = foldKey(useMeStrict().user.id)
  const [state, setState] = useState(() => ({ key, folds: readFolds(key) }))
  const folds = state.key === key ? state.folds : readFolds(key)
  const set = useCallback(
    (group: string, v: Fold) => {
      const next = { ...readFolds(key) }
      delete next[group]
      next[group] = v
      const kept = Object.fromEntries(Object.entries(next).slice(-FOLDS_MAX))
      try {
        localStorage.setItem(key, JSON.stringify(kept))
      } catch {
        /* not kept */
      }
      setState({ key, folds: kept })
    },
    [key],
  )
  return { folds, set }
}

