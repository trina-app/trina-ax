// Several items of the file screen at once: which rows a checkbox click selects (Shift: a range), what each action may
// do with an item (the same rules as the row menu), and the requests one after another: move (a move that would hide
// items from other people is asked about once for the whole batch), share by copying (one dry run per file, one
// question), trash. Dragging rows onto a folder (or a breadcrumb) is that same move: what a drag takes, what it
// carries and where it may be dropped. No React and no API client here: the screen passes the calls in
// (test/unit/bulk-files.test.ts).
import { ApiError, type CopyResult, type FileEntry } from '@mycel/shared/api'
import { isInside, joinPath, parentPath } from './paths'
import { TEAM_FILE_DRAG_TYPE } from './teamAttach'

// ---------------- selection ----------------
/** a navigation-only folder (access none) has no menu, so nothing to select */
export const selectable = (e: FileEntry) => e.access !== 'none'
/** move / trash: like the row menu's rename, move and trash */
export const canChange = (e: FileEntry) => e.access === 'write'
/** share (copy): files only, as the row menu offers it */
export const canShare = (e: FileEntry) => e.type === 'file' && e.access !== 'none'

/**
 * A checkbox clicked. Without Shift (or without an earlier click in this list) it toggles that row. With Shift every
 * row from the last clicked one to this one takes this row's new state (checked or not), like a mail list.
 * `order`: the selectable rows as listed.
 */
export function clickSelect(selected: ReadonlySet<string>, order: readonly string[], path: string, anchor: string | null, shift: boolean): Set<string> {
  const next = new Set(selected)
  const on = !selected.has(path)
  const a = shift && anchor !== null ? order.indexOf(anchor) : -1
  const b = order.indexOf(path)
  const range = a >= 0 && b >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [path]
  for (const p of range) {
    if (on) next.add(p)
    else next.delete(p)
  }
  return next
}

/** The header checkbox: 'all' when every listed row is selected, 'some', or 'none'. */
export function selectionState(selected: ReadonlySet<string>, order: readonly string[]): 'none' | 'some' | 'all' {
  const n = order.filter((p) => selected.has(p)).length
  return n === 0 ? 'none' : n === order.length ? 'all' : 'some'
}

/** The header checkbox clicked: every listed row, or none when all of them were selected already. */
export function toggleAll(selected: ReadonlySet<string>, order: readonly string[]): Set<string> {
  return selectionState(selected, order) === 'all' ? new Set() : new Set(order)
}

// ---------------- actions ----------------
export interface Failed {
  entry: FileEntry
  error: unknown
}
export interface Outcome {
  /** done as asked */
  done: FileEntry[]
  /** the server refused or the request failed */
  failed: Failed[]
  /** left where they were because the person said no (a move that would hide them from other people) */
  declined: FileEntry[]
}

/** lostViewers when the server refused a move because other people would lose sight of the item, else null */
export function narrowedBy(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.code !== 'conflict' || err.body.params?.reason !== 'audience_narrowed') return null
  return Number(err.body.params.lostViewers ?? 0)
}

type MoveBody = { from: string; to: string; onExists: 'rename'; confirm?: boolean }

/**
 * POST /api/files/move for each item into `folder` (a name taken there gets "name (2)"). Items the server answers
 * audience_narrowed for are not moved yet; once all others are done the person is asked once for all of them (how many
 * items, and the most people any one of them would be hidden from), then those are moved with confirm.
 */
export async function moveMany(items: readonly FileEntry[], folder: string, o: { move: (body: MoveBody) => Promise<unknown>; confirmNarrow: (count: number, lostViewers: number) => Promise<boolean> }): Promise<Outcome> {
  const out: Outcome = { done: [], failed: [], declined: [] }
  const narrowed: { entry: FileEntry; body: MoveBody; lost: number }[] = []
  for (const entry of items) {
    const body: MoveBody = { from: entry.path, to: joinPath(folder, entry.name), onExists: 'rename' }
    try {
      await o.move(body)
      out.done.push(entry)
    } catch (error) {
      const lost = narrowedBy(error)
      if (lost === null) out.failed.push({ entry, error })
      else narrowed.push({ entry, body, lost })
    }
  }
  if (!narrowed.length) return out
  if (!(await o.confirmNarrow(narrowed.length, Math.max(...narrowed.map((x) => x.lost))))) {
    out.declined.push(...narrowed.map((x) => x.entry))
    return out
  }
  for (const { entry, body } of narrowed) {
    try {
      await o.move({ ...body, confirm: true })
      out.done.push(entry)
    } catch (error) {
      out.failed.push({ entry, error })
    }
  }
  return out
}

type CopyBody = { from: string; to: string; onExists: 'rename'; dryRun?: boolean }

/**
 * Share by copying (POST /api/files/copy) each file into `folder`. First a dry run per file: when the copies would be
 * seen by people who cannot see the originals, the person is asked once (the most people any one copy adds: the same
 * people counted once, not once per file). Then each file is copied (a name taken there gets "name (2)").
 * declined: the person said no, nothing was copied.
 */
