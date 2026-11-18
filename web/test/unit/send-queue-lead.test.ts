// A waiting message's `lead` (lib/sendQueue.ts): a room's side chat keeps the thread line or quoted message its box showed
// when the message was queued, and sends it on top of the text; messages about different things never go as one.
import { expect, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { combine, parseQueue, serializeQueue, type QueuedMessage } from '../../src/lib/sendQueue'

const me = { id: 'olga', name: 'Olga' }
const item = (content: string, lead?: string): QueuedMessage => ({ id: uuidv7(), content, attachments: [], author: me, createdAt: new Date().toISOString(), ...(lead ? { lead } : {}) })
const THREAD = '> 🧵 Ben · 4:31 PM (thread_id 0190a0b0-0000-7000-8000-000000000001 in this room)'
const QUOTE = '> Ben · 4:32 PM\n> logo drafts by Friday?'

test('messages with the same lead go as one under it; a different lead waits for the next message', () => {
  const a = item('what was decided?', THREAD), b = item('and who does it?', THREAD), c = item('translate this', QUOTE), d = item('plain')
  const first = combine([a, b, c, d])
  expect(first.take).toEqual([a, b])
  expect(first.content).toBe(`${THREAD}\n\nwhat was decided?\n\nand who does it?`)
  const second = combine([c, d])
  expect(second.take).toEqual([c])
  expect(second.content).toBe(`${QUOTE}\n\ntranslate this`)
  expect(combine([d, a]).take).toEqual([d])
  expect(combine([d]).content).toBe('plain')
})

test('the lead is kept with the waiting message in this browser', () => {
  const q = { items: [item('what was decided?', THREAD), item('plain')], paused: null, after: null }
  const back = parseQueue(serializeQueue(q))!
  expect(back.items[0]!.lead).toBe(THREAD)
  expect(back.items[1]!.lead).toBeUndefined()
})
