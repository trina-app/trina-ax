// Who started to see a team project (docs/DECISIONS.md "Project contents only for members"): every change that lets
// someone read a project in projects/ (an owner or admin adding themselves, someone added to one of its groups, a new
// account made in one of its groups, a change of its members) leaves an audit row `project.member_gained` (the
// project, the person, how: `via`, and `self` when they did it themselves) and one quiet inbox notice to the project's
// members, "{who} joined '{name}'" (notifications/service.ts project.joined). So nobody, an admin included, reads a
// project without its members being told and the activity log saying so (security review M5).
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { atLeast, inProjectZone, RuleSet, type Principal } from '../policy/access'
import { notificationsOf } from '../notifications/service'

/** The rules as if a trashed folder were back: its parked rules (under its trash storage path) at its old path, and no
 * rules of a folder that took that path since (as chat/shared.ts rulesInPlace builds them from the database). */
function parkedInPlace(rules: RuleSet, storage: string, original: string): RuleSet {
  const rows: ConstructorParameters<typeof RuleSet>[0] = []
  const under = (f: string, base: string) => f === base || f.startsWith(base + '/')
  for (const f of rules.ruleFolders()) {
    if (under(f, original)) continue
    const path = under(f, storage) ? original + f.slice(storage.length) : f
    for (const r of rules.rulesAt(f)) rows.push({ path, subject_type: r.subjectType, subject_id: r.subjectId, access: r.access })
  }
  return new RuleSet(rows)
}

/** What projectJoins compares: the active people (with groups) and the rules, as admin/folders.ts captureState holds them. */
export interface JoinState { principals: readonly Principal[]; rules: RuleSet }

/**
 * Record who started to read each live team project in projects/ between `before` (null: nobody read anything, a new
 * account) and `after`. `by.actor`: who made the change; `by.via`: what it was (project, group, account, role, rules).
 * Never throws: the change is saved already.
 */
export function projectJoins(ctx: AppContext, before: JoinState | null, after: JoinState, by: { actor: string | null; via: string; only?: ReadonlySet<string> }): void {
  try {
    // projects in place, and those whose folder is in the trash (not purged): judged as if their folder were back (its
    // parked rules at its old path), so a join made while it is in the trash is recorded then, not lost at the restore
    // (security review M1)
    const projects = ctx.db.query(`SELECT p.id, p.name, p.folder_path, t.original_path, t.storage_path FROM projects p
      LEFT JOIN trash_items t ON t.id = p.trashed_with AND t.restored_at IS NULL
      WHERE p.folder_path LIKE 'projects/%' AND (p.trashed_with IS NULL OR t.id IS NOT NULL)`).all() as { id: string; name: string; folder_path: string; original_path: string | null; storage_path: string | null }[]
    for (const pr of projects) {
      const segs = pr.folder_path.split('/')
      if (segs.length !== 2 || !inProjectZone(segs)) continue
      const inPlace = (s: JoinState): RuleSet => (pr.storage_path && pr.original_path ? parkedInPlace(s.rules, pr.storage_path, pr.original_path) : s.rules)
      const sets = new Map<JoinState, RuleSet>()
      const reads = (s: JoinState, p: Principal) => { let r = sets.get(s); if (!r) sets.set(s, (r = inPlace(s))); return atLeast(r.access(p, segs), 'read') }
      const was = new Set(before ? before.principals.filter((p) => reads(before, p)).map((p) => p.id) : [])
      const now = after.principals.filter((p) => reads(after, p))
      const gained = now.filter((p) => !was.has(p.id) && (!by.only || by.only.has(p.id)))
      if (!gained.length) continue
      for (const g of gained) {
        const id = audit(ctx.db, { actor: by.actor, action: 'project.member_gained', target: pr.id, detail: { projectId: pr.id, userId: g.id, via: by.via, ...(by.actor === g.id ? { self: true } : {}) } })
        // its members (who saw it before; not the person, not who made the change: they know)
        for (const m of now) {
          if (m.id === g.id || m.id === by.actor || !was.has(m.id)) continue
          try { notificationsOf(ctx).projectJoined(m.id, String(id)) } catch { ctx.log.warn('project join notice failed') }
        }
      }
    }
  } catch (e) { ctx.log.warn('project joins not recorded', { err: e }) }
}

/** A new account (made by an admin, from an invite or the team link) that sees team projects through its groups: the
 * same trail as any other join. Call after the account and its groups are written. */
export function projectJoinsOfNewAccount(ctx: AppContext, userId: string, actor: string | null, now: JoinState): void {
  projectJoins(ctx, { principals: now.principals.filter((p) => p.id !== userId), rules: now.rules }, now, { actor, via: 'account', only: new Set([userId]) })
}
