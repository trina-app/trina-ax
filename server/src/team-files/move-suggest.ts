// The Move picker's "추천" and "최근" (docs/DECISIONS.md "Move picker: suggested and recent folders"; files onboarding
// plan PR C, owner 2026-11-12). No AI call: the names of the files being moved (and their file-list lines, when this
// person's `_FILES.md` shows them) against the folders this person can write: each folder's own name, the names of the
// files directly in it and their lines. Dropbox found that name-similarity rules beat a model for this; a folder
// is suggested only above THRESHOLD, none rather than a weak guess.
//
// What is read is what the person may see: candidates come from a walk of the folders the file screen shows them
// (siblingVisible), a candidate is a folder they can write (its files are theirs to read), files pass visiblePath, and a
// line counts only when their own `_FILES.md` would show it (file-list/service.ts lineFields). The answer names only
// those folders and a number, never a file. The walk and the files per folder are capped, so a large team folder costs
// no more.
//
// "최근": the person's own file events (moves in, uploads, saves: file_events, no new storage), folders they can still
// write. ✕ on a suggestion: per person, folder and the file's name pattern (digits as '#'), in suggestion_dismissals
// (migration 229), on every device. A ✕'d folder is out of "최근" for those files too, and the others keep the bar the
// best folder set before the ✕ (rank: a ✕ never promotes a weak folder).
import fs from 'node:fs'
import path from 'node:path'
import type { MoveSuggestions } from '@mycel/shared/api'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { authorize, siblingVisible, visiblePath } from '../policy/authorize'
import { badSegment, hiddenEntry } from '../policy/names'
import { HttpError } from '../http/errors'
import { inSkills } from '../skills/guard'
import { fileListOf } from '../file-list/service'
import type { Fields } from '../file-list/format'
import type { TeamFiles } from './service'

/** shown only at or above this (0..1) */
export const THRESHOLD = 0.5
/** at most this many suggestions, each at least RELATIVE of the best one */
export const SUGGEST_MAX = 3
export const RELATIVE = 0.6
export const RECENT_MAX = 3
/** folders the walk looks at, at most; candidates (writable folders) kept, at most; depth below the root */
export const WALK_MAX = 1000
export const CANDIDATES_MAX = 250
export const DEPTH_MAX = 6
/** entries of one folder read, at most (streamed: a folder of 40,000 entries is not read whole) */
export const ENTRIES_PER_FOLDER = 300
export const FILES_PER_FOLDER = 40
/** files of one request whose names are scored (a bulk move of more is judged by the first ones); words per file */
export const FILES_SCORED = 10
export const WORDS_PER_FILE = 12
/** requests one person may make in a minute (the picker asks once per opening) */
export const SUGGEST_RATE_MAX = 30
const RATE_WINDOW_MS = 60_000
/** ✕ rows kept per person (the oldest go) */
export const DISMISS_MAX = 500
/** file events of the person looked at for "최근" */
const RECENT_EVENTS = 300
/** folders looked at between two yields to other requests */
const YIELD_EVERY = 50
/** folders at the root that hold other folders, never a file's place (chat/file-placement.ts ROOT_CONTAINERS) */
const ROOT_CONTAINERS = new Set(['groups', 'users', 'projects'])

/** words that say nothing about where a file goes */
const STOP = new Set([
  // English (file names and file-list lines)
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'about', 'as', 'is', 'its',
  'final', 'copy', 'new', 'old', 'draft', 'ver', 'version', 'rev', 'file', 'files', 'doc', 'docs', 'document',
  'documents', 'untitled', 'misc', 'etc', 'other', 'others', 'temp', 'tmp', 'img', 'image', 'images', 'photo', 'scan',
  'unknown', 'none', 'page', 'pages', 'shared', 'folder',
  // Korean
  '최종', '최최종', '사본', '복사본', '수정', '수정본', '파일', '문서', '자료', '기타', '임시', '새', '제목없음', '이미지',
  '사진', '스캔', '폴더', '전사', '공유',
])

