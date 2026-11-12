// The "AI service is busy" line (QA TC-388): turn.busy marks a running answer; text, a step or the end clears it.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { useChats } from '../../src/store/chats'
import { CHAT, msg } from './fixtures'

const assistant = msg({ role: 'assistant', status: 'streaming', turnId: uuidv7() })
const h = (ev: unknown) => useChats.getState().handleEvent(ev as never)
const busy = (on: boolean, messageId = assistant.id) => h({ type: 'turn.busy', seq: 1, at: 0, data: { chatId: CHAT, messageId, turnId: assistant.turnId, busy: on } })
const isBusy = (id = assistant.id) => !!useChats.getState().busy[id]
beforeEach(() => useChats.getState().reset())
afterEach(() => useChats.getState().reset())

test('turn.busy on shows it, off clears it', () => {
  busy(true)
  expect(isBusy()).toBe(true)
  busy(false)
  expect(isBusy()).toBe(false)
})

test('the first text clears it; an empty reset delta (a refused attempt) does not', () => {
  busy(true)
  h({ type: 'message.delta', seq: 2, at: 0, data: { chatId: CHAT, messageId: assistant.id, offset: 0, text: '', reset: true } })
  expect(isBusy()).toBe(true)
  h({ type: 'message.delta', seq: 3, at: 0, data: { chatId: CHAT, messageId: assistant.id, offset: 0, text: 'Hello' } })
  expect(isBusy()).toBe(false)
})

test('busy again after a step or text: shown again (the next request after a tool step hit the limit)', () => {
  busy(true)
  h({ type: 'message.step', seq: 2, at: 0, data: { chatId: CHAT, messageId: assistant.id, step: { id: 's1', kind: 'tool', tool: 'read', label: 'Read', status: 'done' } } })
  expect(isBusy()).toBe(false)
  busy(true)
  expect(isBusy()).toBe(true)
  h({ type: 'message.delta', seq: 3, at: 0, data: { chatId: CHAT, messageId: assistant.id, offset: 0, text: 'Hi' } })
  busy(true)
  expect(isBusy()).toBe(true)
  busy(false)
  expect(isBusy()).toBe(false)
})

test('a step clears it', () => {
  busy(true)
  h({ type: 'message.step', seq: 2, at: 0, data: { chatId: CHAT, messageId: assistant.id, step: { id: 's1', kind: 'tool', tool: 'read', label: 'Read', status: 'running' } } })
  expect(isBusy()).toBe(false)
})

test('the end clears it, and a late busy frame for an ended answer is ignored', () => {
  busy(true)
  h({ type: 'message.done', seq: 2, at: 0, data: { chatId: CHAT, messageId: assistant.id, status: 'done', message: { ...assistant, status: 'done', content: 'ok' } } })
  expect(isBusy()).toBe(false)
  busy(true)
  expect(isBusy()).toBe(false)
})

test('reset (logout) forgets it; another answer is not touched', () => {
  const other = uuidv7()
  busy(true); busy(true, other)
  busy(false)
  expect(isBusy(other)).toBe(true)
  useChats.getState().reset()
  expect(isBusy(other)).toBe(false)
})
