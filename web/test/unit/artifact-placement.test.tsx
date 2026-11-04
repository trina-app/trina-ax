// An answer's artifact cards show where the AI made them (Step.textAt, components/chat/Messages.tsx): the ad copy's
// "caption → preview → three options" reads in that order; answers from before the field, or a cut inside a code
// block, keep the cards after the text.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Step } from '@mycel/shared/api'
import { AssistantMessage, artifactSplit } from '../../src/components/chat/Messages'
import { useChats } from '../../src/store/chats'
import { CHAT, msg, step } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const CAPTION = '추천 2안을 인스타그램 피드에 올리면 이렇게 보여요.'
const OPTIONS = '\n\n### 1안 · 혜택\n\n> 제목: 첫 달 무료\n\n### 2안 · 고민\n\n> 제목: 아침 5분'
const art = (o: Partial<Step> = {}) => step({ id: 'a1', kind: 'artifact', tool: 'artifact', label: 'artifact create preview', status: 'ok', ...o })

async function render(content: string, steps: Step[]) {
  const m = msg({ role: 'assistant', content, steps })
  useChats.setState({ liveArtifacts: { [CHAT]: { preview: { key: 'preview', chatId: CHAT, messageId: m.id, type: 'html', title: '미리보기', status: 'done', content: '', artifactId: 'x1', version: 1 } } } })
  const page = await mount(
    <MemoryRouter>
      <AssistantMessage m={m} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} />
    </MemoryRouter>,
  )
  const html = page.html()
  await page.unmount()
  return html
}
const order = (html: string) => ({ caption: html.indexOf('이렇게 보여요'), card: html.indexOf('data-testid="artifact-card"'), options: html.indexOf('1안 · 혜택') })

beforeAll(() => { installDom() })
afterAll(() => removeDom())
afterEach(() => useChats.setState({ liveArtifacts: {} }))

describe('artifactSplit', () => {
  test('the first top-level artifact step, clamped; none without the field, at the end, or inside a code block', () => {
    expect(artifactSplit('abcdef', [art({ textAt: 4 }), art({ id: 'a2', textAt: 2 })])).toBe(2)
    expect(artifactSplit('abcdef', [art({ textAt: 2, parentId: 'agent-1' })])).toBeNull()
    expect(artifactSplit('abcdef', [art()])).toBeNull()
    expect(artifactSplit('abcdef', [step({ id: 't', kind: 'tool', label: 'read', status: 'ok', textAt: 1 })])).toBeNull()
    expect(artifactSplit('abc', [art({ textAt: 9 })])).toBeNull()
    expect(artifactSplit('```js\nx', [art({ textAt: 7 })])).toBeNull()
    expect(artifactSplit('```js\nx\n```\nafter', [art({ textAt: 12 })])).toBe(12)
    expect(artifactSplit('abc', [art({ textAt: 0 })])).toBe(0)
  })
})

describe('the answer', () => {
  test('caption, then the preview card, then the options', async () => {
    const o = order(await render(CAPTION + OPTIONS, [art({ textAt: CAPTION.length })]))
    expect(o.caption).toBeGreaterThan(-1)
    expect(o.card).toBeGreaterThan(o.caption)
    expect(o.options).toBeGreaterThan(o.card)
  })

  test('an artifact made before any text: the card first', async () => {
    const o = order(await render(CAPTION + OPTIONS, [art({ textAt: 0 })]))
    expect(o.card).toBeLessThan(o.caption)
  })

  test('an answer from before the field keeps the card after the text', async () => {
    const o = order(await render(CAPTION + OPTIONS, [art()]))
    expect(o.card).toBeGreaterThan(o.options)
  })

  test('the copy button still copies the whole answer', async () => {
    const html = await render(CAPTION + OPTIONS, [art({ textAt: CAPTION.length })])
    expect(html.match(/data-testid="artifact-card"/g)?.length).toBe(1)
    expect(html).toContain('data-testid="answer-actions"')
  })
})
