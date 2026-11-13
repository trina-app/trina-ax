// Where content that some people cannot see came from, as a "confirm" before it reaches more people names it
// ("대화방에 보내기" chat/answer-share.ts): only where the person may look
// themselves (a folder they may read, their own folder, a team connection or shared Drive by its name, a team room by its
// group's name, the everyone room). Never who: a 1:1 or group conversation is never named (its name is people's names).
import type { Database } from 'bun:sqlite'
import type { AnswerSharePlace } from '@mycel/shared/api'
import { getRow } from '../integrations/connections/store'
import { shareRow } from '../integrations/google-drive/shares'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { groupName, roomRow } from '../rooms/store'
import { slackPlaceName, sourceOf, type ReadSource } from './read-scope'

/** The place of one source as `userId` (`me`, their principal now) may be told it, or null: not named. */
export function sharePlaceOf(db: Database, rules: RuleSet, userId: string, me: Principal | null, s: ReadSource): AnswerSharePlace | null {
  /** a team folder ('' = the top), named only when I may read it now myself (a rule changed since: not) */
  const folderPlace = (p: string | undefined): AnswerSharePlace | null => (p !== undefined && me && atLeast(rules.access(me, p === '' ? [] : p.split('/')), 'read') ? { kind: 'folder', path: p } : null)
  switch (s.type) {
    case 'root': return folderPlace('')
    case 'folder': return folderPlace((db.query('SELECT path FROM folders WHERE id = ?').get(s.id) as { path: string } | null)?.path)
    case 'user': return s.id === userId ? { kind: 'mine' } : null
    case 'integration': { const name = getRow(db, s.id)?.name; return name ? { kind: 'service', name } : null }
    case 'drive_share': { const name = shareRow(db, s.id)?.name; return name ? { kind: 'service', name } : null }
    // Slack messages the person read themselves (their own Slack token): named as they saw them (a channel's name)
    case 'slack': return s.userId === userId ? { kind: 'service', name: slackPlaceName(s) } : null
    case 'room': {
      const r = roomRow(db, s.id)
      const team = r?.kind === 'team' ? groupName(db, r) : null
      if (r?.kind === 'all') return { kind: 'room', name: '' }
      if (team) return { kind: 'room', name: team }
      // a 1:1 or group conversation: its name is people's names
      return r?.kind === 'dm' || r?.kind === 'group' ? { kind: 'conversation' } : null
    }
    case 'name': {
      const segs = s.path.split('/').filter(Boolean)
      if (segs[0] === 'users') return segs[1] === userId ? { kind: 'mine' } : null
      const at = sourceOf(db, rules, s.path)
      return at.type === 'name' ? null : sharePlaceOf(db, rules, userId, me, at)
    }
  }
}
