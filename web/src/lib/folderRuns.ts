// The folder uploads of this tab (components/FolderUploads.tsx shows them). Here and not in the component, so that the
// session store can stop them without loading the file screen.
import { create } from 'zustand'
import type { FolderUpload, FolderUploadView } from './folderUpload'
import { SIGNED_OUT } from './localData'

export interface Run {
  run: FolderUpload
  view: FolderUploadView
  /** a refusal stopped the run: said once, in a toast too (the person may be on another page) */
  onRefused: (view: FolderUploadView) => void
}

export const useRuns = create<{ runs: Run[]; settled: number }>(() => ({ runs: [], settled: 0 }))

let generation = 0
/** Moves on at each sign-out: a dropped folder is read for a while before its run starts, and the person may be gone. */
export const folderGeneration = () => generation

/** Sign-out or the end of a session: the next person in this tab sees no path of the last one's folders, and the rest of
 * a folder never goes up with the next person's session. */
export function forgetFolderUploads() {
  generation++
  for (const r of useRuns.getState().runs) r.run.stop(SIGNED_OUT)
  useRuns.setState({ runs: [] })
}
