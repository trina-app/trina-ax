// Text the AI writes between tool calls reads at its place among the steps, as Claude Code shows it
// (docs/decisions/20261125-interim-text-inline.md): an English answer's text is cut where each step started
// (Step.textAt); a Korean answer's interim pieces (Step.interim, kept out of the answer's text) show as text, not
// folded; the copy button still copies the answer's text alone.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Step } from '@mycel/shared/api'
import { AssistantMessage } from '../../src/components/chat/Messages'
import { answerFlow, type FlowItem } from '../../src/lib/answerFlow'
import { msg, step } from './fixtures'
import { CHAT } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const tool = (id: string, textAt?: number, o: Partial<Step> = {}) => step({ id, kind: 'tool', tool: 'grep', label: `search ${id}`, status: 'ok', ...(textAt !== undefined ? { textAt } : {}), ...o })
const note = (id: string, text: string, textAt = 0) => step({ id, kind: 'thinking', label: 'Thinking', status: 'ok', detail: text, interim: true, textAt })
const shape = (items: FlowItem[]) => items.filter((i) => i.kind !== 'cards').map((i) => (i.kind === 'steps' ? `steps:${i.steps.map((s) => s.id).join(',')}` : i.kind === 'note' ? `note:${i.text}` : `text:${i.text.trim()}`))

beforeAll(() => { installDom() })
afterAll(() => removeDom())

describe('answerFlow', () => {
  const A = 'Nothing relevant yet. Let me widen the search.'
  const B = 'Found the price list.'

  test('English: the text between calls sits between their steps, the final answer last', () => {
    const content = `${A}\n\n${B}\n\nThe answer.`
    const steps = [tool('s1', 0), tool('s2', 0), tool('s3', A.length), tool('s4', A.length + 2 + B.length)]
    expect(shape(answerFlow(content, steps, false))).toEqual(['steps:s1,s2', `text:${A}`, 'steps:s3', `text:${B}`, 'steps:s4', 'text:The answer.'])
  })

  test('Korean: an interim step reads as text at its place; a thinking block or a working note stays a step', () => {
    const steps = [tool('s1', 0), note('n1', '관련 파일이 아직 없어요. 범위를 넓혀 볼게요.'), tool('s2', 0), step({ id: 'th', kind: 'thinking', label: 'Thinking', status: 'ok', detail: 'Now the SKILL.md.', textAt: 0 }), tool('s3', 0)]
    expect(shape(answerFlow('가격표를 찾았어요.', steps, false))).toEqual(['steps:s1', 'note:관련 파일이 아직 없어요. 범위를 넓혀 볼게요.', 'steps:s2,th,s3', 'text:가격표를 찾았어요.'])
  })

  test('steps from before the field come before the text, as before; a sub-task keeps its steps', () => {
    const steps = [tool('s1'), step({ id: 'ag', kind: 'tool', tool: 'agent', label: 'agent', status: 'ok' }), tool('k1', undefined, { parentId: 'ag' })]
    expect(shape(answerFlow('Intro.\n\nAnswer.', steps, false))).toEqual(['steps:s1,ag,k1', 'text:Intro.\n\nAnswer.'])
  })

  test('a point inside a paragraph or a code block moves back before that block', () => {
    const content = 'Intro.\n\nLet me look at it.Found it.'
    expect(shape(answerFlow(content, [tool('s1', content.indexOf('Found'))], false))).toEqual(['text:Intro.', 'steps:s1', 'text:Let me look at it.Found it.'])
    const code = 'Intro.\n\n```js\nx\n\ny\n```'
    expect(shape(answerFlow(code, [tool('s1', code.indexOf('y'))], false))).toEqual(['text:Intro.', 'steps:s1', 'text:```js\nx\n\ny\n```'])
    // inside the first block with nothing before it: the step stays above it
    expect(shape(answerFlow('abcdef', [tool('s1', 3)], false))).toEqual(['steps:s1', 'text:abcdef'])
  })

  test('while it runs: the last group is live, the earlier ones fold; the last text streams', () => {
    const content = `${A}\n\nWorking`
    const items = answerFlow(content, [tool('s1', 0), tool('s2', A.length + 2)], true)
    const groups = items.filter((i): i is Extract<FlowItem, { kind: 'steps' }> => i.kind === 'steps')
    expect(groups.map((g) => g.live)).toEqual([false, true])
    expect(items.filter((i) => i.kind === 'text').map((i) => i.kind === 'text' && i.streaming)).toEqual([false, true])
    // a step after the last text: that text is finished, nothing streams
    const after = answerFlow(A, [tool('s1', 0), tool('s2', A.length)], true)
    expect(after.filter((i) => i.kind === 'text').map((i) => i.kind === 'text' && i.streaming)).toEqual([false])
  })
})

async function render(content: string, steps: Step[]) {
  const m = msg({ role: 'assistant', content, steps })
  const page = await mount(
    <MemoryRouter>
      <AssistantMessage m={m} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} />
    </MemoryRouter>,
  )
  const html = page.html()
  await page.unmount()
  return html
}

describe('the answer', () => {
  test('a Korean interim piece shows between the steps, above the answer, not folded', async () => {
    const html = await render('가격표를 찾았어요.', [tool('s1', 0), note('n1', '범위를 넓혀 볼게요.'), tool('s2', 0)])
    expect(html.match(/data-testid="steps"/g)?.length).toBe(2)
    const at = (s: string) => html.indexOf(s)
    expect(at('data-testid="answer-interim"')).toBeGreaterThan(at('data-testid="steps"'))
    expect(at('범위를 넓혀 볼게요')).toBeLessThan(at('가격표를 찾았어요'))
    expect(html.lastIndexOf('data-testid="steps"')).toBeLessThan(at('가격표를 찾았어요'))
  })

  test('a failed search, text, then a retry that worked in the next group: no red mark (decided over the whole answer)', async () => {
    const content = 'Nothing yet. Trying the team drive.\n\nFound it.'
    const html = await render(content, [tool('s1', 0, { status: 'error', tool: 'write', label: 'save a' }), tool('s2', 'Nothing yet. Trying the team drive.'.length, { tool: 'write', label: 'save b' })])
    expect(html.match(/data-testid="steps"/g)?.length).toBe(2)
    expect(html).not.toContain('data-testid="steps-failed"')
  })

  test('an English answer: the text between calls between its steps, one fold line per group', async () => {
    const content = 'Nothing yet. Widening the search.\n\nHere is the list.'
    const html = await render(content, [tool('s1', 0), tool('s2', 'Nothing yet. Widening the search.'.length)])
    const at = (s: string) => html.indexOf(s)
    expect(html.match(/data-testid="steps"/g)?.length).toBe(2)
    expect(at('Widening the search')).toBeGreaterThan(at('data-testid="steps"'))
    expect(html.lastIndexOf('data-testid="steps"')).toBeGreaterThan(at('Widening the search'))
    expect(at('Here is the list')).toBeGreaterThan(html.lastIndexOf('data-testid="steps"'))
  })
})