const fold = (s: string) => s.normalize('NFC').toLowerCase()
/** Korean, Chinese and Japanese words: written without spaces, so a word inside another is the same thing */
const CJK = /^[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u
const isCjk = (s: string) => CJK.test(s)
const isLatin = (s: string) => /^[a-z]+$/.test(s)

/** The words of a name or a line: letters only (dates and numbers say nothing), split by script, ≥ 2 letters. */
export function words(s: string): string[] {
  const out = new Set<string>()
  // camelCase and PascalCase apart before folding
  const t = fold(s.replace(/([a-z])([A-Z])/g, '$1 $2'))
  for (const w of t.match(/[a-z]+|\p{Script=Hangul}+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+|\p{L}+/gu) ?? []) {
    if (w.length < 2 || STOP.has(w)) continue
    out.add(w)
  }
  return [...out]
}

/** A file's stem (no extension) and its extension, lower case. */
export function splitName(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf('.')
  return i > 0 ? { stem: name.slice(0, i), ext: fold(name.slice(i + 1)) } : { stem: name, ext: '' }
}

/** Two words are the same thing: equal, a Korean / Chinese / Japanese word inside the other ("주간보고" in
 * "주간보고서", "見積" in "見積書"), or an English word and its plural / longer form ("invoice", "invoices"). */
export function same(a: string, b: string): boolean {
  if (a === b) return true
  const [s, l] = a.length <= b.length ? [a, b] : [b, a]
  if (isCjk(s) && isCjk(l)) return s.length >= 2 && l.includes(s)
  return s.length >= 4 && isLatin(l) && l.startsWith(s) && l.length - s.length <= 3
}

/** Common work folders across the app's languages (TC-4805: "주간회의록" never reached a "Meeting notes" folder). A file
 * word and a folder name word of one group are the same place: the folder's name counts as covered. Korean, Chinese and
 * Japanese words match inside a longer word ("회의록" in "주간회의록"), Latin ones as `same` does (plurals). Kept small and
 * literal: no model call, no stemming beyond that. Non-ASCII words are escapes (patterns, not screen text). */
const CONCEPTS: Record<string, readonly string[]> = {
  // 회의록 미팅 (a bare 회의: MEETING_KO) / 議事録 会議 / 会议 纪要
  meeting: ['\uD68C\uC758\uB85D', '\uBBF8\uD305', 'meeting', 'meetings', 'minutes', '\u8B70\u4E8B\u9332', '\u4F1A\u8B70', '\u4F1A\u8BAE', '\u7EAA\u8981', 'notulen', 'notulensi', 'rapat', 'actas', 'reunion', 'reuniones'],
  // 견적 / 見積 / 报价
  quote: ['\uACAC\uC801', 'quote', 'quotes', 'quotation', 'estimate', '\u898B\u7A4D', '\u62A5\u4EF7', 'penawaran', 'presupuesto', 'cotizacion'],
  // 계약 / 契約 / 合同
  contract: ['\uACC4\uC57D', 'contract', 'agreement', '\u5951\u7D04', '\u5408\u540C', 'kontrak', 'perjanjian', 'contrato'],
  // 인보이스 세금계산서 계산서 청구서 / 請求書 / 发票
  invoice: ['\uC778\uBCF4\uC774\uC2A4', '\uC138\uAE08\uACC4\uC0B0\uC11C', '\uACC4\uC0B0\uC11C', '\uCCAD\uAD6C\uC11C', 'invoice', 'billing', 'bills', '\u8ACB\u6C42\u66F8', '\u53D1\u7968', 'faktur', 'tagihan', 'factura'],
  // 보고서 리포트 / 報告 / 报告
  report: ['\uBCF4\uACE0\uC11C', '\uB9AC\uD3EC\uD2B8', 'report', '\u5831\u544A', '\u62A5\u544A', 'laporan', 'informe', 'reporte'],
  // 디자인 / デザイン / 设计 (not 시안: it sits inside 게시안내, 실시안)
  design: ['\uB514\uC790\uC778', 'design', '\u30C7\u30B6\u30A4\u30F3', '\u8BBE\u8BA1', 'desain', 'diseno'],
  // 마케팅 / マーケティング / 营销
  marketing: ['\uB9C8\uCF00\uD305', 'marketing', '\u30DE\u30FC\u30B1\u30C6\u30A3\u30F3\u30B0', '\u8425\u9500', 'pemasaran', 'mercadeo'],
}
const CONCEPT_LATIN = new Map<string, string>()
const CONCEPT_CJK = new Map<string, string>()
for (const [c, ts] of Object.entries(CONCEPTS)) for (const t0 of ts) {
  const t = t0.normalize('NFC')
  if (isCjk(t)) CONCEPT_CJK.set(t, c); else CONCEPT_LATIN.set(t, c)
}
const CJK_LENS = [...new Set([...CONCEPT_CJK.keys()].map((t) => t.length))]
/** a Korean word ending in 회의 ("주간회의", "회의자료"), not one that only holds it ("협회의", "교회의", "사회의") */
const MEETING_KO = /(?<![\uD611\uAD50\uC0AC])\uD68C\uC758(?:\uB85D|\uC790\uB8CC|\uC548\uAC74|\uACB0\uACFC|\uB0B4\uC6A9)?$/u
/** The work-folder groups the words name (Set lookups, no pairwise comparison). A Latin word counts as itself or as a
 * longer form of a whole term ("contracts", "meetings"), never a cut-off one ("repo" is not "report"). */
export function conceptsOf(ws: readonly string[]): string[] {
  const out = new Set<string>()
  for (const w of ws) {
    if (isCjk(w)) {
      for (const L of CJK_LENS) for (let i = 0; i + L <= w.length; i++) { const c = CONCEPT_CJK.get(w.slice(i, i + L)); if (c) out.add(c) }
      if (MEETING_KO.test(w)) out.add('meeting')
    } else if (isLatin(w)) {
      for (let k = Math.max(4, w.length - 3); k <= w.length; k++) { const c = CONCEPT_LATIN.get(w.slice(0, k)); if (c) out.add(c) }
    }
  }
  return [...out]
}

const lineWords = (f: Fields | null): string[] => (f ? words([f.type, f.what, ...f.names].join(' ')) : [])

/** The name pattern a ✕ is kept for: the name with its digit runs as '#' ("견적서_2025-03.xlsx" → "견적서_#-#.xlsx"). */
export const namePattern = (name: string) => fold(name).replace(/\d+/g, '#')
export const dismissKey = (folder: string, name: string) => `move:${JSON.stringify([folder, namePattern(name)])}`

/** A candidate folder, indexed once: its own name's words, and how many of its files hold each word. */
export interface Folder {
  path: string
  name: string[]
  /** files looked at */
  n: number
  /** word → files holding it */
  df: Map<string, number>
  /** extension → files with it */
  exts: Map<string, number>
  /** the work-folder groups its own name names (conceptsOf) */
  concepts: string[]
}
/** `concepts`: the work-folder groups of the file's own name (conceptsOf); else taken from `words` */
export interface RankOptions { every?: boolean }
export interface Query { name: string; words: string[]; ext: string; concepts?: string[] }

export function folderOf(p: string, name: string[], files: { words: readonly string[]; ext: string }[]): Folder {
  const df = new Map<string, number>()
  const exts = new Map<string, number>()
  for (const f of files) {
    for (const w of new Set(f.words)) df.set(w, (df.get(w) ?? 0) + 1)
    exts.set(f.ext, (exts.get(f.ext) ?? 0) + 1)
  }
  return { path: p, name, n: files.length, df, exts, concepts: conceptsOf(name) }
}

/** The words of all candidates that are "the same" as each query word, found in one pass over the vocabulary (Set
 * lookups of its substrings / prefixes, no pairwise comparison). */
function matchesOf(qwords: Set<string>, vocab: Map<string, number>): Map<string, string[]> {
  const m = new Map<string, Set<string>>()
  const add = (w: string, v: string) => { let s = m.get(w); if (!s) m.set(w, (s = new Set())); s.add(v) }
  const cjkLens = new Set([...qwords].filter(isCjk).map((w) => w.length))
  for (const w of qwords) {
    if (vocab.has(w)) add(w, w)
    if (isCjk(w)) {
      // vocabulary words inside w
      for (let i = 0; i < w.length; i++) for (let j = i + 2; j <= w.length; j++) { const sub = w.slice(i, j); if (sub !== w && vocab.has(sub)) add(w, sub) }
    } else if (isLatin(w)) {
      // shorter forms of w ("invoices" → "invoice")
      for (let k = Math.max(4, w.length - 3); k < w.length; k++) { const pre = w.slice(0, k); if (vocab.has(pre)) add(w, pre) }
    }
  }
  for (const v of vocab.keys()) {
    if (isCjk(v)) {
      // query words inside v
      for (const L of cjkLens) if (L < v.length) for (let i = 0; i + L <= v.length; i++) { const sub = v.slice(i, i + L); if (qwords.has(sub)) add(sub, v) }
    } else if (isLatin(v)) {
      // v a longer form of a query word
      for (let k = Math.max(4, v.length - 3); k < v.length; k++) { const pre = v.slice(0, k); if (qwords.has(pre)) add(pre, v) }
    }
  }
  return new Map([...m].map(([w, s]) => [w, [...s]]))
}

/**
 * The folders that fit `queries`, best first, each with its confidence (mean over the queries, capped at 0.99 in the
 * answer). For one query and one folder:
 * - name: the share of the folder's own name that the file's words cover ("견적서" for "견적서_삼성_2025.xlsx"); a name
 *   word of two letters or less counts only when a file word equals it or a file in the folder agrees ("인사" does not
 *   take "인사말.docx" on its name alone).
 * - files: for each of the file's words, the share of the folder's files that hold it times the share of all files
 *   holding it that are here (a word common in this folder and rare elsewhere defines it), combined as independent
 *   evidence, and damped while the folder has few files (n / (n + 1)).
 * - extension: +0.1 × the share of its files with the file's extension, only once the match is over THRESHOLD (it
 *   ranks; it never makes a suggestion).
 * - a folder whose own name is one of the common work folders the file's name names (CONCEPTS: "Meeting notes" for
 *   "주간회의록.md") counts as its name fully covered.
 * `opts.every`: the confidence is the lowest over the queries, not the mean: one folder must fit every file (a room
 * message's files go to one folder on the save sheet).
 * `dropped`: folders the person ✕'d for these files. They are scored like any other and taken out only at the end, so a
 * ✕ never promotes a weaker folder: the best one (and RELATIVE of it) is still the bar, and their files still make a
 * word common rather than rare.
 */
export function rank(queries: readonly Query[], folders: readonly Folder[], dropped: (path: string) => boolean = () => false, opts: RankOptions = {}): { path: string; confidence: number }[] {
  if (!queries.length) return []
  const vocab = new Map<string, number>()
  for (const f of folders) for (const [w, k] of f.df) vocab.set(w, (vocab.get(w) ?? 0) + k)
  const qwords = new Set(queries.flatMap((q) => q.words))
  const M = matchesOf(qwords, vocab)
  const total = new Map<string, number>()
  for (const w of qwords) total.set(w, (M.get(w) ?? []).reduce((s, t) => s + (vocab.get(t) ?? 0), 0))
  const out: { path: string; confidence: number }[] = []
  const qc = queries.map((q) => new Set(q.concepts ?? conceptsOf(q.words)))
  for (const f of folders) {
    // files of this folder holding each query word (its matches summed, at most all its files)
    const here = new Map<string, number>()
    for (const w of qwords) here.set(w, Math.min(f.n, (M.get(w) ?? []).reduce((s, t) => s + (f.df.get(t) ?? 0), 0)))
    let sum = 0
    let low = Infinity
    for (const [i, q] of queries.entries()) {
      const named = f.concepts.some((c) => qc[i]!.has(c))
      const covered = named ? 1 : f.name.length ? f.name.filter((t) => q.words.some((w) => w === t || (same(w, t) && (t.length > 2 || (here.get(w) ?? 0) > 0)))).length / f.name.length : 0
      const nameScore = covered >= 1 ? 0.85 : covered * 0.6
      let miss = 1
      if (f.n) for (const w of q.words) {
        const h = here.get(w) ?? 0
        if (h) miss *= 1 - (h / f.n) * (h / Math.max(h, total.get(w) ?? h))
      }
      const fileScore = f.n ? (f.n / (f.n + 1)) * (1 - miss) : 0
      let s = 1 - (1 - nameScore) * (1 - fileScore)
      if (s >= THRESHOLD && q.ext && f.n) s += 0.1 * ((f.exts.get(q.ext) ?? 0) / f.n)
      sum += s
      low = Math.min(low, s)
    }
    const confidence = opts.every ? low : sum / queries.length
    if (confidence >= THRESHOLD) out.push({ path: f.path, confidence })
  }
  out.sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path))
  const best = out[0]?.confidence ?? 0
  return out.filter((s) => s.confidence >= best * RELATIVE && !dropped(s.path)).slice(0, SUGGEST_MAX).map((s) => ({ path: s.path, confidence: Math.round(Math.min(0.99, s.confidence) * 100) / 100 }))
}

