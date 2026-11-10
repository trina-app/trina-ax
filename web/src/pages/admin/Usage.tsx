// Admin > Usage: everyone's usage, laid out like the Claude Console's Usage page. A title with one dim line ("… Data as
// of …"), filter pills ("Range  Last 30 days ⌄", Person, Engine, Model, AI connection, Group by), a download icon, stat
// cards, a "Token usage" chart (tokens per day, stacked by the Group by) and the breakdown table under it. The numbers
// are the same report as before (GET /api/admin/usage, now with its filters, series and facets); amounts are estimates,
// not bills. A person's own usage is Settings > Usage (components/settings/MyUsage.tsx).
import { Download } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { z } from 'zod'
import { TRIAL_CREDENTIAL_ID, type UsageQuery, type UsageResponse } from '@mycel/shared/api'
import { api, API, errorText, saveBlob } from '../../lib/api'
import { formatDateTime, formatNumber, formatUsd, localDay, localDayRange } from '../../lib/format'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { IconButton } from '../../components/ui'
import { UsageBar } from '../../components/UsageBar'
import { FilterPill } from '../../components/usage/FilterPill'
import { StatCards } from '../../components/usage/StatCards'
import { UsageChart } from '../../components/usage/UsageChart'
import { ENGINE_LABEL } from '../../components/chat/EngineMenu'
import { AdminPageHeader, Loadable, OneLine, USAGE_LIMITS_LINK } from './common'
import { usageCsv } from '../../lib/usage-csv'
import { usageShares } from '../../lib/usage-share'
import { Tooltip } from '../../components/Tooltip'

type GroupBy = 'user' | 'engine' | 'model' | 'day' | 'group' | 'credential' | 'skill'
type Range = 'today' | '7d' | '30d' | 'month' | 'custom'
type Report = z.output<typeof UsageResponse>
const ALL = '\u0000all'
const GROUPS: GroupBy[] = ['user', 'group', 'engine', 'model', 'day', 'credential', 'skill']
const RANGES: Range[] = ['today', '7d', '30d', 'month', 'custom']

/** the inclusive local days a preset covers (a custom range keeps what the person typed) */
function presetDays(r: Exclude<Range, 'custom'>, now = new Date()): { from: string; to: string } {
  const today = localDay(now)
  if (r === 'today') return { from: today, to: today }
  if (r === 'month') return { from: localDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
  const back = r === '7d' ? 6 : 29
  return { from: localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)), to: today }
}

/** every day from..to (inclusive), as YYYY-MM-DD */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  const d = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  for (let i = 0; d <= end && i < 400; i++, d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10))
  return out
}

