import { describe, expect, test } from 'bun:test'
import { isBusy } from '../../src/lib/busy'
import { DROP_DEPTH_MAX, droppedEntries, FOLDER_UPLOAD_CONCURRENCY, FolderUpload, isStorageRefusal, isSystemName, planFromEntries, planFromInput, type DropEntry, type FolderPlan, type FolderUploadCalls } from '../../src/lib/folderUpload'

const file = (name: string, size = 3, rel = '') => {
  const f = new File([new Uint8Array(size)], name)
  if (rel) Object.defineProperty(f, 'webkitRelativePath', { value: rel })
  return f
}
const apiError = (code: string) => Object.assign(new Error(code), { code })

/** A folder of a drop. The reader gives `batch` entries per call, then an empty batch, as Chromium does. */
function dir(name: string, kids: DropEntry[], o: { batch?: number; failAt?: number } = {}) {
  const batch = o.batch ?? 100
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let at = 0, calls = 0
      return {
        readEntries(ok: (e: DropEntry[]) => void, no: (e: Error) => void) {
          if (o.failAt === calls++) return no(new Error('read failed'))
          ok(kids.slice(at, at + batch))
          at += batch
        },
      }
    },
  } as DropEntry
}
const entry = (name: string, size = 3) => ({ name, isFile: true, isDirectory: false, file: (ok: (f: File) => void) => ok(file(name, size)) }) as DropEntry

/** Calls that record what the screen would send. `fail`: an error for a path, one time or until cleared. */
function fakeCalls(o: { fail?: Map<string, unknown>; failOnce?: Map<string, unknown>; exists?: Set<string>; maxFileSize?: number; concurrency?: number; hold?: Promise<void> } = {}) {
  const log = { mkdir: [] as string[], upload: [] as string[], discard: [] as string[], peak: 0 }
  let now = 0
  const calls: FolderUploadCalls = {
    maxFileSize: o.maxFileSize ?? 1000,
    concurrency: o.concurrency,
    mkdir: async (path) => {
      log.mkdir.push(path)
      const e = o.fail?.get(path)
      if (e) throw e
      if (o.exists?.has(path)) throw apiError('conflict')
    },
    isFolder: async (path) => o.exists?.has(path) ?? false,
    upload: async (f, path, signal, onProgress) => {
      log.upload.push(path)
      log.peak = Math.max(log.peak, ++now)
      try {
        onProgress({ phase: 'hashing', loaded: f.size, total: f.size })
        onProgress({ phase: 'uploading', loaded: 1, total: f.size })
        await (o.hold ?? Promise.resolve())
        await Promise.resolve()
        signal.throwIfAborted()
        const once = o.failOnce?.get(path)
        if (once) {
          o.failOnce!.delete(path)
          throw once
        }
        const e = o.fail?.get(path)
        if (e) throw e
      } finally {
        now--
      }
    },
    discard: async (_f, path) => { log.discard.push(path) },
  }
  return { calls, log }
}
const plan = (rels: string[], extra: Partial<FolderPlan> = {}): FolderPlan => ({ files: rels.map((rel) => ({ rel, file: file(rel.split('/').pop()!) })), folders: [], unreadable: [], skipped: 0, ...extra })