/** At most `max` entries of a folder, streamed (a huge folder is not read whole). */
function firstEntries(abs: string, max: number): fs.Dirent[] {
  const out: fs.Dirent[] = []
  let d: fs.Dir | null = null
  try {
    d = fs.opendirSync(abs)
    for (let e = d.readSync(); e && out.length < max; e = d.readSync()) out.push(e)
  } catch { /* gone or unreadable: what was read */ } finally { try { d?.closeSync() } catch {} }
  return out
}

/** `p` is one of the moved folders or inside one (a folder never moves into itself) */
const insideAny = (p: string, moved: readonly string[]) => moved.some((m) => p === m || p.startsWith(m + '/'))

/** The folders this person can write, found by a walk of what the file screen shows them (bounded), indexed. `skip`:
 * never a candidate; `moved`: not even walked into. */
async function candidates(files: TeamFiles, user: Principal, rules: RuleSet, lines: (rel: string) => Fields | null, skip: (rel: string) => boolean, moved: readonly string[]): Promise<Folder[]> {
  const out: Folder[] = []
  const queue: string[][] = [[]]
  for (let seen = 0; queue.length && seen < WALK_MAX && out.length < CANDIDATES_MAX; seen++) {
    if (seen && seen % YIELD_EVERY === 0) await new Promise((res) => setImmediate(res))
    const dir = queue.shift()!
    const rel = dir.join('/')
    const ents = firstEntries(path.join(files.root, ...dir), ENTRIES_PER_FOLDER)
    const writable = dir.length > 0 && !(dir.length === 1 && ROOT_CONTAINERS.has(dir[0]!)) && !inSkills(rel) && !skip(rel) && atLeast(rules.access(user, dir), 'write')
    const fs_: { words: string[]; ext: string }[] = []
    for (const e of ents) {
      if (e.isDirectory()) {
        const sub = [...dir, e.name]
        if (dir.length < DEPTH_MAX && !insideAny(sub.join('/'), moved) && siblingVisible(files.fx, rules, user, dir, e.name)) queue.push(sub)
        continue
      }
      if (!writable || !e.isFile() || fs_.length >= FILES_PER_FOLDER) continue
      const f = [...dir, e.name].join('/')
      if (!visiblePath(files.fx, rules, user, f)) continue
      const { stem, ext } = splitName(e.name)
      fs_.push({ words: [...new Set([...words(stem), ...lineWords(lines(f))])], ext })
    }
    if (writable) out.push(folderOf(rel, dir.length ? words(dir[dir.length - 1]!) : [], fs_))
  }
  return out
}

