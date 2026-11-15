// "Find work files on this computer" in the page (docs/DECISIONS.md "Find work files on this computer"; lib/workFiles.ts,
// lib/teamFiles.ts, lib/folderUpload.ts): which desktop apps get the entry, the look's list as documents with nothing
// read until they go up, the personal-looking names of the six languages (phrases too), "Select all" (never a personal
// file, at most 100), the 1 GB line, a run that reads each file only when it goes and names the folders it made, and
// Undo, which takes back only what the run made.
import { describe, expect, test } from 'bun:test'
import { WORK_FILES_BRIDGE_VERSION, folderLabel, FROM_COMPUTER_DIR, type DesktopBridge, type WorkFileMeta, type WorkFileRead } from '@mycel/shared'
import { FolderUpload, type FolderUploadCalls } from '../../src/lib/folderUpload'
import { personalPath } from '../../src/lib/teamFiles'
import { docsFromScan, overBytes, rootNotes, selectAll, undoRun, WorkFileReadError, workFilesBridge } from '../../src/lib/workFiles'
import { folderWords } from '../../src/lib/folderLabels'

const meta = (name: string, o: Partial<WorkFileMeta> = {}): WorkFileMeta => ({ id: `id-${name}`, root: 'documents', folder: '', name, ext: name.split('.').pop()!, size: 10, modified: Date.UTC(2026, 9, 3, 12), ...o })

describe('which desktop app gets the entry', () => {
  const w = { version: WORK_FILES_BRIDGE_VERSION, scan: async () => ({ state: 'cancelled' as const }), stop: () => {}, onProgress: () => () => {}, read: async () => ({ ok: false as const, reason: 'unknown' as const }), openSettings: () => {} }
  test('only one with this version of workFiles (an older app, the Mac App Store build, a browser: none)', () => {
    expect(workFilesBridge(null)).toBeNull()
    expect(workFilesBridge({ bridgeVersion: 1 } as DesktopBridge)).toBeNull()
    expect(workFilesBridge({ bridgeVersion: 1, workFiles: { ...w, version: WORK_FILES_BRIDGE_VERSION + 1 } } as unknown as DesktopBridge)).toBeNull()
    expect(workFilesBridge({ bridgeVersion: 1, workFiles: w } as unknown as DesktopBridge)).toBe(w)
  })
})

