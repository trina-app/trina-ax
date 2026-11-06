// The receipt under an answer that ran a team skill on team files (Message.receipt; docs/DECISIONS.md "M — One meeting
// note, everyone's own tasks"): the folded step summary reads "팀 스킬 '할 일 정리' · 팀 파일 2개" instead of "작업 N단계"
// and still opens the steps; the skill's title comes from the team's skill list (its recorded name until then, or when
// the person cannot see it); an answer without steps shows the same words as plain text; no team file, or an answer
// still being written, keeps the usual summary.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Message, Step } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Steps from '../../src/components/chat/Steps'
import { AssistantMessage, UserMessage, UserText } from '../../src/components/chat/Messages'
import { composeSkillMessage, formAnswers } from '../../src/lib/skillForm'
import { CHAT, msg, step } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const TASKS = 'skills/general/meeting-tasks/SKILL.md'
const receipt = (over: Partial<NonNullable<Message['receipt']>> = {}): NonNullable<Message['receipt']> => ({ skill: { path: TASKS, name: 'meeting-tasks' }, teamFiles: 2, ...over })
const steps: Step[] = [step({ id: 's1', label: 'read 11월 1주 회의.md' }), step({ id: 's2', label: 'read 11월 2주 회의.md' })]
let listed = 0
const CARD_INPUTS = [
  { name: 'topic', label: '주제', placeholder: '비워 두면 회사 소개 전체' },
  { name: 'channel', label: '어디에 올릴까요', type: 'choice' as const, default: 'instagram', options: [{ value: 'instagram', label: '인스타그램' }, { value: 'blog', label: '블로그' }] },
  { name: 'notes', label: '더 넣을 말', multiline: true },
]
const CARDS = { path: 'skills/general/card-news/SKILL.md', name: 'card-news', title: '카드뉴스', description: '카드뉴스 — 회사 소개로 카드 5장', inputs: CARD_INPUTS }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const realFetch = globalThis.fetch
const before = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    if (key === 'GET /api/skills') { listed++; return json(200, { items: [{ path: TASKS, name: 'meeting-tasks', title: '할 일 정리', description: '할 일 정리 — 회의록에서 사람별 할 일' }, CARDS] }) }
    return json(404, { error: { code: 'not_found', message: key } })
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before })
})

describe('the receipt', () => {
  test('in place of "작업 N단계": the skill by its title and how many team files; it still opens the steps', async () => {
    const m = await mount(<Steps steps={steps} streaming={false} receipt={receipt()} />)
    try {
      await m.until(() => m.find('steps-receipt')?.textContent === "팀 스킬 '할 일 정리' · 팀 파일 2개", 'the title')
      expect(m.html()).not.toContain(translate('ko', 'steps.summary', { n: 2 }))
      await m.click(m.get('steps').querySelector('button')!)
      expect(m.html()).toContain('read 11월 1주 회의.md')
    } finally { await m.unmount() }
  })

  test('a skill the list does not have shows its recorded name; the list is asked once', async () => {
    const m = await mount(<Steps steps={steps} streaming={false} receipt={receipt({ skill: { path: 'skills/other/x/SKILL.md', name: 'x' } })} />)
    try {
      await m.settle(30)
      expect(m.get('steps-receipt').textContent).toBe("팀 스킬 'x' · 팀 파일 2개")
      expect(listed).toBe(1)
    } finally { await m.unmount() }
  })

  test('no steps: the same words as plain text; no team file or still writing: the usual summary', async () => {
    let m = await mount(<Steps steps={[]} streaming={false} receipt={receipt({ teamFiles: 3 })} />)
    try {
      await m.until(() => m.find('steps-receipt')?.textContent === "팀 스킬 '할 일 정리' · 팀 파일 3개", 'the plain line')
      expect(m.get('steps-receipt').tagName).toBe('P')
    } finally { await m.unmount() }
    m = await mount(<Steps steps={steps} streaming={false} receipt={receipt({ teamFiles: 0 })} />)
    try {
      expect(m.find('steps-receipt')).toBeNull()
      expect(m.html()).toContain(translate('ko', 'steps.summary', { n: 2 }))
    } finally { await m.unmount() }
    m = await mount(<Steps steps={steps} streaming receipt={receipt()} />)
    try {
      expect(m.find('steps-receipt')).toBeNull()
    } finally { await m.unmount() }
    m = await mount(<Steps steps={[]} streaming={false} />)
    try {
      expect(m.find('steps')).toBeNull()
      expect(m.find('steps-receipt')).toBeNull()
    } finally { await m.unmount() }
  })

  test('the answer passes its receipt on (the lead\'s and every member\'s answers alike)', async () => {
    const m = await mount(
      <MemoryRouter>
        <AssistantMessage m={{ ...msg({ role: 'assistant', content: '## 민지\n- 시안 금요일까지', steps }), receipt: receipt() }} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} />
      </MemoryRouter>,
    )
    try {
      await m.until(() => m.find('steps-receipt')?.textContent === "팀 스킬 '할 일 정리' · 팀 파일 2개", 'the receipt')
    } finally { await m.unmount() }
  })
})

