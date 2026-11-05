// Scheduled tasks, from the sidebar (like Claude's "Scheduled"): /scheduled lists the person's own tasks as quiet cards
// (name, what it does, "Paused · Weekdays at 09:00", how the last run went), /scheduled/:id is one task: run now, on/off,
// its last run, and what it does, when, and with what. The same rules as before in Settings › Scheduled tasks
// (docs/DECISIONS.md "Scheduled tasks: run now, edit, pause", "Scheduled tasks nobody confirmed"): a finished or expired
// one-time task keeps its switch, disabled, with the reason linked to it; a free-text task nobody confirmed has "Check
// again" instead, which opens its schedule card here; edits go through ScheduleEditDialog. New tasks are made by the AI
// in a chat (its card) or from a template. Only presentation moved: the API is the same (shared/src/api/schedules.ts).
import clsx from 'clsx'
import { CalendarClock, ChevronDown, LayoutTemplate, MessageSquarePlus, Pencil, Play, Search, ShieldAlert, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Project, Schedule, ScheduleReviewCard } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { readDraft, writeDraft } from '../lib/localData'
import { cardLine, outcomeLabel, outcomeReason, outcomeTone, repeatText, scheduleName, schedulePreview, scheduleState, stateLabel, type Tone } from '../lib/scheduleText'
import { useLocale, useT } from '../i18n'
import { schedulesChanged } from '../store/live'
import { useMeStrict } from '../store/session'
import { toast } from '../store/ui'
import AskCard from '../components/chat/AskCard'
import { ScheduleEditDialog } from '../components/settings/ScheduleEditDialog'
import { ScheduleTemplates } from '../components/settings/ScheduleTemplates'
import { TitleMenu } from '../components/TitleMenu'
import { Button, EmptyState, ErrorNote, IconButton, Modal, Skeleton, StickyHeader, confirmDialog, inputCls, pageColumn } from '../components/ui'

const DOT: Record<Tone | 'ok', string> = { ok: 'bg-ok', muted: 'bg-faint', warn: 'bg-warn', danger: 'bg-danger' }
const TEXT: Record<Tone, string> = { muted: 'text-muted', warn: 'text-warn', danger: 'text-danger' }

