// A memory step (remember, forget) has 되돌리기 and, the first time, its one-time line only on the person's own answer: on
// someone else's answer in a shared chat it is that person's memory (docs/decisions/20261125-auto-memory-shared-chats.md),
// and an undo of a forgotten one would have added their words to the viewer's own memories.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Step } from '@mycel/shared/api'
import Steps, { StepMemoryOwn } from '../../src/components/chat/Steps'

const step = (o: Partial<Step>): Step => ({ id: 's1', kind: 'tool', tool: 'remember', label: 'Remembered: short answers', status: 'ok', startedAt: '2026-11-25T01:00:00.000Z', endedAt: '2026-11-25T01:00:01.000Z', ...o })
const created = step({ memory: { id: 'm1', change: 'created', text: 'short answers', first: true } })
const forgotten = step({ id: 's2', tool: 'forget', label: 'Forgot: short answers', memory: { id: 'm1', change: 'forgotten', text: 'short answers' } })

describe('a memory step', () => {
  test('the person\'s own answer: 되돌리기 and the one-time line', () => {
    const html = renderToStaticMarkup(<Steps steps={[created, forgotten]} streaming={false} />)
    expect(html.split('data-testid="step-memory-undo"').length - 1).toBe(2)
    expect(html).toContain('data-testid="memory-first-line"')
  })

  test('someone else\'s answer: the step without 되돌리기 or the one-time line', () => {
    const html = renderToStaticMarkup(<StepMemoryOwn.Provider value={false}><Steps steps={[created, forgotten]} streaming={false} /></StepMemoryOwn.Provider>)
    expect(html).toContain('short answers')
    expect(html).not.toContain('step-memory-undo')
    expect(html).not.toContain('memory-first-line')
  })
})
