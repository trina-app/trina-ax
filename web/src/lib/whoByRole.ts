// The owner and admins in a count of who sees something (docs/DECISIONS.md "Who sees it: the project's own people
// first"): the quiet line after the people who are there by its rules. A number for the owner and admins asking (the
// server's AudienceSplit.byRole), the role words alone for a member's new project (#304 `adminsApart`); never a name.
// - A folder: always (the owner and admins open every team folder by role).
// - A project: while the owner and admins see every project by role. Every project-side role line (the members dialog,
//   the new-project line, the share switch, a project folder's chip) comes from `byRoleLine(…, 'project')`,
//   so if projects stop being seen by role, PROJECTS_BY_ROLE is the one switch to turn off.
import type { MessageKey } from '../i18n'

type T = (key: MessageKey, params?: Record<string, string | number>) => string

/** The owner and admins see every project by their role: project counts say so apart. */
export const PROJECTS_BY_ROLE = true

/** "팀장·관리자 2명도 볼 수 있어요" (`byRole` a number), "팀장·관리자도 볼 수 있어요" ('any': a member, no number), or null
 * (nobody sees it only by role, or a project while projects are not seen by role). */
export function byRoleLine(t: T, byRole: number | 'any' | undefined, where: 'project' | 'folder'): string | null {
  if (where === 'project' && !PROJECTS_BY_ROLE) return null
  if (!byRole) return null
  if (byRole === 'any') return t('projects.whoByRoleAny')
  return t(where === 'project' ? 'projects.whoByRole' : 'folderAccess.byRole', { n: byRole })
}
