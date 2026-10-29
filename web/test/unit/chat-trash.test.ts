// The chat trash banner and page use the team's chat retention (Admin > Team settings), not a fixed 7 days.
import { describe, expect, test } from 'bun:test'
import { chatPurgeAt, chatTrashDays, DEFAULT_CHAT_TRASH_DAYS } from '../../src/lib/chat-trash'

const me = (d?: number) => ({ team: { name: 'Acme', defaultLocale: 'ko' as const, ...(d === undefined ? {} : { chatTrashRetentionDays: d }) } })

describe('chat trash retention', () => {
  test('the team setting from /api/me decides the days; an older server without it means the default 7', () => {
    expect(chatTrashDays(me(3))).toBe(3)
    expect(chatTrashDays(me(30))).toBe(30)
    expect(chatTrashDays(me())).toBe(DEFAULT_CHAT_TRASH_DAYS)
    expect(DEFAULT_CHAT_TRASH_DAYS).toBe(7)
    expect(chatTrashDays(null)).toBe(7)
    expect(chatTrashDays(me(0))).toBe(7)
  })
  test('the purge date is the deletion time plus the current retention', () => {
    expect(chatPurgeAt('2026-10-01T00:00:00.000Z', 3)).toBe('2026-10-04T00:00:00.000Z')
    expect(chatPurgeAt('2026-10-01T00:00:00.000Z', 30)).toBe('2026-10-31T00:00:00.000Z')
  })
})
