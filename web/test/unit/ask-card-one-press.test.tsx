// One click per decision (QA TC-ask1-15, components/chat/AskCard.tsx): an AI question that takes one choice answers
// when an option is pressed (buttons, so keyboards and screen readers reach them); while the card's own box holds typed
// text the options are off, so nothing typed is lost, and [답하기] sends the text; [건너뛰기] stays. A question that takes
// several keeps its checkboxes and [답하기].
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { TurnRequest } from '@mycel/shared/api'
import AskCard from '../../src/components/chat/AskCard'
import { FakeElement, installDom, mount, removeDom, type Mounted } from './dom-host'

beforeAll(() => installDom())
afterAll(() => removeDom())

type Ask = Extract<TurnRequest, { kind: 'ask_user' }>
const aiAsk = (o: Partial<Ask> = {}): Ask => ({ kind: 'ask_user', requestId: 'r1', question: 'Which quarter?', multiple: false, allowText: true, options: [{ label: 'Q3', value: 'q3' }, { label: 'Q4', value: 'q4' }], ...o })
const options = (m: Mounted) => m.container.querySelectorAll('[data-testid="ask-option"]')

test('one choice: a press on an option answers with its value at once', async () => {
  const answers: unknown[] = []
  const m = await mount(<AskCard req={{ request: aiAsk() }} onAnswer={async (_id, body) => void answers.push(body)} />)
  try {
    expect(m.html()).not.toContain('type="radio"')
    const [q3, q4] = options(m)
    expect(q3!.localName).toBe('button')
    expect(q3!.getAttribute('type')).toBe('button')
    expect(q4!.textContent).toBe('Q4')
    await m.click(q4!)
    expect(answers).toEqual([{ kind: 'ask_user', answer: 'q4' }])
  } finally {
    await m.unmount()
  }
})

test('text typed in the card turns the options off; [답하기] sends the text; Skip stays', async () => {
  const answers: unknown[] = []
  const m = await mount(<AskCard req={{ request: aiAsk() }} onAnswer={async (_id, body) => void answers.push(body)} />)
  try {
    expect(m.find('ask-send')?.hasAttribute('disabled')).toBe(true)
    await m.type('ask-text', 'Both, please')
    for (const o of options(m)) expect(o.hasAttribute('disabled')).toBe(true)
    await m.click(options(m)[0]!)
    expect(answers).toEqual([])
    await m.click('ask-send')
    expect(answers).toEqual([{ kind: 'ask_user', answer: 'Both, please' }])
    expect(m.html()).toContain('>Skip</button>')
  } finally {
    await m.unmount()
  }
})

test('several choices: checkboxes, nothing sent on a tick, [답하기] sends the ticks', async () => {
  const answers: unknown[] = []
  const m = await mount(<AskCard req={{ request: aiAsk({ multiple: true, allowText: false }) }} onAnswer={async (_id, body) => void answers.push(body)} />)
  try {
    expect(options(m).length).toBe(0)
    const boxes = m.container.querySelectorAll('input[type="checkbox"]')
    expect(boxes.length).toBe(2)
    // a checkbox click: the browser flips `checked` (past React's value tracker), then the click event
    for (const box of boxes) {
      Object.getOwnPropertyDescriptor(FakeElement.prototype, 'checked')!.set!.call(box, true)
      await m.click(box)
    }
    expect(answers).toEqual([])
    await m.click('ask-send')
    expect(answers).toEqual([{ kind: 'ask_user', answer: ['q3', 'q4'] }])
  } finally {
    await m.unmount()
  }
})

test('a server card with more choices keeps its radios and [답하기]: a pick alone answers nothing', async () => {
  const answers: unknown[] = []
  const four = [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'C', value: 'c' }, { label: 'D', value: 'd' }]
  const m = await mount(<AskCard req={{ request: aiAsk({ origin: 'server', allowText: false, options: four } as Partial<Ask>) }} onAnswer={async (_id, body) => void answers.push(body)} />)
  try {
    expect(options(m)).toHaveLength(0)
    const radios = m.container.querySelectorAll('input[type="radio"]')
    expect(radios).toHaveLength(4)
    // a browser checks a radio before the click's listeners run, past React's value tracker (this small DOM does not)
    const radio = radios[2]!
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(radio), 'checked')!.set!.call(radio, true)
    await m.click(radio)
    expect(answers).toEqual([])
    await m.click('ask-send')
    expect(answers).toEqual([{ kind: 'ask_user', answer: 'c' }])
  } finally {
    await m.unmount()
  }
})

test('a server notice with one button (a connection first used in a shared chat): one press answers it', async () => {
  const answers: unknown[] = []
  const request: Ask = { kind: 'ask_user', origin: 'server', requestId: 'n1', question: 'Other people in this chat can also see what the AI gets from Bright Data.', multiple: false, allowText: false, buttons: true, options: [{ label: 'Continue', value: 'once' }] }
  const m = await mount(<AskCard req={{ request }} onAnswer={async (_id, body) => void answers.push(body)} />)
  try {
    expect(m.html()).not.toContain('type="radio"')
    expect(m.find('ask-send')).toBeFalsy()
    await m.click('ask-yes')
    expect(answers).toEqual([{ kind: 'ask_user', answer: 'once' }])
  } finally {
    await m.unmount()
  }
})
