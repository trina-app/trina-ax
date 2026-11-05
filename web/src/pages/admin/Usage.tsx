// Admin > Usage: everyone's usage per person / engine / model / day / group / AI connection / skill, in the calm look of
// Claude's Settings > Usage (a title row with Download CSV, compact controls, quiet rows with thin share bars, the long
// notes on one line with "More"). Amounts are estimates, not bills. A person's own usage is Settings > Usage
// (components/settings/MyUsage.tsx).
import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { z } from 'zod'
import { TRIAL_CREDENTIAL_ID, type UsageResponse } from '@mycel/shared/api'
import { api, API, errorText, saveBlob } from '../../lib/api'
import { formatNumber, formatUsd, localDay, localDayRange } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { Button } from '../../components/ui'
import { UsageBar } from '../../components/UsageBar'
import { AdminPageHeader, Loadable, OneLine, USAGE_LIMITS_LINK } from './common'
import { usageCsv } from '../../lib/usage-csv'
import { usageShares } from '../../lib/usage-share'

type GroupBy = 'user' | 'engine' | 'model' | 'day' | 'group' | 'credential' | 'skill'

export default function Usage() {
  const t = useT()
  const locale = useLocale()
  const [groupBy, setGroupBy] = useState<GroupBy>('user')
  const [from, setFrom] = useState(() => localDay(new Date(Date.now() - 29 * 86400_000)))
  const [to, setTo] = useState(() => localDay(new Date()))
  const range = useMemo(() => localDayRange(from, to), [from, to])
  const queryKey = JSON.stringify([groupBy, range.from, range.to])
  const [retry, setRetry] = useState(0)
  const [report, setReport] = useState<{ key: string; data: z.output<typeof UsageResponse> | null; error: string | null }>({ key: '', data: null, error: null })
  useEffect(() => {
    let cancelled = false
    setReport({ key: queryKey, data: null, error: null })
    api.call(API.usage, { query: { groupBy, ...range } }).then((data) => {
      if (!cancelled) setReport({ key: queryKey, data, error: null })
    }, (error) => {
      if (!cancelled) setReport({ key: queryKey, data: null, error: errorText(error, locale, t('error.network')) })
    })
    return () => { cancelled = true }
    // A response must belong to the selected query, including when older requests finish later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, retry, locale])
  const state = { ...(report.key === queryKey ? report : { data: null, error: null }), reload: async () => { setRetry((n) => n + 1) } }
  // Skill (and group) rows can overlap; shares describe displayed rows, not unique team usage.
  const shares = useMemo(() => usageShares(state.data?.rows ?? []), [state.data])
  const csv = () => {
    if (state.data) saveBlob(new Blob([usageCsv(state.data, groupBy)], { type: 'text/csv;charset=utf-8' }), `usage-${groupBy}-${from}-${to}.csv`)
  }
  const small = 'h-8 rounded-lg border border-field-border bg-surface px-2 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent max-sm:min-h-10'
  return (
    <section aria-label={t('admin.usage')} data-testid="admin-usage">
      {/* the title row stays at the top while the table scrolls, like the other pages; the usage limits live on AI
          engines › Team provider settings, so a link goes there */}
      <AdminPageHeader
        title={t('admin.usage')}
        desc={t('usage.desc')}
        testId="usage-header"
        className="!mb-0"
        actions={
          <>
            <Link to={USAGE_LIMITS_LINK} className="text-sm font-medium text-accent-text underline-offset-2 hover:underline" data-testid="usage-limits-link">
              {t('adminux.usageLimitsLink')}
            </Link>
            <Button size="sm" disabled={!state.data} data-testid="usage-csv" onClick={csv}>
              {t('usage.exportCsv')}
            </Button>
          </>
        }
      />
      {/* compact controls on one line, like Claude's period picker */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" data-testid="usage-controls">
        <label className="flex items-center gap-2">
          <span className="text-muted">{t('usage.groupBy')}</span>
          <select className={clsx(small, 'pr-7')} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            {(['user', 'group', 'engine', 'model', 'day', 'credential', 'skill'] as GroupBy[]).map((g) => (
              <option key={g} value={g}>
                {t(`usage.by.${g}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted">{t('usage.from')}</span>
          <input className={small} type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted">{t('usage.to')}</span>
          <input className={small} type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
      </div>
      {groupBy === 'skill' && <p className="mt-3 text-xs text-muted" data-testid="usage-skill-note">{t('usage.skillNote')}</p>}
      <div className="mt-4">
        <Loadable state={state}>
          {(d) =>
            !d.rows.length ? (
              <p className="border-t border-line py-4 text-sm text-faint">{t('usage.none')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="usage-table">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-faint">
                      <th className="py-2 pr-3 font-normal">{t(`usage.by.${groupBy}`)}</th>
                      <th className="py-2 pr-3 text-right font-normal">{t('usage.turns')}</th>
                      <th className="py-2 pr-3 text-right font-normal">{t('usage.tokens')}</th>
                      <th className="py-2 pr-3 font-normal">{t('usage.share')}</th>
                      <th className="py-2 text-right font-normal">{t('usage.cost')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {d.rows.map((r, i) => {
                      const tok = r.inputTokens + r.outputTokens
                      const share = shares[i] ?? 0
                      return (
                        <tr key={r.key}>
                          <td className="max-w-[16rem] truncate py-2.5 pr-3" title={r.label || undefined}>{groupBy === 'credential' && r.key === TRIAL_CREDENTIAL_ID ? t('trialCredit.usageLabel') : groupBy === 'credential' && !r.label ? <span className="text-faint">{t('usage.deletedCredential')}</span> : r.label}</td>
                          <td className="py-2.5 pr-3 text-right tabular-nums">{formatNumber(r.turns, locale)}</td>
                          <td className="py-2.5 pr-3 text-right tabular-nums">{formatNumber(tok, locale)}</td>
                          <td className="w-48 py-2.5 pr-3">
                            <div className="flex items-center gap-3">
                              <UsageBar pct={share} />
                              <span className="w-12 text-right text-xs text-muted tabular-nums" data-testid="usage-share">{formatNumber(share / 100, locale, { style: 'percent', maximumFractionDigits: 1 })}</span>
                            </div>
                          </td>
                          <td className="py-2.5 text-right text-muted tabular-nums">
                            {formatUsd(r.costUsd, locale)}
                            {!!r.unpricedTurns && <span className="ml-1 text-warn" title={t('usage.unpricedMark')} aria-label={t('usage.unpricedMark')} data-testid="usage-unpriced">+?</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-line font-medium">
                      <td className="py-2.5 pr-3">{t('usage.total')}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{formatNumber(d.totals.turns, locale)}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{formatNumber(d.totals.inputTokens + d.totals.outputTokens, locale)}</td>
                      <td />
                      <td className="py-2.5 text-right tabular-nums">
                        {formatUsd(d.totals.costUsd, locale)}
                        {!!d.totals.unpricedTurns && <span className="ml-1 text-warn" title={t('usage.unpricedMark')} aria-label={t('usage.unpricedMark')}>+?</span>}
                      </td>
                    </tr>
                  </tfoot>
                </table>
                {/* the long cost explanation: one line, "More" opens the rest */}
                <OneLine className="mt-3 text-xs text-faint" testId="usage-cost-note">
                  {t('usage.costNote')}
                </OneLine>
                {!!d.totals.unpricedTurns && <p className="mt-1 text-xs text-warn" data-testid="usage-unpriced-note">{t('usage.unpriced', { n: d.totals.unpricedTurns })}</p>}
                {groupBy === 'credential' && <p className="mt-1 text-xs text-faint">{t('usage.credentialNote')}</p>}
              </div>
            )
          }
        </Loadable>
      </div>
    </section>
  )
}