describe('what goes up', () => {
  test('system files stay out, a project file with a dot does not', () => {
    for (const n of ['.DS_Store', '._clip.mp4', 'Thumbs.db', 'desktop.ini', '__MACOSX', '.Spotlight-V100', 'Icon\r']) expect(isSystemName(n)).toBe(true)
    for (const n of ['.gitignore', '.env.example', 'clip.mp4', 'Icon']) expect(isSystemName(n)).toBe(false)
  })

  test('picker: keeps the subfolder paths, in NFC, and skips system files at any level', () => {
    const nfd = '견적'.normalize('NFD')
    const p = planFromInput([file('a.mp4', 3, `${nfd}/raw/a.mp4`), file('.DS_Store', 3, `${nfd}/.DS_Store`), file('x', 3, `${nfd}/__MACOSX/x`)])
    expect(p.files.map((f) => f.rel)).toEqual(['견적/raw/a.mp4'])
    expect(p.skipped).toBe(2)
  })

  test('drop: reads every batch of a large folder and all levels', async () => {
    const kids = Array.from({ length: 250 }, (_, i) => entry(`clip${i}.mp4`))
    const p = await planFromEntries([dir('clips', [...kids, dir('sub', [entry('b.mov')])])])
    expect(p.files).toHaveLength(251)
    expect(p.files.at(-1)!.rel).toBe('clips/sub/b.mov')
  })

  test('drop: skips system files and entries that are not a file or a folder, and keeps empty folders', async () => {
    const link = { name: 'link', isFile: false, isDirectory: false } as DropEntry
    const p = await planFromEntries([dir('clips', [entry('.DS_Store'), link, dir('empty', []), dir('only-system', [entry('.DS_Store')]), dir('sub', [dir('deep', [entry('a')])])])])
    expect(p.files.map((f) => f.rel)).toEqual(['clips/sub/deep/a'])
    expect(p.folders).toEqual(['clips/empty', 'clips/only-system'])
    expect(p.skipped).toBe(3)
  })

  test('drop: an unreadable folder or file is one failure, the rest is read', async () => {
    const bad = { name: 'bad.mp4', isFile: true, isDirectory: false, file: (_ok: unknown, no: (e: Error) => void) => no(new Error('gone')) } as DropEntry
    const p = await planFromEntries([dir('clips', [bad, dir('locked', [entry('z')], { failAt: 0 }), dir('half', [entry('a'), entry('b')], { batch: 1, failAt: 1 }), entry('ok')])])
    expect(p.unreadable.sort()).toEqual(['clips/bad.mp4', 'clips/half', 'clips/locked'])
    expect(p.files.map((f) => f.rel).sort()).toEqual(['clips/half/a', 'clips/ok'])
  })

  test('drop: a loop of folders ends at the depth limit', async () => {
    const loop = { name: 'l', isFile: false, isDirectory: true, createReader: () => { let n = 0; return { readEntries: (ok: (e: DropEntry[]) => void) => ok(n++ ? [] : [loop]) } } } as unknown as DropEntry
    const p = await planFromEntries([loop])
    expect(p.files).toEqual([])
    expect(p.unreadable).toHaveLength(1)
    expect(p.unreadable[0]!.split('/')).toHaveLength(DROP_DEPTH_MAX + 1)
  })

  test('the drop entries are taken at once, and items without an entry are left out', () => {
    const e = entry('a')
    const items = [{ kind: 'file', webkitGetAsEntry: () => e }, { kind: 'string', webkitGetAsEntry: () => e }, { kind: 'file', webkitGetAsEntry: () => null }, { kind: 'file' }] as unknown as DataTransferItem[]
    expect(droppedEntries({ items })).toEqual([e] as FileSystemEntry[])
    expect(droppedEntries({})).toEqual([])
  })
})