/** A person's own folder (내 파일): only they see it, so a move that is meant to share never suggests it */
export const privateFolder = (rel: string) => rel === 'users' || rel.startsWith('users/')

const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')))
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** The keys of this person's ✕ (suggestion_dismissals). */
function dismissed(files: TeamFiles, userId: string): Set<string> {
  return new Set((files.ctx.db.query("SELECT key FROM suggestion_dismissals WHERE user_id = ? AND key LIKE 'move:%'").all(userId) as { key: string }[]).map((r) => r.key))
}

/** A folder path the file screen would show this person and let them write into (every segment's name checked). */
function writableFolder(files: TeamFiles, user: Principal, rules: RuleSet, p: string): boolean {
  const segs = p.split('/')
  if (!p || segs.some((s, i) => badSegment(s) !== null || hiddenEntry(s, i))) return false
  if (!siblingVisible(files.fx, rules, user, segs.slice(0, -1), segs[segs.length - 1]!) || !atLeast(rules.access(user, segs), 'write')) return false
  try { return fs.lstatSync(path.join(files.root, ...segs)).isDirectory() } catch { return false }
}

/** Folders this person recently moved or saved files into (their file events), that they can still write. */
function recentFolders(files: TeamFiles, user: Principal, rules: RuleSet, skip: (rel: string) => boolean): string[] {
  const rows = files.ctx.db.query(`SELECT path FROM file_events WHERE user_id = ? AND action IN ('create', 'upload')
    AND id > (SELECT COALESCE(MAX(id), 0) - 20000 FROM file_events) ORDER BY id DESC LIMIT ?`).all(user.id, RECENT_EVENTS) as { path: string }[]
  const out: string[] = []
  const looked = new Set<string>()
  for (const r of rows) {
    const d = dirOf(r.path)
    if (looked.has(d)) continue
    looked.add(d)
    if (!d || skip(d) || inSkills(d) || d.split('/').includes('.attachments')) continue
    const segs = d.split('/')
    if (segs.length === 1 && ROOT_CONTAINERS.has(segs[0]!)) continue
    if (!writableFolder(files, user, rules, d)) continue
    out.push(d)
    if (out.length >= RECENT_MAX) break
  }
  return out
}

