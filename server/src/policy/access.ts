// Folder permission resolution (design tab 2 "폴더와 권한 규칙"; docs/DECISIONS.md "Folder access adds up like Google
// Drive (P2)"). Paths are arrays of ACTUAL on-disk names (see resolve.ts) and are compared exactly — never case-folded.
// Access adds up from the folders above, up to and including the nearest limited folder (folders.limited), and the
// widest rule wins. "No access" rows add nothing; the only one that takes access away is a person's own on
// projects/<name> (the project exception). The rules from before (deepest folder decides, person > group > role >
// everyone) were converted once (policy/convert-additive.ts; the old resolver is kept in policy/legacy-deepest.ts).
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'

export type Access = 'none' | 'read' | 'write'
export type Role = 'owner' | 'admin' | 'member' | 'guest'
/** `system`: the server's own principal (admin/folders.ts resolveFolderPath): write everywhere outside users/ and
 * .system/, never inferred from a role (docs/DECISIONS.md "Project contents only for members"). */
export interface Principal { id: string; name: string; role: Role; groups: string[]; system?: true }

// Whether the team folder's disk ignores letter case (files/service.ts sets it from detectCaseInsensitive; one team
// folder per server process). Until then it folds, which fails closed.
let projectsFoldCase = true
/** Set by the files service from the team folder's disk; tests of a case-sensitive team set and restore it. */
export function setProjectsCaseInsensitive(ci: boolean): void { projectsFoldCase = ci }
export const projectsCaseInsensitive = (): boolean => projectsFoldCase
/**
 * The top-level projects root by name (docs/DECISIONS.md "Only the lowercase projects/ folder on case-sensitive
 * disks"): `projects` after NFC; in any letter case only on a disk that ignores case, where `Projects/` is the same
 * folder. On a case-sensitive disk `Projects/` is an ordinary team folder.
 */
export const isProjectsName = (seg: string): boolean => { const n = seg.normalize('NFC'); return n === 'projects' || (projectsFoldCase && n.toLowerCase() === 'projects') }
/**
 * The members-only zone (docs/DECISIONS.md "Project contents only for members"): every path at or below
 * projects/<name>/. Decided by the path alone (isProjectsName), so every RuleSet, wherever it is built, has it.
 * projects/ itself is outside.
 */
export const inProjectZone = (segs: readonly string[]): boolean => segs.length >= 2 && isProjectsName(segs[0]!)
/** The server's own principal: the system flag, not the role, gives it write (decide()). */
export const SYSTEM_PRINCIPAL: Principal = Object.freeze({ id: '\u0000system', name: 'system', role: 'owner' as const, groups: [] as string[], system: true as const })
/** The top folder of the zone (projects/ itself, by isProjectsName). */
export const isProjectsTop = (segs: readonly string[]): boolean => segs.length === 1 && isProjectsName(segs[0]!)
/** The owner or an admin (never the system principal). */
export const isStaff = (p: Pick<Principal, 'role'> & { system?: true }): boolean => !p.system && (p.role === 'owner' || p.role === 'admin')
/** Rules inside the zone start at projects/<name> for the owner and admins: rules on projects/ or the root never reach
 * in for them (an admin's own rule up there would open every project without a floor of its own). */
const ZONE_FLOOR = 2
/** How the owner or an admin is judged inside the zone: as a member with the same groups (a role rule for admins or
 * the owner never applies there). Everyone else, and anyone outside the zone, as they are. */
const zoneSubject = (p: Principal): Principal => ({ id: p.id, name: p.name, role: 'member', groups: p.groups })
/** How a guest is judged (RuleSet.isGuest): role guest, no groups, so applies() takes person rules only. */
const guestSubject = (p: Principal): Principal => ({ id: p.id, name: p.name, role: 'guest', groups: [] })
/** users.guest = 1 (migration 122); none on a database from before it. */
function guestIds(db: Database): string[] {
  try { return (db.query('SELECT id FROM users WHERE guest = 1').all() as { id: string }[]).map((r) => r.id) } catch { return [] }
}
export type SubjectType = 'everyone' | 'role' | 'group' | 'user'

interface Rule { subject_type: SubjectType; subject_id: string | null; access: Access; origin?: string | null }
const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }
const BY_RANK: readonly Access[] = ['none', 'read', 'write']
export const atLeast = (a: Access, b: Access) => RANK[a] >= RANK[b]

/**
 * Readers of a folder apart (shared AudienceSplit; docs/DECISIONS.md "Who sees it: the project's own people first").
 * `readers`: who can read it now. A member reads it by a rule; the owner or an admin is `direct` only when they would read
 * it as a member would (role-blind, as chat/shared.ts Audiences.alone), else `byRole`: they see it only by their role.
 * Only for the owner and admins to read: beside the total, a member would learn how many see it only by role.
 */