describe('the look\'s list', () => {
  test('documents with nothing read: a file\'s bytes are asked for by its id only when it goes up', async () => {
    const asked: string[] = []
    const read = async (id: string): Promise<WorkFileRead> => { asked.push(id); return id === 'id-b.pdf' ? { ok: false, reason: 'changed' } : { ok: true, bytes: new Uint8Array([1, 2, 3]) } }
    const docs = docsFromScan([meta('a.pdf', { folder: 'Clients/Northwind' }), meta('b.pdf', { root: 'downloads' }), meta('급여명세서.pdf', { root: 'desktop' })], read)
    expect(asked).toEqual([])
    expect(docs.map((d) => [d.key, d.pick, d.rel, d.personal])).toEqual([
      ['Documents/Clients/Northwind/a.pdf', 'Documents', 'Clients/Northwind/a.pdf', false],
      ['Downloads/b.pdf', 'Downloads', 'b.pdf', false],
      ['Desktop/급여명세서.pdf', 'Desktop', '급여명세서.pdf', true],
    ])
    const f = await docs[0]!.open()
    expect([f.name, f.size, asked]).toEqual(['a.pdf', 3, ['id-a.pdf']])
    expect(docs[1]!.open()).rejects.toBeInstanceOf(WorkFileReadError)
    // the page never holds a path of the computer
    expect(JSON.stringify(docs)).not.toContain('/Users/')
  })

  test('the folders\' lines: blocked, cut, left out, over 50 MB, none looked at', () => {
    const r = (id: 'documents' | 'desktop' | 'downloads', state: 'ok' | 'blocked' | 'home', o: { cut?: boolean; tooBig?: number } = {}) => ({ id, oneDrive: false, state, cut: o.cut ?? false, tooBig: o.tooBig ?? 0, checked: 0 })
    const n = rootNotes([r('documents', 'ok', { tooBig: 2 }), r('desktop', 'home'), r('downloads', 'blocked')])
    expect([n.blocked.map((x) => x.id), n.left.map((x) => x.id), n.tooBig, n.none]).toEqual([['downloads'], ['desktop'], 2, false])
    expect(rootNotes([r('documents', 'blocked'), r('desktop', 'blocked'), r('downloads', 'blocked')]).none).toBe(true)
    expect(rootNotes([r('documents', 'ok'), r('desktop', 'ok'), r('downloads', 'ok', { cut: true })]).cut.map((x) => x.id)).toEqual(['downloads'])
  })

  test('Select all: never a personal-looking file, at most 100, and says when it stopped there', () => {
    const read = async (): Promise<WorkFileRead> => ({ ok: true, bytes: new Uint8Array() })
    const many = docsFromScan(Array.from({ length: 130 }, (_, i) => meta(`report ${i}.pdf`)), read)
    const personal = docsFromScan([meta('payslip.pdf'), meta('Tax Return 2025.pdf')], read)
    const a = selectAll(new Set(), [...personal, ...many])
    expect(a.ticks.size).toBe(100)
    expect(a.capped).toBe(true)
    expect([...a.ticks].some((k) => /payslip|Tax Return/.test(k))).toBe(false)
    const few = selectAll(new Set(['Documents/payslip.pdf']), many.slice(0, 5))
    // a personal file the person ticked themselves stays ticked; the cap counts it
    expect([few.ticks.size, few.capped, few.ticks.has('Documents/payslip.pdf')]).toEqual([6, false, true])
  })

  test('at most 1 GB per add', () => {
    const docs = docsFromScan([meta('a.pdf', { size: 600 * 1024 * 1024 }), meta('b.pdf', { size: 500 * 1024 * 1024 })], async () => ({ ok: false, reason: 'unknown' }))
    expect(overBytes(docs, new Set(['Documents/a.pdf']))).toBe(false)
    expect(overBytes(docs, new Set(['Documents/a.pdf', 'Documents/b.pdf']))).toBe(true)
  })
})

describe('personal-looking names in the six languages', () => {
  test('words and phrases match; a phrase never matches its words apart; work files do not', () => {
    const personal = [
      'Tax Return 2025.pdf', 'tax-return.pdf', 'Bank Statement March.pdf', "Driver's License.pdf", 'id card scan.pdf', 'Medical record.pdf', 'W-2 2025.pdf', 'payslip_oct.pdf',
      '급여/2026-10.xlsx', '주민등록등본.pdf', '이력서.docx', '인사/명단.xlsx',
      '給与明細_10月.pdf', '履歴書.docx', 'マイナンバー.pdf',
      '工资单.xlsx', '身份证.jpg', '简历.pdf',
      'declaración de la renta 2024.pdf', 'Nómina octubre.pdf', 'pasaporte.pdf', 'extracto bancario.pdf',
      'slip_gaji_okt.pdf', 'KTP.pdf', 'kartu keluarga.pdf', 'daftar riwayat hidup.docx',
    ]
    for (const p of personal) expect(personalPath(p), p).toBe(true)
    const work = ['Quote template.xlsx', 'Brand guide v3.pdf', 'Weekly report - Nov 10.docx', 'Clients/Northwind proposal.pptx', 'statement of work.pdf', 'return policy.pdf', 'bank holiday schedule.xlsx', '인사말.docx', '견적서 양식.xlsx', '議事録.docx', '会议纪要.docx', 'Propuesta comercial.pptx', 'Laporan mingguan.docx']
    for (const p of work) expect(personalPath(p), p).toBe(false)
  })
})

