// "Token usage" in the Claude Console style: tokens per day as stacked bars, one colour per Group by key (the biggest five
// keys, the rest as "Other"), a legend, and a tooltip with the day's numbers. Hand-drawn SVG (no chart library).
// Keyboard: the chart is one stop; ← → move between days and the tooltip follows. A hidden table carries the same
// numbers for screen readers.
import { BarChart3 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatNumber } from '../../lib/format'
import { useLocale, useT } from '../../i18n'

export type ChartPoint = { day: string; key: string; tokens: number }
export type ChartKey = { key: string; label: string }

const MAX_KEYS = 5
// mid-tone colours that read on the light and the dark theme; the first is the brand accent, "Other" is neutral
const COLORS = ['var(--c-accent)', '#3b82c4', '#2f9e6e', '#8b5cf6', '#c99512']
const OTHER = 'var(--c-line-strong)'

const compact = (n: number, locale: Parameters<typeof formatNumber>[1]) => formatNumber(n, locale, { notation: 'compact', maximumFractionDigits: 1 })

export function UsageChart({ days, points, keys, title, desc, testId = 'usage-chart' }: {
  /** every day of the range, in order (YYYY-MM-DD) */
  days: string[]
  points: ChartPoint[]
  /** labels for the keys in the points */
  keys: ChartKey[]
  title: string
  desc: string
  testId?: string
}) {
  const t = useT()
  const locale = useLocale()
  const [active, setActive] = useState<number | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  // the drawing uses the real width in pixels, so the axis text keeps its size on a phone
  const [width, setWidth] = useState(720)
  const hasData = points.some((p) => p.tokens > 0)
  useEffect(() => {
    const el = wrap.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => { if (e) setWidth(Math.max(280, Math.round(e.contentRect.width))) })
    ro.observe(el)
    return () => ro.disconnect()
    // the plot only exists when there is data, so attach again when that changes
  }, [hasData])

  // the five biggest keys keep their colour, the rest add up to "Other"
  const { series, byDay, max, total } = useMemo(() => {
    const sums = new Map<string, number>()
    for (const p of points) sums.set(p.key, (sums.get(p.key) ?? 0) + p.tokens)
    const top = [...sums.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_KEYS).map(([k]) => k)
    const label = (k: string) => keys.find((x) => x.key === k)?.label ?? k
    const series = top.map((k, i) => ({ key: k, label: label(k), color: COLORS[i]! }))
    const hasOther = sums.size > top.length
    if (hasOther) series.push({ key: '\u0000other', label: t('usage.chart.other'), color: OTHER })
    const byDay = new Map<string, Map<string, number>>()
    for (const p of points) {
      const k = top.includes(p.key) ? p.key : '\u0000other'
      const m = byDay.get(p.day) ?? new Map<string, number>()
      m.set(k, (m.get(k) ?? 0) + p.tokens)
      byDay.set(p.day, m)
    }
    let max = 0
    let total = 0
    for (const m of byDay.values()) {
      const s = [...m.values()].reduce((a, b) => a + b, 0)
      max = Math.max(max, s)
      total += s
    }
    return { series, byDay, max, total }
  }, [points, keys, t])

  const dayLabel = (d: string) => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`))
  const dayTotal = (d: string) => [...(byDay.get(d)?.values() ?? [])].reduce((a, b) => a + b, 0)

  // geometry in viewBox units; the SVG scales to the card's width
  const W = width, H = width < 520 ? 180 : 220, left = 40, bottom = 22, top = 8
  const plotW = W - left - 8
  const plotH = H - top - bottom
  const step = plotW / Math.max(days.length, 1)
  const barW = Math.max(2, Math.min(28, step * 0.62))
  const niceMax = max > 0 ? niceCeil(max) : 1
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * niceMax)
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(3, Math.floor(plotW / 80))))

  const empty = total === 0
  const activeDay = active !== null ? days[active] : null

  return (
    // a phone: no frame (Admin › Usage on phones, docs/DECISIONS.md "Admin and Settings on phones")
    <section className="rounded-xl border border-line bg-surface p-5 max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:p-0" data-testid={testId} aria-labelledby={`${testId}-title`}>
      <h3 id={`${testId}-title`} className="text-base font-medium">{title}</h3>
      <p className="mt-1 text-sm text-muted">{desc}</p>
      {empty ? (
        <div className="flex h-56 flex-col items-center justify-center gap-3 text-center" data-testid={`${testId}-empty`}>
          <span className="flex size-12 items-center justify-center rounded-full bg-subtle text-muted"><BarChart3 size={20} aria-hidden /></span>
          <p className="text-sm text-muted">{t('usage.chart.empty')}</p>
        </div>
      ) : (
        <>
          {series.length > 1 && (
            <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted" data-testid={`${testId}-legend`}>
              {series.map((s) => (
                <li key={s.key} className="flex items-center gap-1.5">
                  <span aria-hidden className="size-2.5 rounded-sm" style={{ background: s.color }} />
                  <span className="max-w-[12rem] truncate" title={s.label}>{s.label}</span>
                </li>
              ))}
            </ul>
          )}
          <div
            ref={wrap}
            className="relative mt-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
            tabIndex={0}
            role="group"
            aria-label={t('usage.chart.keys', { title })}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
              e.preventDefault()
              const last = days.length - 1
              setActive((i) => e.key === 'Home' ? 0 : e.key === 'End' ? last : i === null ? (e.key === 'ArrowLeft' ? last : 0) : Math.max(0, Math.min(last, i + (e.key === 'ArrowLeft' ? -1 : 1))))
            }}
            onFocus={() => setActive((i) => i ?? days.length - 1)}
            onBlur={() => setActive(null)}
            onMouseLeave={() => setActive(null)}
            data-testid={`${testId}-plot`}
          >
            <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" aria-hidden>
              {ticks.map((v, i) => {
                const y = top + plotH - (v / niceMax) * plotH
                return (
                  <g key={i}>
                    <line x1={left} x2={W - 8} y1={y} y2={y} stroke="var(--c-line)" strokeWidth={1} />
                    <text x={left - 6} y={y + 3.5} textAnchor="end" fontSize={10} fill="var(--c-faint)">{compact(v, locale)}</text>
                  </g>
                )
              })}
              {days.map((d, i) => {
                const x = left + i * step + (step - barW) / 2
                let y = top + plotH
                const m = byDay.get(d)
                return (
                  <g key={d} onMouseEnter={() => setActive(i)} data-day={d}>
                    {/* a full-height hit area, so a thin or empty day can still be pointed at */}
                    <rect x={left + i * step} y={top} width={step} height={plotH} fill={active === i ? 'var(--c-hover)' : 'transparent'} />
                    {series.map((s) => {
                      const v = m?.get(s.key) ?? 0
                      if (!v) return null
                      const h = (v / niceMax) * plotH
                      y -= h
                      return <rect key={s.key} x={x} y={y} width={barW} height={Math.max(h, 0.5)} fill={s.color} rx={1.5} />
                    })}
                    {i % labelEvery === 0 && (
                      <text x={left + i * step + step / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--c-faint)">{dayLabel(d)}</text>
                    )}
                  </g>
                )
              })}
            </svg>
            {activeDay && (
              <div
                className="pointer-events-none absolute top-2 z-10 w-56 rounded-lg border border-line bg-surface p-3 text-xs shadow-lg"
                style={{ left: `clamp(0px, calc(${((left + (active! + 0.5) * step) / W) * 100}% - 7rem), calc(100% - 14rem))` }}
                data-testid={`${testId}-tooltip`}
                role="status"
                aria-live="polite"
              >
                <p className="font-medium text-ink">{dayLabel(activeDay)}</p>
                <ul className="mt-2 space-y-1">
                  {series.map((s) => (
                    <li key={s.key} className="flex items-center gap-2">
                      <span aria-hidden className="size-2 shrink-0 rounded-sm" style={{ background: s.color }} />
                      <span className="min-w-0 flex-1 truncate text-muted">{s.label}</span>
                      <span className="tabular-nums text-ink">{formatNumber(byDay.get(activeDay)?.get(s.key) ?? 0, locale)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 flex justify-between border-t border-line pt-2 font-medium">
                  <span>{t('usage.total')}</span>
                  <span className="tabular-nums">{formatNumber(dayTotal(activeDay), locale)}</span>
                </p>
              </div>
            )}
          </div>
          {/* the same numbers for screen readers */}
          <table className="sr-only" data-testid={`${testId}-table`}>
            <caption>{title}</caption>
            <thead>
              <tr>
                <th scope="col">{t('usage.by.day')}</th>
                {series.map((s) => <th key={s.key} scope="col">{s.label}</th>)}
                <th scope="col">{t('usage.total')}</th>
              </tr>
            </thead>
            <tbody>
              {days.filter((d) => dayTotal(d) > 0).map((d) => (
                <tr key={d}>
                  <th scope="row">{dayLabel(d)}</th>
                  {series.map((s) => <td key={s.key}>{formatNumber(byDay.get(d)?.get(s.key) ?? 0, locale)}</td>)}
                  <td>{formatNumber(dayTotal(d), locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

/** 1, 2, 2.5 or 5 times a power of ten, at or above n, so the grid lines land on round numbers */
export function niceCeil(n: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(n)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p
  return 10 * p
}
