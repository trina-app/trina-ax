// R2-SKILL-03: which skill issues a screen shows (components/SkillIssues.tsx).
import type { SkillIssue } from '@mycel/shared/api'
import type { useT } from '../i18n'
import { isInside, parentPath } from './paths'

/** skills/ (team skills) or a users/<id>/skills/ folder (personal skills; the server lists only the caller's own). */
export const isSkillsPath = (p: string) => p === 'skills' || p.startsWith('skills/') || /^users\/[^/]+\/skills(?:\/|$)/.test(p)
/** The issues for a folder of the Files screen: its own entries and the entries below it. No folder: all of them. */
export const issuesIn = (items: SkillIssue[], folder?: string) => (folder === undefined ? items : items.filter((i) => i.path !== folder && isInside(i.path, folder)))
/** The text of an issue. `name` has one rule for a SKILL.md and another for a legacy file: only a SKILL.md has the
 * strict rule. */
export function issueText(t: ReturnType<typeof useT>, i: SkillIssue): string {
  const legacyName = i.problem === 'name' && !/(?:^|\/)SKILL\.md$/.test(i.path)
  return t(legacyName ? 'skills.issues.name_legacy' : `skills.issues.${i.problem}`, { folder: parentPath(i.path).split('/').pop() ?? '' })
}
