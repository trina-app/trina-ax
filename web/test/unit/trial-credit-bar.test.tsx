// The hosting service's trial AI credit on Admin › AI connections (src/components/TrialCreditBar.tsx): used of the cap,
// the last day, and that an AI the team connects comes first; used up and ended say so and offer connecting one.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TrialCredit } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { TrialCreditBar } from '../../src/components/TrialCreditBar'

const base: TrialCredit = { active: true, state: 'active', usedUsd: 1.5, capUsd: 10, endsAt: '2026-11-18T15:00:00.000Z', model: 'claude-haiku-5-5' }
// server rendering reads the locale store's first state: English
const render = (c: TrialCredit) => renderToStaticMarkup(<TrialCreditBar credit={c} />)

describe('trial credit bar', () => {
  test('active: used of the cap, until when, and that a connected AI goes first', () => {
    const html = render(base)
    expect(html).toMatch(/Trial credit: \$1\.50 of \$10\.00 used · until November 1[89] · An AI you connect is used first/) // the last day here
    expect(html).toContain('data-state="active"')
    expect(html).toContain('data-testid="usage-bar"')
    expect(html).toContain('width:15%')
    // the Korean line the owner asked for
    expect(translate('ko', 'trialCredit.active', { used: '$1.50', cap: '$10.00', date: '11월 18일' })).toBe('체험 크레딧: $1.50 / $10.00 사용 · 11월 18일까지 · 내 AI를 연결하면 그걸 먼저 써요')
  })
  test('an end at midnight UTC shows the day before it as the last day', () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz !== 'UTC') return // the rule is about the reader's own midnight; checked where the test runs in UTC
    expect(render({ ...base, endsAt: '2026-11-19T00:00:00.000Z' })).toContain('until November 18')
  })
  test('used up and ended: said in words, with what to do', () => {
    const used = render({ ...base, active: false, state: 'used', usedUsd: 10.02 })
    expect(used).toContain('The trial credit is used up ($10.02 of $10.00) · Connect your own AI to go on')
    expect(used).toContain('bg-danger') // the bar past its limit
    expect(used).toContain('bg-warn-soft')
    const ended = render({ ...base, active: false, state: 'ended' })
    expect(ended).toContain(translate('en', 'trialCredit.ended'))
    expect(ended).not.toContain('data-testid="usage-bar"')
  })
})
