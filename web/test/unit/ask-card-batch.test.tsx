// Cards of one kind from one answer as ONE card (components/chat/AskCard.tsx BatchCard, lib/cardBatch.ts). The owner,
// 2026-11-23: "스킬 여러개 만들라고 하니깐 한번에 저렇게 다 띄워 버리네". Three skills to the team: one head line, each skill
// on a line (name, description), the summary once, no path in the default view, one set of buttons; one press answers
// all three, an unticked one gets its card's no first; 자세히 shows the paths and the files.
import { expect, test } from 'bun:test'
import { useState } from 'react'
import type { TurnRequest } from '@mycel/shared/api'
import { BatchCard, CARDS_GATHER_MS } from '../../src/components/chat/AskCard'
import { CARD_JOIN_LOCK_MAX_MS, CARD_JOIN_LOCK_MS, joinLock } from '../../src/lib/cardBatch'
import { useChats } from '../../src/store/chats'
import { installDom, mount, removeDom } from './dom-host'

type Ask = Extract<TurnRequest, { kind: 'ask_user' }>
const card = (i: number, name: string): { turnId: string; messageId: string; request: Ask } => ({
  turnId: 't1', messageId: 'm1',
  request: {
    kind: 'ask_user', origin: 'server', requestId: `r${i}`, multiple: false, allowText: false, buttons: true,
    question: `팀 스킬 폴더(skills/)에 넣을까요?\n\nusers/dion/downloads/lang-skills/${name} → skills/${name}`,
    options: [{ label: '옮기기', value: 'yes' }, { label: '항상 허용', value: '__always' }, { label: '하지 않기', value: 'no' }],
    note: '스킬을 옮길 때 다시 묻지 않아요',
    details: [{ label: '파일 2개', text: 'x', noSize: true, open: [{ path: `users/dion/downloads/lang-skills/${name}/SKILL.md`, size: 8529 }, { path: `users/dion/downloads/lang-skills/${name}/references/a.md`, size: 120 }] }],
    batch: { key: 'skill:move:{"level":"team"}', one: '이 스킬을 팀 스킬로 옮길까요?', many: '스킬 {n}개를 팀 스킬로 옮길까요?', item: name, about: `${name} 설명`, summary: '팀 모두의 AI가 이 스킬을 따르게 돼요 (12명)', summaryMany: '팀 모두의 AI가 이 스킬들을 따르게 돼요 (12명)' },
  },
})

test('three skills: one lean card, no raw path by default, one press answers all (unticked first with its no)', async () => {
  installDom()
  const cards = [card(1, 'korean-landing-copy'), card(2, 'community-voice'), card(3, 'seo-notes')]
  const sent: { id: string; answer: unknown }[] = []
  useChats.setState({ requests: Object.fromEntries(cards.map((c) => [c.request.requestId, c])), answer: async (id: string, body: { answer?: unknown }) => { sent.push({ id, answer: body.answer }) } } as never)
  const m = await mount(<BatchCard cards={cards} />)
  try {
    await m.settle(CARD_JOIN_LOCK_MS + 50)
    expect(m.get('ask-batch-head').textContent).toBe('스킬 3개를 팀 스킬로 옮길까요?')
    expect([...m.container.querySelectorAll('[data-testid="ask-batch-name"]')].map((x) => x.textContent)).toEqual(['korean-landing-copy', 'community-voice', 'seo-notes'])
    expect(m.container.querySelectorAll('[data-testid="ask-batch-summary"]').length).toBe(1)
    expect(m.get('ask-batch-summary').textContent).toBe('팀 모두의 AI가 이 스킬들을 따르게 돼요 (12명)')
    expect(m.html()).not.toContain('users/dion')
    expect(m.container.querySelectorAll('[data-testid="ask-choice"]').length).toBe(3)
    // 자세히: the paths and the files, each openable
    await m.click('ask-details-toggle')
    expect(m.html()).toContain('users/dion/downloads/lang-skills/community-voice')
    expect(m.container.querySelectorAll('[data-testid="ask-detail-open-file"]').length).toBe(6)
    // untick the second, press 옮기기
    // (a browser unticks before the click's listeners run, past React's value tracker; this small DOM does not)
    const tick = m.container.querySelectorAll('[data-testid="ask-batch-tick"]')[1]!
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(tick), 'checked')!.set!.call(tick, false)
    await m.click(tick)
    await m.click(m.container.querySelector('[data-value="yes"]')!)
    expect(sent).toEqual([{ id: 'r2', answer: 'no' }, { id: 'r1', answer: 'yes' }, { id: 'r3', answer: 'yes' }])
  } finally {
    await m.unmount()
    removeDom()
  }
})

