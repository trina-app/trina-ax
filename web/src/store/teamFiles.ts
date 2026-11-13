// Team folders as this window last read them (docs/DECISIONS.md "Folders, project pages and file previews open at
// once"): a folder's first page (GET /api/files/tree?path=…&limit=200, the Files page, a project's page and a phone's
// project files), who can open a folder (GET /api/files/audience, the chip at the end of the breadcrumbs) and the bytes of
// a few small files the preview showed. Going back to a folder or a file shows them at once; the screen reads them again
// behind it. The team folder's own top beside the rail and 최근 파일 are store/fileLists.ts.
//
// Never wrong for long and never wider than the server: a file event drops the listing of the folders it touched and
// the bytes of the files it touched (those show their skeleton again); an access change or a live connection that could
// not resume drops everything; sign-out and another person signing in empty it (App.tsx dropPersonStores) and a read
// started before that never lands. An answer to a read started before a newer one of the same folder never lands
// either: the newest read wins.
import { create } from 'zustand'
import type { FolderAudience, TreeResponse } from '@mycel/shared/api'
import { api, API, isApiError } from '../lib/api'
import { parentPath } from '../lib/paths'
import { accessChanged, filesChanged, reloadAsked } from './live'

/** one page of a folder, as every screen that lists a folder asks for it */
export const FOLDER_PAGE = 200
/** how many folders, audiences and files stay (the oldest seen goes first) */
const KEPT_FOLDERS = 40
const KEPT_FILES = 8
/** a file's bytes stay only when this small (a preview of a big PDF or video is read again) */
const KEPT_FILE_BYTES = 1024 * 1024

/** The same folder however the address spells it (Unicode form; the server matches names case-sensitively). */
export const folderKey = (path: string) => path.normalize('NFC')

interface TeamFilesState {
  /** a folder's first page as the server last listed it, by folderKey */
  folders: Record<string, TreeResponse>
  /** who can open a folder as the server last answered it, by folderKey */
  audiences: Record<string, FolderAudience>
  reset: () => void
}

/** a read started before a reset (another person signed in since) never lands */
let generation = 0
/** the newest read of each folder started, while it is on its way: only its answer is kept */
const started = new Map<string, number>()
/** the reads of a folder's count or a file's bytes on their way, by key; those a file event or a drop came for since
 * they started (their answer is not kept) */
const waiting = new Map<string, Set<number>>()
const dropped = new Set<number>()
let keeps = 0
let reads = 0
/** the read on its way for a folder, which a screen just shown joins */
const running = new Map<string, Promise<TreeResponse>>()
/** recently kept files' bytes, oldest first (path|variant -> bytes) */
const files = new Map<string, Blob>()

/** keep at most `max` keys of `rec`: the ones written last */
function trimmed<T>(rec: Record<string, T>, max: number): Record<string, T> {
  const keys = Object.keys(rec)
  if (keys.length <= max) return rec
  return Object.fromEntries(keys.slice(keys.length - max).map((k) => [k, rec[k]!]))
}
/** `rec` with `key` written last (so it is the newest kept) */
function withLast<T>(rec: Record<string, T>, key: string, value: T, max: number): Record<string, T> {
  const next = { ...rec }
  delete next[key]
  next[key] = value
  return trimmed(next, max)
}
function without<T>(rec: Record<string, T>, keys: readonly string[]): Record<string, T> {
  if (!keys.some((k) => k in rec)) return rec
  const next = { ...rec }
  for (const k of keys) delete next[k]
  return next
}

export const useTeamFiles = create<TeamFilesState>((set) => ({
  folders: {},
  audiences: {},
  reset: () => {
    generation++
    started.clear()
    running.clear()
    waiting.clear()
    dropped.clear()
    files.clear()
    set({ folders: {}, audiences: {} })
  },
}))

/** What may have changed who sees what: nothing kept is shown again before it is read again. */
function forgetAll() {
  generation++
  started.clear()
  running.clear()
  waiting.clear()
  dropped.clear()
  files.clear()
  useTeamFiles.setState({ folders: {}, audiences: {} })
}

/** The folder as last listed, or null (never read, or dropped since). */
export const keptFolder = (path: string): TreeResponse | null => useTeamFiles.getState().folders[folderKey(path)] ?? null

/**
 * Read a folder's first page. A screen just shown joins a read of the same folder on its way; `fresh` (after a change
 * made here or an event: a read on its way may be from before it) always reads again. Only the newest read started
 * keeps its answer; every caller gets its own read's answer (the screen decides which one it shows). A folder that is
 * not there, or not this person's to see, any more is dropped.
 */
export function readFolder(path: string, o: { fresh?: boolean } = {}): Promise<TreeResponse> {
  const key = folderKey(path)
  const joined = running.get(key)
  if (joined && !o.fresh) return joined
  const mine = ++reads
  const gen = generation
  started.set(key, mine)
  const newest = () => gen === generation && started.get(key) === mine
  const p = api.call(API.tree, { query: { path, limit: FOLDER_PAGE } }).then(
    (r) => {
      if (newest()) useTeamFiles.setState((s) => ({ folders: withLast(s.folders, key, r, KEPT_FOLDERS) }))
      return r
    },
    (e: unknown) => {
      if (newest() && (isApiError(e, 'not_found') || isApiError(e, 'forbidden'))) dropFolders([key])
      throw e
    },
  )
  running.set(key, p)
  const off = () => {
    if (running.get(key) === p) running.delete(key)
    if (started.get(key) === mine) started.delete(key)
  }
  p.then(off, off)
  return p
}

