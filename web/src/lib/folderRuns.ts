// The folder uploads of this tab (components/FolderUploads.tsx shows them). Here and not in the component, so that the
// session store can stop them without loading the file screen.
import { create } from 'zustand'
import type { FolderUpload, FolderUploadView } from './folderUpload'
import { SIGNED_OUT } from './localData'

/** A run started by a screen that comes back to it: the welcome steps' 팀 파일 (docs/DECISIONS.md "W6"), which reopens on
 * its newest run (F4 while it runs, F5 after), never on its start. */
export type RunTag = 'welcome-files'

export interface Run {
  run: FolderUpload
  view: FolderUploadView
  /** a refusal stopped the run: said once, in a toast too (the person may be on another page) */
  onRefused: (view: FolderUploadView) => void
  tag?: RunTag
}

/** `tagged`: the newest run of each tag, kept after its row leaves the file screen (a finished run's row goes after a few
 * seconds; the step still shows what it did) until sign-out. */
export const useRuns = create<{ runs: Run[]; settled: number; tagged: Partial<Record<RunTag, Run>> }>(() => ({ runs: [], settled: 0, tagged: {} }))

/** The newest run of a tag in this tab, or null. */
export const taggedRun = (tag: RunTag): Run | null => useRuns.getState().tagged[tag] ?? null

const forgotten = new Set<() => void>()
/** What else of the last person goes at sign-out (the welcome step's list of picked files). */
export const onFolderUploadsForgotten = (fn: () => void) => { forgotten.add(fn) }

let generation = 0
/** Moves on at each sign-out: a dropped folder is read for a while before its run starts, and the person may be gone. */
export const folderGeneration = () => generation

/** Sign-out or the end of a session: the next person in this tab sees no path of the last one's folders, and the rest of
 * a folder never goes up with the next person's session. */
export function forgetFolderUploads() {
  generation++
  const s = useRuns.getState()
  for (const r of new Set([...s.runs, ...Object.values(s.tagged)])) r?.run.stop(SIGNED_OUT)
  useRuns.setState({ runs: [], tagged: {} })
  for (const fn of forgotten) fn()
}
