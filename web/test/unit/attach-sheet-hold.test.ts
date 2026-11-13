// The phone app's photo pick holds the page's history (lib/backCloses.ts holdHistory, QA TC-251) while the picker is
// up, then for the bytes only a bounded time, so Back's history never waits for minutes on a stuck transfer.
import { expect, test } from 'bun:test'
import { bytesHoldMs } from '../../src/components/chat/AttachSheet'

test('the bytes of a pick hold the history 15 s and 1 s per MiB, never more than 2 minutes', () => {
  expect(bytesHoldMs(0)).toBe(15_000)
  expect(bytesHoldMs(1)).toBe(16_000)
  expect(bytesHoldMs(5 * 1024 * 1024)).toBe(20_000)
  expect(bytesHoldMs(200 * 1024 * 1024)).toBe(120_000)
})
