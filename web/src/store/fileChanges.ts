// Changes made on 파일 show at once (docs/DECISIONS.md "Optimistic projects and files"; lib/optimistic.ts): a rename,
// a move, the trash and its Undo, a new folder. The row changes in the folder's listing before the server answers (the
// listing on screen, pages/Files.tsx, and the folder as kept in store/teamFiles.ts); a refusal puts it back with one
// toast. One queue per item, by its path when the change was made (`file:<path>:place`).
//
// A listing read on its way when a change is made, or answered while one is still unanswered, may be from before it:
// the Files page does not show it (`fileEdits`, `fileChangePending`) and reads again once the change has ended.
import type { FileEntry, TreeResponse } from '@mycel/shared/api'
import { errorText } from '../lib/api'
import { currentLocale, t } from '../i18n'
import { optimistic, optimisticEdits, optimisticPendingKeys, type OptimisticResult } from '../lib/optimistic'
import { parentPath } from '../lib/paths'
import { folderKey, useTeamFiles } from './teamFiles'
import { toast } from './ui'

export const fileChangeKey = (path: string) => `file:${folderKey(path)}:place`
const isFileKey = (k: string) => k.startsWith('file:')
/** the changes of files made here so far (a read whose count changed while it was on its way may be from before one) */
export const fileEdits = () => optimisticEdits(isFileKey)
/** a change of a file made here is still unanswered */
export const fileChangePending = () => optimisticPendingKeys(isFileKey).length > 0

/** the person said no to a question the server asked (who would lose or gain sight of it): back, without a toast */
export const DECLINED = Symbol('declined')

const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
/** the server's order in a folder (server/src/team-files/service.ts list): folders first, then by name */
const entryOrder = (a: FileEntry, b: FileEntry) => (a.type === b.type ? coll.compare(a.name, b.name) : a.type === 'folder' ? -1 : 1)
const samePath = (a: string, b: string) => folderKey(a) === folderKey(b)

/** entries made here before the server had them (a new folder, a new name): taken off by themselves, never by path
 * (a row of the same name the server listed is another one) */
const madeHere = new WeakSet<FileEntry>()
/** An entry as it will be once the server has done the change (its own copy settles it). */
export function madeEntry(e: FileEntry): FileEntry {
  const copy = { ...e }
  madeHere.add(copy)
  return copy
}

/** a folder's listing without `e` */
function without(r: TreeResponse, e: FileEntry): TreeResponse {
  const entries = r.entries.filter((x) => (madeHere.has(e) ? x !== e : !samePath(x.path, e.path)))
  return entries.length === r.entries.length ? r : { ...r, entries }
}
/** a folder's listing with `e` in the server's place (not twice) */
function withEntry(r: TreeResponse, e: FileEntry): TreeResponse {
  if (r.entries.some((x) => x === e || samePath(x.path, e.path))) return r
  const i = r.entries.findIndex((x) => entryOrder(e, x) < 0)
  // past the page read so far (more to come): after the rows shown, where 더 보기 continues
  const at = i < 0 ? r.entries.length : i
  return { ...r, entries: [...r.entries.slice(0, at), e, ...r.entries.slice(at)] }
}

type Edit = (r: TreeResponse) => TreeResponse
/** the listings on screen (the Files page's own copy, with its later pages) */
const screens = new Set<(folder: string, f: Edit) => void>()
/** A screen with its own copy of a folder's listing: it gets each change of a folder (by folderKey) to make in it. */
export function onListingEdit(fn: (folder: string, f: Edit) => void): () => void {
  screens.add(fn)
  return () => void screens.delete(fn)
}
function editListing(folder: string, f: Edit) {
  const k = folderKey(folder)
  useTeamFiles.setState((s) => {
    const kept = s.folders[k]
    const next = kept && f(kept)
    return next && next !== kept ? { folders: { ...s.folders, [k]: next } } : s
  })
  for (const fn of screens) fn(k, f)
}

/**
 * An item's place changes at once: `from` is where it is now (null: nowhere listed, such as in the trash), `to` where it
 * will be (null: out of every listing here: the trash, or another folder a move takes it to). Then `send`; a refusal
 * puts it back with one toast (`failText` false: the caller says it; DECLINED never toasts). `confirmed`: the item as
 * the server has it now (a name it changed: "name (2)", " (restored)"), shown in place of `to`.
 */
export function placeEntry<R>(o: {
  /** the queue: the item's path when the change was made */
  key: string
  from: FileEntry | null
  to: FileEntry | null
  send: () => Promise<R>
  confirmed?: (reply: R) => FileEntry | null
  failText?: string | false
}): Promise<OptimisticResult<R>> {
  // what this change put on screen last: taken off before the next value goes on
  let shown: FileEntry | null = o.from
  const show = (v: FileEntry | null) => {
    if (shown === v) return
    const was = shown
    shown = v
    if (was) editListing(parentPath(was.path), (r) => without(r, was))
    if (v) editListing(parentPath(v.path), (r) => withEntry(r, v))
  }
  return optimistic<FileEntry | null, R>({
    key: o.key,
    from: o.from,
    to: o.to,
    show,
    send: o.send,
    confirmed: o.confirmed,
    settle: o.confirmed ? (reply) => show(o.confirmed!(reply)) : undefined,
    failText: false,
  }).then((r) => {
    // back on screen already (the newest change of the item); DECLINED says nothing
    if (!r.ok && r.newest && r.error !== DECLINED && o.failText !== false) toast({ level: 'error', text: o.failText ?? errorText(r.error, currentLocale(), t('error.network')) })
    return r
  })
}

/** A promise answered later (a batch's item: the batch's outcome answers each one). */
export function later<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