describe('the run: read when it goes, the folders it made', () => {
  function calls(exists = new Set<string>()) {
    const log = { mkdir: [] as string[], upload: [] as string[], made: [] as string[] }
    const c: FolderUploadCalls = {
      maxFileSize: 1024 * 1024 * 1024,
      mkdir: async (path) => { log.mkdir.push(path); if (exists.has(path)) throw Object.assign(new Error('conflict'), { code: 'conflict' }) },
      isFolder: async (path) => exists.has(path),
      upload: async (_f, path) => { log.upload.push(path); return { kind: 'path', entry: { path } } },
      discard: async () => {},
      onMade: (p) => log.made.push(p),
    }
    return { c, log }
  }
  test('each file is read once, as it goes; one that cannot be read fails and is not tried again', async () => {
    const opened: string[] = []
    const open = (name: string, fail = false) => async () => { opened.push(name); if (fail) throw new WorkFileReadError('changed'); return new File(['x'], name) }
    const { c, log } = calls(new Set(['users/u1/From this computer']))
    const run = new FolderUpload({ files: [{ rel: 'From this computer/Documents/a.pdf', size: 1, open: open('a.pdf') }, { rel: 'From this computer/Documents/b.pdf', size: 1, open: open('b.pdf', true) }], folders: [], unreadable: [], skipped: 0 }, 'users/u1', c)
    expect(opened).toEqual([])
    await run.start()
    expect(opened.sort()).toEqual(['a.pdf', 'b.pdf'])
    expect(log.upload).toEqual(['users/u1/From this computer/Documents/a.pdf'])
    expect(run.view).toMatchObject({ done: 1, failed: 1, canRetry: false })
    expect(run.rows().find((r) => r.rel.endsWith('b.pdf'))).toMatchObject({ state: 'failed', local: 'unreadable' })
    // what was read on demand is not kept once it went up
    expect(run.rows().every((r) => r.file === undefined)).toBe(true)
    // only the folders the run made, never the one that was there
    expect(log.made).toEqual(['users/u1/From this computer/Documents'])
  })
})

describe('Undo', () => {
  test('only what the run made: its files, then its folders that are empty now, deepest first; never anything else', async () => {
    const removed: string[] = []
    const empty = new Set(['users/u1/From this computer/Documents/Clients', 'users/u1/From this computer/Documents'])
    const r = await undoRun({ files: ['users/u1/From this computer/Documents/Clients/a.pdf', 'users/u1/From this computer/Documents/b (1).pdf', 'users/u1/From this computer/Documents/b (1).pdf'], folders: ['users/u1/From this computer', 'users/u1/From this computer/Documents', 'users/u1/From this computer/Documents/Clients'] }, {
      remove: async (p) => { removed.push(p); return { purgeAt: p.endsWith('a.pdf') ? '2026-12-15T00:00:00Z' : '2026-12-14T00:00:00Z' } },
      // From this computer itself still holds an older file of the person's: it stays
      isEmpty: async (p) => empty.has(p),
    })
    expect(removed).toEqual(['users/u1/From this computer/Documents/Clients/a.pdf', 'users/u1/From this computer/Documents/b (1).pdf', 'users/u1/From this computer/Documents/Clients', 'users/u1/From this computer/Documents'])
    expect(r).toEqual({ removed: removed.slice(0, 2), failed: [], purgeAt: '2026-12-15T00:00:00Z' })
  })

  test('a file that cannot go to the trash is counted; the rest go', async () => {
    const r = await undoRun({ files: ['users/u1/x.pdf', 'users/u1/y.pdf'], folders: [] }, {
      remove: async (p) => { if (p.endsWith('x.pdf')) throw new Error('403'); return { purgeAt: '2026-12-01T00:00:00Z' } },
      isEmpty: async () => true,
    })
    expect(r).toEqual({ removed: ['users/u1/y.pdf'], failed: ['users/u1/x.pdf'], purgeAt: '2026-12-01T00:00:00Z' })
  })
})

describe('My files › From this computer', () => {
  test('one name on disk, said in the person\'s words', () => {
    expect(FROM_COMPUTER_DIR).toBe('From this computer')
    expect(folderLabel('users/u1/From this computer', 'ko', 'u1')).toBe('이 컴퓨터에서')
    expect(folderLabel('users/u2/From this computer', 'ko', 'u1')).toBeNull()
    // (the own folder's word, 自分のフォルダー or 自分のファイル, is set at start: either here)
    expect(folderWords('ja', 'u1').path('users/u1/From this computer/Documents', ' › ')).toMatch(/^自分の.+ › このコンピューターから › Documents$/)
  })
})