export async function shareMany(items: readonly FileEntry[], folder: string, o: { copy: (body: CopyBody) => Promise<CopyResult>; confirmShare: (count: number, viewersAdded: number) => Promise<boolean> }): Promise<Outcome> {
  const out: Outcome = { done: [], failed: [], declined: [] }
  const ok: { entry: FileEntry; body: CopyBody }[] = []
  let added = 0
  for (const entry of items) {
    const body: CopyBody = { from: entry.path, to: joinPath(folder, entry.name), onExists: 'rename' }
    try {
      const dry = await o.copy({ ...body, dryRun: true })
      added = Math.max(added, 'viewersAdded' in dry ? dry.viewersAdded : 0)
      ok.push({ entry, body })
    } catch (error) {
      out.failed.push({ entry, error })
    }
  }
  if (!ok.length) return out
  if (added > 0 && !(await o.confirmShare(ok.length, added))) {
    out.declined.push(...ok.map((x) => x.entry))
    return out
  }
  for (const { entry, body } of ok) {
    try {
      await o.copy(body)
      out.done.push(entry)
    } catch (error) {
      out.failed.push({ entry, error })
    }
  }
  return out
}

/** DELETE /api/files for each item (to the trash, 30 days); the trash ids are for "Undo". */
export async function trashMany(items: readonly FileEntry[], o: { remove: (path: string) => Promise<{ trashId: string }> }): Promise<Outcome & { trashIds: string[] }> {
  const out: Outcome & { trashIds: string[] } = { done: [], failed: [], declined: [], trashIds: [] }
  for (const entry of items) {
    try {
      out.trashIds.push((await o.remove(entry.path)).trashId)
      out.done.push(entry)
    } catch (error) {
      out.failed.push({ entry, error })
    }
  }
  return out
}

// ---------------- drag and drop (a move) ----------------
/** Drag type of rows dragged from the file list (their paths, JSON). Only the list's folder rows and breadcrumbs take
 * it; a chat's message box takes TEAM_FILE_DRAG_TYPE (one file) and computer files only. */
export const FILES_MOVE_DRAG_TYPE = 'application/x-mycel-files-move'

/** a file the AI may read can also be dragged into a chat's message box (as the row menu's "add to chat") */
export const chatDraggable = (e: FileEntry) => e.type === 'file' && e.access !== 'none' && !e.downloadOnly

/** What dragging `row` takes: the whole selection (as listed) when that row is selected, else that row alone. */
export function dragSet(listed: readonly FileEntry[], selected: ReadonlySet<string>, row: FileEntry): FileEntry[] {
  return selected.has(row.path) ? listed.filter((e) => selected.has(e.path)) : [row]
}

/**
 * The data a drag carries. The move type when any of `items` may be moved (the read-only ones are skipped at the drop,
 * as the selection's "move" skips them); for a file the AI may read, also the dragged row's path for a chat's message
 * box (that file alone, as before). null: nothing to drag.
 */
export function dragPayload(items: readonly FileEntry[], row: FileEntry): { data: [type: string, value: string][]; effectAllowed: 'move' | 'copy' | 'copyMove' } | null {
  const data: [string, string][] = []
  const move = items.some(canChange)
  if (move) data.push([FILES_MOVE_DRAG_TYPE, JSON.stringify(items.map((e) => e.path))])
  const chat = chatDraggable(row)
  if (chat) data.push([TEAM_FILE_DRAG_TYPE, row.path], ['text/plain', row.path])
  if (!data.length) return null
  return { data, effectAllowed: move && chat ? 'copyMove' : move ? 'move' : 'copy' }
}

/** why a drop is refused (null: allowed). self: onto one of the dragged items; inside: into a dragged folder's own
 * subfolder; readOnly: a folder the person cannot write (read-only, navigation-only); here: the folder they are in
 * already; nothing: none of them may be moved. */
export type DropRefusal = 'self' | 'inside' | 'readOnly' | 'here' | 'nothing'

/**
 * May `items` be dropped on the folder `target`? Its access is the person's there; null when not known yet (a
 * breadcrumb whose access is still being asked): then the server decides, per item, as for the selection's "move".
 */
export function dropRefusal(items: readonly FileEntry[], target: { path: string; access: FileEntry['access'] | null }): DropRefusal | null {
  if (!items.some(canChange)) return 'nothing'
  if (items.some((e) => e.path === target.path)) return 'self'
  if (items.some((e) => e.type === 'folder' && isInside(target.path, e.path))) return 'inside'
  if (target.access !== null && target.access !== 'write') return 'readOnly'
  if (items.some((e) => parentPath(e.path) === target.path)) return 'here'
  return null
}

/** "a.pdf (reason), b.png (reason) and 2 more": the first few failures for a toast. */
export function failureList(failed: readonly Failed[], text: (error: unknown) => string, more: (n: number) => string, max = 3): string {
  const shown = failed.slice(0, max).map((f) => `${f.entry.name} (${text(f.error)})`)
  return failed.length > max ? `${shown.join(', ')} ${more(failed.length - max)}` : shown.join(', ')
}
