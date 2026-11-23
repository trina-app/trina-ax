// Cards of one kind from one answer as ONE card (components/chat/AskCard.tsx BatchCard, lib/cardBatch.ts). The owner,
// 2026-11-23: "스킬 여러개 만들라고 하니깐 한번에 저렇게 다 띄워 버리네". Three skills to the team: one head line, each skill
// on a line (name, description), the summary once, no path in the default view, one set of buttons; one press answers
// all three, an unticked one gets its card's no first; 자세히 shows the paths and the files.
import { expect, test } from 'bun:test'
import type { TurnRequest } from '@mycel/shared/api'
import { BatchCard } from '../../src/components/chat/AskCard'
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
