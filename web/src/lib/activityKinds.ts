// The filters of the computer's 활동 list (panels/ActivityPanel.tsx; docs/decisions/20261127-activity-lean.md): one line
// that never wraps, 전체 · 멘션 · 스레드 as chips (VISIBLE_CHIPS) and the others in its "⋯" menu (MORE_CHIPS: DM, 트리나,
// 요청), as Slack keeps most of its filters under "Filters". A filter picked from the menu shows as its own chip before
// "⋯"; a chip the line has no room for moves into the menu (fitChips). 활동 is the one Activity, with every notice
// (docs/decisions/20261126-one-activity.md), as Slack's is:
// - DM, 멘션, 스레드: the conversation rows, by the shared tab rule (activityTabHas), so "Mark all as read" on the server
//   reads the same rows. DM is a direct or group chat's rows (its mentions and its followed threads' replies: a plain
//   message is no notice).
// - 트리나: what the AI did for me on its own: a scheduled task's run, a project's job.
// - 요청: something waits for my answer or my hand: a review of a suggested skill, an ask to add an app or to connect the
//   AI, an ask to delete an account, a connection or a shared Drive to sign in to again, skills to merge, an ask to open a
//   file, chat or project of mine. Shown to the owner and admins, and to a member while an ask to open a file of theirs is listed (their
//   other few asks stay under 전체).
// - anything else (someone joined, a project I was added to, a change to the team's AI…) is under 전체 only.
import { activityTabHas, type ActivityTab, type InboxNotification } from '@mycel/shared/api'

export type ActivityChip = ActivityTab | 'trina' | 'requests'
/** the chips the server can read alone ("Mark all as read" under them) */
export const SERVER_CHIPS: readonly ActivityTab[] = ['all', 'dms', 'mentions', 'threads']
export const isServerChip = (chip: ActivityChip): chip is ActivityTab => (SERVER_CHIPS as readonly string[]).includes(chip)

const TRINA: readonly string[] = ['schedule.success', 'schedule.failure', 'dev_env.job', 'dev_env.box']
const REQUESTS: readonly string[] = ['skill.suggested', 'integration.request', 'onboarding.ai_request', 'service.request', 'account.deletion_request', 'drive.share_reconnect', 'integration.template_reconnect', 'connection.reconnect', 'skills.merge_waiting', 'file.access_requested', 'access.requested']
/** asks that reach members too (someone asked to open a file, a chat or a project of theirs: QA TC-3093, TC-4185,
 * TC-4186): their 요청 chip shows while one is listed */
const EVERYONE_REQUESTS: readonly string[] = ['file.access_requested', 'access.requested']

/** the chips always on the line (전체 never moves; 멘션 and 스레드 move into "⋯" only when the line has no room) */
export const VISIBLE_CHIPS: readonly ActivityChip[] = ['all', 'mentions', 'threads']
/** the filters in the "⋯" menu, for those who have them (chipsFor) */
export const MORE_CHIPS: readonly ActivityChip[] = ['dms', 'trina', 'requests']

/** the chip of the app's own notice besides 전체 (null: 전체 only, or a conversation row's: activityTabHas) */
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
  (admin || items.some((x) => EVERYONE_REQUESTS.includes(x.code)) ? [...SERVER_CHIPS, 'trina', 'requests'] : [...SERVER_CHIPS, 'trina'])

/** the chip a link asks for (`?tab=`), when it is one */
export const chipOfParam = (v: string | null): ActivityChip | null =>
  v && ([...SERVER_CHIPS, 'trina', 'requests'] as readonly string[]).includes(v) ? (v as ActivityChip) : null

export const inChip = (item: Pick<InboxNotification, 'code' | 'templateLeft' | 'room' | 'chatThread'>, chip: ActivityChip) =>
  isServerChip(chip) ? activityTabHas(item, chip) : chipOf(item) === chip

/** Newest first, read and unread together (the list's order, as the phone's and Slack's). */
export function newestFirst<I extends Pick<InboxNotification, 'createdAt'>>(items: readonly I[]): I[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Which chips stay on the line: `line` the chips in their order (전체, 멘션, 스레드, then a filter picked from the menu),
 * `width` each one's px, `room` the px the line has for them (the "⋯" and its gap already taken off), `gap` the px
 * between two. The last movable one goes first (스레드, then 멘션); 전체 and `keep` (the picked chip) never move. */
export function fitChips(line: readonly ActivityChip[], width: (c: ActivityChip) => number, room: number, gap: number, keep: ActivityChip): ActivityChip[] {
  const on = [...line]
  const used = () => on.reduce((sum, c, i) => sum + width(c) + (i ? gap : 0), 0)
  for (let i = on.length - 1; i >= 0 && used() > room; i--) {
    const c = on[i]!
    if (c === 'all' || c === keep) continue
    on.splice(i, 1)
  }
  return on
}
