// Activity log: admin actions, file changes, AI tool use and sign-ins. The title and the filters stay at the top while the
// list scrolls; the list reads as sentences grouped by day, with repeats folded into one row ("Dion signed in · 5 times").
// The filters live in the address (lib/activity.ts), so a filtered view can be reloaded or shared. Paged by the API.
import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronDown, FileText, LogIn, Search, ShieldCheck, SlidersHorizontal, Wrench, type LucideIcon } from 'lucide-react'
import type { AuditEntry } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { intlTag } from '../../lib/format'
import {
  ACTIVITY_KINDS, ACTIVITY_RANGES, NO_FILTERS, dayLabel, filtersActive, groupActivity, inSentence, matchesQuery, pathQuery,
  rangeBounds, readFilters, writeFilters, type ActivityFilters, type ActivityKind, type ActivityRun,
} from '../../lib/activity'
import { DICTS, useLocale, useT, type MessageKey } from '../../i18n'
import { Badge, Button, ErrorNote, Skeleton, StickyHeader } from '../../components/ui'
import { useLoad } from './common'

const KIND_ICON: Record<ActivityKind, LucideIcon> = { auth: LogIn, admin: ShieldCheck, file: FileText, tool: Wrench }
const ctl = 'h-8 rounded-lg border border-field-border bg-surface px-2.5 text-label text-ink outline-none transition focus:border-accent focus:ring-1 focus:ring-accent max-sm:min-h-10'

