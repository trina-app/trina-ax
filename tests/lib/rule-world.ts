// A RuleSet from rule rows, for tests (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)"). The server
// builds every RuleSet with RuleSet.fromDb; tests build worlds by hand with RuleSet.fromWorld. `limited` defaults to
// the folders that carry the legacy marker "everyone: none" (the cut a world written before P2 meant by it).
import { RuleSet, type RuleRow } from '../../server/src/policy/access'

export type { RuleRow }
export function ruleWorld(rows: readonly RuleRow[], limited?: Iterable<string>): RuleSet {
  return RuleSet.fromWorld({ rows, limited: limited ?? rows.filter((r) => r.subject_type === 'everyone' && r.access === 'none').map((r) => r.path) })
}
