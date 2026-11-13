// The chips of the computer's 활동 list (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1;
// panels/ActivityPanel.tsx): 전체 · 트리나 · 요청. 활동 holds only the notices that are not conversations (mentions and
// thread replies are in 대화's 멘션·스레드), so the chips sort what is left:
// - 트리나: what the AI did for me on its own: a scheduled task's run, a project's job.
// - 요청: something waits for my answer or my hand: a review of a suggested skill, an ask to add an app or to connect the
//   AI, an ask to delete an account, a connection or a shared Drive to sign in to again, skills to merge. Shown to the
//   owner and admins only (a member's few asks stay under 전체).
// - anything else (someone joined, a project I was added to, a change to the team's AI…) is under 전체 only.
import type { InboxNotification } from '@mycel/shared/api'

export type ActivityChip = 'all' | 'trina' | 'requests'

const TRINA: readonly string[] = ['schedule.success', 'schedule.failure', 'dev_env.job', 'dev_env.box']
const REQUESTS: readonly string[] = ['skill.suggested', 'integration.request', 'onboarding.ai_request', 'service.request', 'account.deletion_request', 'drive.share_reconnect', 'integration.template_reconnect', 'connection.reconnect', 'skills.merge_waiting']

/** the chip a notice belongs to besides 전체 (null: 전체 only) */
export function chipOf(item: Pick<InboxNotification, 'code'>): Exclude<ActivityChip, 'all'> | null {
  if (TRINA.includes(item.code)) return 'trina'
  if (REQUESTS.includes(item.code)) return 'requests'
  return null
}

/** the chips a person sees: 요청 for the owner and admins */
export const chipsFor = (admin: boolean): readonly ActivityChip[] => (admin ? ['all', 'trina', 'requests'] : ['all', 'trina'])

export const inChip = (item: Pick<InboxNotification, 'code'>, chip: ActivityChip) => chip === 'all' || chipOf(item) === chip

/** Unread first (newest first among them), then the read ones (newest first): the list's order. `unread`: whether a
 * row counts as unread here (the list keeps a row read since it showed among the unread ones). */
export function unreadFirst<I extends Pick<InboxNotification, 'readAt' | 'createdAt'>>(items: readonly I[], unread: (item: I) => boolean = (x) => !x.readAt): { unread: I[]; read: I[] } {
  const newest = (a: I, b: I) => b.createdAt.localeCompare(a.createdAt)
  return { unread: items.filter(unread).sort(newest), read: items.filter((x) => !unread(x)).sort(newest) }
}
