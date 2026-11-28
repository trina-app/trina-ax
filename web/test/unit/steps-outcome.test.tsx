// Each call says what it did, like Claude Code (docs/decisions/20261124-step-key-input.md): a few words beside its line
// for what came back ("10 results", "Declined", "Didn't work": never only an icon), and a run of calls of one tool folds
// into one row that opens to each call's input.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Locale, Step } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Steps, { foldRuns, outcomeWords, runHead, runRest, stepMark } from '../../src/components/chat/Steps'

const step = (o: Partial<Step>): Step => ({ id: 's1', kind: 'tool', tool: 'my_bright__search_engine', label: 'Bright Data · Search Engine · "YC Korea founders 2025"', status: 'ok', startedAt: '2026-11-24T10:00:00.000Z', endedAt: '2026-11-24T10:00:02.000Z', ...o })
const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale
afterEach(() => setLocale(before))
const t = (k: string, v?: Record<string, unknown>) => translate('en', k as never, v as never)
const outcome = (rows: string) => [...rows.matchAll(/data-testid="step-outcome">([^<]*)</g)].map((m) => m[1]!.replace(/&#x27;/g, "'"))

describe('what a call came back with, in words', () => {
  test('a count, an end, a failure the AI got past', () => {
    expect(outcomeWords(step({ outcome: { count: 10 } }), 'done', t)).toBe('10 results')
    expect(outcomeWords(step({ status: 'error', outcome: { end: 'declined' } }), 'retried', t)).toBe('Declined')
    expect(outcomeWords(step({ status: 'error', outcome: { end: 'unanswered' } }), 'failed', t)).toBe('No answer')
    // a waiting card its person went past with a new message (docs/decisions/20261128-stale-approval-cards.md)
    expect(outcomeWords(step({ status: 'ok', outcome: { end: 'moved_on' } }), 'unanswered', t)).toBe('Not done: the chat moved on without an answer')
    expect(stepMark(step({ status: 'ok', outcome: { end: 'moved_on' } }), { live: false, gotPast: new Set(), answerFailed: false })).toBe('unanswered')
    // a service error the AI got past: the quiet words, red "Failed" only for one nothing got past
    expect(outcomeWords(step({ status: 'error', outcome: { end: 'failed' } }), 'retried', t)).toBe("Didn't work")
    expect(outcomeWords(step({ status: 'error', outcome: { end: 'failed' } }), 'failed', t)).toBe('Failed')
    expect(outcomeWords(step({ status: 'ok', outcome: { end: 'skipped' } }), 'done', t)).toBe('Skipped')
    expect(outcomeWords(step({ status: 'error', outcome: { end: 'refused' } }), 'failed', t)).toBe('Not allowed')
    // no outcome from the server: the mark itself in words (the minus icon was a tooltip only)
    expect(outcomeWords(step({ status: 'error' }), 'retried', t)).toBe("Didn't work")
    expect(outcomeWords(step({ status: 'error' }), 'failed', t)).toBe('Failed')
    expect(outcomeWords(step({}), 'done', t)).toBe('')
  })

  for (const locale of ['en', 'ko'] as const) {
    test(`${locale}: shown beside the line`, () => {
      setLocale(locale)
      const rows = renderToStaticMarkup(<Steps steps={[step({ outcome: { count: 3 } }), step({ id: 's2', status: 'error', outcome: { end: 'declined' } }), step({ id: 's3', status: 'error' })]} streaming />)
      expect(outcome(rows)).toEqual([translate(locale, 'steps.results', { n: 3 }), translate(locale, 'steps.endDeclined'), translate(locale, 'steps.retriedShort')])
      expect(rows).toContain('YC Korea founders 2025')
    })
  }

  test('a web search keeps its own count, a sub-task its own words', () => {
    setLocale('en')
    const rows = renderToStaticMarkup(<Steps steps={[step({ kind: 'web_search', tool: 'WebSearch', label: 'Web search: x', sources: [{ title: 'a', url: 'https://a.test' }], outcome: { count: 9 } })]} streaming />)
    expect(outcome(rows)).toEqual([])
  })
})

describe('runs of one tool fold', () => {
  const run = Array.from({ length: 12 }, (_, i) => step({ id: `r${i}`, label: `Bright Data · Search Engine · "query ${i}"`, ...(i === 3 ? { status: 'error' as const } : {}) }))
  test('three or more in a row of one tool; anything else stays a row', () => {
    const other = step({ id: 'o', tool: 'read', label: 'Read · a.md' })
    const two = [step({ id: 'x1', tool: 'my_bright__scrape_as_markdown', label: 'Bright Data · Scrape as Markdown · a.com' }), step({ id: 'x2', tool: 'my_bright__scrape_as_markdown', label: 'Bright Data · Scrape as Markdown · b.com' })]
    const items = foldRuns([...run, other, ...two])
    expect(items.map((it) => ('run' in it ? `run:${it.run.length}` : it.step.id))).toEqual(['run:12', 'o', 'x1', 'x2'])
    // a sub-task, a memory or a post never folds
    expect(foldRuns([step({ id: 'a', tool: 'agent' }), step({ id: 'b', tool: 'agent' }), step({ id: 'c', tool: 'agent' })]).every((it) => 'step' in it)).toBe(true)
  })

  test('a teammate\'s view (the generic word, no tool name) folds by its line', () => {
    const generic = Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, kind: 'tool' as const, label: 'Step', status: 'ok' as const, startedAt: '2026-11-24T10:00:00.000Z', endedAt: null }))
    const items = foldRuns(generic)
    expect(items.length).toBe(1)
    expect('run' in items[0]! && runHead(items[0].run.map((s) => s.label))).toBe('Step')
  })

  test('the row names the tool once and each call by its input', () => {
    const labels = run.map((s) => s.label)
    expect(runHead(labels)).toBe('Bright Data · Search Engine')
    expect(runRest(labels[0]!, 'Bright Data · Search Engine')).toBe('"query 0"')
    expect(runHead(['Read · a/b.md', 'Read · a/c.md', 'Read · a/d.md'])).toBe('Read')
    // a query with " · " in it is one query: the line is never cut inside its quotes (review of #513)
    expect(runHead(['Svc · Search · "a · b one"', 'Svc · Search · "a · b two"', 'Svc · Search · "a · b three"'])).toBe('Svc · Search')
    expect(runRest('Read', 'Read')).toBe('Read')
  })

  for (const locale of ['en', 'ko'] as const) {
    test(`${locale}: one row with the count and how many did not work`, () => {
      setLocale(locale)
      const html = renderToStaticMarkup(<Steps steps={run} streaming={false} />)
      // folded under the finished answer: open it (the list is closed until clicked)
      expect(html).toContain(translate(locale, 'steps.summary', { n: 12 }))
    })
  }
})

describe('a narrow screen keeps the key input', () => {
  test('its own line under the tool\'s words, the whole line at sm and wider', () => {
    setLocale('en')
    const rows = renderToStaticMarkup(<Steps steps={[step({ key: ' · "YC Korea founders 2025"', outcome: { count: 8 } })]} streaming />)
    expect(rows).toContain('data-testid="step-key">&quot;YC Korea founders 2025&quot;</p>')
    expect(rows).toContain('<span class="hidden sm:inline">Bright Data · Search Engine · &quot;YC Korea founders 2025&quot;</span>')
    expect(rows).toContain('<span class="sm:hidden">Bright Data · Search Engine</span>')
    // a line that no longer ends in it (changed since): one line, as before
    expect(renderToStaticMarkup(<Steps steps={[step({ key: ' · "other"' })]} streaming />)).not.toContain('step-key')
  })
})