export default function Usage() {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const tz = me.server.timeZone
  const [groupBy, setGroupBy] = useState<GroupBy>('user')
  const [range, setRange] = useState<Range>('30d')
  const [custom, setCustom] = useState(() => presetDays('30d'))
  const days = range === 'custom' ? custom : presetDays(range)
  const { from, to } = days
  const [filters, setFilters] = useState({ user: ALL, engine: ALL, model: ALL, credential: ALL, group: ALL })
  const apiRange = useMemo(() => localDayRange(from, to), [from, to])
  const query = useMemo(() => {
    const q: z.input<typeof UsageQuery> = { groupBy, ...apiRange, series: '1', facets: '1' }
    for (const [k, v] of Object.entries(filters) as [keyof typeof filters, string][]) if (v !== ALL) q[k] = v
    return q
  }, [groupBy, apiRange, filters])
  const queryKey = JSON.stringify(query)
  const [retry, setRetry] = useState(0)
  const [report, setReport] = useState<{ key: string; data: Report | null; error: string | null; at: number }>({ key: '', data: null, error: null, at: 0 })
  useEffect(() => {
    let cancelled = false
    // a new selection shows nothing old: the table and the CSV always belong to what is selected
    setReport((r) => ({ key: queryKey, data: null, error: null, at: r.at }))
    api.call(API.usage, { query }).then((data) => {
      if (!cancelled) setReport({ key: queryKey, data, error: null, at: Date.now() })
    }, (error) => {
      if (!cancelled) setReport({ key: queryKey, data: null, error: errorText(error, locale, t('error.network')), at: Date.now() })
    })
    return () => { cancelled = true }
    // A response must belong to the selected query, including when older requests finish later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, retry, locale])
  const current = report.key === queryKey ? report : null
  const data = current?.data ?? null
  const state = { data, error: current?.error ?? null, reload: async () => { setRetry((n) => n + 1) } }
  // the filter choices stay from the last report that had them
  const [facets, setFacets] = useState<Report['facets']>()
  useEffect(() => { if (data?.facets) setFacets(data.facets) }, [data])
  // Skill (and group) rows can overlap; shares describe displayed rows, not unique team usage.
  const shares = useMemo(() => usageShares(data?.rows ?? []), [data])
  const csv = () => {
    if (data) saveBlob(new Blob([usageCsv(data, groupBy)], { type: 'text/csv;charset=utf-8' }), `usage-${groupBy}-${from}-${to}.csv`)
  }
  const set = (k: keyof typeof filters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }))
  // known engines by their product name (Claude, Codex, API); anything else keeps the report's own label
  const engineName = (k: string, label = k) => ENGINE_LABEL[k as keyof typeof ENGINE_LABEL] ?? label
  const modelName = (k: string, label: string) => (k === '' ? t('composer.defaultModel') : label)
  // removed connections have no label: with more than one, a number tells them apart (QA TC-068)
  const removed = (facets?.credentials ?? []).filter((c) => c.key !== TRIAL_CREDENTIAL_ID && !c.label).map((c) => c.key)
  const removedName = (k: string) => {
    const i = removed.indexOf(k)
    return removed.length > 1 && i >= 0 ? t('usage.deletedCredentialN', { n: i + 1 }) : t('usage.deletedCredential')
  }
  const credName = (k: string, label: string) => (k === TRIAL_CREDENTIAL_ID ? t('trialCredit.usageLabel') : label || removedName(k))
  const rowLabel = (key: string, label: string) =>
    groupBy === 'engine' ? engineName(key, label) : groupBy === 'model' ? modelName(key, label) : groupBy === 'credential' ? credName(key, label) : label
  const all = (k: MessageKey) => ({ value: ALL, label: t(k) })
  const pills = facets && (
    <>
      <FilterPill label={t('usage.by.user')} value={filters.user} onChange={set('user')} testId="usage-filter-user"
        options={[all('usage.pill.all'), ...facets.users.map((u) => ({ value: u.key, label: u.label }))]} />
      <FilterPill label={t('usage.by.engine')} value={filters.engine} onChange={set('engine')} testId="usage-filter-engine"
        options={[all('usage.pill.all'), ...facets.engines.map((e) => ({ value: e.key, label: engineName(e.key, e.label) }))]} />
      <FilterPill label={t('usage.by.model')} value={filters.model} onChange={set('model')} testId="usage-filter-model"
        options={[all('usage.pill.all'), ...facets.models.map((m) => ({ value: m.key, label: modelName(m.key, m.label) }))]} />
      {facets.credentials.length > 0 && (
        <FilterPill label={t('usage.by.credential')} value={filters.credential} onChange={set('credential')} testId="usage-filter-credential"
          options={[all('usage.pill.all'), ...facets.credentials.map((c) => ({ value: c.key, label: credName(c.key, c.label) }))]} />
      )}
    </>
  )
  const filtered = Object.values(filters).some((v) => v !== ALL)
  const chartKeys = data?.rows.map((r) => ({ key: groupBy === 'day' ? 'all' : r.key, label: groupBy === 'day' ? t('usage.tokens') : rowLabel(r.key, r.label) })) ?? []
  const chartDays = useMemo(() => {
    const list = daysBetween(from, to)
    for (const p of data?.series ?? []) if (!list.includes(p.day)) list.push(p.day)
    return list.sort()
  }, [from, to, data])
  return (
    <section aria-label={t('admin.usage')} data-testid="admin-usage">
      {/* the title row stays at the top while the page scrolls, like the other admin pages; usage limits live on AI
          engines › Team provider settings, so a link goes there */}
      <AdminPageHeader
        title={t('admin.usage')}
        desc={t('usage.console.desc', { tz: tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone, at: report.at ? formatDateTime(new Date(report.at).toISOString(), locale, tz) : '…' })}
        testId="usage-header"
        className="!mb-0"
        actions={
          <>
            <Link to={USAGE_LIMITS_LINK} className="text-sm font-medium text-accent-text underline-offset-2 hover:underline" data-testid="usage-limits-link">
              {t('adminux.usageLimitsLink')}
            </Link>
            <IconButton label={t('usage.exportCsv')} disabled={!data} data-testid="usage-csv" onClick={csv}>
              <Download size={16} aria-hidden />
            </IconButton>
          </>
        }
      />

      {/* row 1: what part of the team and when; row 2: what to look at and how to split it */}
      <div className="mt-4 space-y-3" data-testid="usage-controls">
        <div className="flex flex-wrap items-center gap-2">
          {facets && facets.groups.length > 0 && (
            <FilterPill label={t('usage.by.group')} value={filters.group} onChange={set('group')} testId="usage-filter-group"
              options={[all('usage.pill.all'), ...facets.groups.map((g) => ({ value: g.key, label: g.label }))]} />
          )}
          <FilterPill neutral label={t('usage.pill.range')} value={range} onChange={setRange} testId="usage-range"
            options={RANGES.map((r) => ({ value: r, label: t(`usage.range.${r}` as MessageKey) }))} />
          {range === 'custom' && (
            <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="usage-custom-range">
              <label className="sr-only" htmlFor="usage-from">{t('usage.from')}</label>
              <input id="usage-from" className="h-9 rounded-lg border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent" type="date" value={custom.from} max={custom.to}
                onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))} />
              <span aria-hidden className="text-muted">–</span>
              <label className="sr-only" htmlFor="usage-to">{t('usage.to')}</label>
              <input id="usage-to" className="h-9 rounded-lg border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent" type="date" value={custom.to} min={custom.from}
                onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))} />
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pills}
          <span aria-hidden className="mx-1 hidden h-6 w-px bg-line sm:block" />
          <FilterPill neutral label={t('usage.groupBy')} value={groupBy} onChange={setGroupBy} testId="usage-groupby"
            options={GROUPS.map((g) => ({ value: g, label: t(`usage.by.${g}`) }))} />
          {filtered && (
            <button type="button" className="h-9 rounded-lg px-2 text-sm text-accent-text underline-offset-2 hover:underline" onClick={() => setFilters({ user: ALL, engine: ALL, model: ALL, credential: ALL, group: ALL })} data-testid="usage-filters-clear">
              {t('usage.filters.clear')}
            </button>
          )}
        </div>
      </div>
      {groupBy === 'skill' && <p className="mt-3 text-xs text-muted" data-testid="usage-skill-note">{t('usage.skillNote')}</p>}

      <div className="mt-5">
        <Loadable state={state}>
          {(d) => (
            <div className="space-y-5">
              <StatCards
                items={[
                  { label: t('usage.stat.in'), value: formatNumber(d.totals.inputTokens, locale), testId: 'usage-stat-in' },
                  { label: t('usage.stat.out'), value: formatNumber(d.totals.outputTokens, locale), testId: 'usage-stat-out' },
                  { label: t('usage.turns'), value: formatNumber(d.totals.turns, locale), testId: 'usage-stat-turns' },
                  { label: t('usage.cost'), value: `${formatUsd(d.totals.costUsd, locale)}${d.totals.unpricedTurns ? ' +?' : ''}`, testId: 'usage-stat-cost' },
                ]}
              />
              <UsageChart
                title={t('usage.chart.title')}
                desc={t('usage.chart.desc', { by: t(`usage.by.${groupBy}`) })}
                days={chartDays}
                keys={chartKeys}
                points={(d.series ?? []).map((p) => ({ day: p.day, key: p.key, tokens: p.inputTokens + p.outputTokens }))}
              />
              <section className="rounded-xl border border-line bg-surface" aria-labelledby="usage-breakdown-title">
                <h3 id="usage-breakdown-title" className="px-5 pt-5 text-base font-medium">{t('usage.breakdown', { by: t(`usage.by.${groupBy}`) })}</h3>
                {!d.rows.length ? (
                  <p className="px-5 py-5 text-sm text-muted" data-testid="usage-none">{t('usage.none')}</p>
                ) : (
                  <div className="overflow-x-auto px-5 pb-4">
                    <table className="w-full text-sm" data-testid="usage-table">
                      <thead>
                        <tr className="border-b border-line text-left text-xs text-muted">
                          <th className="py-2.5 pr-3 font-medium whitespace-nowrap">{t(`usage.by.${groupBy}`)}</th>
                          <th className="py-2.5 pr-3 text-right font-medium whitespace-nowrap">{t('usage.turns')}</th>
                          <th className="hidden py-2.5 pr-3 text-right font-medium whitespace-nowrap md:table-cell">{t('usage.tokens')}</th>
                          <th className="hidden py-2.5 pr-3 font-medium md:table-cell">{t('usage.share')}</th>
                          <th className="py-2.5 text-right font-medium whitespace-nowrap">{t('usage.cost')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {d.rows.map((r, i) => {
                          const tok = r.inputTokens + r.outputTokens
                          const share = shares[i] ?? 0
                          const name = rowLabel(r.key, r.label)
                          return (
                            <tr key={r.key}>
                              <td className="max-w-[16rem] truncate py-3 pr-3" title={name || undefined}>
                                {groupBy === 'credential' && r.key !== TRIAL_CREDENTIAL_ID && !r.label ? <span className="text-faint">{name}</span> : name}
                              </td>
                              <td className="py-3 pr-3 text-right tabular-nums">{formatNumber(r.turns, locale)}</td>
                              <td className="hidden py-3 pr-3 text-right tabular-nums md:table-cell">{formatNumber(tok, locale)}</td>
                              <td className="hidden w-48 py-3 pr-3 md:table-cell">
                                <div className="flex items-center gap-3">
                                  <UsageBar pct={share} />
                                  <span className="w-12 text-right text-xs text-muted tabular-nums" data-testid="usage-share">{formatNumber(share / 100, locale, { style: 'percent', maximumFractionDigits: 1 })}</span>
                                </div>
                              </td>
                              <td className="py-3 text-right text-muted tabular-nums">
                                {formatUsd(r.costUsd, locale)}
                                {!!r.unpricedTurns && <Tooltip label={t('usage.unpricedMark')}><span className="ml-1 text-warn" aria-label={t('usage.unpricedMark')} data-testid="usage-unpriced">+?</span></Tooltip>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-line font-medium">
                          <td className="py-3 pr-3">{t('usage.total')}</td>
                          <td className="py-3 pr-3 text-right tabular-nums">{formatNumber(d.totals.turns, locale)}</td>
                          <td className="hidden py-3 pr-3 text-right tabular-nums md:table-cell">{formatNumber(d.totals.inputTokens + d.totals.outputTokens, locale)}</td>
                          <td className="hidden md:table-cell" />
                          <td className="py-3 text-right tabular-nums">
                            {formatUsd(d.totals.costUsd, locale)}
                            {!!d.totals.unpricedTurns && <Tooltip label={t('usage.unpricedMark')}><span className="ml-1 text-warn" aria-label={t('usage.unpricedMark')}>+?</span></Tooltip>}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </section>
              <div>
                {/* the long cost explanation: one line, "More" opens the rest */}
                <OneLine className="text-xs text-faint" testId="usage-cost-note">
                  {t('usage.costNote')}
                </OneLine>
                {!!d.totals.unpricedTurns && <p className="mt-1 text-xs text-warn" data-testid="usage-unpriced-note">{t('usage.unpriced', { n: d.totals.unpricedTurns })}</p>}
                {groupBy === 'credential' && <p className="mt-1 text-xs text-faint">{t('usage.credentialNote')}</p>}
              </div>
            </div>
          )}
        </Loadable>
      </div>
    </section>
  )
}
