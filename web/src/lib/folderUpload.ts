// Folder upload on the file screen: a folder from the picker (webkitdirectory) or dropped on the page (webkitGetAsEntry).
// It keeps the subfolder paths, makes the folders parent first (the server makes one level per call and session create
// answers 404 for a missing parent) and sends a few files at a time through the single-file upload (lib/upload.ts), so
// name collisions, the size limit, resume and the access check of each file are the same. One failed file does not stop
// the others and can be tried again. A storage refusal stops the files that did not start. A folder of the same name is
// used as it is; a file of the same name gets a new name ('rename', as for one file).
// No API calls here: the screen gives them (FolderUploadCalls), so the tests need no server.
import { isSystemName } from '@mycel/shared/api'
import { markBusy } from './busy'
import { joinPath, nameProblem, parentPath } from './paths'

/** Files that run at one time. A person has at most 10 open upload sessions on the server (MAX_OPEN_SESSIONS), and a
 * failed large file keeps its session for the resume. */
export const FOLDER_UPLOAD_CONCURRENCY = 3
/** Folder levels read from a drop. The server's limit is the same (MAX_DEPTH); it also ends a loop of links. */
export const DROP_DEPTH_MAX = 64

/** Files and folders that the system makes (shared, so a team folder's document count leaves out the same ones). Other
 * dot files stay: a project needs its .gitignore. */
export { isSystemName } from '@mycel/shared/api'

/** What goes up. Each `rel` is relative to the folder that receives the upload and starts with the folder's own name. */
export interface FolderPlan {
  files: { rel: string; file: File }[]
  /** folders with no file in them: only a drop shows these, the picker gives files only */
  folders: string[]
  /** could not be read from the disk */
  unreadable: string[]
  /** system files, and entries that are not a file or a folder */
  skipped: number
}

const emptyPlan = (): FolderPlan => ({ files: [], folders: [], unreadable: [], skipped: 0 })

/** The picker's files. The browser does not say which ones are links: it gives the content of the target. */
export function planFromInput(files: readonly File[]): FolderPlan {
  const plan = emptyPlan()
  for (const file of files) {
    // macOS gives names in NFD. The server keeps a new folder's name as sent, so one NFD name is a second folder.
    const rel = (file.webkitRelativePath || file.name).normalize('NFC')
    if (rel.split('/').some(isSystemName)) plan.skipped++
    else plan.files.push({ rel, file })
  }
  return plan
}

/** The parts of a FileSystemEntry that are used here. */
export type DropEntry = Pick<FileSystemEntry, 'name' | 'isFile' | 'isDirectory'>

/** The entries of a drop. Call this in the drop event, before any await: after the event the item list is empty. */
export function droppedEntries(dt: { items?: ArrayLike<DataTransferItem> | null }): FileSystemEntry[] {
  const out: FileSystemEntry[] = []
  for (const item of Array.from(dt.items ?? [])) {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null
    if (entry) out.push(entry)
  }
  return out
}

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject))

/** All entries of a folder. Each readEntries call gives one batch (Chromium: 100) and an empty batch at the end. */
async function readAll(dir: FileSystemDirectoryEntry, out: FileSystemEntry[]) {
  const reader = dir.createReader()
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) return
    out.push(...batch)
  }
}

/** The entries of a drop as a plan. An entry that is not a file or a folder is skipped. No browser API marks a link, so
 * this is the only check here; DROP_DEPTH_MAX ends a loop. */
export async function planFromEntries(entries: readonly DropEntry[]): Promise<FolderPlan> {
  const plan = emptyPlan()
  /** true: the path goes up with a file below it, so its folder gets made anyway */
  const walk = async (entry: DropEntry, folder: string, depth: number): Promise<boolean> => {
    if (isSystemName(entry.name)) {
      plan.skipped++
      return false
    }
    const rel = joinPath(folder, entry.name.normalize('NFC'))
    if (entry.isFile) {
      try {
        plan.files.push({ rel, file: await fileOf(entry as FileSystemFileEntry) })
        return true
      } catch {
        plan.unreadable.push(rel)
        return false
      }
    }
    if (!entry.isDirectory) {
      plan.skipped++
      return false
    }
    if (depth >= DROP_DEPTH_MAX) {
      plan.unreadable.push(rel)
      return false
    }
    const kids: FileSystemEntry[] = []
    try {
      await readAll(entry as FileSystemDirectoryEntry, kids)
    } catch {
      plan.unreadable.push(rel)
    }
    let filled = false
    for (const kid of kids) if (await walk(kid, rel, depth + 1)) filled = true
    if (!filled) plan.folders.push(rel)
    return true
  }
  for (const entry of entries) await walk(entry, '', 0)
  return plan
}

