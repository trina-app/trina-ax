// "Read scope" of a chat (design tab 7 "공용 폴더를 거친 유출", tab 1 chats.session_read_scope): where the content
// that went into the model came from, so the server can notice when the AI is about to save it somewhere MORE
// people can see (a hidden instruction in a shared document makes a finance member's AI copy finance numbers into
// shared/). Sources, not people, are stored: viewers are computed from the rules at the time of the write, so a
// changed rule or a new member never leaves a stale set behind.
//   {type:'folder', id}  the nearest folder with rules above a file (folders.id: survives renames and moves)
//   {type:'root'}        no rule folder above it: the team folder's default (owner and admins)
//   {type:'user', id}    users/<id>/…, and what the in-app browser showed the person (only they saw it)
// null (no sources yet) = no limit. read and grep results count; list / glob (names only), skills, memories and the
// person's own messages do not.
import type { Database } from 'bun:sqlite'
import { atLeast, loadPrincipal, RuleSet, type Principal } from '../policy/access'

export type ReadSource = { type: 'folder'; id: string } | { type: 'user'; id: string } | { type: 'root' }

/** One string per source (deduplication, and what the person already allowed for a folder in this turn). */
export const sourceKey = (s: ReadSource) => (s.type === 'root' ? 'root' : `${s.type}:${s.id}`)
const key = sourceKey

/** The source of a team-folder file (relative path with actual names). */
export function sourceOf(db: Database, rules: RuleSet, rel: string): ReadSource {
  const segs = rel.split('/').filter(Boolean)
  if (segs[0] === 'users' && segs.length >= 2) return { type: 'user', id: segs[1]! }
  const ruled = new Set(rules.ruleFolders())
  for (let len = segs.length; len >= 0; len--) {
    const p = segs.slice(0, len).join('/')
    if (!ruled.has(p)) continue
    const row = db.query('SELECT id FROM folders WHERE path = ?').get(p) as { id: string } | null
    if (row) return { type: 'folder', id: row.id }
  }
  return { type: 'root' }
}

export function readScope(db: Database, chatId: string): ReadSource[] | null {
  const row = db.query('SELECT session_read_scope AS s FROM chats WHERE id = ?').get(chatId) as { s: string | null } | null
  if (!row?.s) return null
  try {
    const v = JSON.parse(row.s) as { sources?: ReadSource[] }
    return Array.isArray(v.sources) ? v.sources : null
  } catch { return null }
}

/** Add sources to a chat's scope (deduplicated). */
export function addSources(db: Database, chatId: string, add: ReadSource[]): void {
  if (!add.length) return
  db.transaction(() => {
    const cur = readScope(db, chatId) ?? []
    const seen = new Set(cur.map(key))
    let changed = false
    for (const s of add) if (!seen.has(key(s))) { seen.add(key(s)); cur.push(s); changed = true }
    if (changed) db.query('UPDATE chats SET session_read_scope = ? WHERE id = ?').run(JSON.stringify({ sources: cur }), chatId)
  })()
}

export function clearScope(db: Database, chatId: string): void {
  db.query('UPDATE chats SET session_read_scope = NULL WHERE id = ?').run(chatId)
}

function activePeople(db: Database): Principal[] {
  const ids = db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]
  return ids.map((r) => loadPrincipal(db, r.id)).filter((p): p is Principal => !!p)
}

/** Who may read what came from this source, under today's rules. A folder row that is gone: nobody (asks). */
function viewersOf(db: Database, rules: RuleSet, s: ReadSource, people: Principal[]): Set<string> {
  if (s.type === 'user') return new Set(people.some((p) => p.id === s.id) ? [s.id] : [])
  let segs: string[] = []
  if (s.type === 'folder') {
    const row = db.query('SELECT path FROM folders WHERE id = ?').get(s.id) as { path: string } | null
    if (!row) return new Set()
    segs = row.path === '' ? [] : row.path.split('/')
  }
  return new Set(people.filter((p) => atLeast(rules.access(p, segs), 'read')).map((p) => p.id))
}

export interface Widening {
  /** sources whose readers do not include everyone who can read the target */
  narrower: ReadSource[]
  /** how many people can read the target */
  targetViewers: number
}

/**
 * Would saving at `targetSegs` let more people see what this chat read (plus `extra` sources, e.g. make_file's
 * source file, embedded images and template)? null = no. chatId null: only `extra` (a tool call outside a chat).
 */
export function widening(db: Database, chatId: string | null, targetSegs: string[], extra: ReadSource[] = []): Widening | null {
  const sources = [...((chatId ? readScope(db, chatId) : null) ?? []), ...extra]
  if (!sources.length) return null
  const rules = RuleSet.load(db)
  const people = activePeople(db)
  const target = people.filter((p) => atLeast(rules.access(p, targetSegs), 'read')).map((p) => p.id)
  const narrower = sources.filter((s, i) => sources.findIndex((x) => key(x) === key(s)) === i)
    .filter((s) => { const v = viewersOf(db, rules, s, people); return target.some((id) => !v.has(id)) })
  return narrower.length ? { narrower, targetViewers: target.length } : null
}

/** Where a source is, for the confirmation card. */
export function sourceLabel(db: Database, s: ReadSource, me: string, text: { mine: string; root: string }): string {
  if (s.type === 'root') return text.root
  if (s.type === 'user') return s.id === me ? text.mine : `users/${s.id}/`
  const row = db.query('SELECT path FROM folders WHERE id = ?').get(s.id) as { path: string } | null
  return row ? (row.path === '' ? text.root : row.path + '/') : '?'
}