describe('a folder upload', () => {
  test('makes each folder once, parent first, in the open folder, and sends a few files at a time', async () => {
    const { calls, log } = fakeCalls()
    const rels = Array.from({ length: 12 }, (_, i) => `clips/a/b/${i}.mp4`)
    const run = new FolderUpload(plan([...rels, 'clips/c/x.mp4']), 'projects/jdr', calls)
    await run.start()
    expect(log.mkdir).toEqual(['projects/jdr/clips', 'projects/jdr/clips/a', 'projects/jdr/clips/a/b', 'projects/jdr/clips/c'])
    expect(log.upload).toHaveLength(13)
    expect(log.upload).toContain('projects/jdr/clips/a/b/0.mp4')
    expect(log.peak).toBe(FOLDER_UPLOAD_CONCURRENCY)
    expect(run.view).toMatchObject({ status: 'done', done: 13, total: 13, failed: 0, bytesDone: 39, bytesTotal: 39, name: 'clips', canRetry: false })
  })

  test('a folder that is there is used, and a file of the same name fails only what is below it', async () => {
    const taken = apiError('conflict')
    const { calls, log } = fakeCalls({ exists: new Set(['clips']), fail: new Map([['clips/name-of-a-file', taken]]) })
    const run = new FolderUpload(plan(['clips/a.mp4', 'clips/name-of-a-file/b.mp4', 'clips/name-of-a-file/c.mp4', 'clips/d.mp4']), '', calls)
    await run.start()
    expect(log.upload.sort()).toEqual(['clips/a.mp4', 'clips/d.mp4'])
    expect(run.view).toMatchObject({ status: 'failed', done: 2, failed: 2 })
    expect(run.view.failures.map((f) => f.error)).toEqual([taken, taken])
    expect(log.mkdir.filter((p) => p === 'clips/name-of-a-file')).toHaveLength(1)
  })

  test('one failed file does not stop the others; try again sends only the failed one', async () => {
    const boom = apiError('internal')
    const { calls, log } = fakeCalls({ failOnce: new Map([['clips/2.mp4', boom]]) })
    const run = new FolderUpload(plan(['clips/1.mp4', 'clips/2.mp4', 'clips/3.mp4', 'clips/4.mp4']), '', calls)
    await run.start()
    expect(run.view).toMatchObject({ status: 'failed', done: 3, failed: 1, canRetry: true, bytesDone: 9, bytesTotal: 12 })
    expect(run.view.failures).toEqual([{ path: 'clips/2.mp4', local: undefined, error: boom }])
    log.upload.length = 0
    await run.retry()
    expect(log.upload).toEqual(['clips/2.mp4'])
    expect(run.view).toMatchObject({ status: 'done', done: 4, failed: 0, failures: [] })
  })

  test.each([['storage_full'], ['payload_too_large']])('a %s refusal stops the rest with one message; try again goes on', async (code) => {
    const refusal = apiError(code)
    const { calls, log } = fakeCalls({ concurrency: 1, failOnce: new Map([['clips/2.mp4', refusal]]) })
    const run = new FolderUpload(plan(['clips/1.mp4', 'clips/2.mp4', 'clips/3.mp4', 'clips/4.mp4']), '', calls)
    await run.start()
    expect(log.upload).toEqual(['clips/1.mp4', 'clips/2.mp4'])
    expect(run.view).toMatchObject({ status: 'stopped', done: 1, failed: 0, waiting: 3, canRetry: true })
    expect(run.view.refusal).toBe(refusal)
    await run.retry()
    expect(run.view).toMatchObject({ status: 'done', done: 4, waiting: 0, refusal: null })
  })

  test('files in flight end normally after a refusal, and a second refusal is the same message', async () => {
    const first = apiError('storage_full')
    const { calls, log } = fakeCalls({ fail: new Map<string, unknown>([['clips/1.mp4', first], ['clips/2.mp4', apiError('storage_full')]]) })
    const run = new FolderUpload(plan(['clips/1.mp4', 'clips/2.mp4', 'clips/3.mp4', 'clips/4.mp4', 'clips/5.mp4']), '', calls)
    await run.start()
    expect(log.upload).toEqual(['clips/1.mp4', 'clips/2.mp4', 'clips/3.mp4'])
    expect(run.view).toMatchObject({ status: 'stopped', done: 1, failed: 0, waiting: 4 })
    expect(run.view.refusal).toBe(first)
  })

  test('no write access: the folder refusal reaches each file below it, and nothing goes up', async () => {
    const denied = apiError('forbidden')
    const { calls, log } = fakeCalls({ fail: new Map([['shared/clips', denied]]) })
    const run = new FolderUpload(plan(['clips/1.mp4', 'clips/a/2.mp4']), 'shared', calls)
    await run.start()
    expect(log.mkdir).toEqual(['shared/clips'])
    expect(log.upload).toEqual([])
    expect(run.view).toMatchObject({ status: 'failed', failed: 2, done: 0 })
    expect(run.view.failures.every((f) => f.error === denied)).toBe(true)
  })

  test('a file over the limit, a bad name and an unreadable entry fail before any request and do not come back at try again', async () => {
    const { calls, log } = fakeCalls({ maxFileSize: 5 })
    const p = plan(['clips/ok.mp4', 'clips/bad?/x.mp4'], { unreadable: ['clips/gone.mp4'] })
    p.files.push({ rel: 'clips/big.mp4', file: file('big.mp4', 6) })
    const run = new FolderUpload(p, '', calls)
    await run.start()
    expect(log.upload).toEqual(['clips/ok.mp4'])
    expect(run.view.failures.map((f) => [f.path, f.local])).toEqual([['clips/bad?/x.mp4', 'chars'], ['clips/big.mp4', 'tooLarge'], ['clips/gone.mp4', 'unreadable']])
    expect(run.view).toMatchObject({ status: 'failed', total: 4, done: 1, failed: 3, canRetry: false })
  })

  test('an empty folder is made and does not count as a file; a failed one can be tried again', async () => {
    const fail = new Map<string, unknown>([['clips/empty', apiError('internal')]])
    const { calls, log } = fakeCalls({ fail })
    const run = new FolderUpload(plan(['clips/a.mp4'], { folders: ['clips/empty'] }), '', calls)
    await run.start()
    expect(run.view).toMatchObject({ status: 'failed', total: 1, done: 1, failed: 1, canRetry: true })
    fail.clear()
    await run.retry()
    expect(log.mkdir.filter((p) => p === 'clips/empty')).toHaveLength(2)
    expect(run.view).toMatchObject({ status: 'done', failed: 0 })
  })

  test('cancel stops the run and drops what the server holds; a closed panel drops the failed files too', async () => {
    let open = () => {}
    const hold = new Promise<void>((r) => { open = r })
    const { calls, log } = fakeCalls({ hold })
    const run = new FolderUpload(plan(['c/1', 'c/2', 'c/3', 'c/4', 'c/5']), '', calls)
    const ended = run.start()
    await new Promise((r) => setTimeout(r, 0))
    expect(run.view.active).toHaveLength(FOLDER_UPLOAD_CONCURRENCY)
    expect(isBusy('upload')).toBe(true)
    const cancelled = run.cancel()
    open()
    await Promise.all([ended, cancelled])
    expect(log.upload).toHaveLength(FOLDER_UPLOAD_CONCURRENCY)
    expect(log.discard.sort()).toEqual(['c/1', 'c/2', 'c/3', 'c/4', 'c/5'])
    expect(isBusy('upload')).toBe(false)

    const second = fakeCalls({ fail: new Map([['d/2', apiError('internal')]]) })
    const failed = new FolderUpload(plan(['d/1', 'd/2']), '', second.calls)
    await failed.start()
    await failed.discard()
    expect(second.log.discard).toEqual(['d/2'])
  })

  test('bytes count what was sent, not what was hashed, and several dropped items have no one name', async () => {
    const seen: number[] = []
    const { calls } = fakeCalls()
    const run: FolderUpload = new FolderUpload(plan(['a/1', 'b/2']), '', calls, () => seen.push(run.view.bytesDone))
    await run.start()
    expect(Math.max(...seen)).toBe(6)
    expect(seen.filter((n) => n === 0).length).toBeGreaterThan(1)
    expect(run.view).toMatchObject({ name: null, items: 2 })
  })

  test('a storage refusal is 507 or the disk check of session create, nothing else', () => {
    expect(isStorageRefusal(apiError('storage_full'))).toBe(true)
    expect(isStorageRefusal(apiError('payload_too_large'))).toBe(true)
    for (const e of [apiError('forbidden'), apiError('rate_limited'), new Error('x'), null]) expect(isStorageRefusal(e)).toBe(false)
  })
})
