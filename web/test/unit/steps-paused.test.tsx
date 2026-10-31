// A step the per-answer time limit cut off (Step.paused) shows as paused like the answer, not as a failure; one the
// person's Stop cut off (Step.stopped) as stopped. Both say so in words next to the label, not only to a screen reader
// (QA 0.2.12 N3: "여기서 중지됨" was only the icon's aria-label).
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Locale, Step } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Steps from '../../src/components/chat/Steps'

const step = (o: Partial<Step>): Step => ({ id: 's1', kind: 'tool', tool: 'read', label: 'read applications/21.pdf', status: 'ok', startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:20:00.000Z', ...o })
const paused = step({ status: 'error', paused: true })
const failed = step({ id: 's2', tool: 'grep', label: 'grep "x"', status: 'error' })
// Server rendering reads the store's initial state: set the language there
const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale
afterEach(() => setLocale(before))

describe('a step the time limit paused', () => {
  for (const locale of ['ko', 'en'] as const) {
    test(`${locale}: paused, not failed`, () => {
      setLocale(locale)
      // the rows as they show (live rendering lists every row without a click)
      const rows = renderToStaticMarkup(<Steps steps={[paused]} streaming />)
      expect(rows).toContain(`<span class="shrink-0 text-xs text-muted" data-testid="step-cut">${translate(locale, 'steps.paused')}</span>`)
      expect(rows).toContain('data-testid="step-paused"')
      expect(rows).not.toContain(`aria-label="${translate(locale, 'steps.failed')}"`)
      // folded under the finished answer: no "some steps failed" mark for it, but still for a real failure
      expect(renderToStaticMarkup(<Steps steps={[paused]} streaming={false} />)).not.toContain('data-testid="steps-failed"')
      expect(renderToStaticMarkup(<Steps steps={[paused, failed]} streaming={false} />)).toContain(`aria-label="${translate(locale, 'steps.someFailed')}"`)
    })
  }

  test('a failed step without the mark stays a failure', () => {
    setLocale('en')
    const rows = renderToStaticMarkup(<Steps steps={[failed]} streaming />)
    expect(rows).toContain('aria-label="Failed"')
    expect(rows).not.toContain('Paused here')
    expect(rows).not.toContain('data-testid="step-cut"')
  })
})

describe('a step the person\'s Stop cut off', () => {
  const stopped = step({ id: 's3', status: 'error', stopped: true })
  for (const locale of ['ko', 'en'] as const) {
    test(`${locale}: stopped, not failed`, () => {
      setLocale(locale)
      const rows = renderToStaticMarkup(<Steps steps={[stopped]} streaming />)
      expect(rows).toContain(`<span class="shrink-0 text-xs text-muted" data-testid="step-cut">${translate(locale, 'steps.stopped')}</span>`)
      expect(rows).toContain('data-testid="step-stopped"')
      // the words are on screen once: the icon itself is not read out again
      expect(rows.split(translate(locale, 'steps.stopped')).length).toBe(2)
      expect(rows).not.toContain(`aria-label="${translate(locale, 'steps.failed')}"`)
      expect(renderToStaticMarkup(<Steps steps={[stopped]} streaming={false} />)).not.toContain('data-testid="steps-failed"')
      expect(renderToStaticMarkup(<Steps steps={[stopped, failed]} streaming={false} />)).toContain(`aria-label="${translate(locale, 'steps.someFailed')}"`)
    })
  }
})

describe('a sub-task the Stop cut off', () => {
  test('its row says so on screen and in the name the button reads out', () => {
    setLocale('en')
    const sub = step({ id: 'a1', kind: 'tool', tool: 'agent', label: 'Sub-task: compare reports', status: 'error', stopped: true, subtask: { toolUses: 2 } })
    const kid = step({ id: 'k1', parentId: 'a1' })
    const rows = renderToStaticMarkup(<Steps steps={[sub, kid]} streaming />)
    expect(rows).toContain('data-testid="step-cut">Stopped here</span>')
    expect(rows).toContain('aria-label="Sub-task: compare reports · Stopped here · Show the sub-task&#x27;s steps"')
  })
})
