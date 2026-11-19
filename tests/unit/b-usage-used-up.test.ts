// The AI accounts at their provider's limit (owner report 2026-11-19, potenlab: every team Claude account at its weekly
// limit for two more days). The answer ended at once, as it should, but said "the AI usage limit was reached for now,
// try again a bit later". A wait of up to an hour keeps those words; a longer one says the usage has run out, with
// when it starts again (params.until) for the web app's words by role. Both stay rate_limited (the "answer with another
// AI" fallback follows a limit).
import { expect, test } from 'bun:test'
import { chatErrorReason, CHAT_ERROR_MESSAGES } from '@mycel/shared/api'
import { limitError } from '../../server/src/chat/turn'
import { SOON_MS } from '../../server/src/credentials/resolve'

const now = Date.parse('2026-11-19T01:52:41.000Z')
const at = (ms: number) => new Date(now + ms).toISOString()

test('a short wait: the limit was reached for now, with the seconds to wait', () => {
  const e = limitError('en', at(30 * 60_000), now)
  expect(e).toMatchObject({ code: 'rate_limited', message: CHAT_ERROR_MESSAGES.rate_limit.en, params: { reason: 'rate_limit' }, retryAfter: 1800 })
  expect(e.params?.until).toBeUndefined()
  expect(limitError('en', at(SOON_MS), now).params?.reason).toBe('rate_limit')
})

test('a long wait (a weekly limit, two days): the usage has run out, until when, in the reader\'s language', () => {
  const until = '2026-11-21T07:00:00.000Z'
  const e = limitError('ko', until, now)
  expect(e).toMatchObject({ code: 'rate_limited', message: CHAT_ERROR_MESSAGES.usage_used_up.ko, params: { reason: 'usage_used_up', until }, retryAfter: 191239 })
  expect(e.message).not.toContain('잠시')
  expect(chatErrorReason(e)).toBe('usage_used_up')
  expect(limitError('en', at(SOON_MS + 1000), now).params?.reason).toBe('usage_used_up')
})

test('no time known: the plain limit words, no wait', () => {
  expect(limitError('en', null, now)).toMatchObject({ code: 'rate_limited', params: { reason: 'rate_limit' } })
  expect(limitError('en', 'not a date', now).retryAfter).toBeUndefined()
})
