// A failed step the AI got past is not red (docs/DECISIONS.md "A failed step the AI got past is not red"): the AI
// guessed a file name that does not exist and then read the right file, or a call failed and the next one worked. While
// the answer runs and once it finished (or the person stopped it), such a step has a quiet "went another way" mark
// whose tooltip and name say "안 돼서 트리나가 다른 방법으로 다시 했어요", and the folded list has no red mark. Only a failed
// answer (an interrupted one too) keeps the red: the step's ⓘ and the folded list's mark. Opening a step still shows its
// detail.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Locale, MessageStatus, Step } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Steps, { showsFailures, stepMark } from '../../src/components/chat/Steps'
import { AssistantMessage } from '../../src/components/chat/Messages'
import { aiName } from '../../src/lib/tabs'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const at = '2026-11-07T09:00:00.000Z'
const step = (o: Partial<Step> & Pick<Step, 'id' | 'label'>): Step => ({ kind: 'tool', tool: 'read', status: 'ok', startedAt: at, endedAt: at, ...o })
const guess = step({ id: 'g1', label: '파일 읽기 · shared/company/acme-profile.md', status: 'error' })
const found = step({ id: 'g2', label: '파일 읽기 · shared/company/acme-company-profile.md' })
const steps = [guess, found]
const ai = (l: Locale) => aiName((k) => translate(l, k))
/** as React writes an attribute ("Didn't" → "Didn&#x27;t") */
const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

describe('the rule (stepMark)', () => {
  test('a failed step: red only when the answer failed', () => {
    expect(stepMark(guess, { live: false, answerFailed: false })).toBe('retried')
    expect(stepMark(guess, { live: true, answerFailed: false })).toBe('retried')
    expect(stepMark(guess, { live: false, answerFailed: true })).toBe('failed')
  })

  test('the limit or Stop cut a step off: paused or stopped, never failed, in a failed answer too', () => {
    expect(stepMark({ ...guess, paused: true }, { live: false, answerFailed: true })).toBe('paused')
    expect(stepMark({ ...guess, stopped: true }, { live: false, answerFailed: true })).toBe('stopped')
  })

  test('the other marks stay', () => {
    expect(stepMark(found, { live: false, answerFailed: true })).toBe('done')
    expect(stepMark({ ...found, status: 'running' }, { live: true, answerFailed: false })).toBe('running')
    expect(stepMark({ ...found, tool: 'attachment' }, { live: false, answerFailed: true })).toBe('note')
  })

  test('the folded list\'s red mark: a failed answer with a failed step only', () => {
    expect(showsFailures(steps, false)).toBe(false)
    expect(showsFailures(steps, true)).toBe(true)
    expect(showsFailures([found], true)).toBe(false)
    expect(showsFailures([{ ...guess, paused: true }, { ...guess, id: 'g9', stopped: true }], true)).toBe(false)
  })
})

describe('on screen', () => {
  const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
  const before = useLocaleStore.getInitialState().locale

  test('still running: the quiet mark that says the AI is trying another way, no red', () => {
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      setLocale(l)
      const rows = renderToStaticMarkup(<Steps steps={steps} streaming />)
      expect(rows).toContain('data-testid="step-retried"')
      expect(rows).toContain(`aria-label="${attr(translate(l, 'steps.retrying', { ai: ai(l) }))}"`)
      expect(rows).not.toContain('text-danger')
      expect(rows).not.toContain(`aria-label="${attr(translate(l, 'steps.failed'))}"`)
    }
    setLocale(before)
  })

  test('the Korean words name the AI', () => {
    expect(translate('ko', 'steps.retried', { ai: '트리나' })).toBe('안 돼서 트리나가 다른 방법으로 다시 했어요')
    expect(translate('ko', 'steps.retrying', { ai: '트리나' })).toBe('안 돼서 트리나가 다른 방법을 찾고 있어요')
  })

  test('finished or stopped by the person: no red mark on the folded list', () => {
    setLocale('ko')
    for (const html of [renderToStaticMarkup(<Steps steps={steps} streaming={false} />), renderToStaticMarkup(<Steps steps={steps} streaming={false} failed={false} />)]) {
      expect(html).not.toContain('data-testid="steps-failed"')
      expect(html).not.toContain('text-danger')
    }
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

  for (const status of ['done', 'stopped'] as const) {
    test(`${status}: the failed guess has the quiet mark and its words, the list no red mark`, async () => {
      const m = await mount(answer(status))
      try {
        expect(m.find('steps-failed')).toBeNull()
        await m.click(m.get('steps').querySelector('button')!)
        const mark = m.get('step-retried')
        expect(mark.getAttribute('aria-label')).toBe(translate('ko', 'steps.retried', { ai: ai('ko') }))
        expect(m.find('step-failed')).toBeNull()
        expect(m.get('steps').querySelectorAll('[data-testid="step-retried"]').length).toBe(1)
      } finally { await m.unmount() }
    })
  }

  test('error: the failed step and the folded list stay red', async () => {
    const m = await mount(answer('error'))
    try {
      expect(m.get('steps-failed').getAttribute('aria-label')).toBe(translate('ko', 'steps.someFailed'))
      await m.click(m.get('steps').querySelector('button')!)
      expect(m.get('step-failed').getAttribute('aria-label')).toBe(translate('ko', 'steps.failed'))
      expect(m.find('step-retried')).toBeNull()
    } finally { await m.unmount() }
  })

  test('opening a failed step the AI got past still shows its detail', async () => {
    const refused = step({ id: 'w1', kind: 'web_search', tool: 'web_search', label: '웹 검색 "acme"', status: 'error', detail: '거절됨: 검색으로는 그 검색의 결과만 열 수 있어요.' })
    const m = await mount(answer('done', [refused, found]))
    try {
      await m.click(m.get('steps').querySelector('button')!)
      expect(m.html()).not.toContain('거절됨')
      const row = m.get('step-retried').closest('button')!
      await m.click(row as never)
      expect(m.html()).toContain('거절됨: 검색으로는 그 검색의 결과만 열 수 있어요.')
    } finally { await m.unmount() }
  })
})
