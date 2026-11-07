// "참고한 파일" under each answer (docs/DECISIONS.md "Sources under each answer"): the team files whose content went to
// the model while it wrote the answer. The file tools note them on the turn's TurnFiles (files/service.ts), which every
// agent of the turn shares, so a sub-agent's reads are in the list too, marked: read (the read tool, attachments
// included), search (passages of knowledge_explore and of the lookup before the model) and grep (matching lines of
// content mode). Names alone (grep files_with_matches / count, list, glob) are not content and are left out. The three
// engines use the same tool handlers, so they give the same list.
// At the end of the turn the list is saved with the answer (message_sources, migration 218); the rows go with the
// message and the chat (ON DELETE CASCADE). Whenever someone opens the list, every file is checked again against the
// viewer's access now (authorize + visiblePath, the file screen's own test, like team-file attachments,
// uploads/team-refs.ts): a file they cannot open now (access taken away, deleted, moved) is only counted, without its
// name or path. The list is shown on the screen only: it is not sent in notifications, exports or files.
import type { Database } from 'bun:sqlite'
import type { MessageSourceFile, MessageSources, SourceLoc } from '@mycel/shared/api'
import { SourceLoc as SourceLocSchema } from '@mycel/shared/api'
import { loadPrincipal } from '../policy/access'
import { authorize, visiblePath, type FsCtx } from '../policy/authorize'
import type { RuleSet } from '../policy/access'
import { locKey } from './locations'

export type SourceVia = 'read' | 'search' | 'grep'
/** places kept per file (the list shows them as chips) */
export const SOURCE_LOCS_MAX = 20
/** files kept per answer: an answer that read more keeps the first ones */
export const SOURCE_FILES_MAX = 500

interface Entry { path: string; via: Set<SourceVia>; locs: Map<string, SourceLoc>; sha256: string | null; main: boolean; sub: boolean; changed?: true }

/** The files one turn's agents read or saw passages of, in the order first seen. */
export class SourceLog {
  private files = new Map<string, Entry>()
  /**
   * `agent`: the id of the sub-agent's Agent call that made the tool call, or null for the main AI. `locs`: the places
   * looked at (none: the file as a whole). Paths are team paths as the policy resolved them for the person.
   */
  note(path: string, via: SourceVia, o: { agent: string | null; locs?: (SourceLoc | null | undefined)[]; sha256?: string | null }): void {
    if (!path || path.split('/').some((s) => s === '' || s === '.' || s === '..')) return
    let e = this.files.get(path)
    if (!e) {
      if (this.files.size >= SOURCE_FILES_MAX) return
      e = { path, via: new Set(), locs: new Map(), sha256: null, main: false, sub: false }
      this.files.set(path, e)
    }
    e.via.add(via)
    if (o.agent) e.sub = true; else e.main = true
    // seen with two contents in one turn (read, changed, read again): the list keeps the last hash only
    if (o.sha256 && e.sha256 && o.sha256 !== e.sha256) e.changed = true
    if (o.sha256) e.sha256 = o.sha256
    for (const l of o.locs ?? []) {
      if (!l || e.locs.size >= SOURCE_LOCS_MAX) continue
      const k = locKey(l)
      if (!e.locs.has(k)) e.locs.set(k, l)
    }
  }
  get size() { return this.files.size }
  /** is this path in the list (it will be saved with the answer) with one content: a file seen with two hashes in this
   * turn is not, as the list keeps only the last ("대화방에 보내기" goes by that hash, chat/read-scope.ts) */
  has(path: string): boolean { const e = this.files.get(path); return !!e && !e.changed }
  entries(): readonly Entry[] { return [...this.files.values()] }
}

/** Save the list with the answer (replaces what an earlier save of the same answer wrote). */
export function saveSources(db: Database, messageId: string, log: SourceLog): void {
  const rows = log.entries()
  db.transaction(() => {
    db.query('DELETE FROM message_sources WHERE message_id = ?').run(messageId)
    const ins = db.query('INSERT INTO message_sources (message_id, ord, path, sha256, locs, via, by_main, by_subagent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    rows.forEach((e, i) => ins.run(messageId, i, e.path, e.sha256, JSON.stringify([...e.locs.values()]), [...e.via].join(','), e.main ? 1 : 0, e.sub ? 1 : 0))
  })()
}

/** How many files an answer's list holds (Message.sourceCount), or 0. */
export function sourceCount(db: Database, messageId: string): number {
  return (db.query('SELECT COUNT(*) AS n FROM message_sources WHERE message_id = ?').get(messageId) as { n: number }).n
}

/** A team path that is the team's (not a person's own folder, not skills/ or a server folder): what the answer's
 * receipt counts as "팀 파일". */
export const isTeamFilePath = (p: string): boolean => !!p && !/^(users|skills|\.system)(\/|$)/.test(p)

/** The team files of an answer's list (isTeamFilePath), as recorded. */
export function teamSourcePaths(db: Database, messageId: string): string[] {
  return (db.query('SELECT path FROM message_sources WHERE message_id = ? ORDER BY ord').all(messageId) as { path: string }[]).map((r) => r.path).filter(isTeamFilePath)
}

const VIA = new Set<SourceVia>(['read', 'search', 'grep'])

/**
 * The list as `viewerId` may see it now. Each file is checked with today's rules and the person as they are now; a
 * disabled account sees nothing. A file that fails any check is counted in `unavailable` only.
 */
export function viewSources(db: Database, fx: FsCtx, rules: () => RuleSet, viewerId: string, messageId: string): MessageSources {
  const rows = db.query('SELECT path, locs, via, by_main, by_subagent FROM message_sources WHERE message_id = ? ORDER BY ord').all(messageId) as SourceRow[]
  return viewSourceRows(db, fx, rules, viewerId, rows)
}

/** A stored source row (message_sources, and room_message_sources for an AI answer in a team chat room). */
export interface SourceRow { path: string; locs: string; via: string; by_main: number; by_subagent: number }

/** Stored source rows as `viewerId` may see them now (viewSources' checks). */
export function viewSourceRows(db: Database, fx: FsCtx, rules: () => RuleSet, viewerId: string, rows: readonly SourceRow[]): MessageSources {
  if (!rows.length) return { files: [], unavailable: 0 }
  const user = loadPrincipal(db, viewerId)
  if (!user) return { files: [], unavailable: rows.length }
  const rs = rules()
  const files: MessageSourceFile[] = []
  let unavailable = 0
  for (const r of rows) {
    let rel: string
    try {
      const a = authorize(fx, rs, user, r.path, 'read')
      if (a.st?.isDirectory() || !visiblePath(fx, rs, user, a.rel)) throw new Error('not visible')
      rel = a.rel
    } catch { unavailable++; continue }
    let locs: SourceLoc[] = []
    try { locs = (JSON.parse(r.locs) as unknown[]).flatMap((l) => { const p = SourceLocSchema.safeParse(l); return p.success ? [p.data] : [] }).slice(0, SOURCE_LOCS_MAX) } catch {}
    const via = r.via.split(',').filter((v): v is SourceVia => VIA.has(v as SourceVia))
    files.push({ path: rel, name: rel.slice(rel.lastIndexOf('/') + 1), locs, via: via.length ? via : ['read'], ...(r.by_subagent && !r.by_main ? { subagent: true as const } : {}) })
  }
  return { files, unavailable }
}
