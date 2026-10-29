// files.changed events (tab 4): each person gets only the changes to paths they can read. A move is shown as a
// move to someone who sees both ends, as a delete / create to someone who sees only one end.
//
// What a path is judged by: the place something LEFT (a move's `from`, a delete) by the rules as they were before the
// change, the place something ARRIVED (a move's `path`, create / update / restore) by the rules after it. A folder's
// own rules travel with it (folders.path follows a move, and is parked under the trash path on delete), so judged
// after the change the old path of a restricted folder falls back to its parent's rule ("shared: everyone write")
// and its name went out to every member it was hidden from.
import type { FileChange, ServerEventInput } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { atLeast, loadPrincipal, RuleSet, type Principal } from '../policy/access'

const segs = (p: string) => (p === '' ? [] : p.split('/'))

/** `before`: the rules as they were before the change (default: the same as `rules`, for changes that move no rules). */
export function visibleChanges(rules: RuleSet, user: Principal, changes: FileChange[], before: RuleSet = rules): FileChange[] {
  const can = (r: RuleSet, p: string) => atLeast(r.access(user, segs(p)), 'read')
  const out: FileChange[] = []
  for (const ch of changes) {
    if (ch.action === 'move' && ch.from !== undefined) {
      const a = can(before, ch.from), b = can(rules, ch.path)
      if (a && b) out.push(ch)
      else if (a) out.push({ path: ch.from, action: 'delete', by: ch.by, turnId: ch.turnId })
      else if (b) out.push({ path: ch.path, action: 'create', by: ch.by, turnId: ch.turnId })
    } else if (ch.action === 'delete') {
      if (can(before, ch.path)) out.push(ch)
    } else if (can(rules, ch.path)) out.push(ch)
  }
  return out
}

/**
 * Publish a batch of changes through the realtime hub (component B), filtered per person. `before`: the rules loaded
 * before a change that moved folders rows (move, trash); without it the current rules judge both ends.
 */
export function publishChanges(ctx: AppContext, changes: FileChange[], before?: RuleSet) {
  if (!changes.length) return
  ctx.files.events.emit('hwp-invalidate')
  const rules = RuleSet.load(ctx.db)
  const people = new Map<string, Principal | null>()
  try {
    ctx.services.realtime.publishEach((userId): ServerEventInput | null => {
      if (!people.has(userId)) people.set(userId, loadPrincipal(ctx.db, userId))
      const p = people.get(userId)
      if (!p) return null
      const mine = visibleChanges(rules, p, changes, before ?? rules)
      return mine.length ? { type: 'files.changed', data: { changes: mine } } : null
    })
  } catch (e) {
    ctx.log.warn('files.changed publish failed', { err: e })
  }
}
