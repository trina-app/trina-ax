// A call whose card waits after the answer ended shows as waiting, not done (QA of #594: "파일 수정 ✓" while the
// person's card was still open); once answered the server takes `waiting` off (done, or "Declined").
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Step } from '@mycel/shared/api'
import Steps, { stepMark } from '../../src/components/chat/Steps'

const step = (o: Partial<Step>): Step => ({ id: 's1', kind: 'tool', tool: 'edit', label: 'Edit · users/alice/skills/mine/SKILL.md', status: 'ok', startedAt: '2026-11-25T01:00:00.000Z', endedAt: '2026-11-25T01:00:01.000Z', ...o })
const marks = { live: false, answerFailed: false, gotPast: new Set<string>() }

describe('a step whose card waits', () => {
  test('waiting, then done or declined', () => {
    expect(stepMark(step({ waiting: true }), marks)).toBe('waiting')
    expect(stepMark(step({}), marks)).toBe('done')
    expect(stepMark(step({ outcome: { end: 'declined' } }), marks)).toBe('done')
  })
  test('the row says it waits', () => {
    const html = renderToStaticMarkup(<Steps streaming={false} steps={[step({ waiting: true }), step({ id: 's2' }), step({ id: 's3' })]} />)
    expect(html).toContain('data-testid="step-waiting"')
    expect(html).toContain('Waiting for your answer')
  })
})
