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
// (migration 229), on every device.
import fs from 'node:fs'
import path from 'node:path'
import type { MoveSuggestions } from '@mycel/shared/api'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { authorize, siblingVisible, visiblePath } from '../policy/authorize'
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
export const WALK_MAX = 2000
export const CANDIDATES_MAX = 400
export const DEPTH_MAX = 6
/** entries of one folder read, at most (files beyond it are not looked at) */
export const ENTRIES_PER_FOLDER = 300
export const FILES_PER_FOLDER = 120
/** files of one request whose names are scored (a bulk move of more is judged by the first ones) */
export const FILES_SCORED = 20
/** file events of the person looked at for "최근" */
const RECENT_EVENTS = 300
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
const isHangul = (s: string) => /^[가-힣]+$/.test(s)

/** The words of a name or a line: letters only (dates and numbers say nothing), split by script, ≥ 2 letters. */
export function words(s: string): string[] {
  const out = new Set<string>()
  // camelCase and PascalCase apart before folding
  const t = fold(s.replace(/([a-z])([A-Z])/g, '$1 $2'))
  for (const w of t.match(/[a-z]+|[가-힣]+|\p{L}+/gu) ?? []) {
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

/** Two words are the same thing: equal, a Korean word inside the other ("주간보고" in "주간보고서"), or an English word
 * and its plural / longer form ("invoice", "invoices"). */
export function same(a: string, b: string): boolean {
  if (a === b) return true
  const [s, l] = a.length <= b.length ? [a, b] : [b, a]
  if (isHangul(s) && isHangul(l)) return s.length >= 2 && l.includes(s)
  return s.length >= 4 && /^[a-z]+$/.test(l) && l.startsWith(s) && l.length - s.length <= 3
}

const lineWords = (f: Fields | null): string[] => (f ? words([f.type, f.what, ...f.names].join(' ')) : [])

/** The name pattern a ✕ is kept for: the name with its digit runs as '#' ("견적서_2025-03.xlsx" → "견적서_#-#.xlsx"). */
export const namePattern = (name: string) => fold(name).replace(/\d+/g, '#')
export const dismissKey = (folder: string, name: string) => `move:${JSON.stringify([folder, namePattern(name)])}`

interface Candidate {
  path: string
  /** the folder's own name's words */
  name: string[]
  /** the words of each file looked at (its name and its line) */
  files: string[][]
  exts: string[]
}

interface Query { name: string; words: string[]; ext: string; dir: string }

/**
 * The confidence (0..1.1; the answer caps it at 0.99) that a file with words `q` belongs in `c`, given how often each word is found in the files of
 * all candidates (`total`: word → number of files that hold it, over every candidate).
 * - name: the share of the folder's own name that the file's words cover ("견적서" for "견적서_삼성_2025.xlsx").
 * - files: for each of the file's words, the share of the folder's files that hold it times the share of all files
 *   holding it that are here (a word common in this folder and rare elsewhere defines it), combined as independent
 *   evidence, and damped while the folder has few files (n / (n + 1)).
 * - extension: a little more when most of its files have the file's extension, only on top of a match.
 */
export function score(q: Query, c: Candidate, total: Map<string, number>): number {
  const has = (ws: readonly string[], w: string) => ws.some((t) => same(w, t))
  const covered = c.name.length ? c.name.filter((t) => q.words.some((w) => same(w, t))).length / c.name.length : 0
  const nameScore = covered >= 1 ? 0.85 : covered * 0.6
  const n = c.files.length
  let miss = 1
  if (n) {
    for (const w of q.words) {
      const here = c.files.filter((ws) => has(ws, w)).length
      if (!here) continue
      const spec = here / Math.max(here, total.get(w) ?? here)
      miss *= 1 - (here / n) * spec
    }
  }
  const fileScore = n ? (n / (n + 1)) * (1 - miss) : 0
  let s = 1 - (1 - nameScore) * (1 - fileScore)
  if (s > 0.2 && q.ext && n) s += 0.1 * (c.exts.filter((e) => e === q.ext).length / n)
  // not capped here, so two strong folders still rank (the answer caps it at 0.99)
  return s
}

/** The folders this person can write, found by a walk of what the file screen shows them (bounded). */
function candidates(files: TeamFiles, user: Principal, rules: RuleSet, lines: (rel: string) => Fields | null): Candidate[] {
  const out: Candidate[] = []
  const queue: string[][] = [[]]
  for (let seen = 0; queue.length && seen < WALK_MAX && out.length < CANDIDATES_MAX; seen++) {
    const dir = queue.shift()!
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(path.join(files.root, ...dir), { withFileTypes: true }).slice(0, ENTRIES_PER_FOLDER) } catch { continue }
    const rel = dir.join('/')
    const writable = dir.length > 0 && !(dir.length === 1 && ROOT_CONTAINERS.has(dir[0]!)) && !inSkills(rel) && atLeast(rules.access(user, dir), 'write')
    const c: Candidate = { path: rel, name: dir.length ? words(dir[dir.length - 1]!) : [], files: [], exts: [] }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (dir.length < DEPTH_MAX && siblingVisible(files.fx, rules, user, dir, e.name)) queue.push([...dir, e.name])
        continue
      }
      if (!writable || !e.isFile() || c.files.length >= FILES_PER_FOLDER) continue
      const f = [...dir, e.name].join('/')
      if (!visiblePath(files.fx, rules, user, f)) continue
      const { stem, ext } = splitName(e.name)
      c.files.push([...new Set([...words(stem), ...lineWords(lines(f))])])
      c.exts.push(ext)
    }
    if (writable) out.push(c)
  }
  return out
}

