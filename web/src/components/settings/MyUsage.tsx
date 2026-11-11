// Settings > Usage: the person's own usage (GET /api/me/usage), like Claude's Settings > Usage. First how full the
// usage limits that apply to them are (Admin budgets: theirs, their groups', the team's) with when each resets, then
// their answers per engine and model in the chosen period, then the totals. Only their own: everyone's usage is
// Admin > Usage (pages/admin/Usage.tsx).
import { RefreshCw } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import type { MyUsage as MyUsageData, MyUsageLimit } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { formatDateTime, formatNumber, formatRelative, formatUsd } from '../../lib/format'
import { usageShares } from '../../lib/usage-share'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { isAdmin, useMeStrict } from '../../store/session'
import { ENGINE_LABEL } from '../chat/EngineMenu'
import { ErrorNote, IconButton, Skeleton } from '../ui'
import { UsageBar } from '../UsageBar'
import { FilterPill } from '../usage/FilterPill'
import { StatCards } from '../usage/StatCards'

type Period = MyUsageData['period']
const PERIODS: Period[] = ['day', 'week', 'month']

export default function MyUsage() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const ids = useId()
  const [period, setPeriod] = useState<Period>('month')
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<{ key: string; data: MyUsageData | null; error: string | null; at: number }>({ key: '', data: null, error: null, at: 0 })
  const key = `${period}:${tick}`
  useEffect(() => {
    let live = true
    api.call(API.myUsage, { query: { period } }).then(
      (data) => live && setState({ key, data, error: null, at: Date.now() }),
      (e) => live && setState({ key, data: null, error: errorText(e, locale, t('error.network')), at: Date.now() }),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  // the last answer stays on screen while a new period loads, so the page does not jump
  const d = state.data
  const tz = me.server.timeZone
  const when = (iso: string) => formatDateTime(iso, locale, tz)
  const limitName = (l: MyUsageLimit) =>
    t(`myUsage.limit.${l.scope}.${l.period}` as MessageKey, { name: l.name ?? t('myUsage.groupRemoved') })
  const top = d?.limits[0]
  const shares = usageShares(d?.byModel ?? [])
  return (
    <section aria-labelledby={`${ids}-h`} data-testid="my-usage">
      {/* like the Console: the title, one dim line, and the period pill with refresh on the right */}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <h2 id={`${ids}-h`} className="text-base font-semibold">
            {t('myUsage.title')}
          </h2>
          <p className="mt-1 text-xs text-muted" data-testid="my-usage-desc">
            {t('myUsage.console.desc', { tz: tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone, at: state.at ? formatDateTime(new Date(state.at).toISOString(), locale, tz) : '…' })}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <FilterPill neutral label={t('myUsage.period')} value={period} onChange={setPeriod} testId="my-usage-period"
            options={PERIODS.map((p) => ({ value: p, label: t(`myUsage.period.${p}` as MessageKey) }))} />
          <IconButton label={t('myUsage.refresh')} onClick={() => setTick((n) => n + 1)} data-testid="my-usage-refresh">
            <RefreshCw size={14} aria-hidden />
          </IconButton>
        </div>
      </div>
      {!d && !state.error && <Skeleton lines={4} className="mt-4" />}
      {state.error && !d && (
        <div className="mt-4">
          <ErrorNote onRetry={() => setTick((n) => n + 1)}>{state.error}</ErrorNote>
        </div>
      )}
      {d && (
        <>
          {/* how full the limits are, like Claude's "This week ... N% used" */}
          <div className="mt-4 rounded-xl border border-line bg-surface p-5" data-testid="my-usage-limits">
            {top ? (
              <p className="text-sm font-medium" data-testid="my-usage-headline">
                {top.exceeded
                  ? t(top.action === 'block' ? 'myUsage.blocked' : 'myUsage.overWarn', { at: when(top.resetsAt) })
                  : t('myUsage.within', { pct: formatNumber(top.usedPct / 100, locale, { style: 'percent', maximumFractionDigits: 0 }) })}
              </p>
            ) : (
              <p className="text-sm text-muted" data-testid="my-usage-nolimit">
                {t('myUsage.noLimit')}
              </p>
            )}
            {d.limits.map((l, i) => (
              <div key={i} className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]" data-testid="my-usage-limit">
                <div className="min-w-0">
                  <p className="truncate text-sm">{limitName(l)}</p>
                  <p className="text-xs text-muted">{t('myUsage.resets', { at: when(l.resetsAt) })}</p>
                </div>
                <UsageBar pct={l.usedPct} over={l.exceeded} className="order-3 col-span-2 sm:order-none sm:col-span-1" />
                <span className={l.exceeded ? 'text-sm text-danger tabular-nums' : 'text-sm text-muted tabular-nums'}>
                  {t('myUsage.used', { pct: formatNumber(l.usedPct / 100, locale, { style: 'percent', maximumFractionDigits: 0 }) })}
                </span>
              </div>
            ))}
          </div>

          {/* the totals of the chosen period as the Console's stat cards: answers and an estimate, no tokens (a billing
              unit for developers; Admin › Usage keeps them) */}
          <div className="mt-4">
            <StatCards
              testId="my-usage-totals"
              items={[
                { label: t('usage.turns'), value: formatNumber(d.totals.turns, locale) },
                { label: t('usage.cost'), value: `${formatUsd(d.totals.costUsd, locale)}${d.totals.unpricedTurns ? ' +?' : ''}` },
              ]}
            />
          </div>

          {/* the person's own answers in the chosen period, by engine and model */}
          <section className="mt-4 rounded-xl border border-line bg-surface p-5" aria-labelledby={`${ids}-models`}>
            <h3 id={`${ids}-models`} className="text-base font-medium">{t('myUsage.byModel')}</h3>
            {!d.byModel.length ? (
              <p className="mt-3 text-sm text-muted" data-testid="my-usage-none">
                {t('usage.none')}
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-line" data-testid="my-usage-models">
                {d.byModel.map((r, i) => (
                  <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1.5 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
                    <span className="truncate text-sm">
                      {ENGINE_LABEL[r.engine as keyof typeof ENGINE_LABEL] ?? r.engine}
                      <span className="text-muted"> · {r.model ?? t('composer.defaultModel')}</span>
                    </span>
                    <UsageBar pct={shares[i] ?? 0} className="order-3 col-span-2 sm:order-none sm:col-span-1" />
                    <span className="text-sm text-muted tabular-nums">{formatNumber((shares[i] ?? 0) / 100, locale, { style: 'percent', maximumFractionDigits: 0 })}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="mt-3 text-xs text-faint">{t('myUsage.costNote')}</p>

          <p className="mt-1 text-xs text-muted" data-testid="my-usage-updated">{t('myUsage.updated', { when: formatRelative(new Date(state.at).toISOString(), locale) })}</p>
          {isAdmin(me) && (
            <p className="mt-3 text-sm">
              <Link to="/admin/usage" className="text-accent-text underline-offset-2 hover:underline" data-testid="my-usage-team-link">
                {t('myUsage.teamLink')}
              </Link>
            </p>
          )}
        </>
      )}
    </section>
  )
}
