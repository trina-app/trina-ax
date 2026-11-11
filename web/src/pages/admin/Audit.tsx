// Activity log: admin actions, file changes, AI tool use and sign-ins. The title and the filters stay at the top while the
// list scrolls; the list reads as sentences grouped by day, with repeats folded into one row ("Dion signed in · 5 times").
// The filters live in the address (lib/activity.ts), so a filtered view can be reloaded or shared. Paged by the API.
// A phone (below 768 px; docs/DECISIONS.md "Admin and Settings on phones"): the bar says the page's name (the title is
// for screen readers), and only the search with one Filters button stays at the top; the kind, the person, the time and
// Clear open under it (components/PhoneFilters.tsx), so the kinds never run off the screen (in Spanish they need about
// 550 px). A row opens the record's own page (/admin/audit/<id>, adminScreens.ts) with what is behind it, and Back
// returns to the list where it was.
import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronRight, FileText, LogIn, Search, ShieldCheck, Wrench, type LucideIcon } from 'lucide-react'
import { BROWSER_STEP_VERB, FILE_STEP_VERB } from '@mycel/shared'
import type { AuditEntry } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { intlTag } from '../../lib/format'
import {
  ACTIVITY_KINDS, ACTIVITY_RANGES, NO_FILTERS, dayLabel, filtersActive, groupActivity, inSentence, matchesQuery, pathQuery,
  rangeBounds, readFilters, writeFilters, type ActivityFilters, type ActivityKind, type ActivityRun,
} from '../../lib/activity'
import { currentLocale, DICTS, useLocale, useT, type MessageKey } from '../../i18n'
import { Badge, Button, ErrorNote, Skeleton, StickyHeader, useMediaQuery } from '../../components/ui'
import { PhoneFilters } from '../../components/PhoneFilters'
import { useLoad } from './common'
import { useAdminBar, useUpTo } from './phoneBar'

