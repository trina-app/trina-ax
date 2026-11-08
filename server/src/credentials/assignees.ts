// Who a team AI connection is for, when a group or a person it names is deleted (docs/DECISIONS.md "What a deleted
// member or group leaves behind"). A team connection with any assignment serves only the people and groups it names
// (resolve.ts candidates); one with none serves the whole team. So the rows of a deleted group or person go, and a
// connection that would be left with none is switched off instead: it must never start serving everyone (a paid key
// for one group would suddenly be the whole team's). It is also marked (meta.assigneesGone): switching it on again is
// refused until someone chooses who uses it, so no later click gives it to everyone either. Migration 117 did the same
// for rows older builds left behind.
import type { Database } from 'bun:sqlite'
import { audit } from '../admin/audit'
import { engineStatusCache } from '../admin/engines'
import type { AppContext } from '../context'
import { ASSIGNEES_GONE as MARK, credentialsOf, noticeOwners } from './store'

/** An assignment whose group or person is gone (the group row deleted; the person deleted, or never there). */
const DEAD = `((engine_credential_assignments.subject_type = 'group' AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = engine_credential_assignments.subject_id))
  OR (engine_credential_assignments.subject_type = 'user' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = engine_credential_assignments.subject_id AND u.deleted_at IS NULL)))`

/** A team connection that lost assignments: its id and label, and whether this switched it off. */
export interface Pruned { id: string; label: string; switchedOff: boolean }

/**
 * Inside a delete transaction, after the group row is deleted or the person tombstoned: every assignment whose group or
 * person is gone is removed, and a team connection left with none is switched off (`disabled`). One Activity log line
 * per connection changed (`credential.update`, reason `assignees_deleted`). Returns those connections.
 */
export function pruneAssignments(db: Database, actor: string | null, now: string): Pruned[] {
  const dead = db.query(`SELECT credential_id, subject_type, subject_id FROM engine_credential_assignments WHERE ${DEAD} ORDER BY credential_id, subject_type, subject_id`)
    .all() as { credential_id: string; subject_type: 'group' | 'user'; subject_id: string }[]
  if (!dead.length) return []
  const out: Pruned[] = []
  for (const id of [...new Set(dead.map((d) => d.credential_id))]) {
    const row = db.query('SELECT label, disabled, owner_user_id FROM engine_credentials WHERE id = ?').get(id) as { label: string; disabled: number; owner_user_id: string | null } | null
    if (!row) continue
    const before = db.query('SELECT subject_type AS subjectType, subject_id AS subjectId FROM engine_credential_assignments WHERE credential_id = ? ORDER BY subject_type, subject_id').all(id) as { subjectType: string; subjectId: string }[]
    const gone = new Set(dead.filter((d) => d.credential_id === id).map((d) => `${d.subject_type}:${d.subject_id}`))
    const after = before.filter((a) => !gone.has(`${a.subjectType}:${a.subjectId}`))
    // (a member's own connection never has assignments: it is only its holder's either way). One already off is marked
    // too: switching it on later must not be the one click that gives it to everyone
    const orphaned = !after.length && row.owner_user_id === null
    const switchedOff = orphaned && !row.disabled
    if (orphaned) db.query(`UPDATE engine_credentials SET disabled = 1, meta = ${MARK}, updated_at = ? WHERE id = ?`).run(now, id)
    out.push({ id, label: row.label, switchedOff })
    audit(db, { actor, action: 'credential.update', target: id, detail: {
      changed: switchedOff ? ['disabled', 'assignments'] : ['assignments'], reason: 'assignees_deleted', assignmentsBefore: before, assignmentsAfter: after,
    } })
  }
  db.query(`DELETE FROM engine_credential_assignments WHERE ${DEAD}`).run()
  return out
}

/** Open composers ask GET /api/engines again (the same notice as the AI connection routes send). */
const ENGINES_CHANGED = { type: 'notice', data: { level: 'info', code: 'engine_choice_changed', message: '' } } as const

/**
 * After the delete is written: connections it switched off are told to the owner when an admin deleted (as any
 * admin's switch-off is, store.ts noticeOwners), and the engines' state is read again. Never throws.
 */
export function afterPrune(ctx: AppContext, actor: string, pruned: readonly Pruned[]): void {
  const off = pruned.filter((p) => p.switchedOff)
  if (!off.length) return
  try {
    const cc = credentialsOf(ctx)
    for (const p of off) noticeOwners(cc, actor, 'disabled', p.label)
    const cache = engineStatusCache(ctx)
    cache.forget('claude-code'); cache.forget('codex')
    ctx.services.realtime.publishEach(() => ENGINES_CHANGED)
  } catch (e) { ctx.log.warn('could not tell about AI connections switched off by a delete', { err: e }) }
}
