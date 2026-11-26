// A personal skill step (docs/decisions/20261125-auto-personal-skills.md): 보기 and 되돌리기 on the person's own answer;
// a step with nothing to put back (no version, no trash item) says so instead of offering an undo that does nothing
// (review of #594), and someone else's answer shows neither.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Step } from '@mycel/shared/api'
import Steps, { StepMemoryOwn } from '../../src/components/chat/Steps'

const step = (o: Partial<Step>): Step => ({ id: 's1', kind: 'tool', tool: 'write', label: 'Saved skill: weekly', status: 'ok', startedAt: '2026-11-25T01:00:00.000Z', endedAt: '2026-11-25T01:00:01.000Z', ...o })
const path = 'users/alice/skills/weekly/SKILL.md'

describe('a personal skill step', () => {
  test('saved, fixed with a version, deleted with trash items: 보기 (not for a delete) and 되돌리기', () => {
    const html = renderToStaticMarkup(<Steps streaming={false} steps={[
      step({ skill: { name: 'weekly', path, change: 'saved', first: true } }),
      step({ id: 's2', tool: 'edit', label: 'Skill updated: weekly', skill: { name: 'weekly', path, change: 'fixed', versionId: 'v1' } }),
      step({ id: 's3', tool: 'delete_files', label: 'Deleted skill: weekly, monthly', skill: { name: 'weekly, monthly', path, change: 'deleted', trashIds: ['t1', 't2'] } }),
    ]} />)
    expect(html.split('data-testid="step-skill-undo"').length - 1).toBe(3)
    expect(html.split('data-testid="step-skill-view"').length - 1).toBe(2)
    expect(html).toContain('data-testid="skill-first-line"')
  })
  test('nothing to put back: no undo button, a plain line instead', () => {
    const html = renderToStaticMarkup(<Steps streaming={false} steps={[
      step({ tool: 'edit', label: 'Skill updated: weekly', skill: { name: 'weekly', path, change: 'fixed' } }),
      step({ id: 's2', tool: 'delete_files', label: 'Deleted skill: weekly', skill: { name: 'weekly', path, change: 'deleted' } }),
    ]} />)
    expect(html).not.toContain('step-skill-undo"')
    expect(html.split('data-testid="step-skill-undo-none"').length - 1).toBe(2)
  })
  test('someone else\'s answer: neither', () => {
    const html = renderToStaticMarkup(<StepMemoryOwn.Provider value={false}><Steps streaming={false} steps={[step({ skill: { name: 'weekly', path, change: 'saved' } })]} /></StepMemoryOwn.Provider>)
    expect(html).not.toContain('step-skill-undo')
    expect(html).not.toContain('step-skill-view')
  })
})
