// 팀 파일 in the welcome steps (docs/DECISIONS.md "W6"; lib/teamFiles.ts, lib/folderRuns.ts, components/FolderUploads.tsx):
// the local walk and its limits, the names it never lists, the types it considers, the personal-looking names (every
// part of the path), what goes to the AI (never a personal one, at most 500, name words first), the list's groups,
// merging a second folder, "이미 있어요", hand-picked files that are already there, and the step's tagged upload run (it
// stays after its row leaves, it reports the first landed file once, sign-out forgets it).
import { afterEach, describe, expect, test } from 'bun:test'
import { TEAM_FILES_LIMITS } from '@mycel/shared/api'
import { startFolderUpload } from '../../src/components/FolderUploads'
import { forgetFolderUploads, onFolderUploadsForgotten, taggedRun, useRuns } from '../../src/lib/folderRuns'
import {
  allPersonal, considered, dirFromEntry, dirFromFiles, findAlready, findDocs, forAi, groupDocs, mergeDocs, neverListed, newPicks, personalPath, rankEntries, tick, walkFolder,
  type DirEntryLike, type FileEntryLike, type LocalDoc, type WalkDir, type WalkEntry,
} from '../../src/lib/teamFiles'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 1)
const file = (name: string, o: { size?: number; at?: number; rel?: string } = {}) => {
  const f = new File([new Uint8Array(o.size ?? 3)], name, { lastModified: o.at ?? T0 })
  if (o.rel) Object.defineProperty(f, 'webkitRelativePath', { value: o.rel })
  return f
}
type Spec = { [name: string]: Spec | File }
/** A folder made of names: a nested object is a folder, a File a file. `opened` counts the files whose File was asked for. */
function dir(name: string, spec: Spec, opened = { n: 0 }): WalkDir {
  return {
    name,
    async *entries(): AsyncIterable<WalkEntry> {
      for (const [n, v] of Object.entries(spec)) {
        if (v instanceof File) yield { kind: 'file', name: n, file: async () => { opened.n++; return v } }
        else yield { kind: 'directory', name: n, dir: () => dir(n, v, opened) }
      }
    },
  }
}
const doc = (rel: string, o: { size?: number; at?: number; pick?: string } = {}): LocalDoc => {
  const name = rel.split('/').pop()!
  const pick = o.pick ?? '회사 자료'
  return { key: `${pick}/${rel}`, pick, rel, name, folder: rel.split('/').slice(0, -1).join('/'), ext: name.split('.').pop()!, size: o.size ?? 10, modified: o.at ?? T0, file: file(name, o), personal: personalPath(rel) }
}