const started = new Map<string, number[]>()
/** Count one request for `userId`, or 429 when they made too many in the last minute. */
export function admitSuggest(userId: string) {
  const now = Date.now()
  const times = (started.get(userId) ?? []).filter((t) => t > now - RATE_WINDOW_MS)
  if (times.length >= SUGGEST_RATE_MAX) {
    started.set(userId, times)
    throw new HttpError('rate_limited', undefined, { retryAfter: Math.max(1, Math.ceil((times[0]! + RATE_WINDOW_MS - now) / 1000)) })
  }
  times.push(now)
  started.set(userId, times)
}

/** The Move picker's suggestions for `paths` (each readable by the person, else the policy's not-found). */
export async function moveSuggestions(files: TeamFiles, userId: string, paths: readonly string[], widen = false): Promise<MoveSuggestions> {
  admitSuggest(userId)
  const user = files.principal(userId)
  const rules = files.rules()
  const items = [...new Set(paths)].map((p) => authorize(files.fx, rules, user, p, 'read', { mustExist: true }))
  const from = new Set(items.map((a) => dirOf(a.rel)))
  // where the items are, and the moved folders themselves and everything in them, are never a place to go
  const moved = items.filter((a) => a.st?.isDirectory()).map((a) => a.rel)
  const skip = (rel: string) => from.has(rel) || insideAny(rel, moved) || (widen && privateFolder(rel))
  const lines = (() => { try { return fileListOf(files.ctx).lineFields(user, rules) } catch { return () => null } })()
  const queries: Query[] = items.filter((a) => a.st?.isFile()).slice(0, FILES_SCORED).map((a) => {
    const name = nameOf(a.rel)
    const { stem, ext } = splitName(name)
    // the work-folder group by the file's own name, not its file-list description
    return { name, words: [...new Set([...words(stem), ...lineWords(lines(a.rel))])].slice(0, WORDS_PER_FILE), ext, concepts: conceptsOf(words(stem)) }
  })
  return await suggestFor(files, user, rules, lines, queries, items.slice(0, FILES_SCORED).map((a) => nameOf(a.rel)), skip, moved)
}

