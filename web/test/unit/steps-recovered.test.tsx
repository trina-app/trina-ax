// A failed step the AI got past is not red (docs/DECISIONS.md "A failed step the AI got past is not red"): the AI
// guessed a file name that does not exist and then read the right file, or a call failed and the next one worked. Such
// a step has a quiet mark (CircleMinus) whose tooltip and name say "안 됐지만 트리나가 다른 방법으로 이어 갔어요", and the
// folded list has no red mark, also when the answer failed later for another reason. While the answer runs a failed
// step is quiet too ("…찾고 있어요" until something after it works). Red: a failure nothing got past (a save that stayed
// undone, the step a failing answer ended on) and a dev environment command that did not run because it was full; a
// failed look-up under an answer that did not fail stays quiet. Opening a step still shows its detail.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Locale, MessageStatus, Step } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Steps, { showsFailures, stepMark, stepsGotPast, type MarkContext } from '../../src/components/chat/Steps'
import { AssistantMessage } from '../../src/components/chat/Messages'
import { aiName } from '../../src/lib/tabs'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const at = '2026-11-07T09:00:00.000Z'
const step = (o: Partial<Step> & Pick<Step, 'id' | 'label'>): Step => ({ kind: 'tool', tool: 'read', status: 'ok', startedAt: at, endedAt: at, ...o })
const guess = step({ id: 'g1', label: '파일 읽기 · shared/company/acme-profile.md', status: 'error' })
const found = step({ id: 'g2', label: '파일 읽기 · shared/company/acme-company-profile.md' })
const steps = [guess, found]
const save = step({ id: 'f1', tool: 'write', label: '파일 저장 · shared/company/summary.md', status: 'error' })
const ai = (l: Locale) => aiName((k) => translate(l, k))
/** as React writes an attribute ("Didn't" → "Didn&#x27;t") */
const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
const ctx = (list: Step[], o: { live?: boolean; answerFailed?: boolean } = {}): MarkContext => ({ live: o.live ?? false, answerFailed: o.answerFailed ?? false, gotPast: stepsGotPast(list) })

describe('which failed steps the AI got past (stepsGotPast)', () => {
  test('a later step of the main AI that worked', () => {
    expect([...stepsGotPast(steps)]).toEqual(['g1'])
    expect([...stepsGotPast([found, guess])]).toEqual([])
  })

  test('thinking and attached-file notes are no work done; a later failure is none either', () => {
    const think = step({ id: 't1', kind: 'thinking', tool: undefined, label: 'Thinking' })
    const note = step({ id: 'n1', tool: 'attachment', label: 'changed' })
    expect(stepsGotPast([guess, think, note]).size).toBe(0)
    expect(stepsGotPast([guess, { ...save, id: 'f2' }]).size).toBe(0)
  })

  test('a sub-agent\'s step: a later step of the same sub-agent or of the main AI, or its finished sub-task', () => {
    const a1 = step({ id: 'A1', tool: 'agent', label: 'Sub-task: compare', status: 'running', endedAt: null })
    const b1 = step({ id: 'B1', tool: 'agent', label: 'Sub-task: draft', status: 'running', endedAt: null })
    const kid = (id: string, parentId: string, status: Step['status'] = 'ok') => step({ id, parentId, label: `read ${id}`, status })
    // another sub-agent's step that worked does not count
    expect(stepsGotPast([a1, b1, kid('k1', 'A1', 'error'), kid('k2', 'B1')]).has('k1')).toBe(false)
    expect(stepsGotPast([a1, kid('k1', 'A1', 'error'), kid('k2', 'A1')]).has('k1')).toBe(true)
    expect(stepsGotPast([a1, kid('k1', 'A1', 'error'), found]).has('k1')).toBe(true)
    expect(stepsGotPast([{ ...a1, status: 'ok' }, kid('k1', 'A1', 'error')]).has('k1')).toBe(true)
    // the main AI's failure is not got past by a sub-agent's step alone
    expect(stepsGotPast([guess, a1, kid('k2', 'A1')]).has('g1')).toBe(false)
  })
})

describe('the mark (stepMark)', () => {
  test('a failure the AI got past is quiet in a finished, a stopped and a failed answer', () => {
    for (const answerFailed of [false, true]) expect(stepMark(guess, ctx(steps, { answerFailed }))).toBe('retried')
  })

  test('while the answer runs a failure is quiet; if the answer then fails on it, it turns red', () => {
    expect(stepMark(save, ctx([save], { live: true }))).toBe('retried')
    expect(stepMark(save, ctx([save], { answerFailed: true }))).toBe('failed')
  })

  test('a save that nothing got past is red, also in an answer that finished', () => {
    expect(stepMark(save, ctx([found, save]))).toBe('failed')
  })

  test('a failed look-up nothing got past: quiet under an answer that did not fail, red when the answer failed', () => {
    const search = step({ id: 'w1', kind: 'web_search', tool: 'web_search', label: '웹 검색 "acme"', status: 'error' })
    for (const s of [guess, search, { ...guess, id: 'g5', tool: 'grep' }]) {
      expect(stepMark(s, ctx([s]))).toBe('retried')
      expect(stepMark(s, ctx([s], { answerFailed: true }))).toBe('failed')
    }
  })

  test('the dev environment was full: red, also while the answer runs; a command the person cancelled: theirs', () => {
    const full = step({ id: 'q1', tool: 'box_shell', label: 'box_shell npm test', status: 'error', devEnvRun: { id: 'r1', kind: 'command', state: 'expired', position: null } })
    expect(stepMark(full, ctx([full, found], { live: true }))).toBe('failed')
    expect(stepMark(full, ctx([full, found]))).toBe('failed')
    const cancelled = { ...full, devEnvRun: { ...full.devEnvRun!, state: 'cancelled' as const } }
    expect(stepMark(cancelled, ctx([cancelled]))).toBe('cancelled')
  })

  test('the limit or Stop cut a step off: paused or stopped, never failed; the other marks stay', () => {
    expect(stepMark({ ...save, paused: true }, ctx([save], { answerFailed: true }))).toBe('paused')
    expect(stepMark({ ...save, stopped: true }, ctx([save], { answerFailed: true }))).toBe('stopped')
    expect(stepMark(found, ctx(steps, { answerFailed: true }))).toBe('done')
    expect(stepMark({ ...found, status: 'running' }, ctx(steps, { live: true }))).toBe('running')
    expect(stepMark({ ...found, tool: 'attachment' }, ctx(steps, { answerFailed: true }))).toBe('note')
  })

  test('the folded list\'s red mark: only for a red step', () => {
    expect(showsFailures(steps, false)).toBe(false)
    expect(showsFailures(steps, true)).toBe(false)
    expect(showsFailures([found, save], false)).toBe(true)
    expect(showsFailures([found, guess], true)).toBe(true)
    expect(showsFailures([{ ...save, paused: true }, { ...save, id: 'f9', stopped: true }], true)).toBe(false)
  })
})