describe('the walk', () => {
  test('documents only, by type; pictures only in a brand folder; never dot entries, system names, bundles, node_modules, .git, Library', async () => {
    const opened = { n: 0 }
    const r = await walkFolder(dir('회사 자료', {
      '2026 견적서 양식.xlsx': file('a'), '회사 소개서.pdf': file('b'), 'notes.md': file('c'), 'photo.png': file('d'), 'setup.exe': file('e'), 'movie.mp4': file('f'),
      '.secret.pdf': file('g'), '~$lock.docx': file('h'), '.DS_Store': file('i'), 'Thumbs.db': file('j'),
      '브랜드': { 'logo.png': file('k'), 'guide.pdf': file('l') },
      'Logos': { 'mark.jpg': file('m') },
      'node_modules': { 'readme.md': file('n') }, '.git': { 'HEAD.txt': file('o') }, 'Library': { 'x.pdf': file('p') }, 'Keynote.app': { 'y.pdf': file('q') },
      '.hidden': { 'z.pdf': file('r') },
    }, opened), {})
    expect(r.docs.map((d) => d.key).sort()).toEqual(['회사 자료/2026 견적서 양식.xlsx', '회사 자료/Logos/mark.jpg', '회사 자료/notes.md', '회사 자료/브랜드/guide.pdf', '회사 자료/브랜드/logo.png', '회사 자료/회사 소개서.pdf'].sort())
    // a file that is not a document is never opened
    expect(opened.n).toBe(6)
    expect(r).toMatchObject({ cut: false, stopped: false, tooBig: 0 })
    expect(r.docs.find((d) => d.name === 'guide.pdf')).toMatchObject({ pick: '회사 자료', rel: '브랜드/guide.pdf', folder: '브랜드', ext: 'pdf', size: 3 })
    for (const n of ['.env', 'node_modules', 'NODE_MODULES', '.git', 'library', 'AppData', 'Photos Library.photoslibrary', 'Xcode.app', '__MACOSX', '~$보고서.docx']) expect(neverListed(n), n).toBe(true)
    for (const n of ['Library Rules.pdf', '회사 자료', 'app.pdf']) expect(neverListed(n), n).toBe(false)
    // the picked folder's own name counts: a picked 브랜드 folder lists its logos; a picked 인사 folder is all personal
    expect((await walkFolder(dir('브랜드', { 'logo.png': file('k'), 'a.pdf': file('a') }))).docs.map((d) => d.name).sort()).toEqual(['a.pdf', 'logo.png'])
    const hr = await walkFolder(dir('인사', { '2026-10.xlsx': file('p'), '규정': { '휴가.pdf': file('q') } }))
    expect(hr.docs.map((d) => d.personal)).toEqual([true, true])
    expect(allPersonal(hr.docs, new Set())).toBe(true)
    expect(forAi(hr.docs)).toEqual([])
    expect(considered('a.HWPX', [])).toBe(true)
    expect(considered('a.png', ['photos'])).toBe(false)
    expect(considered('a.png', ['회사 로고'])).toBe(true)
  })

  test('the limits: 5,000 documents, 50,000 entries walked, 6 folders down, 15 s, 50 MB per file; [그만 보기]', async () => {
    const many = (n: number, ext = 'pdf') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.${ext}`, file(`f${i}.${ext}`)]))
    expect(await walkFolder(dir('a', many(12)), { limits: { walkDocs: 5 } })).toMatchObject({ cut: true, docs: { length: 5 } })
    expect(TEAM_FILES_LIMITS).toMatchObject({ walkDocs: 5000, walkFiles: 50_000, depth: 6, walkMs: 15_000, fileBytes: 50 * 1024 * 1024, toAi: 500, prechecked: 20, perUpload: 100 })
    // entries that are not documents count toward the walk too (a Downloads folder full of other files)
    const junk = await walkFolder(dir('a', { ...many(30, 'mp4'), 'x.pdf': file('x') }), { limits: { walkFiles: 10 } })
    expect(junk).toMatchObject({ cut: true, walked: 10, docs: [] })
    // six folders below the picked one, not seven; breadth first: the top files before the deep ones
    const deep: Spec = { 'top.pdf': file('t') }
    let at = deep
    for (let i = 1; i <= 8; i++) { const next: Spec = { [`d${i}.pdf`]: file(`d${i}`) }; at[`l${i}`] = next; at = next }
    const r = await walkFolder(dir('a', deep))
    expect(r.docs.map((d) => d.name)).toEqual(['top.pdf', 'd1.pdf', 'd2.pdf', 'd3.pdf', 'd4.pdf', 'd5.pdf', 'd6.pdf'])
    expect(r.docs.at(-1)!.folder).toBe('l1/l2/l3/l4/l5/l6')
    expect(r.cut).toBe(true)
    // time: the clock passes 15 s
    let now = 0
    const slow = await walkFolder(dir('a', many(40)), { now: () => (now += 1000) })
    expect(slow.cut).toBe(true)
    expect(slow.docs.length).toBeLessThan(16)
    // over 50 MB: counted, not listed
    const big = await walkFolder(dir('a', { 'big.pdf': file('big', { size: 11 }), 'ok.pdf': file('ok', { size: 10 }) }), { limits: { fileBytes: 10 } })
    expect(big).toMatchObject({ tooBig: 1, docs: [{ name: 'ok.pdf' }] })
    let stop = false
    const stopped = await walkFolder(dir('a', many(50)), { stopped: () => stop, onProgress: (n) => { if (n >= 3) stop = true } })
    expect(stopped).toMatchObject({ stopped: true, cut: false })
    expect(stopped.docs.length).toBe(3)
  })

  test('the folder input (Safari, Firefox, the desktop app) and a dropped folder walk the same way', async () => {
    const d = dirFromFiles([file('a.pdf', { rel: '자료/a.pdf' }), file('b.pdf', { rel: '자료/x/b.pdf' }), file('c.pdf', { rel: '자료/.hidden/c.pdf' }), file('d.pdf', { rel: '../d.pdf' }), file('e.pdf', { rel: '다른/e.pdf' })])!
    expect(d.name).toBe('자료')
    expect((await walkFolder(d)).docs.map((x) => x.key)).toEqual(['자료/a.pdf', '자료/x/b.pdf'])
    expect(dirFromFiles([])).toBeNull()
    const entry = (name: string): FileEntryLike => ({ name, isFile: true, isDirectory: false, file: (ok) => ok(file(name)) })
    const folder = (name: string, kids: (DirEntryLike | FileEntryLike)[]): DirEntryLike => ({
      name, isFile: false, isDirectory: true,
      createReader() { let done = false; return { readEntries(ok) { ok(done ? [] : kids); done = true } } },
    })
    const r = await walkFolder(dirFromEntry(folder('드롭', [entry('a.docx'), folder('sub', [entry('b.xlsx')])])))
    expect(r.docs.map((x) => x.key)).toEqual(['드롭/a.docx', '드롭/sub/b.xlsx'])
  })
})

describe('the list', () => {
  test('personal-looking names, matched against every part of the path', () => {
    for (const p of ['인사/급여/2026-10.xlsx', '급여명세서.pdf', 'HR/handbook.pdf', 'docs/payroll_2026.xlsx', '김민지 이력서.docx', 'Personal/notes.md', '인사팀/규정.pdf', 'my CV.pdf'])
      expect(personalPath(p), p).toBe(true)
    for (const p of ['영업/견적서 양식.xlsx', '회사 인사말.docx', 'Hardware/specs.pdf', 'Shrimp recipes.pdf', '회사 소개서.pdf'])
      expect(personalPath(p), p).toBe(false)
  })

  test('for the AI: never a personal one, at most 500, name words first, then office files, then newest; ids and the folder', () => {
    const docs = [
      doc('old 양식.xlsx', { at: T0 - 300 * DAY }), doc('new report.pdf', { at: T0 }), doc('notes.md', { at: T0 + DAY }), doc('older report.pdf', { at: T0 - DAY }),
      doc('인사/급여/2026-10.xlsx', { at: T0 + 2 * DAY }), doc('Policy handbook.docx', { at: T0 - 900 * DAY }),
    ]
    expect(forAi(docs).map((d) => d.name)).toEqual(['old 양식.xlsx', 'Policy handbook.docx', 'new report.pdf', 'older report.pdf', 'notes.md'])
    expect(forAi(Array.from({ length: 600 }, (_, i) => doc(`f${i}.pdf`))).length).toBe(500)
    const { entries, keyOf } = rankEntries([doc('영업/양식/견적서.xlsx', { size: 48_000 })])
    expect(entries).toEqual([{ id: 'e0', name: '견적서.xlsx', path: '회사 자료/영업/양식', type: 'xlsx', size: 48_000, modified: '2026-10-01' }])
    expect(keyOf.get('e0')).toBe('회사 자료/영업/양식/견적서.xlsx')
    // what goes out is metadata only: no File, no content
    expect(JSON.stringify(entries)).not.toContain('file')
  })

  test('the groups: the AI\'s top 20 first, its further picks and the rest under "다른 파일도 보기", personal and already apart', () => {
    const docs = Array.from({ length: 30 }, (_, i) => doc(`f${i}.pdf`, { at: T0 + i * DAY }))
    docs.push(doc('인사/급여.xlsx'), doc('there.pdf'))
    const picks = new Map(Array.from({ length: 25 }, (_, i) => [docs[24 - i]!.key, 'report' as const]))
    picks.set(docs[30]!.key, 'report') // a personal one the AI could not have seen: never a pick
    const g = groupDocs(docs, picks, new Set([docs[31]!.key]))
    expect(g.recommended.map((d) => d.name)).toEqual(Array.from({ length: 20 }, (_, i) => `f${24 - i}.pdf`))
    expect(g.more.map((d) => d.name).slice(0, 5)).toEqual(['f4.pdf', 'f3.pdf', 'f2.pdf', 'f1.pdf', 'f0.pdf'])
    expect(g.more.map((d) => d.name).slice(5)).toEqual(['f29.pdf', 'f28.pdf', 'f27.pdf', 'f26.pdf', 'f25.pdf'])
    expect(g.personal.map((d) => d.rel)).toEqual(['인사/급여.xlsx'])
    expect(g.already.map((d) => d.rel)).toEqual(['there.pdf'])
    // no AI: nothing recommended, all of it under "다른 파일도 보기"
    expect(groupDocs(docs, null, new Set()).recommended).toEqual([])
    expect(allPersonal([doc('인사/a.pdf'), doc('급여/b.pdf'), doc('there.pdf')], new Set(['회사 자료/there.pdf']))).toBe(true)
    expect(allPersonal([doc('인사/a.pdf'), doc('b.pdf')], new Set())).toBe(false)
    expect(findDocs(docs, 'F1').map((d) => d.name)).toEqual(['f1.pdf', ...Array.from({ length: 10 }, (_, i) => `f${10 + i}.pdf`)])
  })

  test('ticks: at most 100 per upload (the 101st is refused)', () => {
    let ticks = new Set(Array.from({ length: 99 }, (_, i) => `k${i}`))
    let r = tick(ticks, 'k99', true)
    expect(r).toMatchObject({ refused: false })
    ticks = r.ticks
    r = tick(ticks, 'k100', true)
    expect(r.refused).toBe(true)
    expect(r.ticks.size).toBe(100)
    expect(tick(ticks, 'k0', false).ticks.size).toBe(99)
  })

  test('폴더 더 고르기: the lists merge, a file listed twice (a folder and one inside it) shows once', () => {
    const a = [doc('영업/견적서.xlsx'), doc('규정.pdf')]
    const b = [doc('견적서.xlsx', { pick: '영업' }), doc('새 파일.pdf', { pick: '영업' })]
    expect(mergeDocs(a, b).map((d) => d.key)).toEqual(['회사 자료/영업/견적서.xlsx', '회사 자료/규정.pdf', '영업/새 파일.pdf'])
    // a file of another size or date is another file
    expect(mergeDocs(a, [doc('견적서.xlsx', { pick: '영업', size: 11 })])).toHaveLength(3)
  })

  test('이미 있어요: the same path in the target folder with the same size; folders that are not there are not listed', async () => {
    const listed: string[] = []
    const tree: Record<string, { name: string; type: 'file' | 'folder'; size: number }[]> = {
      'groups/Acme': [{ name: '회사 자료', type: 'folder', size: 0 }, { name: '규정.pdf', type: 'file', size: 10 }],
      'groups/Acme/회사 자료': [{ name: '영업', type: 'folder', size: 0 }, { name: '규정.pdf', type: 'file', size: 10 }, { name: '소개.pdf', type: 'file', size: 99 }, { name: '규정 (1).pdf', type: 'file', size: 10 }],
      'groups/Acme/회사 자료/영업': [{ name: '견적서.xlsx', type: 'file', size: 10 }],
    }
    const list = async (p: string) => { listed.push(p); return tree[p] ?? null }
    const docs = [doc('규정.pdf'), doc('소개.pdf'), doc('영업/견적서.xlsx'), doc('영업/양식/new.pdf'), doc('없음/a.pdf'), doc('x.pdf', { pick: '다른 폴더' })]
    expect([...await findAlready(docs, 'groups/Acme', list)].sort()).toEqual(['회사 자료/규정.pdf', '회사 자료/영업/견적서.xlsx'])
    // only folders that are there are listed, from the target down: 영업/양식, 없음 and 다른 폴더 are not (no 404s)
    expect(listed.sort()).toEqual(['groups/Acme', 'groups/Acme/회사 자료', 'groups/Acme/회사 자료/영업'])
  })

  test('hand-picked files: what is already in the folder or in a run of the step (same name and size) is skipped', () => {
    const r = newPicks([file('a.pdf', { size: 5 }), file('b.pdf', { size: 5 }), file('b.pdf', { size: 5 }), file('c.pdf', { size: 7 })], new Map([['a.pdf', 5], ['c.pdf', 6]]))
    expect(r.files.map((f) => `${f.name}:${f.size}`)).toEqual(['b.pdf:5', 'c.pdf:7'])
    expect(r.skipped).toBe(2)
    expect(newPicks(Array.from({ length: 120 }, (_, i) => file(`f${i}.pdf`)), new Map())).toMatchObject({ files: { length: 100 }, cut: 20 })
  })
})

/** An upload with its progress goes through XMLHttpRequest (lib/xhr.ts): this one answers from the faked fetch. */
class FakeXHR {
  status = 0
  response: Blob | null = null
  responseType = ''
  withCredentials = false
  upload: { onprogress: ((e: unknown) => void) | null; onload: (() => void) | null } = { onprogress: null, onload: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  private method = 'GET'
  private url = ''
  private type: string | null = null
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader() {}
  getResponseHeader(k: string) { return k.toLowerCase() === 'content-type' ? this.type : null }
  abort() { this.onabort?.() }
  send(body: unknown) {
    void (async () => {
      const res = await globalThis.fetch(this.url, { method: this.method, body: body as BodyInit })
      this.status = res.status
      this.type = res.headers.get('content-type')
      this.response = await res.blob()
      this.upload.onload?.()
      this.onload?.()
    })()
  }
}

describe('the step\'s upload run', () => {
  const realFetch = globalThis.fetch
  const g = globalThis as Record<string, unknown>
  const xhrBefore = Object.getOwnPropertyDescriptor(g, 'XMLHttpRequest')
  afterEach(() => {
    globalThis.fetch = realFetch
    if (xhrBefore) Object.defineProperty(g, 'XMLHttpRequest', xhrBefore)
    else delete g.XMLHttpRequest
    forgetFolderUploads()
  })

  test('tagged: kept after its row goes; each landed file reported with where it is now; sign-out forgets it and the list', async () => {
    const seen: string[] = []
    Object.defineProperty(g, 'XMLHttpRequest', { configurable: true, writable: true, value: FakeXHR })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`)
      if (url.includes('/api/files/mkdir')) return new Response(JSON.stringify({ name: 'x', path: 'x', type: 'folder', size: null, mtime: '2026-11-08T00:00:00.000Z', mime: null, access: 'write' }), { status: 201, headers: { 'content-type': 'application/json' } })
      if (url.includes('/api/files/upload')) {
        const form = init!.body as FormData
        const name = String(form.get('name'))
        return new Response(JSON.stringify({ name, path: `${form.get('folder')}/${name}`, type: 'file', size: Number(form.get('size')), mtime: '2026-11-08T00:00:00.000Z', mime: 'application/pdf', access: 'write' }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const landed: string[] = []
    const run = startFolderUpload({ files: [{ rel: '회사 자료/a.pdf', file: file('a.pdf') }, { rel: '회사 자료/b.pdf', file: file('b.pdf') }], folders: [], unreadable: [], skipped: 0 }, 'groups/Acme', () => {}, { tag: 'welcome-files', onLanded: (p) => landed.push(p) })
    expect(taggedRun('welcome-files')!.run).toBe(run.run)
    // an untagged run of the file screen is not the step's
    startFolderUpload({ files: [], folders: ['x'], unreadable: [], skipped: 0 }, 'shared', () => {})
    await new Promise<void>((resolve) => { const off = useRuns.subscribe((s) => { if (s.tagged['welcome-files']?.view.status !== 'running') { off(); resolve() } }); if (taggedRun('welcome-files')!.view.status !== 'running') resolve() })
    expect(landed.sort()).toEqual(['groups/Acme/회사 자료/a.pdf', 'groups/Acme/회사 자료/b.pdf'])
    expect(taggedRun('welcome-files')!.view).toMatchObject({ status: 'done', done: 2, total: 2 })
    expect(taggedRun('welcome-files')!.run.rows().map((r) => [r.rel, r.state])).toEqual([['회사 자료/a.pdf', 'done'], ['회사 자료/b.pdf', 'done']])
    // the picked folder's own name, made once for the step's run (and x for the other run)
    expect(seen.filter((s) => s.startsWith('POST /api/files/mkdir')).length).toBe(2)
    expect(seen.filter((s) => s.startsWith('POST /api/onboarding/files/landed'))).toEqual([])
    // the row on the file screen goes; the step still has the run
    useRuns.setState((s) => ({ runs: s.runs.filter((r) => r.run !== run.run) }))
    expect(taggedRun('welcome-files')!.run).toBe(run.run)
    let forgot = 0
    onFolderUploadsForgotten(() => { forgot++ })
    forgetFolderUploads()
    expect(taggedRun('welcome-files')).toBeNull()
    expect(useRuns.getState().runs).toEqual([])
    expect(forgot).toBe(1)
  })
})