const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')))
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** The keys of this person's ✕ (suggestion_dismissals). */
function dismissed(files: TeamFiles, userId: string): Set<string> {
  return new Set((files.ctx.db.query("SELECT key FROM suggestion_dismissals WHERE user_id = ? AND key LIKE 'move:%'").all(userId) as { key: string }[]).map((r) => r.key))
}

/** Folders this person recently moved or saved files into (their file events), that they can still write. */
function recentFolders(files: TeamFiles, user: Principal, rules: RuleSet, skip: Set<string>): string[] {
  const rows = files.ctx.db.query(`SELECT path FROM file_events WHERE user_id = ? AND action IN ('create', 'upload')
    AND id > (SELECT COALESCE(MAX(id), 0) - 20000 FROM file_events) ORDER BY id DESC LIMIT ?`).all(user.id, RECENT_EVENTS) as { path: string }[]
  const out: string[] = []
  const looked = new Set<string>()
  for (const r of rows) {
    const d = dirOf(r.path)
    if (looked.has(d)) continue
    looked.add(d)
    if (!d || skip.has(d) || inSkills(d) || d.split('/').includes('.attachments')) continue
    const segs = d.split('/')
    if (segs.length === 1 && ROOT_CONTAINERS.has(segs[0]!)) continue
    if (!siblingVisible(files.fx, rules, user, segs.slice(0, -1), segs[segs.length - 1]!) || !atLeast(rules.access(user, segs), 'write')) continue
    try { if (!fs.statSync(path.join(files.root, ...segs)).isDirectory()) continue } catch { continue }
    out.push(d)
    if (out.length >= RECENT_MAX) break
  }
  return out
}

/** The Move picker's suggestions for `paths` (each readable by the person, else the policy's not-found). */
export function moveSuggestions(files: TeamFiles, userId: string, paths: readonly string[]): MoveSuggestions {
  const user = files.principal(userId)
  const rules = files.rules()
  const items = [...new Set(paths)].map((p) => authorize(files.fx, rules, user, p, 'read', { mustExist: true }))
  const from = new Set(items.map((a) => dirOf(a.rel)))
  const lines = (() => { try { return fileListOf(files.ctx).lineFields(user, rules) } catch { return () => null } })()
  const queries: Query[] = items.filter((a) => a.st?.isFile()).slice(0, FILES_SCORED).map((a) => {
    const name = nameOf(a.rel)
    const { stem, ext } = splitName(name)
    return { name, words: [...new Set([...words(stem), ...lineWords(lines(a.rel))])], ext, dir: dirOf(a.rel) }
  })
  let suggested: MoveSuggestions['suggested'] = []
  if (queries.length && queries.some((q) => q.words.length)) {
    const cands = candidates(files, user, rules, lines).filter((c) => !from.has(c.path))
    const total = new Map<string, number>()
    for (const c of cands) for (const ws of c.files) for (const w of ws) total.set(w, (total.get(w) ?? 0) + 1)
    // a query word counts every file whose word is "the same" (a Korean word inside it, a plural)
    const totals = new Map<string, number>()
    for (const q of queries) for (const w of q.words) if (!totals.has(w)) {
      let n = 0
      for (const [t, k] of total) if (same(w, t)) n += k
      totals.set(w, n)
    }
    const no = dismissed(files, userId)
    const scored = cands
      .filter((c) => !queries.some((q) => no.has(dismissKey(c.path, q.name))))
      .map((c) => ({ path: c.path, confidence: queries.reduce((s, q) => s + score(q, c, totals), 0) / queries.length }))
      .filter((s) => s.confidence >= THRESHOLD)
      .sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path))
    const best = scored[0]?.confidence ?? 0
    suggested = scored.filter((s) => s.confidence >= best * RELATIVE).slice(0, SUGGEST_MAX).map((s) => ({ path: s.path, confidence: Math.round(Math.min(0.99, s.confidence) * 100) / 100 }))
  }
  const recent = recentFolders(files, user, rules, new Set([...from, ...suggested.map((s) => s.path)])).map((p) => ({ path: p }))
  return { suggested, recent }
}

/** ✕ on a suggestion: never this folder again for files named like these (per person). */
export function dismissMoveSuggestion(files: TeamFiles, userId: string, paths: readonly string[], folder: string): void {
  const user = files.principal(userId)
  const rules = files.rules()
  const names = [...new Set(paths)].map((p) => nameOf(authorize(files.fx, rules, user, p, 'read', { mustExist: true }).rel))
  const at = new Date().toISOString()
  const put = files.ctx.db.query('INSERT INTO suggestion_dismissals (user_id, key, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING')
  files.ctx.db.transaction(() => { for (const n of names) put.run(userId, dismissKey(folder, n), at) })()
}
