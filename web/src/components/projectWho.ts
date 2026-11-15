// Who sees a project, in the words of its page's 멤버 line and its card (docs/DECISIONS.md "Who sees it, always"):
// pages/Projects.tsx and 프로젝트's list (panels/ProjectsPanel.tsx) say it the same way.
import type { Project } from '@mycel/shared/api'
import type { useT } from '../i18n'
import { isProjectsFolder } from '../lib/projectFolders'
import { whoSees } from '../lib/sharedChat'
import { whoSeesText } from './chat/WhoSees'

/** Who sees a project, by the rule of its page's 멤버 line (MembersRow below), for that line and for its card on the list,
 * so the two never differ. `own` words the count of its own people (the owner and admins): beside the 멤버 label just the
 * number ("3명"), on a card with the word ("멤버 3명"). Nothing from a server without the count. */
export function whoSeesProject(t: ReturnType<typeof useT>, p: Project, own: 'projects.membersN' | 'projects.whoMembers'): string | undefined {
  if (p.audience === undefined) return undefined
  // its folder is in the trash: nobody is its member until it comes back, and "남은 멤버 없음" would read as if everyone
  // had left; its card, page and row say "휴지통에 있음" alone (QA TC-1012)
  if (p.inTrash) return undefined
  // a team project in projects/ is its members' (docs/DECISIONS.md "Project contents only for members"): its own count,
  // also for the owner or an admin who is not a member ("남은 멤버 없음" when nobody active is one, "나만 봐요" when I am)
  if (isProjectsFolder(p.folderPath)) return p.audience === 0 ? t('projects.noMembers') : p.member !== false && p.audience === 1 ? t('chat.whoMe') : t(own, { n: p.audience })
  const shared = { audience: p.audience, alone: p.alone }
  return whoSees(shared).kind === 'people' && p.audienceSplit ? t(own, { n: p.audienceSplit.direct }) : whoSeesText(t, shared, 'project')
}
