// Usage per person / engine / model / day / group: turns and tokens (cost only means something in company-key mode).
import { useMemo, useState } from 'react'
import { api, API } from '../../lib/api'
import { formatNumber, formatUsd, localDay } from '../../lib/format'
import { useLocale, useT } from '../../i18n'
import { Field, inputCls } from '../../components/ui'
import { Card, Loadable, useLoad } from './common'

type GroupBy = 'user' | 'engine' | 'model' | 'day' | 'group'

export default function Usage() {
  const t = useT()
  const locale = useLocale()
  const [groupBy, setGroupBy] = useState<GroupBy>('user')
  const [from, setFrom] = useState(() => localDay(new Date(Date.now() - 29 * 86400_000)))
  const [to, setTo] = useState(() => localDay(new Date()))
  const range = useMemo(() => ({ from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59`).toISOString() }), [from, to])
  const state = useLoad(() => api.call(API.usage, { query: { groupBy, ...range } }), [groupBy, range])
  const max = Math.max(1, ...(state.data?.rows.map((r) => r.inputTokens + r.outputTokens) ?? [1]))
  return (
    <Card title={t('admin.usage')} desc={t('usage.desc')}>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field label={t('usage.groupBy')}>
          <select className={inputCls} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            {(['user', 'group', 'engine', 'model', 'day'] as GroupBy[]).map((g) => (
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
                        <td className="py-2 pr-3">{r.label}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(r.turns, locale)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(tok, locale)}</td>
                        <td className="w-32 py-2 pr-3" aria-hidden>
                          <div className="h-1.5 rounded bg-subtle">
                            <div className="h-full rounded bg-accent" style={{ width: `${(tok / max) * 100}%` }} />
                          </div>
                        </td>
                        <td className="py-2 text-right text-muted tabular-nums">{formatUsd(r.costUsd, locale)}</td>
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
                    <td className="py-2 text-right tabular-nums">{formatUsd(d.totals.costUsd, locale)}</td>
                  </tr>
                </tfoot>
              </table>
              <p className="mt-2 text-xs text-faint">{t('usage.costNote')}</p>
            </div>
          )
        }
      </Loadable>
    </Card>
  )
}