export default function Audit() {
  const t = useT()
  const locale = useLocale()
  const [params, setParams] = useSearchParams()
  const f = readFilters(params)
  const set = (patch: Partial<ActivityFilters>) => setParams((p) => writeFilters({ ...readFilters(p), ...patch }), { replace: true })
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const [items, setItems] = useState<AuditEntry[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // phones: the kind stays in view, the rest behind "Filters"
  const [more, setMore] = useState(false)
  // the search box answers at once; the address (and a path search on the server) follows a moment later
  const [q, setQ] = useState(f.q)
  useEffect(() => setQ(f.q), [f.q])
  useEffect(() => {
    const timer = setTimeout(() => q !== readFilters(new URLSearchParams(window.location.search)).q && set({ q }), 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const path = pathQuery(f.q)
  const bounds = rangeBounds(f)
  const load = async (moreRows: boolean) => {
    setBusy(true)
    try {
      const r = await api.call(API.audit, { query: { limit: 100, cursor: moreRows ? cursor ?? undefined : undefined, source: f.kind || undefined, actor: f.who || undefined, path, ...bounds } })
      setItems((cur) => (moreRows && cur ? [...cur, ...r.items] : r.items))
      setCursor(r.nextCursor)
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => void load(false), 150)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.kind, f.who, path, bounds.from, bounds.to])

  // the day labels stick just under the title row, whatever its height (it wraps on narrow screens)
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    const head = el?.querySelector<HTMLElement>('[data-sticky-header]')
    if (!el || !head) return
    const fit = () => el.style.setProperty('--activity-head', `${head.offsetHeight}px`)
    fit()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    ro?.observe(head)
    return () => ro?.disconnect()
  }, [])

  const shown = items && (path ? items : items.filter((e) => matchesQuery(e, f.q, actionLabel(t, e))))
  const days = shown ? groupActivity(shown) : []
  const active = filtersActive(f)
  const extra = (f.who ? 1 : 0) + (f.range !== 'any' ? 1 : 0) + (f.q ? 1 : 0)
  const clear = () => {
    setQ('')
    setParams(writeFilters(NO_FILTERS), { replace: true })
  }
  const words = { today: t('sidebar.today'), yesterday: t('sidebar.yesterday') }

  return (
    <div ref={box} data-testid="activity">
      <StickyHeader className="-mt-3 mb-1 py-3" testId="activity-header">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold tracking-tight">{t('admin.audit')}</h2>
          <p className="text-xs text-faint max-md:hidden">{t('audit.desc')}</p>
          {active && (
            <button type="button" className="ml-auto text-sm font-medium text-accent-text hover:underline" onClick={clear} data-testid="activity-clear">
              {t('activity.clear')}
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="activity-filters">
          <div role="group" aria-label={t('audit.kind')} className="flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-subtle p-0.5" data-testid="activity-kinds">
            {(['', ...ACTIVITY_KINDS] as const).map((k) => (
              <button
                key={k || 'all'}
                type="button"
                aria-pressed={f.kind === k}
                onClick={() => set({ kind: k })}
                className={clsx(
                  'rounded-md px-3 py-1 text-label font-medium whitespace-nowrap focus-visible:-outline-offset-2',
                  f.kind === k ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink',
                )}
              >
                {k ? t(`activity.chip.${k}`) : t('audit.all')}
              </button>
            ))}
          </div>
          <button type="button" className={clsx(ctl, 'inline-flex items-center gap-1.5 sm:hidden')} aria-expanded={more} onClick={() => setMore(!more)} data-testid="activity-more">
            <SlidersHorizontal size={14} aria-hidden /> {t('activity.filters')}
            {extra > 0 && <span className="rounded-full bg-accent px-1.5 text-micro text-accent-ink tabular-nums">{extra}</span>}
          </button>
          <div className={clsx('flex min-w-0 flex-wrap items-center gap-2 max-sm:w-full sm:flex-1', !more && 'max-sm:hidden')}>
            <select className={clsx(ctl, 'pr-8')} aria-label={t('audit.actor')} value={f.who} onChange={(e) => set({ who: e.target.value })} data-testid="activity-who">
              <option value="">{t('audit.everyone')}</option>
              {users.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <select className={clsx(ctl, 'pr-8')} aria-label={t('activity.when')} value={f.range} onChange={(e) => set({ range: e.target.value as ActivityFilters['range'] })} data-testid="activity-range">
              {ACTIVITY_RANGES.map((r) => (
                <option key={r} value={r}>
                  {t(`activity.range.${r}`)}
                </option>
              ))}
            </select>
            {f.range === 'custom' && (
              <span className="flex items-center gap-1">
                <input className={ctl} type="date" aria-label={t('audit.from')} value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} data-testid="audit-from" />
                <span className="text-faint" aria-hidden>–</span>
                <input className={ctl} type="date" aria-label={t('audit.to')} value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} data-testid="audit-to" />
              </span>
            )}
            <label className={clsx(ctl, 'flex min-w-0 flex-1 items-center gap-2 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent max-sm:basis-full sm:min-w-48')}>
              <Search size={14} className="shrink-0 text-faint" aria-hidden />
              <input type="search" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" placeholder={t('activity.search')} aria-label={t('activity.search')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="activity-search" />
            </label>
          </div>
        </div>
      </StickyHeader>

      {error && <ErrorNote onRetry={() => void load(false)}>{error}</ErrorNote>}
      {!items && !error && <Skeleton lines={8} />}
      {shown && !shown.length && (
        <p className="py-6 text-sm text-faint" data-testid="activity-empty">
          {active ? t('audit.none') : t('activity.empty')}{' '}
          {/* older pages may still hold a match (the search looks only at the rows loaded so far): look further back */}
          {active && cursor && (
            <button type="button" className="mr-3 font-medium text-accent-text hover:underline disabled:opacity-60" disabled={busy} onClick={() => void load(true)} data-testid="activity-search-older">
              {t('adminux.audit.searchOlder')}
            </button>
          )}
        </p>
      )}
      {shown && shown.length > 0 && (
        <div data-testid="audit-list">
          {days.map((d) => (
            <section key={d.day} aria-labelledby={`activity-day-${d.day}`} data-testid="activity-day">
              <h3 id={`activity-day-${d.day}`} className="sticky z-10 bg-[var(--sticky-bg)] py-1.5 text-xs font-medium text-faint" style={{ top: 'var(--activity-head, 0px)' }}>
                {dayLabel(d.day, intlTag(locale), words)}
              </h3>
              <ul className="divide-y divide-line">
                {d.runs.map((run) => (
                  <Row key={run.key} run={run} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {/* "Load more" only under rows: an empty result has its own line above */}
      {cursor && shown && shown.length > 0 && (
        <div className="pt-4 text-center">
          <Button size="sm" busy={busy} onClick={() => void load(true)} data-testid="activity-load-more">
            {t('common.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** One line: the time, the kind, "Dion signed in", the item, "· 5 times". Click: what is behind it. */
function Row({ run }: { run: ActivityRun }) {
  const t = useT()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const e = run.entries[0]!
  const n = run.entries.length
  const Icon = KIND_ICON[e.source]
  const ip = typeof e.detail?.ip === 'string' ? e.detail.ip : null
  return (
    <li data-testid="activity-row" data-kind={e.source}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 rounded-md px-1.5 py-2 text-left text-sm hover:bg-hover focus-visible:-outline-offset-2">
        <span className="w-[4.5rem] shrink-0 text-xs text-faint tabular-nums">{formatTime(e.at, locale)}</span>
        <Icon size={15} className="shrink-0 text-faint" aria-hidden />
        <span className="sr-only">{t(`audit.source.${e.source}`)}: </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-ink">{who(t, e)}</span> <Sentence e={e} />
          {n > 1 && <span className="text-faint" data-testid="activity-times"> · {t('activity.times', { count: n })}</span>}
        </span>
        {e.detail?.via === 'internet' && <Badge>{t('audit.viaInternet')}</Badge>}
        <ToolOutcome e={e} />
        {ip && <span className="shrink-0 text-xs text-faint tabular-nums max-sm:hidden" data-testid="audit-ip">{ip}</span>}
        <ChevronDown size={14} className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="mb-3 ml-1.5 rounded-lg bg-subtle px-3 py-2 sm:ml-[5.75rem]" data-testid="activity-detail">
          {/* a folded run: what they share once, then each time it happened */}
          <Details e={e} times={n > 1 ? run.entries.map((x) => x.at) : undefined} />
        </div>
      )}
    </li>
  )
}

/** "signed in", "changed a team skill · skills/x/SKILL.md", "AI used read · read groups/x -> denied". The action id
 * stays in the tooltip for anyone matching it with the server log. */
function Sentence({ e }: { e: AuditEntry }) {
  const t = useT()
  const label = actionLabel(t, e)
  const summary = e.source === 'tool' && typeof e.detail?.summary === 'string' ? e.detail.summary : ''
  // a sign-in's item is the username, already the person on the row
  const item = e.source === 'auth' ? null : e.target
  return (
    <>
      {e.source === 'tool' && <span className="text-faint">· </span>}
      <span className="text-muted" title={e.action}>
        {e.source === 'tool' ? t('activity.aiUsed', { tool: label }) : inSentence(label)}
      </span>
      {item && <span className="text-faint"> · <span className="font-mono text-xs">{item}</span></span>}
      {summary && <span className="text-faint"> · {arrows(summary)}</span>}
    </>
  )
}

/** Everything the row knows: exact time, who (and their id), the action id, the item, where from, and the rest as is. */
function Details({ e, times }: { e: AuditEntry; times?: string[] }) {
  const t = useT()
  const locale = useLocale()
  const exact = (iso: string) => new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso))
  const rows: [string, string][] = [
    ...(times ? [] : [[t('activity.detail.time'), exact(e.at)] as [string, string]]),
    [t('audit.kind'), t(`audit.source.${e.source}`)],
    [t('audit.actor'), e.actor ? `${e.actor.name} (${e.actor.id})` : who(t, e)],
    [t('activity.detail.action'), e.action],
  ]
  if (e.target) rows.push([t('activity.detail.item'), e.target])
  // the detail fields people read (what it did, the result, where from) get a name and words; the other fields stay as
  // the server wrote them, under "More details", for anyone matching the entry with the server log
  const detail: Record<string, unknown> = { ...(e.detail ?? {}) }
  const take = (k: string) => {
    const v = detail[k]
    delete detail[k]
    return v
  }
  const summary = typeof detail.summary === 'string' ? (take('summary') as string) : null
  if (summary) rows.push([t('adminux.audit.key.summary'), arrows(summary)])
  if (typeof detail.ok === 'number' || typeof detail.ok === 'boolean') {
    const failed = take('ok') === 0 || e.detail?.ok === false
    const denied = failed && !!summary && /-> denied\b/.test(summary)
    rows.push([t('adminux.audit.key.result'), t(denied ? 'audit.denied' : failed ? 'audit.failed' : 'adminux.audit.done')])
  }
  if (typeof detail.ip === 'string') rows.push([t('adminux.audit.key.ip'), take('ip') as string])
  if (detail.via === 'internet') {
    take('via')
    rows.push([t('adminux.audit.key.via'), t('audit.viaInternet')])
  }
  if (typeof detail.reason === 'string') rows.push([t('adminux.audit.key.reason'), take('reason') as string])
  const rest = Object.entries(detail).filter(([, v]) => v !== null && v !== undefined && v !== '')
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-faint">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
      {times && (
        <div className="contents">
          <dt className="text-faint">{t('activity.detail.time')}</dt>
          <dd>
            <ul data-testid="activity-times-list">
              {times.map((at, i) => (
                <li key={i} className="tabular-nums text-ink">{exact(at)}</li>
              ))}
            </ul>
          </dd>
        </div>
      )}
      {rest.length > 0 && <div className="col-span-2 mt-1.5 text-faint">{t('adminux.audit.moreDetails')}</div>}
      {rest.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-mono text-faint">{k}</dt>
          <dd className="min-w-0 break-words text-ink">
            {typeof v === 'object' ? <pre className="overflow-x-auto whitespace-pre-wrap font-mono">{JSON.stringify(v, null, 2)}</pre> : <span className="font-mono">{String(v)}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const formatTime = (iso: string, locale: Parameters<typeof intlTag>[0]) => new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))

/** No person: the AI for file and tool events, else the server itself (failed sign-ins, a reset link made on the server Mac). */
const who = (t: ReturnType<typeof useT>, e: AuditEntry) => e.actor?.name ?? t(e.source === 'file' || e.source === 'tool' ? 'files.byAi' : 'audit.system')

/**
 * What happened, in words: admin and sign-in actions ("auth.login" → "로그인"), file events ("conflict" → "충돌 사본
 * 만듦"). Tool calls keep the tool's name (read, write, web_fetch: the summary next to it says what it did); the id
 * stays in the tooltip for anyone matching it with the server log. Unknown ids are shown as they are.
 */
export function actionLabel(t: ReturnType<typeof useT>, e: AuditEntry): string {
  const key = e.source === 'file' ? `audit.file.${e.action}` : e.source === 'tool' ? (e.action === '(connect)' ? 'audit.tool.connect' : '') : `audit.act.${e.action}`
  return key && key in DICTS.ko ? t(key as MessageKey) : e.action
}

/** Tool calls: whether the call was refused (permission) or failed. */
function ToolOutcome({ e }: { e: AuditEntry }) {
  const t = useT()
  if (e.source !== 'tool' || !e.detail) return null
  const summary = typeof e.detail.summary === 'string' ? e.detail.summary : ''
  const failed = e.detail.ok === 0 || e.detail.ok === false
  if (!failed) return null
  return <Badge tone="danger">{t(/-> denied\b/.test(summary) ? 'audit.denied' : 'audit.failed')}</Badge>
}

/** A tool summary's "->" ("read hr/x.xlsx -> denied: no access") as an arrow, which reads as words, not as code. */
const arrows = (text: string) => text.replace(/\s*->\s*/g, ' → ')
