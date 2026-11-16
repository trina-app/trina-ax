// The chips of the computer's 활동 list (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1;
// panels/ActivityPanel.tsx): 전체 · 트리나 · 요청. 활동 holds only the notices that are not conversations (mentions and
// thread replies are in 대화's 멘션·스레드), so the chips sort what is left:
// - 트리나: what the AI did for me on its own: a scheduled task's run, a project's job.
// - 요청: something waits for my answer or my hand: a review of a suggested skill, an ask to add an app or to connect the
//   AI, an ask to delete an account, a connection or a shared Drive to sign in to again, skills to merge, an ask to open a
//   file of mine. Shown to the owner and admins, and to a member while an ask to open a file of theirs is listed (their
//   other few asks stay under 전체).
// - anything else (someone joined, a project I was added to, a change to the team's AI…) is under 전체 only.
import type { InboxNotification } from '@mycel/shared/api'

export type ActivityChip = 'all' | 'trina' | 'requests'

const TRINA: readonly string[] = ['schedule.success', 'schedule.failure', 'dev_env.job', 'dev_env.box']
const REQUESTS: readonly string[] = ['skill.suggested', 'integration.request', 'onboarding.ai_request', 'service.request', 'account.deletion_request', 'drive.share_reconnect', 'integration.template_reconnect', 'connection.reconnect', 'skills.merge_waiting', 'file.access_requested']
/** asks that reach members too (someone asked to open a file of theirs: QA TC-3093): their 요청 chip shows while one is listed */
const EVERYONE_REQUESTS: readonly string[] = ['file.access_requested']

/** the chip a notice belongs to besides 전체 (null: 전체 only) */
export function chipOf(item: Pick<InboxNotification, 'code' | 'templateLeft'>): Exclude<ActivityChip, 'all'> | null {
  if (TRINA.includes(item.code)) return 'trina'
  // a team template that is no longer for me: nothing to do (QA TC-2980)
  if (item.templateLeft) return null
  if (REQUESTS.includes(item.code)) return 'requests'
  return null
}

/** the chips a person sees: 요청 for the owner and admins, and for a member while an ask to open a file of theirs is
 * listed (`items`) */
export const chipsFor = (admin: boolean, items: readonly Pick<InboxNotification, 'code'>[] = []): readonly ActivityChip[] =>
  (admin || items.some((x) => EVERYONE_REQUESTS.includes(x.code)) ? ['all', 'trina', 'requests'] : ['all', 'trina'])

export const inChip = (item: Pick<InboxNotification, 'code' | 'templateLeft'>, chip: ActivityChip) => chip === 'all' || chipOf(item) === chip

/** Unread first (newest first among them), then the read ones (newest first): the list's order. `unread`: whether a
 * row counts as unread here (the list keeps a row read since it showed among the unread ones). */
export function unreadFirst<I extends Pick<InboxNotification, 'readAt' | 'createdAt'>>(items: readonly I[], unread: (item: I) => boolean = (x) => !x.readAt): { unread: I[]; read: I[] } {
  const newest = (a: I, b: I) => b.createdAt.localeCompare(a.createdAt)
  return { unread: items.filter(unread).sort(newest), read: items.filter((x) => !unread(x)).sort(newest) }
}
