// A confirm card never opens on raw JSON, code or a long payload (docs/decisions/20261124-card-no-raw-payload.md); what a
// person needs to decide (where it goes, long random-looking values, recipients) stays in view.
import { expect, test } from 'bun:test'
import type { TurnRequest } from '@mycel/shared/api'
import AskCard from '../../src/components/chat/AskCard'
import { foldsField, isPayload, payloadAddresses, payloadSummary } from '../../src/lib/cardPayload'
import { installDom, mount, removeDom } from './dom-host'

type Ask = Extract<TurnRequest, { kind: 'ask_user' }>
const ask = (details: NonNullable<Ask['details']>): { turnId: string; messageId: string; request: Ask } => ({
  turnId: 't1', messageId: 'm1',
  request: { kind: 'ask_user', origin: 'server', requestId: 'r1', question: '보낼까요?', multiple: false, allowText: false, options: [{ label: '보내기', value: 'yes' }, { label: '보내지 않기', value: 'no' }], details },
})
const big = JSON.stringify({ subject: '행사 안내', to: 'sora@example.com', body: 'x'.repeat(6900), hook: 'https://hooks.example.net/in' }, null, 2)

test('the shape decides: JSON, markup and code are payloads, prose is not', () => {
  for (const t of [big, '{"a":1}', '[1,2]', '<!doctype html><p>x</p>', '#!/bin/sh\necho hi', 'const a = { b: [1, 2] }; if (a.b[0] <= 2) { run($x); }\n'.repeat(4)]) expect(isPayload(t), t.slice(0, 30)).toBe(true)
  for (const t of ['안녕하세요, 내일 회의는 3시입니다.', 'Hi team, the meeting moved to 3 pm. Please bring the notes. '.repeat(6), '']) expect(isPayload(t), t.slice(0, 30)).toBe(false)
})

test('a field that says who gets it never folds', () => {
  expect(foldsField({ value: JSON.stringify(Array.from({ length: 30 }, (_, i) => `person${i}@example.com`)) })).toBe(false)
  expect(foldsField({ value: 'sora@example.com' })).toBe(false)
  expect(foldsField({ value: big })).toBe(true)
  expect(foldsField({ value: 'echo hi\n'.repeat(40), code: true })).toBe(true)
})

test('the summary and the addresses', () => {
  expect(payloadSummary(big)).toBe('subject: 행사 안내 · to: sora@example.com · hook: https://hooks.example.net/in')
  expect(payloadAddresses(big)).toEqual(['sora@example.com', 'hooks.example.net'])
  expect(payloadAddresses(big, 'sora@example.com')).toEqual(['hooks.example.net'])
})

test('the address scan stays fast on a huge unbroken value', () => {
  const t0 = performance.now()
  expect(payloadAddresses('x'.repeat(200_000))).toEqual([])
  expect(performance.now() - t0).toBeLessThan(200)
})

test('a 6,935-character JSON: closed by default with a plain line; where it goes and a random value stay; 자세히 opens it', async () => {
  installDom()
  const mark = 'Zx81Qa7LmP02vKt9RbY4nW6sHc3JdE5u'
  const text = big.replace('행사 안내', mark)
  const m = await mount(<AskCard req={ask([{ label: '보낼 내용', text, marks: [mark] }])} />)
  try {
    expect(m.find('ask-detail-text')).toBeNull()
    expect(m.html()).not.toContain('x'.repeat(100))
    expect(m.get('ask-detail-folded-label').textContent).toBe('보낼 내용')
    expect(m.get('ask-payload-addresses').textContent).toContain('sora@example.com')
    expect(m.get('ask-payload-addresses').textContent).toContain('hooks.example.net')
    expect(m.get('ask-payload-marks').textContent).toContain(mark)
    await m.click('ask-detail-folded')
    expect(m.get('ask-detail-text').textContent).toContain('x'.repeat(100))
  } finally { await m.unmount(); removeDom() }
})

test('long prose shows its start; a short message and red alert lines stay open', async () => {
  installDom()
  const prose = '내일 회의 안내입니다. '.repeat(100)
  const a = await mount(<AskCard req={ask([{ label: '보낼 내용', text: prose }])} />)
  try {
    expect(a.get('ask-detail-text').textContent!.length).toBeLessThan(260)
    await a.click('ask-detail-more')
    expect(a.get('ask-detail-text').textContent!.length).toBe(prose.length)
  } finally { await a.unmount() }
  const b = await mount(<AskCard req={ask([{ label: '보낼 내용', text: '내일 3시입니다.' }])} />)
  try { expect(b.get('ask-detail-text').textContent).toBe('내일 3시입니다.') } finally { await b.unmount() }
  const c = await mount(<AskCard req={ask([{ label: '멤버', text: '{"a":1}', alerts: [{ text: '{"a":1}', note: '없는 이름' }] }])} />)
  try { expect(c.find('ask-detail-text')).not.toBeNull() } finally { await c.unmount(); removeDom() }
})