test('one skill alone still leads in plain words', async () => {
  installDom()
  const c = card(1, 'korean-landing-copy')
  useChats.setState({ requests: { r1: c } } as never)
  const m = await mount(<BatchCard cards={[c]} />)
  try {
    expect(m.get('ask-batch-head').textContent).toBe('이 스킬을 팀 스킬로 옮길까요?')
    expect(m.find('ask-batch-tick')).toBeNull()
    expect(m.get('ask-batch-summary').textContent).toBe('팀 모두의 AI가 이 스킬을 따르게 돼요 (12명)')
    expect(m.html()).not.toContain('users/dion')
  } finally {
    await m.unmount()
    removeDom()
  }
})

// One press never approves a card that was not on screen long enough to be seen (review of #475): a new rule is showing
// and, as the person presses, the AI raises a card to overwrite another rule
const live = async (first: ReturnType<typeof card>[]) => {
  let set: (c: ReturnType<typeof card>[]) => void = () => {}
  const sent: string[] = []
  const put = (cs: ReturnType<typeof card>[]) => useChats.setState({ requests: Object.fromEntries(cs.map((c) => [c.request.requestId, c])), answer: async (id: string) => { sent.push(id) } } as never)
  put(first)
  const Host = () => { const [cs, s] = useState(first); set = (x) => { put(x); s(x) }; return <BatchCard cards={cs} answerRunning /> }
  const m = await mount(<Host />)
  return { m, sent, join: async (cs: ReturnType<typeof card>[]) => { set(cs); await m.settle(20) } }
}
const inCall = (c: ReturnType<typeof card>) => ({ ...c, request: { ...c.request, expiresAt: new Date(Date.now() + 600_000).toISOString() } })

test('a mixed group: a card waiting in its call joins, the press waits, then covers what was seen', async () => {
  installDom()
  const a = card(1, 'r-new'), b = inCall(card(2, 'r-old'))
  const { m, sent, join } = await live([a])
  try {
    await m.settle(CARDS_GATHER_MS + 100)
    await join([a, b])
    await m.click('ask-choice')
    await m.settle(30)
    expect(sent).toEqual([])
    await m.settle(CARD_JOIN_LOCK_MS + 100)
    await m.click('ask-choice')
    await m.until(() => sent.length === 2, 'both sent')
    expect(sent).toEqual(['r1', 'r2'])
  } finally { await m.unmount(); removeDom() }
}, 15_000)

test('a card arriving at the click is not approved and stays open; repeated arrivals cannot lock the buttons for good', async () => {
  installDom()
  const cs = [1, 2, 3, 4, 5, 6, 7].map((i) => inCall(card(i, `r-${i}`)))
  const { m, sent, join } = await live([cs[0]!])
  try {
    await m.settle(100)
    // one more every second: past the cap the buttons work, for the cards seen long enough only
    for (let i = 2; i <= 6; i++) { await join(cs.slice(0, i)); await m.settle(980) }
    await join(cs.slice(0, 7))
    await m.click('ask-choice')
    await m.until(() => sent.length > 0, 'a press went through')
    await m.settle(50)
    expect(sent).toContain('r1')
    expect(sent).not.toContain('r7')
    expect(sent).not.toContain('r6')
  } finally { await m.unmount(); removeDom() }
}, 20_000)

test('Always waits until every card was seen (the server answers all open cards of its kind); a lone card that became a group is locked', async () => {
  installDom()
  const a = card(1, 'r-a'), b = card(2, 'r-b')
  const sent: string[] = []
  useChats.setState({ requests: { r1: a, r2: b }, answer: async (id: string) => { sent.push(id) } } as never)
  // (mounted with two cards and no answer running: a reconnect brought the second to a lone card)
  const m = await mount(<BatchCard cards={[a, b]} />)
  try {
    await m.click(m.container.querySelector('[data-value="__always"]')!)
    await m.click(m.container.querySelector('[data-value="yes"]')!)
    await m.settle(30)
    expect(sent).toEqual([])
    await m.settle(CARD_JOIN_LOCK_MS + 50)
    await m.click(m.container.querySelector('[data-value="__always"]')!)
    await m.until(() => sent.length === 2, 'both answered once seen')
  } finally { await m.unmount(); removeDom() }
}, 10_000)

test('joinLock: a run of arrivals locks for its cap at most; each card counts once it has been seen', () => {
  const t = 1_000_000
  expect(joinLock(new Map([['a', 0]]), t)).toMatchObject({ locked: false, next: null })
  const one = joinLock(new Map([['a', 0], ['b', t]]), t + 100)
  expect(one.locked).toBe(true)
  expect([...one.seen]).toEqual(['a'])
  expect(joinLock(new Map([['a', 0], ['b', t]]), t + CARD_JOIN_LOCK_MS).locked).toBe(false)
  const run = new Map([['a', 0], ['b', t], ['c', t + 1000], ['d', t + 2000], ['e', t + 3000], ['f', t + 3900]])
  expect(joinLock(run, t + 3950).locked).toBe(true)
  const past = joinLock(run, t + CARD_JOIN_LOCK_MAX_MS)
  expect(past.locked).toBe(false)
  expect([...past.seen].sort()).toEqual(['a', 'b', 'c', 'd'])
})
