// Usage per person / engine / model / day / group / AI connection / skill; amounts are estimates, not bills.
import { useEffect, useMemo, useState } from 'react'
import type { z } from 'zod'
import type { UsageResponse } from '@mycel/shared/api'
import { api, API, errorText, saveBlob } from '../../lib/api'
import { formatNumber, formatUsd, localDay, localDayRange } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { Button, Field, inputCls } from '../../components/ui'
import { Card, Loadable } from './common'
import { usageCsv } from '../../lib/usage-csv'

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
  const rowTokens = state.data?.rows.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0) ?? 0
  return (
    <Card title={t('admin.usage')} desc={t('usage.desc')} actions={
      <Button size="sm" disabled={!state.data} data-testid="usage-csv" onClick={() => {
        if (state.data) saveBlob(new Blob([usageCsv(state.data, groupBy)], { type: 'text/csv;charset=utf-8' }), `usage-${groupBy}-${from}-${to}.csv`)
      }}>{t('usage.exportCsv')}</Button>
    }>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field label={t('usage.groupBy')}>
          <select className={inputCls} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            {(['user', 'group', 'engine', 'model', 'day', 'credential', 'skill'] as GroupBy[]).map((g) => (
              <option key={g} value={g}>
                {t(`usage.by.${g}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('usage.from')}>
          <input className={inputCls} type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </Field>
        <Field label={t('usage.to')}>
          <input className={inputCls} type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </Field>
      </div>
      {groupBy === 'skill' && <p className="mb-3 text-xs text-muted" data-testid="usage-skill-note">{t('usage.skillNote')}</p>}
      <Loadable state={state}>
        {(d) =>
          !d.rows.length ? (
            <p className="text-sm text-faint">{t('usage.none')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="usage-table">
                <thead>
                  <tr className="text-left text-xs text-faint">
                    <th className="py-2 pr-3 font-medium">{t(`usage.by.${groupBy}`)}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t('usage.turns')}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t('usage.tokens')}</th>
                    <th className="py-2 pr-3 font-medium">
                      <span className="sr-only">{t('usage.share')}</span>
                    </th>
                    <th className="py-2 text-right font-medium">{t('usage.cost')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.rows.map((r) => {
                    const tok = r.inputTokens + r.outputTokens
                    return (
                      <tr key={r.key}>
                        <td className="py-2 pr-3">{groupBy === 'credential' && !r.label ? <span className="text-faint">{t('usage.deletedCredential')}</span> : r.label}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(r.turns, locale)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(tok, locale)}</td>
                        <td className="w-32 py-2 pr-3" aria-hidden>
                          <div className="h-1.5 rounded bg-subtle">
                            <div className="h-full rounded bg-accent" style={{ width: `${rowTokens > 0 ? (tok / rowTokens) * 100 : 0}%` }} />
                          </div>
                        </td>
                        <td className="py-2 text-right text-muted tabular-nums">
                          {formatUsd(r.costUsd, locale)}
                          {!!r.unpricedTurns && <span className="ml-1 text-warn" title={t('usage.unpricedMark')} aria-label={t('usage.unpricedMark')} data-testid="usage-unpriced">+?</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-line-strong font-medium">
                    <td className="py-2 pr-3">{t('usage.total')}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(d.totals.turns, locale)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(d.totals.inputTokens + d.totals.outputTokens, locale)}</td>
                    <td />
                    <td className="py-2 text-right tabular-nums">
                      {formatUsd(d.totals.costUsd, locale)}
                      {!!d.totals.unpricedTurns && <span className="ml-1 text-warn" title={t('usage.unpricedMark')} aria-label={t('usage.unpricedMark')}>+?</span>}
                    </td>
                  </tr>
                </tfoot>
              </table>
              <p className="mt-2 text-xs text-faint">{t('usage.costNote')}</p>
              {!!d.totals.unpricedTurns && <p className="mt-1 text-xs text-warn" data-testid="usage-unpriced-note">{t('usage.unpriced', { n: d.totals.unpricedTurns })}</p>}
              {groupBy === 'credential' && <p className="mt-1 text-xs text-faint">{t('usage.credentialNote')}</p>}
            </div>
          )
        }
      </Loadable>
    </Card>
  )
}
