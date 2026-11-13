// 파일's two lists as this window last read them (docs/DECISIONS.md "Projects and Files lists open at once"): the team
// folder's top (GET /api/files/tree?path=, the places beside the rail and the phone's 파일 tab: components/panels/
// FilesPanel.tsx) and 최근 파일 (GET /api/files/recent, pages/RecentFiles.tsx). Going back to 파일 shows them at once and
// reads each again behind it, one request at a time (asked again after a change meanwhile: once more after it); a file event, an access change or a live connection that could
// not resume reads again while they are on screen. Emptied on sign-out (App.tsx dropPersonStores): nothing of one
// person's files stays for the next.
import { create } from 'zustand'
import type { FileEntry } from '@mycel/shared/api'
import { api, API } from '../lib/api'

/** how many recent files the list shows (the server's newest first) */
export const RECENT_LIMIT = 50

interface FileListsState {
  /** the entries of the team folder's top as the server listed them; null before the first read ends */
  top: FileEntry[] | null
  /** the recent files (files only); null before the first read ends */
  recent: FileEntry[] | null
  reset: () => void
}

/** a read started before a reset (another person signed in since) never lands */
let generation = 0
const inFlight: { top: Promise<void> | null; recent: Promise<void> | null } = { top: null, recent: null }
/** asked again while a read was on its way (a file event: its answer may be from before the change): once more after it */
const again = { top: false, recent: false }

export const useFileLists = create<FileListsState>((set) => ({
  top: null,
  recent: null,
  reset: () => {
    generation++
    inFlight.top = null
    inFlight.recent = null
    again.top = again.recent = false
    set({ top: null, recent: null })
  },
}))

function once(key: 'top' | 'recent', read: () => Promise<FileEntry[]>, fresh: boolean): Promise<void> {
  const running = inFlight[key]
  if (running) {
    if (fresh) again[key] = true
    return running
  }
  const mine = generation
  const p: Promise<void> = read()
    .then((items) => {
      if (mine === generation) useFileLists.setState({ [key]: items })
    })
    .finally(() => {
      if (inFlight[key] === p) inFlight[key] = null
    })
  inFlight[key] = p
  return p.then(
    () => {
      if (!again[key] || mine !== generation) return
      again[key] = false
      return once(key, read, false)
    },
    (e: unknown) => {
      again[key] = false
      throw e
    },
  )
}

/** Read the team folder's top again (rejects when it fails; what was there stays). `fresh`: after a change (an event), so
 * a read already on its way is followed by one more; without it (a list shown) that read is joined. */
export const readTeamTop = (o: { fresh?: boolean } = {}): Promise<void> => once('top', () => api.call(API.tree, { query: { path: '' } }).then((r) => r.entries), !!o.fresh)

/** Read 최근 파일 again (rejects when it fails; what was there stays). `fresh`: as for readTeamTop. */
export const readRecentFiles = (o: { fresh?: boolean } = {}): Promise<void> =>
  once('recent', () => api.call(API.recentFiles, { query: { limit: RECENT_LIMIT } }).then((r) => r.items.filter((f) => f.type === 'file')), !!o.fresh)
