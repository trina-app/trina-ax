// Who can open a file or a folder, and by which route (docs/decisions/20261116-ai-share-who-can-open.md, plan
// docs/AGENTS/plan/20261116-1150-ai-share-who-can-open.md). Read-only: it decides nothing, it explains what the folder
// rules (policy/access.ts RuleSet.explain) and the file shares (files/shares.ts) already decide, with the same calls
// they use, so the explanation and the access never drift apart.
//
//   accessRouteFor(ctx, personId, path)   how one person opens the file or folder at `path`, or null: they cannot.
//                                         For the share tool ("Jun can already open it through Sales") and who_can_open.
//   routeWords(ctx, route, viewerId)      the route as one English phrase for the AI (it answers in the person's
//                                         language), folders in the words the Files screen uses, never a path.
//   fileAccess / folderAccess             the list for who_can_open (chat/who-can-open.ts), cut to what the asker may
//                                         see on screen: a file's owner (and whoever may share it) sees who it is
//                                         shared with, as the Share dialog shows; the people a FOLDER's access lets in
//                                         are named only for the owner and admins (Admin › folder access), a member
//                                         gets the count the Files screen shows them (GET /api/files/audience).
//
// A guest never opens anything through a share, and is never listed as someone to share with.
import type { AppContext } from '../context'
import { atLeast, isStaff, loadPrincipal, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { FILE_SHARE_EVERYONE, plainLabel } from '@mycel/shared/api'
import { placeWords } from '../chat/place-words'
import { fileSharesOf } from './shares'

export type AccessRoute =
  /** their own personal folder, or everything in it */
  | { kind: 'own' }
  /** the team owner or an admin: every team folder outside the projects */
  | { kind: 'staff' }
  /** the folder's access: `folder` is the folder whose access lets them in ('' for the top), `by` who that access names */
  | { kind: 'folder'; folder: string; by: 'everyone' | 'role' | 'group' | 'person'; group?: string }
  /** the file was shared: with them by name, with a group they are in, or with everyone on the team */
  | { kind: 'shared'; by: 'person' | 'group' | 'everyone'; group?: string }

/** people named in one list, at most (the rest is a count) */
export const NAMES_MAX = 10

const segsOf = (p: string) => p.normalize('NFC').split('/').filter((x) => x && x !== '.')
const groupName = (ctx: AppContext, id: string | null) => (id ? (ctx.db.query('SELECT name FROM groups WHERE id = ?').get(id) as { name: string } | null)?.name : undefined)
/** a display name as the AI is given it: one line, no tags (plainLabel), capped */
export const nameOf = (ctx: AppContext, id: string): string | null => {
  const r = ctx.db.query('SELECT name FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as { name: string } | null
  return r ? plainLabel(r.name, 80) : null
}

/** The route the folder rules give `p` at `segs`, or null when they give none. */
function ruleRoute(ctx: AppContext, p: Principal, segs: string[]): AccessRoute | null {
  const e = ctx.files.rules().explain(p, segs)
  if (!atLeast(e.access, 'read')) return null
  const r = e.reason
  if (r.kind === 'own-personal') return { kind: 'own' }
  if (r.kind === 'owner-admin') return { kind: 'staff' }
  if (r.kind !== 'rule') return { kind: 'folder', folder: segs.slice(0, 1).join('/'), by: 'everyone' }
  const by = r.tier === 'user' ? 'person' : r.tier
  const g = by === 'group' ? groupName(ctx, r.rules[0]?.subjectId ?? null) : undefined
  return { kind: 'folder', folder: r.folder, by, ...(g ? { group: plainLabel(g, 80) } : {}) }
}

/** The route a file share gives `p` for the file at `rel` (only when the folder rules give none), or null. */
function shareRoute(ctx: AppContext, p: Principal, rel: string): AccessRoute | null {
  if (p.role === 'guest') return null
  const shares = fileSharesOf(ctx)
  const s = shares.liveRow(rel)
  if (!s) return null
  // the link's own checks (live, the same file, the owner still edits it, a grant that reaches them)
  const o = shares.open(p.id, s.id)
  if (o.kind !== 'open' || o.by !== 'grant') return null
  const grants = ctx.db.query('SELECT subject_type, subject_id FROM file_share_grants WHERE share_id = ? ORDER BY granted_at, subject_id').all(s.id) as { subject_type: 'user' | 'group'; subject_id: string }[]
  if (grants.some((g) => g.subject_type === 'user' && g.subject_id === p.id)) return { kind: 'shared', by: 'person' }
  const grp = grants.find((g) => g.subject_type === 'group' && g.subject_id !== FILE_SHARE_EVERYONE && p.groups.includes(g.subject_id))
  if (grp) { const n = groupName(ctx, grp.subject_id); return { kind: 'shared', by: 'group', ...(n ? { group: plainLabel(n, 80) } : {}) } }
  return { kind: 'shared', by: 'everyone' }
}

/**
 * How `personId` can open the file or folder at `path` now, or null: they cannot (also: no such account, an account
 * that is off). The folder rules first (they open more: edit, search, the AI's tools), then a file share (view only).
 * `path` is a team path the CALLER already resolved for someone who may open it; nothing here tells whether it exists.
 */
export function accessRouteFor(ctx: AppContext, personId: string, path: string): AccessRoute | null {
  const p = loadPrincipal(ctx.db, personId)
  if (!p) return null
  const segs = segsOf(path)
  if (!segs.length) return null
  return ruleRoute(ctx, p, segs) ?? shareRoute(ctx, p, segs.join('/'))
}

/** A route as one English phrase for the AI ("through the Sales group, which the file is shared with"); folders in the
 * Files screen's words as `viewerId` reads them, never a path. */
export function routeWords(ctx: AppContext, route: AccessRoute, viewerId: string): string {
  if (route.kind === 'own') return 'it is in their own folder'
  if (route.kind === 'staff') return 'as a team owner or admin (they can open every team folder)'
  if (route.kind === 'shared') {
    return route.by === 'person' ? 'the file is shared with them by name (view only)'
      : route.by === 'group' ? `through the ${route.group ? `"${route.group}"` : 'a'} group, which the file is shared with (view only)`
        : 'the file is shared with everyone on the team (view only)'
  }
  const folder = `the folder "${plainLabel(placeWords(ctx.db, route.folder, 'en', viewerId), 120)}"`
  return route.by === 'everyone' ? `through ${folder}, which everyone on the team can open`
    : route.by === 'group' ? `through the ${route.group ? `"${route.group}"` : 'a'} group, which can open ${folder}`
      : route.by === 'role' ? `through ${folder}, which their role can open`
        : `through ${folder}, where they are added by name`
}

/** One line of a who-can-open list: a subject and how many people it stands for. */
export interface AccessLine { who: string; kind: 'person' | 'group' | 'everyone'; people?: number }

export interface FileAccess {
  kind: 'file'
  name: string
  /** where it is, in the Files screen's words (the asker's own view) */
  place: string
  /** a team path, as stored (for the tool's own follow-up calls; never printed for the person) */
  path: string
  owner: { id: string; name: string } | null
  mine: boolean
  /** the asker may add people (the Share dialog's rule) */
  canShare: boolean
  /** ...and may not only because the team turned members' file sharing off */
  shareOff: boolean
  /** the asker sees the list (its owner, or whoever may share it) */
  full: boolean
  /** how the asker opens it */
  self: AccessRoute | null
  /** who it is shared with (the Share dialog's rows), when `full` */
  shared: AccessLine[]
  /** how many active people can open it now, by the folder's access and by shares together (when `full`) */
  total: number | null
  /** the people the FOLDER's access lets in besides the asker: their number, and for the owner and admins their names
   * (the first NAMES_MAX) */
  byFolder: { people: number; names: string[] | null } | null
}

/** Every active account but guests are looked at for a list (each a rule walk): a team past this size gets counts only. */
export const WALK_MAX = 2000
const activeIds = (ctx: AppContext): string[] => (ctx.db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL ORDER BY name, id LIMIT ?").all(WALK_MAX + 1) as { id: string }[]).map((r) => r.id)

/**
 * The file at `input` (a team path) for `askerId`, as who_can_open answers it; null when they cannot open it by the
 * folder rules (the same answer as a missing file; a file they have only by a share is answered by `sharedWithMeAccess`).
 */
export function fileAccess(ctx: AppContext, askerId: string, input: string): FileAccess | null {
  const me = loadPrincipal(ctx.db, askerId)
  if (!me || me.role === 'guest') return null
  const shares = fileSharesOf(ctx)
  let v
  try { v = shares.view(askerId, input, 'en') } catch { return null }
  // a folder (the view answers for one once folder sharing is on): folderAccess answers it, never as a file
  if (v.kind === 'folder') return null
  const segs = segsOf(v.path)
  const full = v.canShare || v.mine
  const staff = isStaff(me)
  const out: FileAccess = {
    kind: 'file', name: plainLabel(segs[segs.length - 1] ?? '', 120), place: plainLabel(placeWords(ctx.db, segs.slice(0, -1).join('/'), 'en', askerId), 160), path: v.path,
    owner: v.owner ? { id: v.owner.id, name: plainLabel(v.owner.name, 80) } : null, mine: v.mine, canShare: v.canShare, shareOff: v.off === true, full,
    self: accessRouteFor(ctx, askerId, v.path), shared: [], total: null, byFolder: null,
  }
  if (!full) return out
  out.shared = v.people.filter((p) => !p.inactive).map((p): AccessLine => p.subjectType === 'user'
    ? { who: plainLabel(p.name, 80), kind: 'person' }
    : p.everyone ? { who: 'Everyone on the team', kind: 'everyone' }
      : { who: plainLabel(p.name, 80), kind: 'group', people: (ctx.db.query("SELECT COUNT(*) n FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? AND u.status = 'active' AND u.deleted_at IS NULL").get(p.subjectId) as { n: number }).n })
  const ids = activeIds(ctx)
  if (ids.length > WALK_MAX) return out
  let total = 0
  const folder: string[] = []
  for (const id of ids) {
    const p = loadPrincipal(ctx.db, id)
    if (!p) continue
    const byRule = ruleRoute(ctx, p, segs)
    if (byRule) { total++; if (id !== askerId) folder.push(id); continue }
    if (shareRoute(ctx, p, v.path)) total++
  }
  out.total = total
  // a personal file: the folder lets in its person alone (nothing to say). A team file: the count for everyone who
  // may see the list, the names for the owner and admins (the folder access screen is theirs)
  if (segs[0] !== 'users') out.byFolder = { people: folder.length, names: staff ? folder.slice(0, NAMES_MAX).map((id) => nameOf(ctx, id) ?? '').filter(Boolean) : null }
  return out
}

export interface FolderAccess {
  kind: 'folder'
  name: string
  place: string
  path: string
  /** the asker's own personal folder (or one inside it): nobody else, and it cannot be shared as a folder */
  personal: boolean
  /** the owner and admins: they see and change who can open a team folder */
  full: boolean
  self: AccessRoute | null
  /** how many active people can open it (the count the Files screen shows everyone who can open it) */
  people: number | null
  /** for the owner and admins: the first NAMES_MAX names of them */
  names: string[] | null
}

/** The folder at `input` for `askerId`; null when they may not list it (the same as a missing folder) or it is a file. */
export function folderAccess(ctx: AppContext, askerId: string, input: string): FolderAccess | null {
  const me = loadPrincipal(ctx.db, askerId)
  if (!me || me.role === 'guest') return null
  let a
  try { a = authorize(ctx.files.fx, ctx.files.rules(), me, input, 'list') } catch { return null }
  if (!a.st?.isDirectory() || !a.segs.length) return null
  const segs = a.segs
  const personal = segs[0] === 'users'
  const full = !personal && isStaff(me)
  const out: FolderAccess = {
    kind: 'folder', name: plainLabel(segs[segs.length - 1] ?? '', 120), place: plainLabel(placeWords(ctx.db, a.rel, 'en', askerId), 160), path: a.rel,
    personal, full, self: accessRouteFor(ctx, askerId, a.rel), people: personal ? 1 : null, names: null,
  }
  if (personal) return out
  const ids = activeIds(ctx)
  if (ids.length > WALK_MAX) return out
  const can = ids.filter((id) => { const p = loadPrincipal(ctx.db, id); return !!p && !!ruleRoute(ctx, p, segs) })
  out.people = can.length
  if (full) out.names = can.filter((id) => id !== askerId).slice(0, NAMES_MAX).map((id) => nameOf(ctx, id) ?? '').filter(Boolean)
  return out
}

/** A file `askerId` has only through a share (named by its team path or its /f/<id> link): how they open it and who
 * shared it; nothing about who else has it (that list is its owner's). Null: it does not open for them. */
export function sharedWithMeAccess(ctx: AppContext, askerId: string, input: string): { name: string; path: string; self: AccessRoute; owner: { id: string; name: string } | null; shareId: string } | null {
  const me = loadPrincipal(ctx.db, askerId)
  if (!me || me.role === 'guest') return null
  const shares = fileSharesOf(ctx)
  const at = ctx.files.shared?.link(me, input) ?? ctx.files.shared?.at(me, input) ?? null
  if (!at) return null
  const s = shares.liveRow(at.rel)
  if (!s) return null
  const self = accessRouteFor(ctx, askerId, at.rel)
  if (!self) return null
  const owner = s.owner_id ? nameOf(ctx, s.owner_id) : null
  return { name: plainLabel(at.segs[at.segs.length - 1] ?? '', 120), path: at.rel, self, owner: s.owner_id && owner ? { id: s.owner_id, name: owner } : null, shareId: s.id }
}
