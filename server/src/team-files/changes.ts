// files.changed events (tab 4): each person gets only the changes to paths they can read. A move is shown as a
// move to someone who sees both ends, as a delete / create to someone who sees only one end.
import type { FileChange, ServerEventInput } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { atLeast, loadPrincipal, RuleSet, type Principal } from '../policy/access'

const segs = (p: string) => (p === '' ? [] : p.split('/'))

export function visibleChanges(rules: RuleSet, user: Principal, changes: FileChange[]): FileChange[] {
  const can = (p: string) => atLeast(rules.access(user, segs(p)), 'read')
  const out: FileChange[] = []
  for (const ch of changes) {
    if (ch.action === 'move' && ch.from !== undefined) {
      const a = can(ch.from), b = can(ch.path)
      if (a && b) out.push(ch)
      else if (a) out.push({ path: ch.from, action: 'delete', by: ch.by, turnId: ch.turnId })
      else if (b) out.push({ path: ch.path, action: 'create', by: ch.by, turnId: ch.turnId })
    } else if (can(ch.path)) out.push(ch)
  }
  return out
}

/** Publish a batch of changes through the realtime hub (component B), filtered per person. */
export function publishChanges(ctx: AppContext, changes: FileChange[]) {
  if (!changes.length) return
  const rules = RuleSet.load(ctx.db)
  const people = new Map<string, Principal | null>()
  try {
    ctx.services.realtime.publishEach((userId): ServerEventInput | null => {
      if (!people.has(userId)) people.set(userId, loadPrincipal(ctx.db, userId))
      const p = people.get(userId)
      if (!p) return null
      const mine = visibleChanges(rules, p, changes)
      return mine.length ? { type: 'files.changed', data: { changes: mine } } : null
    })
  } catch (e) {
    ctx.log.warn('files.changed publish failed', { err: e })
  }
}
