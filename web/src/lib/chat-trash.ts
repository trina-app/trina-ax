// How long the team keeps deleted chats (and a deleted account's chats and memories). The server purges with the
// current Admin > Team settings value (chatTrashRetentionDays), so the screens read it from /api/me and never use a
// fixed number. An older server does not send it: then its default, 7 days.
import type { Me } from '@mycel/shared/api'

export const DEFAULT_CHAT_TRASH_DAYS = 7

export function chatTrashDays(me: Pick<Me, 'team'> | null | undefined): number {
  const d = me?.team.chatTrashRetentionDays
  return typeof d === 'number' && Number.isInteger(d) && d >= 1 ? d : DEFAULT_CHAT_TRASH_DAYS
}

/** When a chat in the trash is removed for good: deleted at + the team's current retention. */
export function chatPurgeAt(deletedAt: string, days: number): string {
  return new Date(Date.parse(deletedAt) + days * 86_400_000).toISOString()
}