describe('on screen', () => {
  const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
  const before = useLocaleStore.getInitialState().locale

  test('still running: the quiet mark says the AI is trying another way, then that it went on once a later step worked', () => {
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      setLocale(l)
      const trying = renderToStaticMarkup(<Steps steps={[guess]} streaming />)
      expect(trying).toContain('data-testid="step-retried"')
      expect(trying).toContain(`aria-label="${attr(translate(l, 'steps.retrying', { ai: ai(l) }))}"`)
      expect(trying).not.toContain('text-danger')
      const went = renderToStaticMarkup(<Steps steps={steps} streaming />)
      expect(went).toContain(`aria-label="${attr(translate(l, 'steps.retried', { ai: ai(l) }))}"`)
      expect(went).not.toContain(`aria-label="${attr(translate(l, 'steps.failed'))}"`)
    }
    setLocale(before)
  })

  test('the Korean words name the AI', () => {
    expect(translate('ko', 'steps.retried', { ai: '트리나' })).toBe('안 됐지만 트리나가 다른 방법으로 이어 갔어요')
    expect(translate('ko', 'steps.retrying', { ai: '트리나' })).toBe('안 돼서 트리나가 다른 방법을 찾고 있어요')
  })

  test('a sub-task row\'s name carries its mark\'s words (its name replaces its contents)', () => {
    setLocale('en')
    const sub = step({ id: 'A1', tool: 'agent', label: 'Sub-task: compare', status: 'error', subtask: { toolUses: 2 } })
    const kid = step({ id: 'k1', parentId: 'A1', label: 'read a.md' })
    expect(renderToStaticMarkup(<Steps steps={[sub, kid, found]} streaming />)).toContain(`aria-label="Sub-task: compare · ${attr(translate('en', 'steps.retried', { ai: ai('en') }))} · Show the sub-task&#x27;s steps"`)
    expect(renderToStaticMarkup(<Steps steps={[{ ...sub, status: 'ok' }, kid]} streaming />)).toContain('aria-label="Sub-task: compare · Show the sub-task&#x27;s steps"')
    setLocale(before)
  })
})

describe('under an answer (AssistantMessage)', () => {
  const before = useLocaleStore.getState().locale
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'ko' })
  })
  afterAll(() => {
    removeDom()
    useLocaleStore.setState({ locale: before })
  })
  const answer = (status: MessageStatus, list: Step[] = steps) => (
    <MemoryRouter>
      <AssistantMessage m={msg({ role: 'assistant', content: status === 'error' ? '' : '회사 소개를 정리했어요.', steps: list, status, ...(status === 'error' ? { error: { code: 'engine_unavailable', message: 'x' } } : {}) })} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} />
    </MemoryRouter>
  )

  for (const status of ['done', 'stopped', 'error'] as const) {
    test(`${status}: the guess the AI got past has the quiet mark and its words, the list no red mark`, async () => {
      const m = await mount(answer(status))
      try {
        expect(m.find('steps-failed')).toBeNull()
        await m.click(m.get('steps').querySelector('button')!)
        expect(m.get('step-retried').getAttribute('aria-label')).toBe(translate('ko', 'steps.retried', { ai: ai('ko') }))
        expect(m.find('step-failed')).toBeNull()
      } finally { await m.unmount() }
    })
  }

  for (const status of ['done', 'error'] as const) {
    test(`${status}: a save nothing got past stays red, on the row and on the folded list`, async () => {
      const m = await mount(answer(status, [found, save]))
      try {
        expect(m.get('steps-failed').getAttribute('aria-label')).toBe(translate('ko', 'steps.someFailed'))
        await m.click(m.get('steps').querySelector('button')!)
        expect(m.get('step-failed').getAttribute('aria-label')).toBe(translate('ko', 'steps.failed'))
        expect(m.find('step-retried')).toBeNull()
      } finally { await m.unmount() }
    })
  }

  test('opening a failed step the AI got past still shows its detail', async () => {
    const refused = step({ id: 'w1', kind: 'web_search', tool: 'web_search', label: '웹 검색 "acme"', status: 'error', detail: '거절됨: 검색으로는 그 검색의 결과만 열 수 있어요.' })
    const m = await mount(answer('done', [refused, found]))
    try {
      await m.click(m.get('steps').querySelector('button')!)
      expect(m.html()).not.toContain('거절됨')
      await m.click(m.get('step-retried').closest('button')!)
      expect(m.html()).toContain('거절됨: 검색으로는 그 검색의 결과만 열 수 있어요.')
    } finally { await m.unmount() }
  })
})
