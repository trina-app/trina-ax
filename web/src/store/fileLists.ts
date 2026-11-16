// 파일's lists as this window last read them (docs/DECISIONS.md "Projects and Files lists open at once"): the team
// folder's top (GET /api/files/tree?path=, the places beside the rail and the phone's 파일 tab: components/panels/
// FilesPanel.tsx), 최근 파일 (GET /api/files/recent, pages/RecentFiles.tsx) and Shared with me (GET
// /api/files/shared-with-me, pages/SharedFiles.tsx: its first page or pages, read on from `next` by the page). Going back to 파일 shows them at once and
// reads each again behind it, one request at a time (asked again after a change meanwhile: once more after it); a file event, an access change or a live connection that could
// not resume reads again while they are on screen. Emptied on sign-out (App.tsx dropPersonStores): nothing of one
// person's files stays for the next.
import { create } from 'zustand'
import type { FileEntry, SharedWithMeItem } from '@mycel/shared/api'
import { api, API } from '../lib/api'

/** how many recent files the list shows (the server's newest first) */
export const RECENT_LIMIT = 50

/** Shared with me as read so far: the rows, and where to read on (null: all read) */
export interface SharedList { items: SharedWithMeItem[]; next: string | null }
/** a read of Shared with me keeps asking for the next page until it has this many new rows (about a screen)… */
export const SHARED_SCREEN = 20
/** …or it made this many calls (a person with many hidden team-wide shares gets empty pages with `next` set) */
export const SHARED_CHAIN_MAX = 10

interface FileListsState {
  /** the entries of the team folder's top as the server listed them; null before the first read ends */
  top: FileEntry[] | null
  /** the recent files (files only); null before the first read ends */
  recent: FileEntry[] | null
  /** Shared with me; null before the first read ends */
  shared: SharedList | null
  reset: () => void
}

/** a read started before a reset (another person signed in since) never lands */
let generation = 0
type Key = 'top' | 'recent' | 'shared'
const inFlight: Record<Key, Promise<void> | null> = { top: null, recent: null, shared: null }
/** asked again while a read was on its way (a file event: its answer may be from before the change): once more after it */
const again: Record<Key, boolean> = { top: false, recent: false, shared: false }

export const useFileLists = create<FileListsState>((set) => ({
  top: null,
  recent: null,
  shared: null,
  reset: () => {
    generation++
    inFlight.top = inFlight.recent = inFlight.shared = null
    again.top = again.recent = again.shared = false
    set({ top: null, recent: null, shared: null })
  },
}))

function once<T>(key: Key, read: () => Promise<T>, fresh: boolean): Promise<void> {
  const running = inFlight[key]
  if (running) {
    if (fresh) again[key] = true
    return running
  }
  const mine = generation
  const p: Promise<void> = read()
    .then((items) => {
      if (mine === generation) useFileLists.setState({ [key]: items } as Partial<FileListsState>)
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

/** Pages of Shared with me from `from` (null: the top), added to `have` (a row read twice is kept once), until a
 * screen's worth of new rows, the end, or SHARED_CHAIN_MAX calls */
async function sharedPages(from: string | null, have: SharedWithMeItem[]): Promise<SharedList> {
  const seen = new Set(have.map((i) => i.linkId))
  const items = [...have]
  let next = from
  for (let calls = 0; calls < SHARED_CHAIN_MAX; calls++) {
    const r = await api.call(API.sharedWithMe, { query: next ? { cursor: next } : {} })
    for (const i of r.items) if (!seen.has(i.linkId)) { seen.add(i.linkId); items.push(i) }
    next = r.next
    if (!next || items.length - have.length >= SHARED_SCREEN) break
  }
  return { items, next }
}

/** Read Shared with me again from the top (rejects when it fails; what was there stays). `fresh`: as for readTeamTop. */
export const readSharedWithMe = (o: { fresh?: boolean } = {}): Promise<void> => once('shared', () => sharedPages(null, []), !!o.fresh)

/** Read on from where the list stopped (the page's end came into view, or Load more). Nothing while a read runs. */
export function readMoreShared(): Promise<void> {
  const cur = useFileLists.getState().shared
  if (!cur?.next || inFlight.shared) return inFlight.shared ?? Promise.resolve()
  const mine = generation
  const p: Promise<void> = sharedPages(cur.next, cur.items)
    .then((more) => {
      // a read from the top meanwhile (a change) wins
      if (mine === generation && useFileLists.getState().shared === cur) useFileLists.setState({ shared: more })
    })
    .finally(() => {
      if (inFlight.shared === p) inFlight.shared = null
    })
  inFlight.shared = p
  return p
}
