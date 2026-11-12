// The version arrows (and the other message-row buttons) of a chat wait for its answer (pages/Chat.tsx rowButtonsWait):
// in a shared chat someone else's live answer is not on this screen, so "someone else is answering" counts too
// (switching versions then dropped their answer off the branch and the next message continued from the other one).
import { expect, test } from 'bun:test'
import { rowButtonsWait, type ViewMessage } from '../../src/store/thread'

const msg = (o: Partial<ViewMessage>) => ({ id: 'm', role: 'assistant', status: 'done', parentId: null, content: '', ...o }) as ViewMessage
const done = [msg({ id: 'q', role: 'user' }), msg({ id: 'a', parentId: 'q' })]

test('an idle chat: the arrows work', () => {
  expect(rowButtonsWait(done, { readOnly: false, othersTurn: null })).toBe(false)
})

test("someone else's answer in a shared chat (not on this screen): the arrows wait", () => {
  expect(rowButtonsWait(done, { readOnly: false, othersTurn: { name: 'Alice Kim' } })).toBe(true)
})

test('my own answer streaming, a question sending, or a read-only chat: the arrows wait', () => {
  expect(rowButtonsWait([...done, msg({ id: 'b', status: 'streaming' })], { readOnly: false, othersTurn: null })).toBe(true)
  expect(rowButtonsWait([...done, msg({ id: 'l', role: 'user', local: { state: 'sending' } } as Partial<ViewMessage>)], { readOnly: false, othersTurn: null })).toBe(true)
  expect(rowButtonsWait(done, { readOnly: true, othersTurn: null })).toBe(true)
})