/** The last run's result as a small dot, with its words for screen readers and on hover. */
function OutcomeDot({ s }: { s: Schedule }) {
  const t = useT()
  if (!s.lastOutcome) return null
  const tone = outcomeTone(s.lastOutcome)
  const label = outcomeLabel(s, t)
  return (
    <span className="inline-flex shrink-0 items-center" title={label} data-testid="schedule-dot" data-outcome={s.lastOutcome}>
      <span className={clsx('size-2 rounded-full', DOT[s.lastOutcome === 'done' ? 'ok' : tone])} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** The person's own tasks and the team time zone they run in, kept fresh when another screen changes them. */
function useScheduleList() {
  const t = useT(), locale = useLocale()
  const [items, setItems] = useState<Schedule[] | null>(null)
  const [tz, setTz] = useState('')
  const [error, setError] = useState<string | null>(null)
  const life = useRef(0), revision = useRef(0)
  const load = useCallback(async () => {
    const generation = life.current, rev = ++revision.current
    try {
      const r = await api.call(API.listSchedules)
      if (generation !== life.current || rev !== revision.current) return
      setItems(r.items)
      setTz(r.timeZone)
      setError(null)
    } catch (e) {
      if (generation === life.current && rev === revision.current) setError(errorText(e, locale, t('error.network')))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    life.current++
    void load()
    const off = schedulesChanged.on(() => void load())
    return () => { life.current++; off() }
  }, [load])
  const replace = (u: Schedule) => { revision.current++; setItems((cur) => cur?.map((x) => (x.id === u.id ? u : x)) ?? null) }
  const add = (u: Schedule) => { revision.current++; setItems((cur) => [u, ...(cur ?? []).filter((x) => x.id !== u.id)]) }
  const drop = (id: string) => { revision.current++; setItems((cur) => cur?.filter((x) => x.id !== id) ?? null) }
  return { items, tz, error, load, replace, add, drop, life }
}

/** "Describe it in a chat": a new chat with a start for the sentence in its box. */
function useStartInChat() {
  const t = useT(), me = useMeStrict(), navigate = useNavigate()
  return () => {
    // a start for the sentence in the new-chat box, unless something is already typed there
    if (!readDraft(me.user.id, 'new')) writeDraft(me.user.id, 'new', t('scheduled.chatStarter'))
    navigate('/')
  }
}

/** "New task ⌄": describe it to the AI in a new chat (it makes it on a card), or fill in a template. */
function NewTaskMenu({ onTemplate, testId }: { onTemplate: () => void; testId: string }) {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const menuItems = () => [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
  useEffect(() => {
    if (!open) return
    menuItems()[0]?.focus()
    // not on losing focus: Safari moves focus off a button when it is pressed (TitleMenu)
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.stopPropagation()
      setOpen(false)
      box.current?.querySelector('button')?.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const all = menuItems()
      const at = all.indexOf(document.activeElement as HTMLElement)
      all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
    }
  }
  const inChat = useStartInChat()
  const items = [
    { label: t('scheduled.newInChat'), icon: <MessageSquarePlus size={15} aria-hidden />, run: inChat, id: 'chat' },
    { label: t('scheduled.newFromTemplate'), icon: <LayoutTemplate size={15} aria-hidden />, run: onTemplate, id: 'template' },
  ]
  return (
    <div ref={box} className="relative" onKeyDown={onKeyDown}>
      <Button variant="primary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid={testId}>
        {t('scheduled.newTask')} <ChevronDown size={14} aria-hidden />
      </Button>
      {open && (
        <div role="menu" aria-label={t('scheduled.newTask')} className="absolute top-full right-0 z-30 mt-1 w-60 rounded-lg border border-line bg-surface p-1 text-left shadow-lg">
          {items.map((it) => (
            <button key={it.id} role="menuitem" type="button" data-testid={`new-task-${it.id}`}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm -outline-offset-2 hover:bg-hover focus:bg-hover"
              onClick={() => { setOpen(false); it.run() }}>
              {it.icon} {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ScheduleCard({ s }: { s: Schedule }) {
  const t = useT(), locale = useLocale()
  const waiting = scheduleState(s) === 'review'
  return (
    <Link to={`/scheduled/${s.id}`} className="block h-full rounded-xl bg-subtle px-4 py-3.5 transition-colors hover:bg-hover" data-testid="schedule-item" data-review={waiting ? 'waiting' : undefined}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{scheduleName(s, t)}</span>
        {waiting && <ShieldAlert size={14} className="shrink-0 text-warn" aria-hidden />}
      </span>
      <span className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted">{schedulePreview(s)}</span>
      <span className={clsx('mt-1.5 block truncate text-xs', waiting ? 'text-warn' : 'text-faint')}>{cardLine(s, t, locale)}</span>
      {/* the last result in words beside its dot: phones have no hover title, and every failure is the same red */}
      {s.lastOutcome && (
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs" data-testid="schedule-card-outcome" data-outcome={s.lastOutcome}>
          <span className={clsx('size-2 shrink-0 rounded-full', DOT[s.lastOutcome === 'done' ? 'ok' : outcomeTone(s.lastOutcome)])} aria-hidden />
          <span className={clsx('truncate', s.lastOutcome === 'done' ? 'text-faint' : TEXT[outcomeTone(s.lastOutcome)])}>{outcomeLabel(s, t)}</span>
        </span>
      )}
    </Link>
  )
}

/** /scheduled */
export function ScheduledList() {
  const t = useT()
  const { items, tz, error, load, add } = useScheduleList()
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const startInChat = useStartInChat()
  const q = query.trim().toLowerCase()
  const shown = items?.filter((s) => !q || scheduleName(s, t).toLowerCase().includes(q)) ?? []
  const closeSearch = () => { setQuery(''); setSearching(false) }
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className={clsx(pageColumn, 'p-4 sm:p-6')}>
        <StickyHeader className="-mt-3 mb-4 flex flex-wrap items-center gap-x-3 gap-y-3 py-3" testId="scheduled-header">
          <h1 className="text-xl font-semibold tracking-tight">{t('settings.schedules')}</h1>
          <div className="ml-auto flex items-center gap-1.5">
            {searching ? (
              <div className="relative w-48 sm:w-56">
                <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
                <input type="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSearch() } }}
                  placeholder={t('scheduled.search')} aria-label={t('scheduled.search')} className={`${inputCls} pr-8 pl-9`} data-testid="scheduled-search" data-own-clear />
                <button type="button" aria-label={t('scheduled.closeSearch')} onClick={closeSearch} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-faint hover:text-ink">
                  <X size={14} aria-hidden />
                </button>
              </div>
            ) : (
              items && items.length > 0 && (
                <IconButton label={t('scheduled.search')} onClick={() => setSearching(true)} data-testid="scheduled-search-open">
                  <Search size={16} />
                </IconButton>
              )
            )}
            <NewTaskMenu onTemplate={() => setTemplateOpen(true)} testId="new-task" />
          </div>
        </StickyHeader>
        {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
        {!items && !error && <Skeleton lines={4} />}
        {items && !items.length && (
          <div data-testid="scheduled-empty">
            <EmptyState icon={<CalendarClock size={28} aria-hidden />} title={t('schedules.empty')}>
              <p>{t('scheduled.emptyBody')}</p>
              {/* the same two ways to start as the "New task" menu, shown as buttons so the first step is visible */}
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Button variant="primary" onClick={startInChat} data-testid="scheduled-empty-chat">
                  <MessageSquarePlus size={15} aria-hidden /> {t('scheduled.newInChat')}
                </Button>
                <Button onClick={() => setTemplateOpen(true)} data-testid="scheduled-empty-template">
                  <LayoutTemplate size={15} aria-hidden /> {t('scheduled.newFromTemplate')}
                </Button>
              </div>
            </EmptyState>
          </div>
        )}
        {items && items.length > 0 && (
          <>
            {shown.length ? (
              <ul className="grid gap-3 sm:grid-cols-2" data-testid="schedule-list">
                {shown.map((s) => (
                  <li key={s.id} className="min-w-0">
                    <ScheduleCard s={s} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-12 text-center text-sm text-muted" data-testid="scheduled-no-match">{t('scheduled.noMatch', { q: query.trim() })}</p>
            )}
            {tz && <p className="mt-4 text-xs text-faint" data-testid="scheduled-tz">{t('schedules.timeZone', { tz })}</p>}
          </>
        )}
      </div>
      <Modal open={templateOpen} onClose={() => setTemplateOpen(false)} title={t('scheduleTemplates.title')} width={560}>
        <ScheduleTemplates inDialog onCreated={(s) => { add(s); setTemplateOpen(false); toast({ level: 'success', text: t('scheduled.created') }) }} />
      </Modal>
    </div>
  )
}

/** One short section of the detail page's side column (Instructions, Repeats, ...). */
function Side({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <section className="py-4 first:pt-0" data-testid={testId}>
      <h2 className="text-sm font-medium">{label}</h2>
      <div className="mt-1.5 text-sm text-muted">{children}</div>
    </section>
  )
}

/** One task: the part the page draws (exported for tests). The actions are absent where they are not offered. */
export function ScheduleView({ s, tz, project, onToggle, onRunNow, running, onReview, review }: {
  s: Schedule; tz: string | null
  /** the project it runs in, when it has one and it can be read */
  project?: Pick<Project, 'id' | 'name'> | null
  onToggle: () => void
  onRunNow?: () => void
  running?: boolean
  /** "Check again": open its card (a task nobody confirmed) */
  onReview?: () => void
  /** that card, while it is open */
  review?: ReactNode
}) {
  const t = useT(), locale = useLocale()
  const base = useId()
  const [more, setMore] = useState(false)
  const state = scheduleState(s)
  const blocked = state === 'completed' || state === 'expired'
  const waiting = state === 'review'
  const name = scheduleName(s, t)
  const when = (iso: string | null | undefined) => formatDateTime(iso, locale, tz || undefined)
  const hintId = `${base}-hint`
  const status = state === 'on' ? (s.nextRunAt ? t('schedules.next', { time: when(s.nextRunAt) }) : '') : stateLabel(s, t)
  // a last run that did not succeed also shows under the title: on a phone the run section is far below the fold
  const badOutcome = s.lastOutcome && s.lastOutcome !== 'done' ? s.lastOutcome : null
  // a finished or expired one-time task can still run once with "Run now", so its hint says that, not "create a new schedule"
  const runNowShown = !!onRunNow && !waiting
  const hint = blocked
    ? t(runNowShown ? (state === 'completed' ? 'scheduled.completedRunHint' : 'scheduled.expiredRunHint') : `schedules.${state}Hint`)
    : waiting ? t('schedules.reviewHint') : state === 'paused' ? t('schedules.pausedHint') : ''
  const long = !s.templateId && (s.prompt.length > 180 || s.prompt.split('\n').length > 3)
  const ran = s.lastRunAt || s.lastChatId
  const reason = outcomeReason(s, t)
  // The API keeps only the last run (lastRunAt, lastChatId, lastOutcome), so the section shows that one run: when it ran,
  // how it went, why in plain words, and a link to its chat.
  const runLine = (
    <span className="min-w-0 flex-1">
      <span className="block text-sm text-ink">{s.lastRunAt ? when(s.lastRunAt) : t('schedules.lastRun')}</span>
      {s.lastOutcome && (
        <span className={clsx('mt-0.5 flex items-center gap-1.5 text-xs', TEXT[outcomeTone(s.lastOutcome)])} data-testid="schedule-outcome" data-outcome={s.lastOutcome}>
          <OutcomeDot s={s} />
          <span aria-hidden>{outcomeLabel(s, t)}</span>
        </span>
      )}
      {reason && <span className="mt-1 block text-xs text-muted" data-testid="schedule-outcome-reason">{reason}</span>}
      {s.lastChatId && <span className="mt-1 block text-xs text-accent-text">{t('scheduled.openResult')}</span>}
    </span>
  )
  return (
    <div data-testid="schedule-view" data-review={waiting ? 'waiting' : undefined}>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <div className="min-w-0 flex-[1_1_18rem]">
          <h1 className="text-[26px] font-semibold tracking-tight break-words sm:text-[30px]">{name}</h1>
          {(status || badOutcome) && (
            <p className={clsx('mt-1.5 text-sm', waiting ? 'text-warn' : 'text-muted')} data-testid="schedule-status">
              {status}
              {status && badOutcome && <span aria-hidden> · </span>}
              {badOutcome && <span className={TEXT[outcomeTone(badOutcome)]} data-testid="schedule-status-outcome">{outcomeLabel(s, t)}</span>}
            </p>
          )}
          {hint && (
            <p id={hintId} className={clsx('mt-1 flex items-start gap-1 text-xs', waiting ? 'text-warn' : 'text-faint')} data-testid={blocked ? 'schedule-blocked-hint' : waiting ? 'schedule-review-hint' : 'schedule-paused-hint'}>
              {waiting && <ShieldAlert size={13} className="mt-px shrink-0" aria-hidden />}
              {hint}
            </p>
          )}
          {s.pendingDueAt && <p className="mt-1 text-xs text-faint" data-testid="schedule-deferred">{t('scheduleTemplates.deferred', { time: when(s.retryAt ?? s.pendingDueAt) })}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-4">
          {onRunNow && !waiting && (
            <Button size="sm" busy={running} title={t('schedules.runNowHint')} onClick={onRunNow} data-testid="schedule-run-now">
              {!running && <Play size={13} aria-hidden />} {t('schedules.runNow')}
            </Button>
          )}
          {waiting ? (
            <Button size="sm" variant="primary" aria-describedby={hintId} aria-expanded={!!review} onClick={onReview} data-testid="schedule-review">
              {t('schedules.review')}
            </Button>
          ) : (
            <span className="flex items-center gap-2 text-sm text-muted">
              {/* a disabled switch has no label: the state is already in the status line and the hint */}
              {!blocked && <span aria-hidden>{s.enabled ? t('scheduled.on') : stateLabel(s, t)}</span>}
              <button type="button" role="switch" aria-checked={s.enabled} aria-label={t('scheduled.switch')} disabled={blocked}
                aria-describedby={blocked ? hintId : undefined} onClick={blocked ? undefined : onToggle} data-testid="schedule-toggle"
                className="relative h-5 w-9 shrink-0 rounded-full bg-field-border transition after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:transition aria-checked:bg-accent aria-checked:after:translate-x-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 dark:aria-checked:after:bg-accent-ink" />
            </span>
          )}
        </div>
      </div>
      {review && <div className="mt-5" data-testid="schedule-review-card">{review}</div>}
      {/* phone: what it is first, then its runs; wide: the runs on the left, what it is beside them */}
      <div className="mt-8 grid gap-x-12 gap-y-8 border-t border-line pt-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-labelledby={`${base}-history`} className="order-2 min-w-0 lg:order-1" data-testid="schedule-history">
          <h2 id={`${base}-history`} className="text-sm font-medium">{t('scheduled.lastRunTitle')}</h2>
          {ran ? (
            <ul className="mt-2 divide-y divide-line">
              <li>
                {s.lastChatId ? (
                  <Link to={`/c/${s.lastChatId}`} className="-mx-2 flex items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-hover" data-testid="schedule-run-link">{runLine}</Link>
                ) : (
                  <div className="flex items-center gap-3 py-2.5">{runLine}</div>
                )}
              </li>
            </ul>
          ) : (
            <p className="mt-2 text-sm text-faint">{t('scheduled.noRuns')}</p>
          )}
        </section>
        <div className="order-1 min-w-0 divide-y divide-line lg:order-2">
          <Side label={t('schedules.field.prompt')} testId="schedule-instructions">
            {s.templateId ? (
              <p>{t('scheduleTemplates.hint')}</p>
            ) : (
              <>
                <p className={clsx('break-words whitespace-pre-wrap', !more && long && 'line-clamp-3')}>{s.prompt}</p>
                {long && (
                  <button type="button" aria-expanded={more} onClick={() => setMore((v) => !v)} className="mt-1 text-xs text-accent-text hover:underline">
                    {t(more ? 'scheduled.showLess' : 'scheduled.showMore')}
                  </button>
                )}
              </>
            )}
          </Side>
          <Side label={t('scheduled.repeats')} testId="schedule-repeats">
            <p>{repeatText(s, t, locale)}</p>
            {tz && <p className="mt-0.5 text-xs text-faint">{t('schedules.timeZone', { tz })}</p>}
          </Side>
          <Side label={t('scheduled.runsWith')} testId="schedule-runs-with">
            {s.templateId ? (
              <>
                <p>{t('scheduleTemplates.source')}: <span className="text-ink">{s.sourcePath}</span></p>
                <p>{t('scheduleTemplates.output')}: <span className="text-ink">{s.outputPath}</span></p>
              </>
            ) : s.projectId && project ? (
              <Link to={`/projects/${project.id}`} className="text-ink hover:underline">{project.name}</Link>
            ) : (
              <p>{t('schedules.noProject')}</p>
            )}
          </Side>
          <Side label={t('scheduled.details')} testId="schedule-details">
            {s.enabled && s.nextRunAt && <p>{t('schedules.next', { time: when(s.nextRunAt) })}</p>}
            {s.lastRunAt ? <p>{t('scheduled.lastRunAt', { time: when(s.lastRunAt) })}</p> : !ran && <p>{t('scheduled.noRuns')}</p>}
          </Side>
        </div>
      </div>
    </div>
  )
}

/** /scheduled/:id */
export function ScheduledTask() {
  const t = useT(), locale = useLocale(), navigate = useNavigate()
  const { id = '' } = useParams()
  const { items, tz, error, load, replace, drop, life } = useScheduleList()
  const s = items?.find((x) => x.id === id) ?? null
  const [projects, setProjects] = useState<Project[] | null>(null)
  useEffect(() => {
    let live = true
    api.call(API.listProjects).then((r) => { if (live) setProjects(r.items) }, () => { if (live) setProjects([]) })
    return () => { live = false }
  }, [])
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
  const toggle = async (x: Schedule) => {
    const generation = life.current
    try {
      const u = await api.call(API.updateSchedule, { params: { id: x.id }, body: { enabled: !x.enabled } })
      if (generation === life.current) replace(u)
    } catch (e) { fail(e) }
  }
  // "다시 확인": the task's card, here; resuming is answering it
  const [review, setReview] = useState<ScheduleReviewCard | null>(null)
  const openReview = async (x: Schedule) => {
    if (review) { setReview(null); return }
    const generation = life.current
    try {
      const card = await api.call(API.getScheduleReview, { params: { id: x.id } })
      if (generation === life.current) setReview(card)
    } catch (e) {
      fail(e)
      if (generation === life.current) void load()
    }
  }
  const answerReview = async (x: Schedule, requestId: string, answer: string | string[] | null) => {
    const value = Array.isArray(answer) ? answer[0] ?? null : answer
    // "Skip" leaves it paused, like "Keep it paused"
    if (!value || value === 'keep') { setReview(null); return }
    const generation = life.current
    try {
      const u = await api.call(API.confirmScheduleReview, { params: { id: x.id }, body: { requestId, answer: value } })
      if (generation !== life.current) return
      replace(u)
      setReview(null)
      schedulesChanged.emit()
      if (u.enabled) toast({ level: 'success', text: t('schedules.reviewDone') })
    } catch (e) {
      // the task or its connections changed since the card was shown: show the card as it is now
      if (isApiError(e, 'conflict') && e.body.params?.reason === 'schedule_card_changed') {
        fail(e)
        try {
          const card = await api.call(API.getScheduleReview, { params: { id: x.id } })
          if (generation === life.current) setReview(card)
        } catch { if (generation === life.current) { setReview(null); void load() } }
        return
      }
      throw e
    }
  }
  // "지금 실행": a run now, in a new chat (the toast opens it)
  const [running, setRunning] = useState(false)
  const runNow = async (x: Schedule) => {
    const generation = life.current
    setRunning(true)
    try {
      const r = await api.call(API.runScheduleNow, { params: { id: x.id }, body: {} })
      if (generation !== life.current) return
      replace(r.schedule)
      toast({ level: 'success', text: t('schedules.runStarted'), action: { label: t('schedules.openRun'), run: () => navigate(`/c/${r.chatId}`) } })
    } catch (e) { fail(e) } finally { if (generation === life.current) setRunning(false) }
  }
  const [editing, setEditing] = useState(false)
  const remove = async (x: Schedule) => {
    const generation = life.current
    if (!(await confirmDialog({ title: t('schedules.deleteTitle'), body: t('schedules.deleteBody', { title: scheduleName(x, t) }), confirm: t('schedules.delete'), danger: true }))) return
    if (generation !== life.current) return
    try {
      await api.call(API.deleteSchedule, { params: { id: x.id } })
      if (generation !== life.current) return
      drop(x.id)
      if (x.needsReview) schedulesChanged.emit()
      navigate('/scheduled', { replace: true })
    } catch (e) { fail(e) }
  }
  const project = s?.projectId ? projects?.find((p) => p.id === s.projectId) ?? null : null
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <StickyHeader bar className="flex h-12 shrink-0 items-center border-b border-line px-4 sm:px-6" testId="scheduled-topline">
        <nav aria-label={t('files.breadcrumb')} className="flex min-w-0 items-center gap-1.5 text-sm">
          <Link to="/scheduled" className="shrink-0 text-muted hover:text-ink">{t('settings.schedules')}</Link>
          {s && (
            <>
              <span className="text-faint" aria-hidden>/</span>
              <TitleMenu
                name={scheduleName(s, t)}
                testId="schedule-menu"
                items={[
                  { label: t('common.edit'), icon: <Pencil size={14} aria-hidden />, onSelect: () => setEditing(true), testId: 'schedule-edit' },
                  { label: t('schedules.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => void remove(s), danger: true, testId: 'schedule-delete' },
                ]}
              />
            </>
          )}
        </nav>
      </StickyHeader>
      <div className="mx-auto w-full max-w-[1080px] px-4 pt-8 pb-12 sm:px-6 sm:pt-10">
        {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
        {!items && !error && <Skeleton lines={5} />}
        {items && !s && (
          <EmptyState title={t('scheduled.notFound')}>
            <Link to="/scheduled" className="text-sm text-accent-text hover:underline">{t('settings.schedules')}</Link>
          </EmptyState>
        )}
        {s && (
          <ScheduleView s={s} tz={tz || null} project={project} running={running}
            onToggle={() => void toggle(s)} onRunNow={() => void runNow(s)} onReview={() => void openReview(s)}
            review={review ? <AskCard key={review.request.requestId} req={review} onAnswer={(requestId, body) => answerReview(s, requestId, body.kind === 'ask_user' ? body.answer : null)} /> : undefined} />
        )}
      </div>
      {editing && s && (
        <ScheduleEditDialog key={s.id} s={s} tz={tz || null} onClose={() => setEditing(false)}
          onSaved={(u) => { replace(u); setEditing(false); if (u.needsReview === false) schedulesChanged.emit(); toast({ level: 'success', text: t('schedules.edited') }) }} />
      )}
    </div>
  )
}
