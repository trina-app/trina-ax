import { describe, expect, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { applyCreated, applyDelta, applyDone, applyStep, markLocal, mergeFresh, mergeTurnStarted, optimisticUserMessage, prependPage, runningMessage } from '../../src/store/thread'
import { CHAT, msg, step } from './fixtures'

describe('applyDelta (offset rules of ws.ts)', () => {
  const a = () => msg({ role: 'assistant', status: 'streaming', content: 'Hello' })
  test('appends at the end', () => {
    const m = a()
    const r = applyDelta([m], { messageId: m.id, offset: 5, text: ' world' })
    expect(r.kind).toBe('applied')
    if (r.kind === 'applied') expect(r.messages[0]!.content).toBe('Hello world')
  })
  test('cuts the overlap after a REST reload that already had part of the delta', () => {
    const m = a()
    const r = applyDelta([m], { messageId: m.id, offset: 3, text: 'lo there' })
    expect(r.kind === 'applied' && r.messages[0]!.content).toBe('Hello there')
  })
  test('ignores a delta we already have entirely', () => {
    const m = a()
    expect(applyDelta([m], { messageId: m.id, offset: 0, text: 'Hel' }).kind).toBe('ignored')
  })
  test('a delta beyond what we have is a gap (reload)', () => {
    const m = a()
    expect(applyDelta([m], { messageId: m.id, offset: 9, text: 'x' }).kind).toBe('gap')
  })
  test('unknown message and finished message', () => {
    const m = a()
    expect(applyDelta([m], { messageId: uuidv7(), offset: 0, text: 'x' }).kind).toBe('unknown')
    const done = { ...m, status: 'done' as const }
    expect(applyDelta([done], { messageId: m.id, offset: 5, text: '!' }).kind).toBe('ignored')
  })
  test('does not mutate its input', () => {
    const m = a()
    const list = [m]
    applyDelta(list, { messageId: m.id, offset: 5, text: '!' })
    expect(list[0]!.content).toBe('Hello')
  })
})

describe('steps, done, created', () => {
  test('a step is added, then replaced by id', () => {
    const m = msg({ role: 'assistant', status: 'streaming' })
    const one = applyStep([m], m.id, step({ id: 's1' }))!
    const two = applyStep(one, m.id, step({ id: 's1', status: 'ok' }))!
    expect(two[0]!.steps).toHaveLength(1)
    expect(two[0]!.steps[0]!.status).toBe('ok')
    expect(applyStep([m], uuidv7(), step({ id: 's' }))).toBeNull()
  })
  test('done replaces the streamed message', () => {
    const m = msg({ role: 'assistant', status: 'streaming', content: 'par' })
    const r = applyDone([m], { ...m, status: 'done', content: 'partial and final' })!
    expect(r[0]!.content).toBe('partial and final')
    expect(r[0]!.status).toBe('done')
  })
  test('created: appended when it continues the branch, stale when it does not', () => {
    const u = msg({ role: 'user', content: 'hi' })
    const next = msg({ role: 'assistant', parentId: u.id, status: 'streaming' })
    const r = applyCreated([u], next)
    expect(Array.isArray(r) && r.length).toBe(2)
    expect(applyCreated([u], msg({ role: 'user', parentId: uuidv7() }))).toBe('stale')
    expect(applyCreated([], msg({ role: 'user', parentId: null }))).toHaveLength(1)
  })
  test('created for a message we stream already keeps the longer text', () => {
    const m = msg({ role: 'assistant', status: 'streaming', content: 'Hello world' })
    const r = applyCreated([m], { ...m, content: 'Hello' }) as ReturnType<typeof msg>[]
    expect(r[0]!.content).toBe('Hello world')
  })
})

describe('send / edit / regenerate merges', () => {
  const u1 = msg({ role: 'user', content: 'one' })
  const a1 = msg({ role: 'assistant', parentId: u1.id, content: 'answer one' })
  test('send replaces the optimistic message', () => {
    const local = optimisticUserMessage({ id: uuidv7(), chatId: CHAT, parentId: a1.id, content: 'two', author: { id: 'olga', name: 'Olga' }, attachments: [], clientMessageId: 'cm-12345678', now: new Date().toISOString() })
    const userMessage = msg({ role: 'user', parentId: a1.id, content: 'two' })
    const assistantMessage = msg({ role: 'assistant', parentId: userMessage.id, status: 'streaming' })
    const r = mergeTurnStarted([u1, a1, local], { userMessage, assistantMessage, turnId: uuidv7(), queuePosition: 0 }, { replaceId: local.id })
    expect(r.map((m) => m.id)).toEqual([u1.id, a1.id, userMessage.id, assistantMessage.id])
  })
  test('edit cuts the branch at the edited message', () => {
    const userMessage = msg({ role: 'user', content: 'one, edited' })
    const assistantMessage = msg({ role: 'assistant', parentId: userMessage.id, status: 'streaming' })
    const r = mergeTurnStarted([u1, a1], { userMessage, assistantMessage, turnId: uuidv7(), queuePosition: 0 }, { cutAt: u1.id })
    expect(r.map((m) => m.id)).toEqual([userMessage.id, assistantMessage.id])
  })
  test('regenerate cuts at the old answer', () => {
    const assistantMessage = msg({ role: 'assistant', parentId: u1.id, status: 'streaming' })
    const r = mergeTurnStarted([u1, a1], { userMessage: null, assistantMessage, turnId: uuidv7(), queuePosition: 2 }, { cutAt: a1.id })
    expect(r.map((m) => m.id)).toEqual([u1.id, assistantMessage.id])
  })
  test('markLocal flips the state of the optimistic message only', () => {
    const local = optimisticUserMessage({ id: uuidv7(), chatId: CHAT, parentId: null, content: 'x', author: { id: 'a', name: 'A' }, attachments: [], clientMessageId: 'cm-12345678', now: new Date().toISOString() })
    const r = markLocal([u1, local], local.id, 'failed', 'offline')
    expect(r[1]!.local).toEqual({ clientMessageId: 'cm-12345678', state: 'failed', error: 'offline' })
    expect(r[0]).toBe(u1)
  })
})

describe('REST reloads', () => {
  test('mergeFresh keeps unsent local messages and streamed text that is ahead of the last save', () => {
    const a = msg({ role: 'assistant', status: 'streaming', content: 'Hello wor' })
    const local = optimisticUserMessage({ id: uuidv7(), chatId: CHAT, parentId: a.id, content: 'x', author: { id: 'a', name: 'A' }, attachments: [], clientMessageId: 'cm-12345678', now: new Date().toISOString() })
    const r = mergeFresh([a, local], [{ ...a, content: 'Hello' }])
    expect(r[0]!.content).toBe('Hello wor')
    expect(r[1]!.id).toBe(local.id)
    // the server's copy wins when it is ahead or different
    expect(mergeFresh([a], [{ ...a, content: 'Hello world!' }])[0]!.content).toBe('Hello world!')
    expect(mergeFresh([a], [{ ...a, content: 'Bye' }])[0]!.content).toBe('Bye')
  })
  test('mergeFresh: a reload still showing the answer as running does not undo message.done', () => {
    const done = msg({ role: 'assistant', status: 'done', content: 'Checking first.\n\nSaved shared/a.md.' })
    expect(mergeFresh([done], [{ ...done, status: 'streaming', content: 'Checking first.' }])[0]).toBe(done)
  })
  test('prependPage drops overlap', () => {
    const x = msg({ role: 'user' })
    const y = msg({ role: 'assistant' })
    expect(prependPage([y], [x, y]).map((m) => m.id)).toEqual([x.id, y.id])
  })
  test('runningMessage finds the streaming answer', () => {
    const a = msg({ role: 'assistant', status: 'streaming' })
    expect(runningMessage([msg({ role: 'user' }), a])?.id).toBe(a.id)
    expect(runningMessage([msg({ role: 'assistant' })])).toBeUndefined()
  })
})