// A question that runs a skill reads as the skill's title (a chip) and the question; the command is what was sent
// ("/meeting-tasks …" in the transcript, copy and edit) and what runs.
describe('a question that runs a skill', () => {
  test('"/meeting-tasks 이 회의록으로…" shows the chip "할 일 정리" and the question; a form\'s lines follow the chip', async () => {
    let m = await mount(<UserText content="/meeting-tasks 이 회의록으로 이번 주 할 일, 사람별로 정리해 줘" clamp />)
    try {
      await m.until(() => m.find('skill-chip'), 'the chip')
      expect(m.get('skill-chip').textContent).toBe('할 일 정리')
      expect(m.get('user-text-skill').textContent).toBe('할 일 정리이 회의록으로 이번 주 할 일, 사람별로 정리해 줘')
      expect(m.html()).not.toContain('/meeting-tasks 이')
    } finally { await m.unmount() }
    m = await mount(<UserText content={'/meeting-tasks\n누구 할 일: 내 할 일만'} clamp />)
    try {
      await m.until(() => m.find('skill-chip'), 'the chip')
      expect(m.get('user-text-skill').textContent).toBe('할 일 정리누구 할 일: 내 할 일만')
    } finally { await m.unmount() }
  })

  // docs/DECISIONS.md "W3": a member's form run read "어디에 올릴까요: 인스타그램" in their own bubble, as if typed
  test('a form run reads back its answers; typed text after the command is no form', () => {
    const sent = composeSkillMessage('card-news', CARD_INPUTS, { channel: 'instagram', topic: '신제품 출시', notes: '첫 줄\n\n둘째 줄' })
    expect(sent).toBe('/card-news\n주제: 신제품 출시\n\n어디에 올릴까요: 인스타그램\n\n더 넣을 말:\n첫 줄\n\n둘째 줄')
    expect(formAnswers(sent.slice('/card-news\n'.length), CARD_INPUTS)).toEqual([
      { label: '주제', value: '신제품 출시' }, { label: '어디에 올릴까요', value: '인스타그램' }, { label: '더 넣을 말', value: '첫 줄\n\n둘째 줄' },
    ])
    expect(formAnswers('어디에 올릴까요: 인스타그램', CARD_INPUTS)).toEqual([{ label: '어디에 올릴까요', value: '인스타그램' }])
    for (const typed of ['인스타그램용으로 만들어 줘', '이번엔\n어디에 올릴까요: 블로그', '', '어디에 올릴까요:   ']) expect({ typed, a: formAnswers(typed, CARD_INPUTS) }).toEqual({ typed, a: null })
    expect(formAnswers('주제: x', undefined)).toBeNull()
  })

  test('a form run shows the skill and the answers as one quiet line, not a typed message; typed text keeps its bubble', async () => {
    const noop = () => {}
    const at = (content: string) => <MemoryRouter><UserMessage m={{ ...msg({ role: 'user', content }), local: undefined } as never} chatId={CHAT} busy={false} onEdit={noop} onSelectBranch={noop} /></MemoryRouter>
    let m = await mount(at('/card-news\n주제: 신제품 출시\n\n어디에 올릴까요: 인스타그램'))
    try {
      await m.until(() => m.find('user-form-run'), 'the run')
      expect(m.get('skill-chip').textContent).toBe('카드뉴스')
      expect(m.get('user-form-answers').textContent).toBe('주제: 신제품 출시 · 어디에 올릴까요: 인스타그램')
      // the labels are read out and are the tooltips, not printed in the line
      expect(m.get('user-form-answers').innerHTML).toContain('title="어디에 올릴까요"')
      expect(m.find('user-text')).toBeNull()
    } finally { await m.unmount() }
    // short answers show in full, with nothing to unfold
    m = await mount(at('/card-news\n어디에 올릴까요: 인스타그램'))
    try {
      await m.until(() => m.find('user-form-run'), 'the run')
      expect(m.get('user-form-answers').className).not.toContain('line-clamp')
      expect(m.find('user-form-answers-toggle')).toBeNull()
    } finally { await m.unmount() }
    // long answers (or several lines) fold to two lines; "전체 보기" lists each answer under its label, "접기" folds again
    const long = '/card-news\n주제: ' + '신제품 출시 소식과 고객 사례를 함께 '.repeat(8).trim() + '\n\n어디에 올릴까요: 블로그\n\n더 넣을 말:\n첫 줄\n둘째 줄'
    m = await mount(at(long))
    try {
      await m.until(() => m.find('user-form-run'), 'the run')
      expect(m.get('user-form-answers').className).toContain('line-clamp-2')
      expect(m.get('user-form-answers-toggle').textContent).toBe('전체 보기')
      expect(m.get('user-form-answers-toggle').getAttribute('aria-expanded')).toBe('false')
      await m.click('user-form-answers-toggle')
      expect(m.get('user-form-answers').getAttribute('data-open')).toBe('true')
      expect(m.get('user-form-answers').textContent).toBe('주제' + '신제품 출시 소식과 고객 사례를 함께 '.repeat(8).trim() + '어디에 올릴까요블로그더 넣을 말첫 줄\n둘째 줄')
      expect(m.get('user-form-answers-toggle').textContent).toBe('접기')
      await m.click('user-form-answers-toggle')
      expect(m.get('user-form-answers').getAttribute('data-open')).toBeNull()
    } finally { await m.unmount() }
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) expect([translate(l, 'chat.showAll'), translate(l, 'chat.showLess')].every((x) => x && !x.startsWith('chat.'))).toBe(true)
    m = await mount(at('/card-news 인스타그램용으로 5장'))
    try {
      await m.until(() => m.find('skill-chip'), 'the chip')
      expect(m.find('user-form-run')).toBeNull()
      expect(m.get('user-text').textContent).toContain('인스타그램용으로 5장')
    } finally { await m.unmount() }
  })

  test('a command no skill of the person\'s has, or plain text, stays as typed', async () => {
    for (const text of ['/etc/hosts 열어 줘', '/nope 해 줘', '회의록 정리해 줘']) {
      const m = await mount(<UserText content={text} clamp />)
      try {
        await m.settle(30)
        expect({ text, chip: !!m.find('skill-chip'), shown: m.container.textContent }).toEqual({ text, chip: false, shown: text })
      } finally { await m.unmount() }
    }
  })
})