/** A refusal for lack of space: 507 storage_full, or 413 from session create (the real disk, uploads/sessions.ts). The
 * file size is checked before the request, so a 413 for the file itself does not come back here. */
export const isStorageRefusal = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code
  return code === 'storage_full' || code === 'payload_too_large'
}

export interface FolderUploadCalls {
  /** the largest file an upload session takes */
  maxFileSize: number
  /** make one folder; a 409 means that the name is there */
  mkdir(path: string, signal: AbortSignal): Promise<unknown>
  isFolder(path: string, signal: AbortSignal): Promise<boolean>
  upload(file: File, path: string, signal: AbortSignal, onProgress: (p: { phase: 'hashing' | 'uploading' | 'finishing'; loaded: number; total: number }) => void): Promise<unknown>
  /** drop what the server holds of an unfinished file */
  discard(file: File, path: string): Promise<unknown>
  concurrency?: number
}

/** Why a file failed before any request: 'unreadable', 'tooLarge', or a name problem (paths.ts). */
export type LocalRefusal = 'unreadable' | 'tooLarge' | NonNullable<ReturnType<typeof nameProblem>>

export interface FolderFailure {
  path: string
  /** set: trying again does not help */
  local?: LocalRefusal
  error?: unknown
}

export interface FolderUploadView {
  id: number
  /** the folder that receives the upload */
  base: string
  /** the uploaded folder's name, or null when the drop had several items */
  name: string | null
  /** top-level items */
  items: number
  status: 'running' | 'done' | 'failed' | 'stopped'
  total: number
  done: number
  failed: number
  /** not started, or stopped by a refusal */
  waiting: number
  bytesDone: number
  bytesTotal: number
  skipped: number
  failures: readonly FolderFailure[]
  /** the storage refusal that stopped the upload */
  refusal: unknown
  active: readonly { name: string; phase: 'hashing' | 'uploading' | 'finishing' | null; loaded: number; total: number }[]
  canRetry: boolean
}

interface Item {
  rel: string
  file?: File
  /** a folder with no file in it */
  folder?: boolean
  size: number
  state: 'queued' | 'active' | 'done' | 'failed'
  loaded: number
  phase: FolderUploadView['active'][number]['phase']
  local?: LocalRefusal
  error?: unknown
}

let seq = 0

function localRefusal(rel: string, size: number, max: number): LocalRefusal | undefined {
  for (const seg of rel.split('/')) {
    const problem = nameProblem(seg)
    if (problem) return problem
  }
  return size > max ? 'tooLarge' : undefined
}

export class FolderUpload {
  readonly id = ++seq
  private items: Item[]
  private abort = new AbortController()
  private queue: Item[] = []
  /** each folder is asked for once per run; the files below a refused folder get its refusal and send nothing */
  private made = new Map<string, Promise<void>>()
  private refusal: unknown = null
  private running = false
  private run: Promise<void> | null = null
  private name: string | null
  private tops: number
  private skipped: number

  constructor(plan: FolderPlan, readonly base: string, private calls: FolderUploadCalls, private onChange: () => void = () => {}) {
    const entry = (rel: string, size: number, file?: File): Item => {
      const local = localRefusal(rel, size, calls.maxFileSize)
      return { rel, file, size, state: local ? 'failed' : 'queued', loaded: 0, phase: null, local }
    }
    this.items = [
      ...plan.files.map((f) => entry(f.rel, f.file.size, f.file)),
      ...plan.folders.map((rel): Item => ({ ...entry(rel, 0), folder: true })),
      ...plan.unreadable.map((rel): Item => ({ rel, size: 0, state: 'failed', loaded: 0, phase: null, local: 'unreadable' })),
    ]
    const tops = new Set(this.items.map((i) => i.rel.split('/')[0]!))
    this.tops = tops.size
    this.name = tops.size === 1 ? [...tops][0]! : null
    this.skipped = plan.skipped
  }

