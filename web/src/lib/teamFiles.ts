// 팀 파일 in the welcome steps (docs/DECISIONS.md "W6 — Onboarding v6: 팀 파일 recommendations"; FLOW v6 §3.2): the
// local list of a folder the person picked, made in the page before anything leaves it. The walk opens no file: it
// reads names, sizes and dates only (a File object is a reference; its bytes are read by the upload, of the files the
// person ticks). The same walk for the three ways in (WalkDir): a File System Access handle (Chrome, Edge: read lazily,
// so the count goes up and [그만 보기] stops it), a dropped folder (any browser) and the file list of
// <input webkitdirectory> (Safari, Firefox and the desktop app, which hand over the whole folder at once).
// - It stops at 5,000 documents or 50,000 entries walked, 6 folders down, or 15 s (the cut line says so).
// - Never listed: dot files and folders, system names (isSystemName), app bundles, node_modules, .git, Library,
//   Office's lock files (~$…).
// - Documents: pdf, doc(x), hwp(x), xls(x), csv, ppt(x), key, pages, numbers, txt, md, rtf; png and jpg only in a folder
//   named like logo or brand (브랜드, 로고). Over 50 MB: counted, not offered (the file screen takes those).
// - Personal-looking names (a word list matched against every part of the path, 인사/급여/2026-10.xlsx) are never sent
//   to the AI and never ticked by default; the person may still tick them (finance and HR work with payroll daily).
// - At most 500 entries go to the AI: by name words first (양식, 템플릿, 서식, 규정, 소개서, 매뉴얼, 가이드), then by type,
//   then newest. The AI's top 20 come ticked; at most 100 ticked per upload.
// No API calls here: the step gives them (the "이미 있어요" listing), so the tests need no server.
import { TEAM_FILES_LIMITS, type RankFileEntry, type TeamFileReason } from '@mycel/shared/api'
import { isSystemName } from './folderUpload'
import { extOf, joinPath } from './paths'

const L = TEAM_FILES_LIMITS
/** `a/b`, or `a` when b is empty (a file at the top of the picked folder) */
const under = (a: string, b: string) => (b ? joinPath(a, b) : a)

