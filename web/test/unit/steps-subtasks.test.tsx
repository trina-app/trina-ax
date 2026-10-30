// Sub-tasks under an answer (docs/DECISIONS.md "Sub-agents"): a sub-agent's steps go under its "Sub-task" row; the
// folded summary counts the answer's own steps; while a sub-agent works its latest step shows beneath its row; the
// totals read "12 tool uses · 1m 20s" in each language. Apps that do not know Step.parentId show the flat list.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Locale, Step } from '@mycel/shared/api'
import { localizeStep } from '@mycel/shared'
import { translate, useLocaleStore } from '../../src/i18n'
import Steps, { groupSteps, subtaskStats } from '../../src/components/chat/Steps'

const at = '2026-10-30T00:00:00.000Z'
const step = (o: Partial<Step> & Pick<Step, 'id' | 'label'>): Step => ({ kind: 'tool', status: 'ok', startedAt: at, endedAt: at, ...o })
const steps: Step[] = [
  step({ id: 's1', tool: 'read', label: 'Read · shared/a.md' }),
  step({ id: 'A1', tool: 'agent', label: 'Sub-task: Compare contracts', status: 'running', endedAt: null, subtask: { toolUses: 12, ms: 80_400 } }),
  step({ id: 'c1', tool: 'read', label: 'Read · shared/contract-1.md', parentId: 'A1' }),
  step({ id: 'c2', tool: 'grep', label: 'Search "fee" · shared/', parentId: 'A1', status: 'running', endedAt: null }),
  step({ id: 'B1', tool: 'agent', label: 'Sub-task: Draft', subtask: { toolUses: 1, ms: 4_000, hidden: 3 } }),
  step({ id: 'd1', tool: 'write', label: 'Save · users/alice/draft.md', parentId: 'B1', status: 'error' }),
  step({ id: 'orphan', tool: 'read', label: 'Read · shared/o.md', parentId: 'gone' }),
]
const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale
afterEach(() => setLocale(before))
const t = (l: Locale) => (key: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate(l, key, p)

describe('sub-task steps', () => {
  test('grouping: children under their sub-task, a step whose sub-task is missing stays on top', () => {
    const g = groupSteps(steps)
    expect(g.top.map((s) => s.id)).toEqual(['s1', 'A1', 'B1', 'orphan'])
    expect(g.kids.get('A1')!.map((s) => s.id)).toEqual(['c1', 'c2'])
    expect(g.kids.get('B1')!.map((s) => s.id)).toEqual(['d1'])
  })

  test('totals in five languages (plural forms where the language has them)', () => {
    expect(subtaskStats({ toolUses: 12, ms: 80_400 }, t('en'))).toBe('12 tool uses · 1m 20s')
    expect(subtaskStats({ toolUses: 1, ms: 4_000 }, t('en'))).toBe('1 tool use · 4s')
    expect(subtaskStats({ toolUses: 12, ms: 80_400 }, t('ko'))).toBe('도구 12번 · 1분 20초')
    expect(subtaskStats({ toolUses: 12, ms: 80_400 }, t('ja'))).toBe('ツール12回 · 1分20秒')
    expect(subtaskStats({ toolUses: 1, ms: 80_400 }, t('es'))).toBe('1 uso de herramienta · 1 min 20 s')
    expect(subtaskStats({ toolUses: 3 }, t('id'))).toBe('3 kali pakai alat')
    expect(subtaskStats(undefined, t('en'))).toBe('')
    expect(subtaskStats({}, t('en'))).toBe('')
  })

  test('the sub-task label follows the language on screen', () => {
    expect(localizeStep(steps[1]!, 'ko').label).toBe('하위 작업: Compare contracts')
    expect(localizeStep(steps[1]!, 'ja').label).toBe('サブタスク：Compare contracts')
  })

  test('while answering: the answer\'s own last steps, each working sub-task with its latest step beneath', () => {
    setLocale('en')
    const html = renderToStaticMarkup(<Steps steps={steps} streaming />)
    expect(html).toContain('Sub-task: Compare contracts')
    expect(html).toContain('12 tool uses · 1m 20s')
    expect(html).toContain('data-testid="subtask-latest"')
    expect(html).toContain('Search &quot;fee&quot; · shared/')
    // the earlier child of the working sub-task and the finished sub-task's children stay folded
    expect(html).not.toContain('shared/contract-1.md')
    expect(html).not.toContain('users/alice/draft.md')
    expect(html.match(/data-testid="subtask-latest"/g)).toHaveLength(1)
  })

  test('folded after the answer: counts the answer\'s own steps; a failed child marks the list', () => {
    setLocale('en')
    const html = renderToStaticMarkup(<Steps steps={steps.map((s) => ({ ...s, status: s.status === 'running' ? 'ok' : s.status, endedAt: at }))} streaming={false} />)
    expect(html).toContain(translate('en', 'steps.summary', { n: 4 }))
    expect(html).toContain(translate('en', 'steps.someFailed'))
  })
})