export function splitOf(rules: RuleSet, readers: readonly Principal[], segs: readonly string[]): { direct: number; byRole: number } {
  const direct = readers.filter((x) => x.role === 'member' || x.role === 'guest' || atLeast(rules.access({ ...x, role: 'member' }, segs), 'read')).length
  return { direct, byRole: readers.length - direct }
}

/** How an applying rule is named in explain(): the subject type of the widest applying rule (person first on a tie). */
const TIERS = ['user', 'group', 'role', 'everyone'] as const
const TIER: Record<SubjectType, number> = { user: 0, group: 1, role: 2, everyone: 3 }

/**
 * Why a person has the access they have at a path (RuleSet.explain): the branch of the permission function that
 * decided, in its order.
 * - system: `.system/` (nobody, owner included) · temp: a server temp name in the path (nobody)
 * - own-personal: `users/<me>/…` (write) · other-personal: `users/<someone else>/…` (nobody, owner and admin
 *   included) · users-root: `users/` itself (read, nobody writes there)
 * - owner-admin: the owner or an admin (write everywhere else but the members-only zone projects/<name>/, where they
 *   are judged as a member by the rules at or below projects/<name>), or the system principal (write everywhere else)
 * - left: the person's own "no access" on projects/<name> (the project exception: they left it, or an admin keeps them
 *   out), for that folder and everything in it (`folder`)
 * - rule: the folder of the widest rule that applies to the person on the way up to the nearest limited folder (`folder`,
 *   '' = team root; on a tie the nearest), that rule's subject type (`tier`) and the applying rules there with that
 *   access and type (`rules`)
 * - no-rule: no rule on the way up applies to the person; `cutAt`: the limited folder that stopped the walk, when one
 *   did (for the owner and admins inside the zone: none at or below projects/<name>)
 */
export type AccessReasonKind = 'system' | 'temp' | 'own-personal' | 'other-personal' | 'users-root' | 'owner-admin' | 'rule' | 'no-rule' | 'left'
export interface DecidingRule { subjectType: SubjectType; subjectId: string | null; access: Access; origin?: string | null }
export type AccessReason =
  | { kind: Exclude<AccessReasonKind, 'rule' | 'no-rule' | 'left'> }
  | { kind: 'no-rule'; cutAt?: string }
  | { kind: 'left'; folder: string }
  | { kind: 'rule'; folder: string; tier: SubjectType; rules: DecidingRule[] }
export interface Explained { access: Access; reason: AccessReason }

/** Where decide() leaves why it answered. access() passes none, so the hot path allocates nothing for it. */
interface Why { kind: AccessReasonKind; folderLen: number; cutLen: number; rules: readonly Rule[] | null; best: number; who?: Principal }