/** The suggested and recent folders for `queries` (files named `names`): the walk of the folders `user` can write, the
 * rank, the person's ✕ and their recent folders. Shared by the Move picker and a room file's "Save to team folder"
 * (rooms/save-to-team.ts), whose files are not in the team folder yet. */
async function suggestFor(files: TeamFiles, user: Principal, rules: RuleSet, lines: (rel: string) => Fields | null, queries: readonly Query[], names: readonly string[], skip: (rel: string) => boolean = () => false, moved: readonly string[] = [], opts: RankOptions = {}): Promise<MoveSuggestions> {
  // ✕ for any of the files' names (suggestion_dismissals)
  const no = dismissed(files, user.id)
  const wasDismissed = (folder: string) => names.some((n) => no.has(dismissKey(folder, n)))
  let suggested: MoveSuggestions['suggested'] = []
  if (queries.some((q) => q.words.length)) {
    suggested = rank(queries, await candidates(files, user, rules, lines, skip, moved), wasDismissed, opts)
  }
  // a folder ✕'d for these files is not under "최근" either (it would read as still suggested)
  const taken = new Set(suggested.map((s) => s.path))
  const recent = recentFolders(files, user, rules, (rel) => skip(rel) || taken.has(rel) || wasDismissed(rel)).map((p) => ({ path: p }))
  return { suggested, recent }
}

