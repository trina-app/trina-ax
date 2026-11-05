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
import { AssistantMessage } from '../../src/components/chat/Messages'
import { CHAT, msg, step } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const TASKS = 'skills/general/meeting-tasks/SKILL.md'
const receipt = (over: Partial<NonNullable<Message['receipt']>> = {}): NonNullable<Message['receipt']> => ({ skill: { path: TASKS, name: 'meeting-tasks' }, teamFiles: 2, ...over })
const steps: Step[] = [step({ id: 's1', label: 'read 11월 1주 회의.md' }), step({ id: 's2', label: 'read 11월 2주 회의.md' })]
let listed = 0

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const realFetch = globalThis.fetch
const before = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    if (key === 'GET /api/skills') { listed++; return json(200, { items: [{ path: TASKS, name: 'meeting-tasks', title: '할 일 정리', description: '할 일 정리 — 회의록에서 사람별 할 일' }] }) }
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