const KIND_ICON: Record<ActivityKind, LucideIcon> = { auth: LogIn, admin: ShieldCheck, file: FileText, tool: Wrench }
const ctl = 'h-8 rounded-lg border border-field-border bg-surface px-2.5 text-label text-ink outline-none transition focus:border-accent focus:ring-1 focus:ring-accent max-md:min-h-10'

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
  const phone = useMediaQuery('(max-width: 767.98px)')
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
  }, [phone])

  const shown = items && (path ? items : items.filter((e) => matchesQuery(e, f.q, actionLabel(t, e))))
  const days = shown ? groupActivity(shown) : []
  const active = filtersActive(f)
  const clear = () => {
    setQ('')
    setParams(writeFilters(NO_FILTERS), { replace: true })
  }
  const words = { today: t('sidebar.today'), yesterday: t('sidebar.yesterday') }
  // a phone: a record's own page, pushed from its row with the list's filters kept in the address
  const sub = useParams().sub
  const navigate = useNavigate()
  const upTo = useUpTo()
  const opened = phone && sub ? days.flatMap((d) => d.runs).find((r) => r.entries[0]!.id === sub) : undefined
  const missing = phone && !!sub && !!shown && !busy && !opened
  useEffect(() => { if (missing) upTo('/admin/audit') }, [missing]) // eslint-disable-line react-hooks/exhaustive-deps
  useAdminBar(opened ? t('audit.recordTitle') : null)
  const openRun = phone ? (run: ActivityRun) => navigate(`/admin/audit/${encodeURIComponent(run.entries[0]!.id)}${window.location.search}`) : undefined
  if (phone && sub) return opened ? <RecordPage run={opened} /> : <Skeleton lines={4} />
  const clearButton = (
    <button type="button" className="ml-auto text-sm font-medium text-accent-text hover:underline max-md:ml-0 max-md:min-h-10" onClick={clear} data-testid="activity-clear">
      {t('activity.clear')}
    </button>
  )
  // the kind: a computer's row of segments; a phone's wrap inside Filters
  const kinds = (
    <div role="group" aria-label={t('audit.kind')} className="flex max-w-full gap-0.5 rounded-lg bg-subtle p-0.5 md:overflow-x-auto max-md:flex-wrap" data-testid="activity-kinds">
      {(['', ...ACTIVITY_KINDS] as const).map((k) => (
        <button
          key={k || 'all'}
          type="button"
          aria-pressed={f.kind === k}
          onClick={() => set({ kind: k })}
          className={clsx(
            'rounded-md px-3 py-1 text-label font-medium whitespace-nowrap focus-visible:-outline-offset-2 max-md:min-h-10',
            f.kind === k ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink',
          )}
        >
          {k ? t(`activity.chip.${k}`) : t('audit.all')}
        </button>
      ))}
    </div>
  )
  const who = (
    <select className={clsx(ctl, 'pr-8')} aria-label={t('audit.actor')} value={f.who} onChange={(e) => set({ who: e.target.value })} data-testid="activity-who">
      <option value="">{t('audit.everyone')}</option>
      {users.data?.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </select>
  )
  const when = (
    <>
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
    </>
  )
  const search = (
    <label className={clsx(ctl, 'flex min-w-0 flex-1 items-center gap-2 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent sm:min-w-48')}>
      <Search size={14} className="shrink-0 text-faint" aria-hidden />
      <input type="search" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" placeholder={t('activity.search')} aria-label={t('activity.search')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="activity-search" />
    </label>
  )

  return (
    <div ref={box} data-testid="activity">
      {phone ? (
        // a phone: the bar above says the name; the search and Filters on one row, the only part that stays at the top
        <StickyHeader className="-mt-3 mb-1 flex flex-wrap items-center gap-2 py-2" testId="activity-header">
          <h2 className="sr-only">{t('admin.audit')}</h2>
          <div className="flex w-full flex-wrap items-center gap-2" data-testid="activity-filters">
            {search}
            <PhoneFilters active={(f.kind ? 1 : 0) + (f.who ? 1 : 0) + (f.range !== 'any' ? 1 : 0)} testId="activity-more">
              {kinds}
              {who}
              {when}
              {active && clearButton}
            </PhoneFilters>
          </div>
        </StickyHeader>
      ) : (
        <StickyHeader className="-mt-3 mb-1 py-3" testId="activity-header">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold tracking-tight">{t('admin.audit')}</h2>
            <p className="text-xs text-faint">{t('audit.desc')}</p>
            {active && clearButton}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="activity-filters">
            {kinds}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {who}
              {when}
              {search}
            </div>
          </div>
        </StickyHeader>
      )}

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
                  <Row key={run.key} run={run} onOpen={openRun} />
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

/** A phone's page of one record (a folded run: each time it happened): the sentence, then what is behind it. */
function RecordPage({ run }: { run: ActivityRun }) {
  const t = useT()
  const locale = useLocale()
  const e = run.entries[0]!
  const n = run.entries.length
  return (
    <section aria-labelledby="activity-record-title" data-testid="activity-record" data-kind={e.source}>
      <h2 id="activity-record-title" className="text-base break-words">
        <span className="font-semibold text-ink">{who(t, e)}</span> <Sentence e={e} />
      </h2>
      <p className="mt-1 text-xs text-faint tabular-nums">
        {new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(e.at))}{n > 1 && <> · {t('activity.times', { count: n })}</>}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {e.detail?.via === 'internet' && <Badge>{t('audit.viaInternet')}</Badge>}
        <ToolOutcome e={e} />
      </div>
      <div className="mt-4 border-t border-line pt-3 text-sm" data-testid="activity-detail">
        <Details e={e} times={n > 1 ? run.entries.map((x) => x.at) : undefined} />
      </div>
    </section>
  )
}

/** One line: the time, the kind, "Dion signed in", the item, "· 5 times". Click: what is behind it (a phone, `onOpen`:
 * the record's own page). */
function Row({ run, onOpen }: { run: ActivityRun; onOpen?: (run: ActivityRun) => void }) {
  const t = useT()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const e = run.entries[0]!
  const n = run.entries.length
  const Icon = KIND_ICON[e.source]
  const ip = typeof e.detail?.ip === 'string' ? e.detail.ip : null
  return (
    <li data-testid="activity-row" data-kind={e.source}>
      <button type="button" aria-expanded={onOpen ? undefined : open} onClick={() => (onOpen ? onOpen(run) : setOpen(!open))} className="flex w-full items-center gap-3 rounded-md px-1.5 py-2 text-left text-sm hover:bg-hover focus-visible:-outline-offset-2 max-md:min-h-12">
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
        {onOpen ? <ChevronRight size={14} className="shrink-0 text-faint" aria-hidden /> : <ChevronDown size={14} className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-180')} aria-hidden />}
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

/** "signed in", "changed a team skill · skills/x/SKILL.md", "프로젝트 만듦 · 출시 준비", "AI가 파일 읽기 사용 ·
 * groups/x/a.csv". The action id stays in the tooltip for anyone matching it with the server log; ids and the tool's
 * summary as the server wrote it are in the row's details. */
function Sentence({ e }: { e: AuditEntry }) {
  const t = useT()
  const label = actionLabel(t, e)
  const item = rowItem(e)
  return (
    <>
      {e.source === 'tool' && <span className="text-faint">· </span>}
      <span className="text-muted" title={e.action}>
        {e.source === 'tool' ? t('activity.aiUsed', { tool: label }) : inSentence(label)}
      </span>
      {item && <span className="text-faint"> · <span className={clsx(item.code && 'font-mono text-xs')}>{item.text}</span></span>}
      {item?.confirmed && <span className="text-faint"> · {t('activity.confirmedByUser')}</span>}
    </>
  )
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * What the row names after the action, when it reads as words: the item (a path, a username, a skill folder); for an
 * item that is an id (a project's, a room's, an invite's) its name when the entry has one; for an AI tool, the path or
 * address it worked on ("read shared/a.csv -> 4 lines" → shared/a.csv). A sign-in's item is the username, already the
 * person on the row. The rest (the id, the whole summary, the process behind a tool connection) is in the details.
 */
export function rowItem(e: AuditEntry): { text: string; code: boolean; confirmed?: true } | null {
  if (e.source === 'auth') return null
  if (e.source === 'tool') {
    const summary = typeof e.detail?.summary === 'string' ? e.detail.summary : ''
    const [head = '', ...rest] = summary.split(' -> ')
    const tail = rest.join(' -> ')
    // "(confirmed by the user)", "(address confirmed by the user)", …: the person allowed it on a card
    const confirmed = /confirmed by the user/.test(summary) ? ({ confirmed: true } as const) : {}
    const item = head.startsWith(`${e.action} `) ? head.slice(e.action.length + 1).trim() : ''
    // a web address (web_fetch …): host and path, and "?…" when a query was left out (the query is where data that
    // leaves would be: an admin needs to see that there was one)
    const url = /^https?:\/\/\S+/i.exec(item)?.[0]
    if (url) {
      try {
        const u = new URL(url)
        return { text: `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search ? '?…' : ''}`, code: true, ...confirmed }
      } catch { /* not an address after all */ }
    }
    // a file the tool saved (make_file pdf -> users/a/b.pdf 12B, save_url -> users/a/b.png (…)): the saved path
    if (e.action === 'make_file' || e.action === 'save_url') {
      const saved = /^(\S+\/\S+)/.exec(tail)?.[1]
      return saved ? { text: saved, code: true, ...confirmed } : null
    }
    return item.includes('/') && !/[{}"=]/.test(item) ? { text: item, code: true, ...confirmed } : null
  }
  if (!e.target) return null
  if (!ID.test(e.target)) return { text: e.target, code: true }
  const name = e.detail?.name
  return typeof name === 'string' && name.trim() ? { text: name, code: false } : null
}

/** Reasons the server writes as ids that have words ("<action>:<reason>"); any other reason is shown as written. */
const REASON_WORDS: Record<string, MessageKey> = {
  'remote_mcp.scope_dropped:role': 'audit.reason.notAdmin',
  'remote_mcp.scope_dropped:status': 'audit.reason.disabled',
  'remote_mcp.tool:not_admin': 'audit.reason.notAdmin',
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
  // a person's own AI app through the MCP connector (its tools, its upload links, the group changes it made)
  if (detail.via === 'connector' || detail.via === 'connector_link') {
    take('via')
    rows.push([t('adminux.audit.key.via'), t('audit.viaConnector')])
  }
  if (typeof detail.reason === 'string') {
    const reason = take('reason') as string
    const words = REASON_WORDS[`${e.action}:${reason}`]
    rows.push([t('adminux.audit.key.reason'), words ? t(words) : reason])
  }
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
 * 만듦"), and the AI's own tools in the words of the steps under an answer ("read" → "파일 읽기", shared/step-labels.ts).
 * The id stays in the tooltip for anyone matching it with the server log. Unknown ids (another service's tool) are
 * shown as they are.
 */
export function actionLabel(t: ReturnType<typeof useT>, e: AuditEntry): string {
  if (e.source === 'tool') {
    if (e.action === '(connect)') return t('audit.tool.connect')
    const words = Object.hasOwn(FILE_STEP_VERB, e.action) ? FILE_STEP_VERB[e.action] : Object.hasOwn(BROWSER_STEP_VERB, e.action) ? BROWSER_STEP_VERB[e.action] : undefined
    return words?.[currentLocale()] ?? e.action
  }
  const key = e.source === 'file' ? `audit.file.${e.action}` : `audit.act.${e.action}`
  return key in DICTS.ko ? t(key as MessageKey) : e.action
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
