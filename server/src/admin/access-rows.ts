// The parts of the folder access answers (admin/access-explain.ts) that read nothing: which paths may be shown, the
// order of rows, pages, counts and "visible for navigation". No database, no disk: the web mock server
// (web/test/mock/server.ts) answers with the same functions, so the screen is tested against the same shapes and order.
import { PRODUCT } from '@mycel/shared'
import type { Access, AccessReason, Navigation } from '../policy/access'
import { badSegment, foldKey, hiddenEntry } from '../policy/names'
import { parseInput } from '../policy/resolve'

/** rows per page: default and most (people in a folder answer, folders in a person answer) */
export const DEFAULT_ROWS = 500
export const MAX_ROWS = 2000
/** at most this many folders in `via`; `viaMore` says there are others */
export const MAX_VIA = 20

const USERS = foldKey('users')
const SYSTEM = foldKey(PRODUCT.systemDir)
export const segsOf = (p: string) => (p === '' ? [] : p.split('/'))
/** byte order, the same everywhere (SQLite's ORDER BY, the mock, the cursor) */
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const TEMP = foldKey(PRODUCT.tmpPrefix)
/** Segments of a team path that may be shown, or null: anything under users/ or .system/ (any case or width), a
 * server temp name anywhere (any case: `.MYCEL-TMP-…` too), a name the team folder does not accept. Display only: what
 * the permission function answers for such a path does not change. */
export function shownSegs(p: string): string[] | null {
  const segs = segsOf(p)
  if (segs.length && (foldKey(segs[0]!) === USERS || foldKey(segs[0]!) === SYSTEM)) return null
  if (segs.some((s, i) => badSegment(s) !== null || hiddenEntry(s, i) || foldKey(s).startsWith(TEMP))) return null
  return segs
}
/** For RuleSet.listing().at / navigator(): a readable folder named in `via` must be one the answers may show (a
 * forgotten rule row such as `Users/x` or `.SYSTEM/x` still makes a folder listable, as canList() says, but is not
 * named). The person's own users/<id> is added by those functions themselves. */
export const shownPath = (p: string) => shownSegs(p) !== null

/** The folder answer's path as typed, or why it is refused, before anything is read: personal folders are their
 * owner's alone (the person answer has the one row), .system/, temp names and paths outside the team folder are no
 * team folders. */
export function folderInput(rel: string | undefined): { segs: string[] } | { refuse: 'personal' | 'not-team'; detail: string } {
  let typed: string[]
  try { typed = parseInput(rel ?? '') } catch (e) { return { refuse: 'not-team', detail: (e as Error).message } }
  if (typed.length && foldKey(typed[0]!) === USERS) return { refuse: 'personal', detail: "users/ is only its owner's" }
  if (!shownSegs(typed.join('/'))) return { refuse: 'not-team', detail: 'not a team folder' }
  return { segs: typed }
}

/** The nearest folder at or above `segs` that carries rules ('' when only the root does, null when none does). Below
 * it nothing carries rules, so every person's answer at `segs` is their answer there: callers compute once per such
 * folder. */
export function ruleFolderOf(ruleFolders: ReadonlySet<string>, segs: readonly string[]): string | null {
  for (let len = segs.length; len >= 0; len--) {
    const k = segs.slice(0, len).join('/')
    if (ruleFolders.has(k)) return k
  }
  return null
}

/** people by name, then id (byte order) */
export const byPerson = (a: { name: string; id: string }, b: { name: string; id: string }) => cmp(a.name, b.name) || cmp(a.id, b.id)

/** Counts per access and per source (the deciding folder for 'rule', one row per other reason): most first, then
 * reason, then folder. */
export function summarize(rows: readonly { access: Access; reason: AccessReason }[]) {
  const access = { none: 0, read: 0, write: 0 }
  const sources = new Map<string, { reason: AccessReason['kind']; folder: string | null; count: number }>()
  for (const r of rows) {
    access[r.access]++
    const folder = r.reason.kind === 'rule' ? r.reason.folder : null
    const k = `${r.reason.kind}\u0000${folder ?? ''}`
    const s = sources.get(k)
    if (s) s.count++
    else sources.set(k, { reason: r.reason.kind, folder, count: 1 })
  }
  return { access, sources: [...sources.values()].sort((a, b) => b.count - a.count || cmp(a.reason, b.reason) || cmp(a.folder ?? '', b.folder ?? '')) }
}

/** Shown in the tree although the person has no access there? `listable` is canList(); `via` the readable folders
 * below that make it so (only when the access itself is none: `look` runs only then, RuleSet.listing().at or
 * RuleSet.navigator()). */
export function navigation(look: () => Navigation, access: Access): { listable: boolean; via: string[]; viaMore: boolean } {
  if (access !== 'none') return { listable: true, via: [], viaMore: false }
  const n = look()
  return { listable: n.listable, via: n.via, viaMore: n.more }
}

/** Someone about to be invited (the new-person answer) has no personal folder yet, so it is never named: listing()
 * always names the person's own users/<id>, here a made-up id that is no path (it failed the answer's RelPath check).
 * `n` is listing().at(…, max + 1, …): that folder is left out and `via` cut to `max`. `listable` stays canList()'s
 * answer (once invited, the person has the folder, and the team root is on the way to it). Display only: access() and
 * the rows are unchanged. */
export function withoutOwnFolder(n: Navigation, own: string, max: number): Navigation {
  const via = n.via.filter((v) => v !== own)
  return { listable: n.listable, via: via.slice(0, max), more: n.more || via.length > max }
}

/** Rows of a person answer by path: those at or below `prefix`, after `cursor` (the last path of the page before), at
 * most `limit`. `nextCursor`: the last path of this page when more follow. */
export function pageByPath<T extends { path: string }>(rows: readonly T[], o: { prefix?: string; cursor?: string; limit?: number }) {
  const prefix = o.prefix ?? ''
  const all = [...rows].filter((r) => prefix === '' || r.path === prefix || r.path.startsWith(prefix + '/')).sort((a, b) => cmp(a.path, b.path))
  const from = o.cursor === undefined ? all : all.filter((r) => cmp(r.path, o.cursor!) > 0)
  const limit = Math.min(o.limit ?? DEFAULT_ROWS, MAX_ROWS)
  const items = from.slice(0, limit)
  return { items, total: all.length, nextCursor: from.length > items.length ? items[items.length - 1]!.path : null }
}

/** The cursor of a folder answer: the last person of the page before (name and id, the byPerson order), as base64url. */
export const personCursor = (u: { name: string; id: string }) => Buffer.from(JSON.stringify([u.name, u.id])).toString('base64url')
export function readPersonCursor(c: string): { name: string; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown
    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' ? { name: v[0], id: v[1] } : null
  } catch { return null }
}

/** Rows of a folder answer by person (`rows` in byPerson order): those after the person the cursor names, so people
 * added, removed or switched off between two pages neither come twice nor go missing. null: the cursor is not one. */
export function pageByPerson<T>(rows: readonly T[], who: (r: T) => { name: string; id: string }, o: { cursor?: string; limit?: number }) {
  const after = o.cursor === undefined ? undefined : readPersonCursor(o.cursor)
  if (after === null) return null
  const from = after ? rows.filter((r) => byPerson(who(r), after) > 0) : rows
  const limit = Math.min(o.limit ?? DEFAULT_ROWS, MAX_ROWS)
  const items = from.slice(0, limit)
  return { items, total: rows.length, nextCursor: from.length > items.length ? personCursor(who(items[items.length - 1]!)) : null }
}