/** These folders' listings (and who can open them) are not shown again before they are read again. */
export function dropFolders(keys: readonly string[]) {
  for (const k of keys) {
    // an answer on its way may be from before the change: it is not kept either
    if (started.has(k)) started.set(k, ++reads)
    running.delete(k)
    markDropped(k)
  }
  useTeamFiles.setState((s) => ({ folders: without(s.folders, keys), audiences: without(s.audiences, keys) }))
}

/** Who can open the folder, as last answered (null: never, or dropped since). */
export const keptAudience = (path: string): FolderAudience | null => useTeamFiles.getState().audiences[folderKey(path)] ?? null

/** a drop of this key now: the reads of it on their way do not keep their answer */
function markDropped(key: string) {
  for (const id of waiting.get(key) ?? []) dropped.add(id)
}
/** Start a read whose answer is kept for `key` (a folder's count, a file's bytes): it is kept only when no reset, access
 * change, file event or drop of that key came meanwhile. Call the result with the answer, or with nothing when it failed. */
function startKeep(key: string): (keep?: () => void) => void {
  const gen = generation
  const mine = ++keeps
  const set = waiting.get(key) ?? new Set<number>()
  set.add(mine)
  waiting.set(key, set)
  return (keep) => {
    const ok = gen === generation && !dropped.has(mine)
    dropped.delete(mine)
    set.delete(mine)
    if (!set.size && waiting.get(key) === set) waiting.delete(key)
    if (ok && keep) keep()
  }
}

/** A read of who can open the folder starts: the result keeps its answer (null: it failed, nothing is kept). */
export function audienceRead(path: string): (a: FolderAudience | null) => void {
  const key = folderKey(path)
  const done = startKeep(key)
  return (a) => done(a ? () => useTeamFiles.setState((s) => ({ audiences: withLast(s.audiences, key, a, KEPT_FOLDERS) })) : undefined)
}

/** The variant of a file's bytes: the same file read with other limits (a text preview's start) is another copy. */
const fileKey = (path: string, variant: string) => `${folderKey(path)}|${variant}`

/** A file's bytes as the preview last read them (null: not kept). */
export function keptFile(path: string, variant: string): Blob | null {
  return files.get(fileKey(path, variant)) ?? null
}

/** A preview's read of a file's bytes starts: the result keeps what it read (a small file only; null: it failed, and
 * what was kept of it goes; nothing: it was stopped, nothing changes). Not kept when the file changed meanwhile (a
 * file event) or after a reset. */
export function fileRead(path: string, variant: string): (blob?: Blob | null) => void {
  const key = fileKey(path, variant)
  const done = startKeep(key)
  return (blob) => {
    if (!blob) {
      done()
      if (blob === null) forgetFile(path)
      return
    }
    done(() => keepBytes(key, blob))
  }
}
function keepBytes(key: string, blob: Blob) {
  files.delete(key)
  if (blob.size > KEPT_FILE_BYTES) return
  files.set(key, blob)
  while (files.size > KEPT_FILES) files.delete(files.keys().next().value!)
}

/** A file's bytes that could not be read again (gone, refused, failed): not shown again from here. */
export function forgetFile(path: string) {
  const prefix = `${folderKey(path)}|`
  for (const key of [...files.keys()]) if (key.startsWith(prefix)) files.delete(key)
}

/** Whether two reads of a file have the same bytes (the preview keeps its viewer as it is then). */
export async function sameBytes(a: Blob, b: Blob): Promise<boolean> {
  if (a === b) return true
  if (a.size !== b.size || a.type !== b.type) return false
  const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()])
  const u = new Uint8Array(x)
  const v = new Uint8Array(y)
  for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false
  return true
}

/** The folders a file event touched: the folder of each path (and of a move's old path), and a folder itself (it may
 * have been deleted, moved or renamed, with everything under it). */
export function touchedBy(changes: readonly { path: string; from?: string }[]): { folders: Set<string>; under: string[] } {
  const folders = new Set<string>()
  const under: string[] = []
  for (const c of changes) {
    for (const p of c.from ? [c.path, c.from] : [c.path]) {
      folders.add(folderKey(parentPath(p)))
      under.push(folderKey(p))
    }
  }
  return { folders, under }
}

function onFilesChanged(changes: readonly { path: string; from?: string }[]) {
  const { folders, under } = touchedBy(changes)
  const kept = Object.keys(useTeamFiles.getState().folders)
  const inside = (k: string) => under.some((u) => k === u || k.startsWith(`${u}/`))
  dropFolders([...new Set([...folders, ...kept.filter(inside)])])
  for (const key of [...files.keys(), ...waiting.keys()]) {
    const bar = key.lastIndexOf('|')
    if (bar < 0 || !inside(key.slice(0, bar))) continue
    files.delete(key)
    markDropped(key)
  }
}

filesChanged.on((changes) => onFilesChanged(changes))
accessChanged.on(() => forgetAll())
reloadAsked.on(() => forgetAll())