/** Words a file brings besides its own name (a room file's room name and message): after the file's own, up to this */
export const CONTEXT_WORDS = 8

/**
 * Suggested and recent folders for files that are not in the team folder yet (a room file before "Save to team folder"):
 * each by its name and the words of where it was sent (`context`, after the name's own words). The same rate limit, walk
 * and rank as the Move picker; nothing is read that the person could not see there.
 */
export async function suggestForNames(files: TeamFiles, userId: string, items: readonly { name: string; context?: string }[], opts: RankOptions = {}): Promise<MoveSuggestions> {
  const user = files.principal(userId)
  const rules = files.rules()
  const lines = (() => { try { return fileListOf(files.ctx).lineFields(user, rules) } catch { return () => null } })()
  const scored = items.slice(0, FILES_SCORED)
  const queries: Query[] = scored.map((it) => {
    const { stem, ext } = splitName(it.name)
    const own = words(stem).slice(0, WORDS_PER_FILE)
    const more = it.context ? words(it.context).filter((w) => !own.includes(w)).slice(0, CONTEXT_WORDS) : []
    // the work-folder group by the file's own name only (a room named "Design" does not make every file a design)
    return { name: it.name, words: [...own, ...more], ext, concepts: conceptsOf(own) }
  })
  return await suggestFor(files, user, rules, lines, queries, scored.map((it) => it.name), undefined, undefined, opts)
}

/** ✕ on a suggestion: never this folder again for files named like these (per person). The folder must be one they can
 * write (else not found); the oldest rows go past DISMISS_MAX. */
export function dismissMoveSuggestion(files: TeamFiles, userId: string, paths: readonly string[], folder: string): void {
  const user = files.principal(userId)
  const rules = files.rules()
  const names = [...new Set(paths)].slice(0, FILES_SCORED).map((p) => nameOf(authorize(files.fx, rules, user, p, 'read', { mustExist: true }).rel))
  if (!writableFolder(files, user, rules, folder)) throw new HttpError('not_found')
  const at = new Date().toISOString()
  const db = files.ctx.db
  const put = db.query('INSERT INTO suggestion_dismissals (user_id, key, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING')
  db.transaction(() => {
    for (const n of names) put.run(userId, dismissKey(folder, n), at)
    db.query(`DELETE FROM suggestion_dismissals WHERE user_id = ? AND key LIKE 'move:%' AND key NOT IN
      (SELECT key FROM suggestion_dismissals WHERE user_id = ? AND key LIKE 'move:%' ORDER BY dismissed_at DESC, key LIMIT ?)`).run(userId, userId, DISMISS_MAX)
  })()
}