  get view(): FolderUploadView {
    let done = 0, failed = 0, waiting = 0, total = 0, bytesDone = 0, bytesTotal = 0
    const failures: FolderFailure[] = []
    const active: FolderUploadView['active'][number][] = []
    let canRetry = false
    for (const i of this.items) {
      if (i.state === 'failed') {
        failed++
        failures.push({ path: i.rel, local: i.local, error: i.error })
        if (!i.local) canRetry = true
      }
      if (i.folder) continue
      total++
      bytesTotal += i.size
      if (i.state === 'done') {
        done++
        bytesDone += i.size
      } else if (i.state === 'queued') {
        waiting++
        canRetry = true
      } else if (i.state === 'active') {
        bytesDone += i.loaded
        active.push({ name: i.rel, phase: i.phase, loaded: i.loaded, total: i.size })
      }
    }
    const status = this.running ? 'running' : this.refusal !== null ? 'stopped' : failed ? 'failed' : 'done'
    return { id: this.id, base: this.base, name: this.name, items: this.tops, status, total, done, failed, waiting, bytesDone, bytesTotal, skipped: this.skipped, failures, refusal: this.refusal, active, canRetry: canRetry && !this.running }
  }

  /** Each file as it is now (the welcome step's rows, docs/DECISIONS.md "W6"): its path inside the receiving folder, size,
   * state and bytes sent; `queued` after the run ended means it never went (stopped). Folders are left out. */
  rows(): { rel: string; size: number; state: Item['state']; loaded: number; local?: LocalRefusal; error?: unknown; file?: File }[] {
    return this.items.filter((i) => !i.folder).map((i) => ({ rel: i.rel, size: i.size, state: i.state, loaded: i.loaded, local: i.local, error: i.error, file: i.file }))
  }

  /** Send what is queued. Ends when all of it is done or failed, or at a refusal. */
  start(): Promise<void> {
    if (this.run) return this.run
    this.running = true
    this.refusal = null
    this.queue = this.items.filter((i) => i.state === 'queued')
    const release = markBusy('upload')
    const workers = Array.from({ length: Math.min(this.calls.concurrency ?? FOLDER_UPLOAD_CONCURRENCY, Math.max(1, this.queue.length)) }, () => this.work())
    this.onChange()
    this.run = Promise.all(workers).then(() => {}).finally(() => {
      release()
      this.running = false
      this.run = null
      this.onChange()
    })
    return this.run
  }

  /** The failed files and the files that a refusal stopped. A large file goes on from the chunks the server has. */
  retry(): Promise<void> {
    if (this.run) return this.run
    for (const i of this.items) if (i.state === 'failed' && !i.local) {
      i.state = 'queued'
      i.error = undefined
    }
    // a folder refused before may work now, and a folder made in the meantime answers 409 and is used
    this.made.clear()
    return this.start()
  }

  /** Stop the run, and leave what the server holds. */
  stop(reason?: unknown) {
    this.abort.abort(reason)
  }

  /** Stop the run and let the server drop the unfinished files. */
  async cancel() {
    this.abort.abort()
    await this.run
    await this.discard()
  }

  /** The person closed the panel: open sessions count against their limit and hold storage for a day otherwise. */
  async discard() {
    await Promise.all(this.items.map((i) => (i.file && i.state !== 'done' ? this.calls.discard(i.file, joinPath(this.base, i.rel)).catch(() => {}) : null)))
  }

  private async work() {
    const signal = this.abort.signal
    while (!signal.aborted && this.refusal === null) {
      const item = this.queue.shift()
      if (!item) return
      item.state = 'active'
      this.onChange()
      try {
        await this.ensure(item.file ? parentPath(item.rel) : item.rel)
        if (item.file) {
          await this.calls.upload(item.file, joinPath(this.base, item.rel), signal, (p) => {
            item.phase = p.phase
            if (p.phase !== 'hashing') item.loaded = p.loaded
            this.onChange()
          })
        }
        item.state = 'done'
      } catch (e) {
        item.loaded = 0
        item.phase = null
        if (signal.aborted) item.state = 'queued'
        else if (isStorageRefusal(e)) {
          item.state = 'queued'
          this.refusal ??= e
        } else {
          item.state = 'failed'
          item.error = e
        }
      }
      this.onChange()
    }
  }

  private ensure(rel: string): Promise<void> {
    if (!rel) return Promise.resolve()
    let p = this.made.get(rel)
    if (!p) {
      p = this.ensure(parentPath(rel)).then(() => this.mkdir(joinPath(this.base, rel)))
      this.made.set(rel, p)
    }
    return p
  }

  private async mkdir(path: string) {
    const signal = this.abort.signal
    try {
      await this.calls.mkdir(path, signal)
    } catch (e) {
      // 409: the folder is there, or a file has the name, or a name that differs only in case: only the first is used
      if ((e as { code?: unknown } | null)?.code !== 'conflict' || !(await this.calls.isFolder(path, signal))) throw e
    }
  }
}
