// Name search and "recent files" for the composer's team-file picker. Both show only files the caller can read,
// decided by the same functions as the file screen's tree and the AI's glob tool: allowedRoots() picks the folders
// ripgrep may enter (hidden sub-folders are excluded before anything is opened) and visiblePath() checks every hit
// again (name rules, server folders, read access, regular single-link file). Nothing else is ever listed.
import fs from 'node:fs'
import type { FileEntry, FileList } from '@mycel/shared/api'
import { allowedRoots, excludeArgs, runRg } from '../files/search'
import { authorize, visiblePath } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import type { TeamFiles } from './service'

/** ripgrep options for listing names only (no size limit: big files are attachable too) */
const RG_LIST = ['--files', '--null', '--no-config', '--no-ignore', '--hidden', '--no-follow', '--one-file-system', '--no-messages']
const HIT_CAP = 5000
const fold = (s: string) => s.normalize('NFC').toLowerCase()

export async function findFiles(files: TeamFiles, userId: string, q: string, base: string, limit: number): Promise<FileList> {
  const user = files.principal(userId)
  const rules = files.rules()
  const b = authorize(files.fx, rules, user, base, 'list')
  if (!b.st!.isDirectory()) throw new ToolError(`'${b.rel}' is a file`, 'not_folder')
  const { roots, excludes } = allowedRoots(files.fx, rules, user, b.segs)
  if (!roots.length) return { items: [], truncated: false }
  const needle = fold(q.trim())
  const hits: { rel: string; st: fs.Stats }[] = []
  const cfg = files.ctx.files.cfg
  const r = await runRg(cfg.rg, [...RG_LIST, ...excludeArgs(excludes), '--', ...roots], files.root, '\0', (rec) => {
    const rel = rec.replace(/^\.\//, '')
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    if (!fold(name).includes(needle)) return
    const st = visiblePath(files.fx, rules, user, rel)
    if (st) hits.push({ rel, st })
    if (hits.length >= HIT_CAP) return false
  }, cfg.grepTimeoutMs)
  hits.sort((x, y) => y.st.mtimeMs - x.st.mtimeMs || x.rel.localeCompare(y.rel))
  return { items: hits.slice(0, limit).map((h) => files.entry(user, rules, h.rel.split('/'), h.st)), truncated: hits.length > limit || r.killed !== null }
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