/** The document types considered (FLOW v6 §3.2). */
export const DOC_TYPES: readonly string[] = ['pdf', 'doc', 'docx', 'hwp', 'hwpx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'key', 'pages', 'numbers', 'txt', 'md', 'rtf']
const DOCS = new Set(DOC_TYPES)
const IMAGES = new Set(['png', 'jpg', 'jpeg'])
/** a folder whose pictures are brand material */
const brandFolder = (name: string) => /logo|brand|브랜드|로고/i.test(name)

/** Folders never entered (case does not matter). Library is the Mac's app data in a home folder; AppData Windows'. */
const NEVER = new Set(['node_modules', '.git', 'library', 'appdata'])
/** App bundles and packages: folders to the browser, one thing to a person. */
const BUNDLE = /\.(app|appex|bundle|framework|plugin|kext|prefpane|qlgenerator|saver|pkg|mpkg|lproj|xcodeproj|xcworkspace|photoslibrary|photolibrary|musiclibrary|tvlibrary|imovielibrary|fcpbundle)$/i

/** A name the walk never lists. */
export const neverListed = (name: string) =>
  name.startsWith('.') || name.startsWith('~$') || isSystemName(name) || NEVER.has(name.toLowerCase()) || BUNDLE.test(name)

/** A file the step considers, by its type and the folder it is in. */
export function considered(name: string, folders: readonly string[]): boolean {
  const ext = extOf(name)
  return DOCS.has(ext) || (IMAGES.has(ext) && folders.some(brandFolder))
}

// ---------------------------------------------------------------- personal-looking names

/** Korean words matched inside a part of the path. */
const PERSONAL_KO = ['급여', '월급', '연봉', '임금대장', '인사기록', '인사평가', '인사카드', '인사발령', '주민등록', '주민번호', '신분증', '여권', '이력서', '자기소개서', '경력증명', '재직증명', '원천징수', '연말정산', '건강검진', '진단서', '통장', '계좌', '비밀번호', '개인정보', '가족관계', '근로계약', '퇴직', '징계']
/** Short Korean words that are personal as a whole part only ("인사" is HR, "인사말" a greeting). */
const PERSONAL_KO_WHOLE = /^(인사|인사팀|인사부|인사총무|인사자료)$/
/** English words matched as whole words. */
const PERSONAL_EN = new Set(['payroll', 'salary', 'salaries', 'payslip', 'payslips', 'paystub', 'paystubs', 'resume', 'cv', 'passport', 'ssn', 'medical', 'password', 'passwords', 'personal', 'private', 'hr', 'w2'])

/** A part of the path (a folder or the file name) looks personal. */
function personalPart(part: string): boolean {
  const s = part.normalize('NFC').replace(/\.[a-z0-9]+$/i, '').trim()
  if (!s) return false
  if (PERSONAL_KO_WHOLE.test(s)) return true
  if (PERSONAL_KO.some((w) => s.includes(w))) return true
  return s.toLowerCase().split(/[^a-z0-9]+/).some((w) => PERSONAL_EN.has(w))
}
/** Any part of the path looks personal (인사/급여/2026-10.xlsx), the picked folder's own name included. */
export const personalPath = (rel: string) => rel.split('/').some(personalPart)

// ---------------------------------------------------------------- the walk

/** A folder as the walk sees it: its entries, names first; a file is opened (for its size and date) only when it is a
 * document. */
export interface WalkDir {
  readonly name: string
  entries(): AsyncIterable<WalkEntry>
}
export type WalkEntry = { kind: 'directory'; name: string; dir: () => WalkDir } | { kind: 'file'; name: string; file: () => Promise<File> }

/** One document of the list. `rel` is the path inside the picked folder; in the team folder it goes to
 * `<place>/<pick>/<rel>` (the picked folder's own name first, as the file screen's folder upload does). */
export interface LocalDoc {
  key: string
  pick: string
  rel: string
  name: string
  /** the folder inside the picked one ('' at its top) */
  folder: string
  ext: string
  size: number
  modified: number
  file: File
  personal: boolean
}

export interface WalkResult {
  docs: LocalDoc[]
  /** entries walked (files and folders) */
  walked: number
  /** a limit stopped it (documents, entries, depth or time): the cut line */
  cut: boolean
  /** [그만 보기] stopped it */
  stopped: boolean
  /** documents over the size limit (not listed) */
  tooBig: number
  unreadable: number
}

export interface WalkOptions {
  /** true once [그만 보기] was pressed */
  stopped?: () => boolean
  onProgress?: (docs: number, walked: number) => void
  now?: () => number
  limits?: Partial<Record<'walkDocs' | 'walkFiles' | 'depth' | 'walkMs' | 'fileBytes', number>>
}

/** Walk a picked folder breadth first (the top folders before the deep ones), within the limits. */
export async function walkFolder(root: WalkDir, o: WalkOptions = {}): Promise<WalkResult> {
  const lim = { walkDocs: L.walkDocs, walkFiles: L.walkFiles, depth: L.depth, walkMs: L.walkMs, fileBytes: L.fileBytes, ...o.limits }
  const now = o.now ?? (() => Date.now())
  const start = now()
  const pick = root.name.normalize('NFC')
  const out: WalkResult = { docs: [], walked: 0, cut: false, stopped: false, tooBig: 0, unreadable: 0 }
  const queue: { dir: WalkDir; folders: string[] }[] = [{ dir: root, folders: [] }]
  let reported = 0
  const report = () => { if (out.docs.length !== reported || out.walked % 200 === 0) { reported = out.docs.length; o.onProgress?.(out.docs.length, out.walked) } }
  const over = () => {
    if (o.stopped?.()) { out.stopped = true; return true }
    if (out.docs.length >= lim.walkDocs || out.walked >= lim.walkFiles || now() - start >= lim.walkMs) { out.cut = true; return true }
    return false
  }
  while (queue.length) {
    const { dir, folders } = queue.shift()!
    let it: AsyncIterator<WalkEntry> | null = null
    try {
      it = dir.entries()[Symbol.asyncIterator]()
      for (;;) {
        if (over()) return done(out, o)
        const step = await it.next()
        if (step.done) break
        const e = step.value
        out.walked++
        const name = e.name.normalize('NFC')
        if (neverListed(name)) continue
        if (e.kind === 'directory') {
          if (folders.length + 1 > lim.depth) { out.cut = true; continue }
          queue.push({ dir: e.dir(), folders: [...folders, name] })
          continue
        }
        // the picked folder's own name counts too (a picked 브랜드 folder's logos; a picked 인사 folder is personal)
        if (!considered(name, [pick, ...folders])) continue
        let file: File
        try { file = await e.file() } catch { out.unreadable++; continue }
        if (file.size > lim.fileBytes) { out.tooBig++; continue }
        const folder = folders.join('/')
        const rel = joinPath(folder, name)
        out.docs.push({ key: `${pick}/${rel}`, pick, rel, name, folder, ext: extOf(name), size: file.size, modified: file.lastModified, file, personal: personalPath(joinPath(pick, rel)) })
        report()
      }
    } catch {
      // a folder that cannot be read (taken away, no permission): the rest goes on
      out.unreadable++
    } finally {
      void it?.return?.()
    }
  }
  return done(out, o)
}
const done = (out: WalkResult, o: WalkOptions) => { o.onProgress?.(out.docs.length, out.walked); return out }

// ---- the three ways in

/** The parts of FileSystemDirectoryHandle used here (Chrome and Edge: showDirectoryPicker, a dropped folder's handle). */
export interface DirHandleLike {
  readonly kind: 'directory'
  readonly name: string
  entries(): AsyncIterable<[string, { readonly kind: 'file' | 'directory' }]>
}
interface FileHandleLike { readonly kind: 'file'; getFile(): Promise<File> }

export function dirFromHandle(h: DirHandleLike): WalkDir {
  return {
    name: h.name,
    async *entries() {
      for await (const [name, child] of h.entries()) {
        if (child.kind === 'directory') yield { kind: 'directory', name, dir: () => dirFromHandle(child as unknown as DirHandleLike) }
        else yield { kind: 'file', name, file: () => (child as unknown as FileHandleLike).getFile() }
      }
    },
  }
}

/** The parts of FileSystemDirectoryEntry used here (a dropped folder, any browser). */
export interface DirEntryLike {
  readonly name: string
  readonly isDirectory: boolean
  readonly isFile: boolean
  createReader(): { readEntries(ok: (entries: (DirEntryLike | FileEntryLike)[]) => void, fail: (e: unknown) => void): void }
}
export interface FileEntryLike {
  readonly name: string
  readonly isDirectory: boolean
  readonly isFile: boolean
  file(ok: (f: File) => void, fail: (e: unknown) => void): void
}

export function dirFromEntry(e: DirEntryLike): WalkDir {
  return {
    name: e.name,
    async *entries() {
      const reader = e.createReader()
      // one batch per call (Chromium: 100) and an empty batch at the end
      for (;;) {
        const batch = await new Promise<(DirEntryLike | FileEntryLike)[]>((resolve, reject) => reader.readEntries(resolve, reject))
        if (!batch.length) return
        for (const x of batch) {
          if (x.isDirectory) yield { kind: 'directory', name: x.name, dir: () => dirFromEntry(x as DirEntryLike) }
          else if (x.isFile) yield { kind: 'file', name: x.name, file: () => new Promise<File>((ok, no) => (x as FileEntryLike).file(ok, no)) }
        }
      }
    },
  }
}

interface Tree { dirs: Map<string, Tree>; files: Map<string, File> }
const tree = (): Tree => ({ dirs: new Map(), files: new Map() })
function dirOfTree(name: string, t: Tree): WalkDir {
  return {
    name,
    async *entries() {
      for (const [n, d] of t.dirs) yield { kind: 'directory', name: n, dir: () => dirOfTree(n, d) }
      for (const [n, f] of t.files) yield { kind: 'file', name: n, file: async () => f }
    },
  }
}

/** The file list of <input webkitdirectory> (every file of the picked folder, each with its path from it): null when it
 * has none. Past walkFiles files the rest are dropped (Firefox gives up far above that). */
export function dirFromFiles(files: ArrayLike<File>): WalkDir | null {
  const root = tree()
  let rootName: string | null = null
  const n = Math.min(files.length, L.walkFiles)
  for (let i = 0; i < n; i++) {
    const file = files[i]!
    const parts = (file.webkitRelativePath || file.name).normalize('NFC').split('/')
    if (parts.length < 2 || parts.some((p) => !p || p === '.' || p === '..')) continue
    rootName ??= parts[0]!
    if (parts[0] !== rootName) continue
    let t = root
    for (const part of parts.slice(1, -1)) {
      let next = t.dirs.get(part)
      if (!next) t.dirs.set(part, (next = tree()))
      t = next
    }
    t.files.set(parts[parts.length - 1]!, file)
  }
  return rootName === null ? null : dirOfTree(rootName, root)
}

// ---------------------------------------------------------------- the list

/** Several picks ("폴더 더 고르기"): one list, a file listed twice (a folder and a folder inside it) once. */
export function mergeDocs(a: readonly LocalDoc[], b: readonly LocalDoc[]): LocalDoc[] {
  const seen = new Set<string>()
  const id = (d: LocalDoc) => `${d.name}\u0000${d.size}\u0000${d.modified}`
  const keys = new Set<string>()
  const out: LocalDoc[] = []
  for (const d of [...a, ...b]) {
    if (seen.has(id(d)) || keys.has(d.key)) continue
    seen.add(id(d))
    keys.add(d.key)
    out.push(d)
  }
  return out
}

/** Name words that mark a document a team keeps (forms, rules, introductions, manuals). */
const KEEP_WORDS = ['양식', '템플릿', '서식', '규정', '소개서', '매뉴얼', '가이드', 'template', 'form', 'forms', 'policy', 'manual', 'guide', 'handbook']
const keepWord = (d: LocalDoc) => {
  const s = d.name.normalize('NFC').toLowerCase()
  const words = s.split(/[^a-z0-9]+/)
  return KEEP_WORDS.some((w) => (/^[a-z]+$/.test(w) ? words.includes(w) : s.includes(w)))
}
/** Office files and PDFs before text files and pictures. */
const TEXTISH = new Set(['csv', 'txt', 'md', 'rtf', 'png', 'jpg', 'jpeg'])

/** The entries for the AI: never a personal-looking one, at most `max`, by name words, then type, then newest. */
export function forAi(docs: readonly LocalDoc[], max: number = L.toAi): LocalDoc[] {
  return docs.filter((d) => !d.personal)
    .map((d) => ({ d, word: keepWord(d) ? 0 : 1, type: TEXTISH.has(d.ext) ? 1 : 0 }))
    .sort((a, b) => a.word - b.word || a.type - b.type || b.d.modified - a.d.modified)
    .slice(0, max)
    .map((x) => x.d)
}

const ymd = (ms: number) => {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** What the AI gets of each (no content): ids e0, e1, … and the map back. */
export function rankEntries(docs: readonly LocalDoc[]): { entries: RankFileEntry[]; keyOf: Map<string, string> } {
  const keyOf = new Map<string, string>()
  const entries = docs.map((d, i): RankFileEntry => {
    const id = `e${i}`
    keyOf.set(id, d.key)
    const folder = under(d.pick, d.folder)
    return { id, name: d.name.slice(0, L.nameChars), path: folder.slice(0, L.pathChars), type: d.ext.slice(0, 16), size: d.size, modified: ymd(d.modified) }
  })
  return { entries, keyOf }
}

export interface Grouped {
  /** the AI's picks shown first, ticked at the start (at most `prechecked`) */
  recommended: LocalDoc[]
  /** "다른 파일도 보기": the AI's further picks first, then the rest, newest first */
  more: LocalDoc[]
  /** "개인 정보일 수 있는 파일": never ticked at the start */
  personal: LocalDoc[]
  /** "이미 있어요": the same path is taken in the target folder by a file of the same size */
  already: LocalDoc[]
}

/** The list's groups. `picks`: the AI's, best first (null: no AI answer). */
export function groupDocs(docs: readonly LocalDoc[], picks: ReadonlyMap<string, TeamFileReason> | null, already: ReadonlySet<string>, prechecked: number = L.prechecked): Grouped {
  const g: Grouped = { recommended: [], more: [], personal: [], already: [] }
  const byKey = new Map(docs.map((d) => [d.key, d]))
  const picked: LocalDoc[] = []
  for (const key of picks?.keys() ?? []) {
    const d = byKey.get(key)
    if (d && !d.personal && !already.has(key)) picked.push(d)
  }
  const pickedKeys = new Set(picked.map((d) => d.key))
  for (const d of docs) {
    if (already.has(d.key)) g.already.push(d)
    else if (d.personal) g.personal.push(d)
  }
  g.recommended = picked.slice(0, prechecked)
  const rest = docs.filter((d) => !already.has(d.key) && !d.personal && !pickedKeys.has(d.key)).sort((a, b) => b.modified - a.modified)
  g.more = [...picked.slice(prechecked), ...rest]
  return g
}

/** Every listed file looks personal (an HR or finance owner picked 인사): nothing goes to the AI, the group opens. */
export const allPersonal = (docs: readonly LocalDoc[], already: ReadonlySet<string>) => {
  const open = docs.filter((d) => !already.has(d.key))
  return open.length > 0 && open.every((d) => d.personal)
}

/** One more tick, unless the upload already has `max` (the cap line). */
export function tick(ticks: ReadonlySet<string>, key: string, on: boolean, max: number = L.perUpload): { ticks: Set<string>; refused: boolean } {
  const next = new Set(ticks)
  if (!on) { next.delete(key); return { ticks: next, refused: false } }
  if (next.has(key)) return { ticks: next, refused: false }
  if (next.size >= max) return { ticks: next, refused: true }
  next.add(key)
  return { ticks: next, refused: false }
}

/** "파일 이름으로 찾기" over a long group. */
export const findDocs = (docs: readonly LocalDoc[], q: string) => {
  const s = q.normalize('NFC').trim().toLowerCase()
  return s ? docs.filter((d) => d.rel.normalize('NFC').toLowerCase().includes(s)) : [...docs]
}

/** A folder's listing as the step reads it (null: the folder is not there). */
export type ListFolder = (path: string) => Promise<{ name: string; type: 'file' | 'folder'; size: number }[] | null>

/**
 * "이미 있어요": the documents whose path in the target folder (`<base>/<pick>/<rel>`) is taken by a file of the same
 * size. A renamed "(1)" copy never matches. Only folders that are there are listed, from the target folder down (a first
 * pick: one listing), at most `maxCalls`.
 */
export async function findAlready(docs: readonly LocalDoc[], base: string, list: ListFolder, maxCalls = 300): Promise<Set<string>> {
  const want = new Map<string, LocalDoc[]>()
  const needed = new Set<string>()
  for (const d of docs) {
    const folder = under(joinPath(base, d.pick), d.folder)
    want.set(folder, [...(want.get(folder) ?? []), d])
    // every folder on the way down is needed
    const parts = under(d.pick, d.folder).split('/')
    for (let i = 1; i <= parts.length; i++) needed.add(joinPath(base, parts.slice(0, i).join('/')))
  }
  const out = new Set<string>()
  // from the target folder itself, which is there: a picked folder's own is listed only when the target holds it (a
  // first pick asks once and is answered without a 404)
  const queue = [base]
  let calls = 0
  while (queue.length && calls < maxCalls) {
    const folder = queue.shift()!
    calls++
    let entries: Awaited<ReturnType<ListFolder>> = null
    try { entries = await list(folder) } catch { entries = null }
    if (!entries) continue
    const sizes = new Map(entries.filter((e) => e.type === 'file').map((e) => [e.name.normalize('NFC'), e.size]))
    for (const d of want.get(folder) ?? []) if (sizes.get(d.name) === d.size) out.add(d.key)
    for (const e of entries) {
      const sub = joinPath(folder, e.name.normalize('NFC'))
      if (e.type === 'folder' && needed.has(sub)) queue.push(sub)
    }
  }
  return out
}

/** Hand-picked files ("파일 직접 올리기", a drop, the phone): those not already in the folder or in a run of the step
 * (same name and size), so picking again never makes a "(1)" copy; at most perUpload. */
export function newPicks(files: readonly File[], taken: ReadonlyMap<string, number>, max: number = L.perUpload): { files: File[]; skipped: number; cut: number } {
  const seen = new Map(taken)
  const out: File[] = []
  let skipped = 0
  for (const f of files) {
    const name = f.name.normalize('NFC')
    if (seen.get(name) === f.size) { skipped++; continue }
    seen.set(name, f.size)
    out.push(f)
  }
  return { files: out.slice(0, max), skipped, cut: Math.max(0, out.length - max) }
}
