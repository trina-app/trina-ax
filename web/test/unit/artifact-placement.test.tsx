// An answer's artifact cards show where the AI made them (Step.textAt, components/chat/Messages.tsx): the ad copy's
// "caption → preview → three options" reads in that order; answers from before the field, or a cut inside a code
// block, keep the cards after the text.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Step } from '@mycel/shared/api'
import { AssistantMessage, answerParts, artifactSplit } from '../../src/components/chat/Messages'
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
    expect(artifactSplit('cap\n\nmore', [art({ textAt: 5 }), art({ id: 'a2', textAt: 3 })])).toBe(3)
    expect(artifactSplit('cap\n\nmore', [art({ textAt: 3, parentId: 'agent-1' })])).toBeNull()
    expect(artifactSplit('cap\n\nmore', [art()])).toBeNull()
    expect(artifactSplit('cap\n\nmore', [step({ id: 't', kind: 'tool', label: 'read', status: 'ok', textAt: 3 })])).toBeNull()
    expect(artifactSplit('abc', [art({ textAt: 9 })])).toBeNull()
    expect(artifactSplit('```js\nx', [art({ textAt: 7 })])).toBeNull()
    expect(artifactSplit('```js\nx\n```\n\nafter', [art({ textAt: 13 })])).toBe(13)
    expect(artifactSplit('abc', [art({ textAt: 0 })])).toBe(0)
  })

  test('never inside a block: back to the blank line before a paragraph, list or quote; kept where a block ends', () => {
    // between blocks: right after the blank line, or where a block ends with a blank line after it
    expect(artifactSplit('cap\n\nmore', [art({ textAt: 5 })])).toBe(5)
    expect(artifactSplit('cap\n\nmore', [art({ textAt: 3 })])).toBe(3)
    // inside a paragraph, a list or a quote: the blank line before it
    const list = 'cap\n\n- a\n- b\n- c'
    expect(artifactSplit(list, [art({ textAt: list.indexOf('- b') })])).toBe(5)
    const quote = 'cap\n\n> 제목: a\n>\n> 본문: b\n\nnext'
    expect(artifactSplit(quote, [art({ textAt: quote.indexOf('> 본문') })])).toBe(5)
    expect(artifactSplit('cap\n\nsome text here', [art({ textAt: 10 })])).toBe(5)
    // a heading right above stays with its block: back before "### 1안" too
    const options = 'cap\n\n### 1안\n\n> 제목: a\n> 본문: b'
    expect(artifactSplit(options, [art({ textAt: options.indexOf('> 본문') })])).toBe(5)
    // inside the first block, with no blank line before it: after the text, as before
    expect(artifactSplit('abcdef', [art({ textAt: 2 })])).toBeNull()
    // a blank line inside a code block is no boundary: still inside the code, so after the text
    const code = 'intro\n\n```js\nx\n\ny\n```'
    expect(artifactSplit(code, [art({ textAt: code.indexOf('y') })])).toBeNull()
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

  test('a cut inside the options list goes back to the start of the options', async () => {
    const content = CAPTION + OPTIONS
    const o = order(await render(content, [art({ textAt: content.indexOf('> 제목: 첫 달') + 3 })]))
    // the card after the caption and before the first option, never inside a quote
    expect(o.card).toBeGreaterThan(o.caption)
    expect(o.options).toBeGreaterThan(o.card)
  })

  test('while it streams, the part still being written is the last one with text', () => {
    expect(answerParts('cap\n\nmore', 5, true)).toEqual({ before: { text: 'cap\n\n', streaming: false }, after: { text: 'more', streaming: true } })
    // nothing after the cards yet: the text before them is the one still streaming
    expect(answerParts('cap\n\n ', 5, true)).toEqual({ before: { text: 'cap\n\n', streaming: true }, after: null })
    expect(answerParts('cap\n\n ', 5, false)).toEqual({ before: { text: 'cap\n\n', streaming: false }, after: null })
    expect(answerParts('more', 0, true)).toEqual({ before: null, after: { text: 'more', streaming: true } })
  })

  test('the copy button still copies the whole answer', async () => {
    const html = await render(CAPTION + OPTIONS, [art({ textAt: CAPTION.length })])
    expect(html.match(/data-testid="artifact-card"/g)?.length).toBe(1)
    expect(html).toContain('data-testid="answer-actions"')
  })
})
