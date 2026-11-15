// "Find work files on this computer" in the page (docs/DECISIONS.md "Find work files on this computer"). The desktop app
// looks through Documents, Desktop and Downloads after its own dialog and hands the page a list with an id per file
// (shared/src/desktop-bridge.ts workFiles); here that list becomes the step's documents (lib/teamFiles.ts LocalDoc), whose
// content is read only when the person adds them (`open` → workFiles.read). Also: which entry the page offers, the
// list's "Select all" (never a personal-looking file, at most 100) and Undo, which takes back only what the run made.
// No API calls here: the screens give them, so the tests need no server.
import { TEAM_FILES_LIMITS } from '@mycel/shared/api'
import { FROM_COMPUTER_DIR, WORK_FILES_BRIDGE_VERSION, type DesktopBridge, type WorkFileMeta, type WorkFileRead, type WorkRootId, type WorkRootResult } from '@mycel/shared'
import { WORK_FILES_LIMITS } from '@mycel/shared/file-scan'
import { personalPath, type LocalDoc } from './teamFiles'
import { joinPath } from './paths'

export type WorkFilesBridge = NonNullable<DesktopBridge['workFiles']>

/** The desktop app's workFiles, when it offers this page's version (an older app, the Mac App Store build, a browser and
 * a phone: null, so no entry is shown). */
export function workFilesBridge(bridge: DesktopBridge | null): WorkFilesBridge | null {
  const w = bridge?.workFiles
  return w && w.version === WORK_FILES_BRIDGE_VERSION && typeof w.scan === 'function' && typeof w.read === 'function' ? w : null
}

/** The folder in My files the files go to (shared/src/folder-labels.ts: its name on disk, said in the person's words). */
export const FROM_COMPUTER = FROM_COMPUTER_DIR
/** The root folders' names on disk under it, as the computer names them. */
export const ROOT_FOLDER: Record<WorkRootId, string> = { documents: 'Documents', desktop: 'Desktop', downloads: 'Downloads' }

/** Why a read gave nothing, as an Error the upload counts as "could not be read" (the file is not tried again). */
export class WorkFileReadError extends Error {
  constructor(readonly reason: Extract<WorkFileRead, { ok: false }>['reason']) {
    super(`work file not read: ${reason}`)
  }
}

/** The look's files as the step's documents: `pick` the root's folder name, `rel` the path inside it. Nothing is read:
 * `open` asks the app for the bytes, by id, when the file goes up. */
export function docsFromScan(files: readonly WorkFileMeta[], read: (id: string) => Promise<WorkFileRead>): LocalDoc[] {
  return files.map((f) => {
    const pick = ROOT_FOLDER[f.root]
    const folder = f.folder.normalize('NFC')
    const name = f.name.normalize('NFC')
    const rel = joinPath(folder, name)
    return {
      key: `${pick}/${rel}`,
      pick,
      rel,
      name,
      folder,
      ext: f.ext,
      size: f.size,
      modified: f.modified,
      personal: personalPath(joinPath(pick, rel)),
      open: async () => {
        const r = await read(f.id)
        if (!r.ok) throw new WorkFileReadError(r.reason)
        return new File([r.bytes as BlobPart], name, { lastModified: f.modified })
      },
    }
  })
}

/** What the list says about the folders: macOS kept the app out (blocked), a folder cut (big), files over 50 MB, folders
 * left out (the home folder, a network path), none looked at at all. */
export function rootNotes(roots: readonly WorkRootResult[]) {
  const looked = roots.filter((r) => r.state === 'ok')
  return {
    blocked: roots.filter((r) => r.state === 'blocked'),
    cut: roots.filter((r) => r.cut),
    left: roots.filter((r) => r.state === 'home'),
    tooBig: roots.reduce((n, r) => n + r.tooBig, 0),
    none: looked.length === 0,
  }
}

/** "Select all": the ticks plus the shown work files in their order, never a personal-looking one, up to `max` (the cap
 * line says when it stopped there). */
export function selectAll(ticks: ReadonlySet<string>, docs: readonly LocalDoc[], max: number = TEAM_FILES_LIMITS.perUpload): { ticks: Set<string>; capped: boolean } {
  const next = new Set(ticks)
  let capped = false
  for (const d of docs) {
    if (d.personal || next.has(d.key)) continue
    if (next.size >= max) { capped = true; break }
    next.add(d.key)
  }
  return { ticks: next, capped }
}

/** The ticked files' bytes over the one-add limit (the app reads at most 1 GB of one look). */
export const overBytes = (docs: readonly LocalDoc[], ticks: ReadonlySet<string>, max: number = WORK_FILES_LIMITS.readBytes) =>
  docs.reduce((n, d) => (ticks.has(d.key) ? n + d.size : n), 0) > max

// ---------------------------------------------------------------- Undo

/** What a run made: the files that landed (their path now: a renamed "(1)" copy is the run's own), and the folders it
 * made (never one that was there). */
export interface RunMade {
  files: string[]
  folders: string[]
}

export interface UndoCalls {
  /** to the trash; its answer says until when the trash keeps it */
  remove(path: string): Promise<{ purgeAt: string }>
  /** the folder holds nothing (null: it cannot be read; left as it is) */
  isEmpty(path: string): Promise<boolean | null>
}

/**
 * Undo: only what this run made goes to the trash. Its files (never a file that was there before: the run never replaces
 * one, a same-named file got a new name), then its folders that hold nothing now, deepest first (a folder something
 * else was put in since stays). The computer's files are never touched. `purgeAt`: the latest trash end of what went,
 * for the team's trash period in words.
 */
export async function undoRun(made: RunMade, calls: UndoCalls): Promise<{ removed: string[]; failed: string[]; purgeAt: string | null }> {
  const removed: string[] = []
  const failed: string[] = []
  let purgeAt: string | null = null
  const note = (at: string) => { if (!purgeAt || at > purgeAt) purgeAt = at }
  for (const path of [...new Set(made.files)]) {
    try {
      note((await calls.remove(path)).purgeAt)
      removed.push(path)
    } catch {
      failed.push(path)
    }
  }
  const folders = [...new Set(made.folders)].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a))
  for (const path of folders) {
    if ((await calls.isEmpty(path).catch(() => null)) !== true) continue
    try {
      note((await calls.remove(path)).purgeAt)
    } catch {
      // a folder that stays: nothing of the run's files is in it any more
    }
  }
  return { removed, failed, purgeAt }
}

/** The folder a run's files land in: My files › From this computer. */
export const runFolder = (base: string) => joinPath(base, FROM_COMPUTER)
