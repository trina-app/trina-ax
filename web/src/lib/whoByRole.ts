// The owner and admins in a count of who sees a folder (docs/DECISIONS.md "Who sees it: the project's own people
// first"): the quiet line after the people who are there by its rules. A number for the owner and admins asking (the
// server's AudienceSplit.byRole), the role words alone without one; never a name.
// Only ordinary team folders (and a project made before outside projects/, whose folder is one of them): a team
// project in projects/ is its members' only, the owner and admins included only as members (docs/DECISIONS.md "Project
// contents only for members"), so no project count has a role part any more.
import type { MessageKey } from '../i18n'

type T = (key: MessageKey, params?: Record<string, string | number>) => string

/** "팀장·관리자 2명도 볼 수 있어요" (`byRole` a number), or null (nobody sees it only by role). */
export function byRoleLine(t: T, byRole: number | undefined): string | null {
  if (!byRole) return null
  return t('folderAccess.byRole', { n: byRole })
}
