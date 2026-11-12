// Name search and "recent files" for the composer's team-file picker and ⌘K. Both show only files the caller can read,
// decided by the same functions as the file screen's tree and the AI's glob tool: allowedRoots() picks the folders
// ripgrep may enter (hidden sub-folders are excluded before anything is opened) and visiblePath() checks every hit
// again (name rules, server folders, read access, regular single-link file). Nothing else is ever listed. A name matches
// when it holds every word of the text, in any order and any case (shared/src/search-text.ts searchWords, as ⌘K's room
// files and messages: "budget q4" finds "Q4 Budget.xlsx"). ⌘K also asks for folders (`folders`): the folders the file
// screen would show the caller (siblingVisible), found by a walk of folders only (QA TC-230: "주간" found no folder).
import fs from 'node:fs'
import path from 'node:path'
import { searchWords } from '@mycel/shared'
import type { FileEntry, FileList } from '@mycel/shared/api'
import { allowedRoots, excludeArgs, runRg } from '../files/search'
import { authorize, siblingVisible, visiblePath } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import type { TeamFiles } from './service'

/** ripgrep options for listing names only (no size limit: big files are attachable too) */
const RG_LIST = ['--files', '--null', '--no-config', '--no-ignore', '--hidden', '--no-follow', '--one-file-system', '--no-messages']
/** a name search keeps at most this many visible file hits (newest first of them); more is "truncated" (QA TC-277:
 * 5,000 permission checks in one go on 23k files stalled every request for 60-400 ms) */
export const HIT_CAP = 1000
/** names that match are checked (visiblePath: lstat + access) this many at a time, other requests run in between */
export const CHECK_CHUNK = 100
/** at most this many matching names are kept for the check: a few files the caller cannot read may be among them */
const CANDIDATE_CAP = HIT_CAP * 2
/** folder hits kept, at most (⌘K folders; few in practice, and the walk awaits each folder's listing already) */
const FOLDER_HIT_CAP = 5000
/** folders looked at for folder names, at most (a walk of folders only; files are not opened) */
const FOLDER_SCAN = 20_000
const fold = (s: string) => s.normalize('NFC').toLowerCase()

export async function findFiles(files: TeamFiles, userId: string, q: string, base: string, limit: number, o: { folders?: boolean } = {}): Promise<FileList> {
  const user = files.principal(userId)
  const rules = files.rules()
  const b = authorize(files.fx, rules, user, base, 'list')
  if (!b.st!.isDirectory()) throw new ToolError(`'${b.rel}' is a file`, 'not_folder')
  const { roots, excludes } = allowedRoots(files.fx, rules, user, b.segs)
  if (!roots.length) return { items: [], truncated: false }
  const words = searchWords(q).map(fold)
  const names: string[] = []
  const cfg = files.ctx.files.cfg
  const r = await runRg(cfg.rg, [...RG_LIST, ...excludeArgs(excludes), '--', ...roots], files.root, '\0', (rec) => {
    const rel = rec.replace(/^\.\//, '')
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const folded = fold(name)
    if (!words.every((w) => folded.includes(w))) return
    names.push(rel)
    if (names.length >= CANDIDATE_CAP) return false
  }, cfg.grepTimeoutMs)
  // every listed file passes visiblePath (same rules and principal); the checks run in chunks so one broad search
  // never holds the server
  const hits: { rel: string; st: fs.Stats }[] = []
  for (let i = 0; i < names.length && hits.length < HIT_CAP; i += CHECK_CHUNK) {
    if (i) await new Promise((res) => setImmediate(res))
    for (const rel of names.slice(i, i + CHECK_CHUNK)) {
      const st = visiblePath(files.fx, rules, user, rel)
      if (st) hits.push({ rel, st })
      if (hits.length >= HIT_CAP) break
    }
  }
  const byTime = (x: { rel: string; st: fs.Stats }, y: { rel: string; st: fs.Stats }) => y.st.mtimeMs - x.st.mtimeMs || x.rel.localeCompare(y.rel)
  hits.sort(byTime)
  // folders first: there are few, and the one asked for must not fall behind thirty files
  const dirs: FolderHits = o.folders ? await findFolders(files, user, rules, b.segs, words) : []
  dirs.sort(byTime)
  const all = [...dirs, ...hits]
  return { items: all.slice(0, limit).map((h) => files.entry(user, rules, h.rel.split('/'), h.st)), truncated: all.length > limit || r.killed !== null || !!dirs.scanCut }
}

type FolderHits = { rel: string; st: fs.Stats }[] & { scanCut?: boolean }

/** Folders under `base` whose name holds every word, among those the file screen shows the caller (siblingVisible:
 * name rules, server folders, may list it). Only listable folders are entered; links are not followed. */
async function findFolders(files: TeamFiles, user: ReturnType<TeamFiles['principal']>, rules: ReturnType<TeamFiles['rules']>, base: string[], words: string[]): Promise<FolderHits> {
  const out: FolderHits = []
  const queue: string[][] = [base]
  for (let seen = 0; queue.length; seen++) {
    if (seen >= FOLDER_SCAN) { out.scanCut = true; break }
    const dir = queue.shift()!
    let names: fs.Dirent[]
    try { names = await fs.promises.readdir(path.join(files.root, ...dir), { withFileTypes: true }) } catch { continue }
    for (const e of names) {
      if (!e.isDirectory() || !siblingVisible(files.fx, rules, user, dir, e.name)) continue
      const segs = [...dir, e.name]
      queue.push(segs)
      const folded = fold(e.name)
      if (!words.every((w) => folded.includes(w))) continue
      try { out.push({ rel: segs.join('/'), st: fs.lstatSync(path.join(files.root, ...segs)) }) } catch {}
      if (out.length >= FOLDER_HIT_CAP) return out
    }
  }
  return out
}

/** Files changed lately (file screen, uploads, AI saves) that the caller can read now, newest first. */
export function recentFiles(files: TeamFiles, userId: string, limit: number): FileList {
  const user = files.principal(userId)
  const rules = files.rules()
  const rows = files.ctx.db.query(`SELECT path, MAX(id) AS last FROM file_events
    WHERE action IN ('create', 'update', 'upload', 'restore') AND id > (SELECT COALESCE(MAX(id), 0) - 20000 FROM file_events)
    GROUP BY path ORDER BY last DESC LIMIT 2000`).all() as { path: string }[]
  const items: FileEntry[] = []
  for (const r of rows) {
    if (items.length >= limit) break
    // chat attachments and shared screenshots are not "team files" to pick again
    if (r.path.includes('/.attachments/')) continue
    const st = visiblePath(files.fx, rules, user, r.path)
    if (st) items.push(files.entry(user, rules, r.path.split('/'), st))
  }
  return { items, truncated: false }
}