export function loadPrincipal(db: Database, userId: string): Principal | null {
  // the role as the API knows it: a guest is stored as role 'member' with users.guest = 1 (migration 122_a_guests.sql)
  const u = db.query("SELECT id, name, CASE WHEN guest = 1 THEN 'guest' ELSE role END AS role, status FROM users WHERE id = ?").get(userId) as any
  if (!u || u.status !== 'active') return null
  const groups = (db.query('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as any[]).map((r) => r.group_id)
  return { id: u.id, name: u.name, role: u.role, groups }
}

/** One stored rule row with its folder's path. `origin`: set only on a person rule the one-time conversion wrote. */
export interface RuleRow { path: string; subject_type: SubjectType; subject_id: string | null; access: Access; origin?: string | null }
/** Everything access depends on: the rule rows, the limited folders (by path) and the guests' ids (docs/DECISIONS.md
 * "Guests: only what they were invited to": for them only person rules inside projects/<name> count). */
export interface RuleWorld { rows: readonly RuleRow[]; limited: Iterable<string>; guests?: Iterable<string> }
/** A rule as the API and the database have it (FolderRuleInput, DecidingRule). */
export interface RuleLike { subjectType: string; subjectId: string | null; access: string; origin?: string | null }

/** The settings key whose value says the folder rules are in the additive model (written by the conversion). */
export const FOLDER_ACCESS_MODEL_KEY = 'folder_access_model'
export const FOLDER_ACCESS_MODEL = 'additive-1'

/** A folder path cut into names ('' = the team root). */
const segsOf = (p: string): string[] => (p === '' ? [] : p.split('/'))
/** projects/<name>: a depth-2 folder of the members-only zone (the only place a person's "no access" row counts). */
export const isZoneTop = (p: string): boolean => { const s = segsOf(p); return s.length === 2 && isProjectsName(s[0]!) && !!s[1] }
/** The legacy marker: "everyone: none", kept on a limited folder without an everyone rule (an older reader's cut). */
export const isLegacyMarker = (r: Pick<RuleLike, 'subjectType' | 'access'>): boolean => r.subjectType === 'everyone' && r.access === 'none'
/** The managed marker: "role admin: write" (inert for access; keeps a folder admin-only to move, rename or trash). */
export const isManagedMarker = (r: Pick<RuleLike, 'subjectType' | 'subjectId' | 'access'>): boolean => r.subjectType === 'role' && r.subjectId === 'admin' && r.access === 'write'
/** A project exception: a person's own "no access" on projects/<name> (`path`). */
export const isProjectException = (path: string, r: Pick<RuleLike, 'subjectType' | 'subjectId' | 'access'>): boolean => r.subjectType === 'user' && r.access === 'none' && !!r.subjectId && isZoneTop(path)
/** The rules the API shows and hashes: without the two markers and the project exception rows. */
const shownRule = (path: string, r: Pick<RuleLike, 'subjectType' | 'subjectId' | 'access'>): boolean => !isLegacyMarker(r) && !isManagedMarker(r) && !isProjectException(path, r)

/** In-place view of a parked (trashed) folder: its rows under `storage` at `original`, and no rows of a folder that took
 * `original` since (chat/shared.ts rulesInPlace, team-files trash). A mapPath for RuleSet.fromDb. */
export const inPlace = (storage: string, original: string) => {
  const under = (f: string, base: string) => f === base || (base !== '' && f.startsWith(base + '/'))
  return (p: string): string | null => (under(p, storage) ? original + p.slice(storage.length) : under(p, original) ? null : p)
}

let failClosedLogged = false

export class RuleSet {
  /** every stored row (markers and project exceptions included), by folder path */
  private byPath = new Map<string, Rule[]>()
  private limited: Set<string>
  /** the guests' user ids (users.guest = 1): judged by person rules inside projects/<name> only, whatever role a
   * Principal built anywhere says (the role is checked too: either one makes a guest) */
  private guests: Set<string>
  /** projects/<name> -> the people its project exception rows name */
  private exceptions = new Map<string, Set<string>>()
  /** set when the set was built from a database without the conversion marker: no rule applies */
  readonly failedClosed: boolean

  private constructor(w: RuleWorld, failedClosed = false) {
    this.failedClosed = failedClosed
    this.limited = new Set(w.limited)
    this.guests = new Set(w.guests ?? [])
    for (const r of w.rows) {
      const list = this.byPath.get(r.path) ?? []
      list.push({ subject_type: r.subject_type, subject_id: r.subject_id, access: r.access, origin: r.origin ?? null })
      this.byPath.set(r.path, list)
      if (r.subject_type === 'user' && r.access === 'none' && r.subject_id && isZoneTop(r.path)) {
        const s = this.exceptions.get(r.path) ?? new Set<string>()
        s.add(r.subject_id)
        this.exceptions.set(r.path, s)
      }
    }
  }

  /** A rule set from rows and limited folders (tests, the web mock, srt attack scripts; the server reads fromDb). */
  static fromWorld(w: RuleWorld): RuleSet { return new RuleSet(w) }

  /**
   * THE loader: the folders table (so a limited folder with no rules counts) and the rules. `mapPath` rewrites a
   * folder's path or drops it (null): the trash views put parked rows back at their old path with it. Without the
   * conversion marker (a hand-edited or half-copied database) no rule applies: members get none, the owner and admins
   * keep their fixed branches (fail closed).
   */
  static fromDb(db: Database, o: { mapPath?: (p: string) => string | null } = {}): RuleSet {
    let model: string | null = null
    try { model = (db.query('SELECT value FROM settings WHERE key = ?').get(FOLDER_ACCESS_MODEL_KEY) as { value: string } | null)?.value ?? null } catch { model = null }
    if (model !== FOLDER_ACCESS_MODEL) {
      if (!failClosedLogged) { failClosedLogged = true; console.error(`folder access: the database has no "${FOLDER_ACCESS_MODEL_KEY}" marker; every folder rule is ignored (fail closed)`) }
      return new RuleSet({ rows: [], limited: [], guests: guestIds(db) }, true)
    }
    const map = o.mapPath
    const folders = db.query('SELECT id, path, limited FROM folders').all() as { id: string; path: string; limited: number }[]
    const pathOf = new Map<string, string>()
    const limited: string[] = []
    for (const f of folders) {
      const p = map ? map(f.path) : f.path
      if (p === null) continue
      pathOf.set(f.id, p)
      if (f.limited === 1) limited.push(p)
    }
    const rows: RuleRow[] = []
    for (const r of db.query('SELECT folder_id, subject_type, subject_id, access, origin FROM folder_rules').all() as { folder_id: string; subject_type: SubjectType; subject_id: string | null; access: Access; origin: string | null }[]) {
      const p = pathOf.get(r.folder_id)
      if (p === undefined) continue
      rows.push({ path: p, subject_type: r.subject_type, subject_id: r.subject_id, access: r.access, origin: r.origin })
    }
    return new RuleSet({ rows, limited, guests: guestIds(db) })
  }
  /** = fromDb(db) */
  static load(db: Database): RuleSet { return RuleSet.fromDb(db) }

  /** Everything this set holds, as fromWorld takes it. */
  world(): { rows: RuleRow[]; limited: string[]; guests: string[] } {
    const rows: RuleRow[] = []
    for (const [path, list] of this.byPath) for (const r of list) rows.push({ path, subject_type: r.subject_type, subject_id: r.subject_id, access: r.access, origin: r.origin })
    return { rows, limited: [...this.limited], guests: [...this.guests] }
  }

  /** The folders where access can change: those that carry a rule row, and the limited ones ('' = the team root). */
  boundaryFolders(): string[] { return [...new Set([...this.byPath.keys(), ...this.limited])] }
  /** the rules of one folder path ('' = team root) as the API shows them: without the legacy marker, the managed marker
   * and the project exception rows (exceptionsAt) */
  rulesAt(folder: string): DecidingRule[] {
    return (this.byPath.get(folder) ?? []).filter((r) => shownRule(folder, { subjectType: r.subject_type, subjectId: r.subject_id, access: r.access }))
      .map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, access: r.access, ...(r.origin ? { origin: r.origin } : {}) }))
  }
  /** every stored row of one folder, markers and exceptions included */
  storedAt(folder: string): DecidingRule[] {
    return (this.byPath.get(folder) ?? []).map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, access: r.access, ...(r.origin ? { origin: r.origin } : {}) }))
  }
  /** the people a project exception keeps out of projects/<name> (`folder`) and everything in it */
  exceptionsAt(folder: string): string[] { return [...(this.exceptions.get(folder) ?? [])].sort() }
  /** the folder cuts what comes from the folders above (Limit access) */
  limitedAt(folder: string): boolean { return this.limited.has(folder) }
  /** the folder carries the managed marker */
  managedAt(folder: string): boolean { return (this.byPath.get(folder) ?? []).some((r) => r.subject_type === 'role' && r.subject_id === 'admin' && r.access === 'write') }

  /**
   * This set with one folder's shown rules replaced by `next.rules`, as writeFolderAccess would store them: `limited`
   * omitted keeps the folder's current value; the markers follow (the legacy marker on a limited folder without an
   * everyone rule, the managed marker kept); project exceptions of people `next.rules` does not name stay; a person
   * rule saved with the same access keeps its origin.
   */
  replacing(folder: string, next: { rules: readonly RuleLike[]; limited?: boolean; exceptions?: readonly string[] }): RuleSet {
    const w = this.world()
    const limited = next.limited ?? this.limited.has(folder)
    const old = this.byPath.get(folder) ?? []
    const named = new Set(next.rules.filter((r) => r.subjectType === 'user' && r.subjectId).map((r) => r.subjectId!))
    const rows = w.rows.filter((r) => r.path !== folder)
    for (const r of next.rules) {
      const was = old.find((o) => o.subject_type === r.subjectType && o.subject_id === r.subjectId && o.access === r.access)
      rows.push({ path: folder, subject_type: r.subjectType as SubjectType, subject_id: r.subjectId, access: r.access as Access, origin: r.origin !== undefined ? r.origin : (was?.origin ?? null) })
    }
    for (const r of old) {
      if (r.subject_type === 'role' && r.subject_id === 'admin' && r.access === 'write' && !next.rules.some(isManagedMarker)) rows.push({ path: folder, subject_type: 'role', subject_id: 'admin', access: 'write' })
      if (!next.exceptions && isProjectException(folder, { subjectType: r.subject_type, subjectId: r.subject_id, access: r.access }) && !named.has(r.subject_id!)) rows.push({ path: folder, subject_type: 'user', subject_id: r.subject_id, access: 'none' })
    }
    // (`exceptions` given: the folder's project exceptions are exactly these)
    if (next.exceptions && isZoneTop(folder)) for (const id of next.exceptions) if (!named.has(id)) rows.push({ path: folder, subject_type: 'user', subject_id: id, access: 'none' })
    if (limited && !next.rules.some((r) => r.subjectType === 'everyone' && r.access !== 'none')) rows.push({ path: folder, subject_type: 'everyone', subject_id: null, access: 'none' })
    const lim = new Set(w.limited)
    if (limited) lim.add(folder)
    else lim.delete(folder)
    return new RuleSet({ rows, limited: lim, guests: w.guests })
  }
  /** This set with a project exception for `userId` on projects/<name> (`folder`), as setProjectException stores it:
   * their own rule there becomes "no access". */
  excepting(folder: string, userId: string): RuleSet {
    if (!isZoneTop(folder)) throw new Error('excepting: not a projects/<name> folder')
    const w = this.world()
    const rows = w.rows.filter((r) => !(r.path === folder && r.subject_type === 'user' && r.subject_id === userId))
    rows.push({ path: folder, subject_type: 'user', subject_id: userId, access: 'none' })
    return new RuleSet({ rows, limited: w.limited, guests: w.guests })
  }
  /** This set after `from` moves to `to`: the rows and limits at or below it go with it (team-files relocate moves the
   * folders rows), everything else stays. */
  relocated(from: string, to: string): RuleSet {
    const move = (p: string) => (p === from ? to : from === '' || p.startsWith(from + '/') ? to + p.slice(from.length) : p)
    const w = this.world()
    return new RuleSet({ rows: w.rows.map((r) => ({ ...r, path: move(r.path) })), limited: w.limited.map(move), guests: w.guests })
  }
  /** The rules as if a trashed folder were back: its parked rows (under `storage`) at `original`, and none of a folder
   * that took that path since (as chat/shared.ts rulesInPlace builds them from the database). */
  parkedInPlace(storage: string, original: string): RuleSet {
    const map = inPlace(storage, original)
    const w = this.world()
    const rows: RuleRow[] = []
    for (const r of w.rows) { const p = map(r.path); if (p !== null) rows.push({ ...r, path: p }) }
    const limited: string[] = []
    for (const f of w.limited) { const p = map(f); if (p !== null) limited.push(p) }
    return new RuleSet({ rows, limited, guests: w.guests })
  }

  access(p: Principal, segs: readonly string[]): Access { return this.decide(p, segs, null) }

  /** access() and the reason for it, from the same computation (admin screens: "why can this person see this?") */
  explain(p: Principal, segs: readonly string[]): Explained {
    const why: Why = { kind: 'no-rule', folderLen: 0, cutLen: -1, rules: null, best: 0 }
    const access = this.decide(p, segs, why)
    if (why.kind === 'no-rule') return { access, reason: why.cutLen >= 0 ? { kind: 'no-rule', cutAt: segs.slice(0, why.cutLen).join('/') } : { kind: 'no-rule' } }
    if (why.kind === 'left') return { access, reason: { kind: 'left', folder: segs.slice(0, 2).join('/') } }
    if (why.kind !== 'rule') return { access, reason: { kind: why.kind } }
    const who = why.who ?? p
    const top = why.rules!.filter((r) => r.access !== 'none' && applies(r, who) && RANK[r.access] === why.best)
    const tier = TIERS[Math.min(...top.map((r) => TIER[r.subject_type]))]!
    const rules = top.filter((r) => r.subject_type === tier)
      .map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, access: r.access }))
      .sort((a, b) => String(a.subjectId ?? '').localeCompare(String(b.subjectId ?? '')))
    return { access, reason: { kind: 'rule', folder: segs.slice(0, why.folderLen).join('/'), tier, rules } }
  }

  /** A guest by id (users.guest = 1 when the set was loaded) or by role. */
  isGuest(p: Pick<Principal, 'id' | 'role'>): boolean { return p.role === 'guest' || this.guests.has(p.id) }

  /** The person is kept out of the project folder `segs` is in by a project exception. */
  private excepted(id: string, segs: readonly string[]): boolean {
    if (!this.exceptions.size || !inProjectZone(segs)) return false
    return !!this.exceptions.get(segs.slice(0, 2).join('/'))?.has(id)
  }

  /** THE resolution. Both access() and explain() come from here, so the answer and its reason never drift apart. */
  private decide(p: Principal, segs: readonly string[], why: Why | null): Access {
    if (segs.length && segs[0] === PRODUCT.systemDir) { if (why) why.kind = 'system'; return 'none' }
    for (let i = 0; i < segs.length; i++) if (segs[i]!.startsWith(PRODUCT.tmpPrefix)) { if (why) why.kind = 'temp'; return 'none' }
    // users/<id>/ (tab 2 rules 2-3): the person's own folder is always write; anyone else's is none for every role,
    // owner and admin included, and rules there are ignored (the admin API refuses them; a moved folder or a
    // restored backup could still bring one in).
    if (segs[0] === 'users' && segs.length >= 2) {
      const own = segs[1] === p.id
      if (why) why.kind = own ? 'own-personal' : 'other-personal'
      return own ? 'write' : 'none'
    }
    // users/ itself only holds the personal folders: nobody writes there directly (no files beside the folders, no
    // folder for a person who does not exist yet, no renaming or trashing the whole tree)
    if (segs.length === 1 && segs[0] === 'users') { if (why) why.kind = 'users-root'; return 'read' }
    if (p.system) { if (why) why.kind = 'owner-admin'; return 'write' }
    // a guest: nothing outside the members-only zone (shared/, skills/, connected/, every team folder, whatever rule
    // names them); inside it only person rules at or below projects/<name>, and below it only once they read
    // projects/<name> itself (docs/DECISIONS.md "Guests: only what they were invited to")
    if (this.isGuest(p)) {
      if (!inProjectZone(segs)) { if (why) why.kind = 'no-rule'; return 'none' }
      if (segs.length > ZONE_FLOOR && !atLeast(this.decide(p, segs.slice(0, ZONE_FLOOR), null), 'read')) {
        if (why) this.decide(p, segs.slice(0, ZONE_FLOOR), why)
        return 'none'
      }
    }
    // the owner and admins: everything outside the members-only zone; inside it they are judged as a member, by the
    // rules at or below projects/<name> only (docs/DECISIONS.md "Project contents only for members")
    const guest = this.isGuest(p)
    const staff = !guest && (p.role === 'owner' || p.role === 'admin')
    if (staff && !inProjectZone(segs)) { if (why) why.kind = 'owner-admin'; return 'write' }
    // and inside a project only once they read the project's own folder (are its members): a rule on a folder inside it
    // never lets them in alone, so nobody reads part of a project without showing in its members (security review M2)
    if (staff && segs.length > ZONE_FLOOR && !atLeast(this.decide(p, segs.slice(0, ZONE_FLOOR), null), 'read')) {
      if (why) this.decide(p, segs.slice(0, ZONE_FLOOR), why)
      return 'none'
    }
    const q = guest ? guestSubject(p) : staff ? zoneSubject(p) : p
    const floor = staff || guest ? ZONE_FLOOR : 0
    if (why) why.who = q
    // the project exception: a person's own "no access" on projects/<name> keeps them out of it and all in it, whatever
    // else applies (docs/DECISIONS.md "Leaving a project"; it depends on the rule row only)
    if (this.excepted(q.id, segs)) { if (why) why.kind = 'left'; return 'none' }
    // every rule that applies on the way up, up to and including the nearest limited folder, adds up: the widest wins
    // (on a tie the nearest folder is named). The key of each level is the joined path cut after its first `len`
    // names: the same string as segs.slice(0, len).join('/')
    const full = segs.join('/')
    let end = full.length
    let best = -1
    for (let len = segs.length; len >= floor; len--) {
      if (len < segs.length) end -= segs[len]!.length + (len > 0 ? 1 : 0)
      const key = end === full.length ? full : full.slice(0, end)
      const rules = this.byPath.get(key)
      if (rules) {
        const g = grantIn(rules, q)
        if (g > best) { best = g; if (why) { why.folderLen = len; why.rules = rules; why.best = g } }
      }
      if (this.limited.has(key)) { if (why && best < 0) why.cutLen = len; break }
    }
    if (best < 0) { if (why) why.kind = 'no-rule'; return 'none' }
    if (why) why.kind = 'rule'
    return BY_RANK[best]!
  }

  /** true when something strictly below `segs` is readable (so the folder may be listed for navigation) */
  hasVisibleDescendant(p: Principal, segs: readonly string[]): boolean {
    if (segs.length && segs[0] === PRODUCT.systemDir) return false
    if (segs[0] === 'users') {
      if (segs.length === 1) return true // own personal folder below
      return segs[1] === p.id
    }
    if (p.system || (isStaff(p) && !this.isGuest(p) && !inProjectZone(segs))) return true
    const cands = [...this.boundaryFolders().map((f) => (f === '' ? [] : f.split('/'))).filter((c) => c[0] !== 'users'), ['users', p.id]]
    for (const c of cands) {
      if (c.length > segs.length && segs.every((s, i) => s === c[i]) && atLeast(this.access(p, c), 'read')) return true
    }
    return false
  }
  canList(p: Principal, segs: readonly string[]) { return atLeast(this.access(p, segs), 'read') || this.hasVisibleDescendant(p, segs) }

  /**
   * canList() of one person for many paths at once (admin answers): the folders hasVisibleDescendant() looks at
   * (boundary folders outside users/, and the person's own users/<id>) are tried once, strictly below `within`; each path
   * at or below `within` then looks up the readable ones below it instead of trying them all again. `listable(segs)`
   * equals canList(p, segs) (tests/unit/access-explain-equivalence.test.ts). `via(segs, max, shown)`: the readable
   * folders strictly below segs that no other readable one below segs contains (why a folder without access shows in
   * the tree), by path, at most `max`, and whether there are more. `shown` only decides which of them may be named (the
   * person's own users/<id> always may): listable() does not look at it.
   */
  listing(p: Principal, within: readonly string[] = []): Listing {
    const readable = new Set<string>()
    const below = new Map<string, string[][]>()
    const cands = this.candidatesBelow(within)
    const own = ['users', p.id]
    for (const c of own.length > within.length && within.every((s, i) => s === own[i]) ? [...cands, own] : cands) {
      if (!atLeast(this.access(p, c), 'read')) continue
      readable.add(c.join('/'))
      for (let k = within.length; k < c.length; k++) {
        const key = c.slice(0, k).join('/')
        const list = below.get(key)
        if (list) list.push(c)
        else below.set(key, [c])
      }
    }
    const listable = (segs: readonly string[]): boolean => {
      if (atLeast(this.access(p, segs), 'read')) return true
      if (segs.length && segs[0] === PRODUCT.systemDir) return false
      if (segs[0] === 'users') return segs.length === 1 || segs[1] === p.id
      if (p.system || (isStaff(p) && !this.isGuest(p) && !inProjectZone(segs))) return true
      return below.has(segs.join('/'))
    }
    const ownPath = own.join('/')
    const via = (segs: readonly string[], max: number, shown: (path: string) => boolean = () => true) => {
      const top = (below.get(segs.join('/')) ?? []).filter((c) => {
        for (let k = segs.length + 1; k < c.length; k++) if (readable.has(c.slice(0, k).join('/'))) return false
        return true
      }).map((c) => c.join('/')).filter((f) => f === ownPath || shown(f)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      return { folders: top.slice(0, max), more: top.length > max }
    }
    return { listable, via, at: (segs, max, shown) => { const ok = listable(segs); const v = ok ? via(segs, max, shown) : { folders: [], more: false }; return { listable: ok, via: v.folders, more: v.more } } }
  }

  /**
   * listing().at(within, max) for one folder and many people (the admin folder answer), without trying every folder
   * below it for every person: the boundary folders below are taken in path order with their rule chains (up to the
   * nearest limited folder), a folder below a readable one is not tried (it cannot be the topmost readable, and the
   * folder is listable already), the scan stops after max + 1, and people no rule can tell apart share one scan (same
   * role and groups, and the same person rules and project exceptions naming them: people named the same way at the same
   * folders, the company-by-name case, share it too). The decision on each folder is grantIn() folded up to the limit,
   * as in access(). Same answer as listing() and canList() (tests/unit/access-explain-equivalence.test.ts). `shown`: as
   * for listing().via (a readable folder it refuses still makes the folder listable and still covers what is below it,
   * but is not named).
   */
  navigator(within: readonly string[], max: number, shown: (path: string) => boolean = () => true): (p: Principal) => Navigation {
    const items = this.candidatesBelow(within).map((segs) => ({ segs, path: segs.join('/') })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const index = new Map(items.map((it, i) => [it.path, i]))
    // the nearest candidate above each one, still below `within` (-1: none)
    const parent = items.map((it) => {
      for (let k = it.segs.length - 1; k > within.length; k--) { const j = index.get(it.segs.slice(0, k).join('/')); if (j !== undefined) return j }
      return -1
    })
    // the rule lists from the folder up to the nearest limited folder (null: .system/ or a temp name, readable by nobody)
    const chainsFrom = (floor: number) => items.map((it) => {
      if (it.segs[0] === PRODUCT.systemDir || it.segs.some((s) => s.startsWith(PRODUCT.tmpPrefix))) return null
      const out: Rule[][] = []
      for (let len = it.segs.length; len >= floor; len--) {
        const key = it.segs.slice(0, len).join('/')
        const r = this.byPath.get(key)
        if (r) out.push(r)
        if (this.limited.has(key)) break
      }
      return out
    })
    const zoneKey = items.map((it) => (inProjectZone(it.segs) ? it.segs.slice(0, 2).join('/') : null))
    const chains = chainsFrom(0)
    // the owner and admins inside the members-only zone: only the rules at or below projects/<name> (decide())
    let zoneChains: ReturnType<typeof chainsFrom> | null = null
    // what tells two people with the same role and groups apart: the person rules and project exceptions naming them
    const sig = new Map<string, string[]>()
    for (const [path, list] of this.byPath) for (const r of list) {
      if (r.subject_type !== 'user' || r.subject_id === null) continue
      const s = sig.get(r.subject_id) ?? []
      s.push(`${path}\u0000${r.access}`)
      sig.set(r.subject_id, s)
    }
    const sigOf = new Map<string, string>()
    for (const [id, s] of sig) sigOf.set(id, s.sort().join('\u0001'))
    const shown_ = items.map((it) => shown(it.path))
    const shared = new Map<string, { any: boolean; top: string[] }>()
    const scan = (p: Principal, zone: boolean) => {
      const named = sigOf.get(p.id)
      const key = `${zone ? 'zone\u0000' : ''}${p.role === 'guest' ? `guest\u0000${p.id}\u0000` : ''}${p.role}\u0000${[...new Set(p.groups)].sort().join('\u0001')}${named !== undefined ? `\u0000${named}` : ''}`
      const known = shared.get(key)
      if (known) return known
      const ch = zone ? (zoneChains ??= chainsFrom(ZONE_FLOOR)) : chains
      const top: string[] = []
      let any = false
      const readable = new Uint8Array(items.length)
      for (let i = 0; i < items.length && top.length <= max; i++) {
        let a = parent[i]!, covered = false
        while (a >= 0) { if (readable[a]) { covered = true; break } a = parent[a]! }
        if (covered) continue
        const chain = ch[i]
        if (!chain) continue
        const zk = zoneKey[i]
        if (p.role === 'guest' && (zk === null || !atLeast(this.access(p, items[i]!.segs.slice(0, ZONE_FLOOR)), 'read'))) continue
        if (zk !== null && this.exceptions.get(zk)?.has(p.id)) continue
        let rank = -1
        for (const rules of chain) { const g = grantIn(rules, p); if (g > rank) rank = g }
        if (rank >= RANK.read) { readable[i] = 1; any = true; if (shown_[i]) top.push(items[i]!.path) }
      }
      const r = { any, top }
      shared.set(key, r)
      return r
    }
    return (p) => {
      if (atLeast(this.access(p, within), 'read')) return { listable: true, via: [], more: false }
      if (within.length && within[0] === PRODUCT.systemDir) return { listable: false, via: [], more: false }
      if (within[0] === 'users') return within.length === 1 ? { listable: true, via: [`users/${p.id}`], more: false } : { listable: within[1] === p.id, via: [], more: false }
      if (p.system) return { listable: true, via: [], more: false }
      if (this.isGuest(p)) {
        // a guest: nothing outside the zone but their own users/<id>; inside, person rules only (decide())
        // (the root and projects/ itself only show the way to their project)
        if (within.length && !inProjectZone(within) && !isProjectsTop(within)) return { listable: false, via: [], more: false }
        if (inProjectZone(within) && !atLeast(this.access(p, within.slice(0, ZONE_FLOOR)), 'read')) return { listable: false, via: [], more: false }
        const found = scan(guestSubject(p), true)
        const top = [...found.top]
        if (within.length === 0) {
          const own = `users/${p.id}`
          let i = 0
          while (i < top.length && top[i]! < own) i++
          top.splice(i, 0, own)
        }
        return { listable: found.any || within.length === 0, via: top.slice(0, max), more: top.length > max }
      }
      const zone = isStaff(p) && inProjectZone(within)
      if (isStaff(p) && !zone) return { listable: true, via: [], more: false }
      // (inside a project they do not read, nothing is readable for them: decide())
      if (zone && !atLeast(this.access(p, within.slice(0, ZONE_FLOOR)), 'read')) return { listable: false, via: [], more: false }
      const found = scan(zone ? zoneSubject(p) : p, zone)
      const top = [...found.top]
      // the person's own users/<id> is below the team root, readable and topmost (nothing above it is a candidate)
      if (within.length === 0) {
        const own = `users/${p.id}`
        let i = 0
        while (i < top.length && top[i]! < own) i++
        top.splice(i, 0, own)
      }
      return { listable: found.any || within.length === 0, via: top.slice(0, max), more: top.length > max }
    }
  }
  /** boundary folders outside users/ strictly below `within`, as segments (kept per `within` for the next person) */
  private candidatesBelow(within: readonly string[]): string[][] {
    const key = within.join('/')
    let c = this.candidates.get(key)
    if (!c) {
      c = this.boundaryFolders().map((f) => (f === '' ? [] : f.split('/')))
        .filter((s) => s[0] !== 'users' && s.length > within.length && within.every((w, i) => w === s[i]))
      this.candidates.set(key, c)
    }
    return c
  }
  private candidates = new Map<string, string[][]>()
}

export interface Navigation { listable: boolean; via: string[]; more: boolean }
export interface Listing {
  listable(segs: readonly string[]): boolean
  via(segs: readonly string[], max: number, shown?: (path: string) => boolean): { folders: string[]; more: boolean }
  /** listable(segs), and via(segs, max, shown) when it is */
  at(segs: readonly string[], max: number, shown?: (path: string) => boolean): Navigation
}

/** One folder's rules for a person: -1 when no rule with access applies, else the rank of the widest applying access
 * ("no access" rows add nothing). decide() and navigator() both use it. */
export function grantIn(rules: readonly Pick<Rule, 'subject_type' | 'subject_id' | 'access'>[], p: Principal): number {
  let best = -1
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!
    if (r.access === 'none' || !applies(r, p)) continue
    const k = RANK[r.access]
    if (k > best) best = k
  }
  return best
}

export function applies(r: Pick<Rule, 'subject_type' | 'subject_id'>, p: Pick<Principal, 'id' | 'role' | 'groups'>): boolean {
  // a guest: person rules only (everyone, role and group rules never apply to them)
  if (p.role === 'guest') return r.subject_type === 'user' && r.subject_id === p.id
  switch (r.subject_type) {
    case 'everyone': return true
    case 'role': return r.subject_id === p.role
    case 'group': return r.subject_id !== null && p.groups.includes(r.subject_id)
    case 'user': return r.subject_id === p.id
  }
}
