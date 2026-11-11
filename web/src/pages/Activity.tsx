// Activity (what used to be the Inbox, in Settings › Notifications): a page of its own, read like Slack's Activity. The
// title and its tabs (All · DMs · Mentions · Threads, a dot on a tab with something unread); under them "Unreads" and a
// search that narrow what is loaded; the notices grouped under their day (Today, Yesterday, a date), newest first. A row
// is the writer's photo (a bell for a notice of the app's own), who and the time, the line, and underneath where it was
// (a DM, #room › Thread) or what it is about. The unread count sits on the right. The whole row opens the place and reads
// it; a notice with nowhere to open keeps its "Mark as read". The preferences stay in Settings › Notifications (the gear).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { AtSign, Bell, BellRing, Hash, Inbox, MessageCircle, MessagesSquare, Search, Settings, X } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import type { InboxNotification } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { intlTag, localDay } from '../lib/format'
import { badgeText } from '../lib/rooms'
import { aiName } from '../lib/tabs'
import { useLocale, useT, type MessageKey } from '../i18n'
import { accessChanged, notificationsChanged, reloadAsked } from '../store/live'
import { useRooms } from '../store/rooms'
import { Button, EmptyState, ErrorNote, IconButton, Skeleton, inputCls, pageColumn, stickyCls } from '../components/ui'
import { Face, isRoomRow, roomNoticeLink, roomRowText, type RoomNotice } from '../components/settings/RoomNoticeRow'
import { noticeLink, noticeText } from '../components/settings/Notifications'
import { HandoverNoticeExtras } from '../components/handover/HandoverNotice'
import { useRoomTitle } from '../components/rooms/RoomIcon'
import { Tooltip } from '../components/Tooltip'

type T = ReturnType<typeof useT>
type Filter = 'all' | 'dms' | 'mentions' | 'threads'
const FILTERS: { id: Filter; label: MessageKey; icon?: typeof Bell }[] = [
  { id: 'all', label: 'feed.tab.all' },
  { id: 'dms', label: 'feed.tab.dms', icon: MessageCircle },
  { id: 'mentions', label: 'feed.tab.mentions', icon: AtSign },
  { id: 'threads', label: 'feed.tab.threads', icon: MessagesSquare },
]
/** A tab. The tab list scrolls sideways, which cuts anything drawn outside it: the focus ring is drawn inside the tab. */
export const tabCls = 'inline-flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm transition focus-visible:-outline-offset-2'
const isFilter = (s: string | null): s is Filter => FILTERS.some((f) => f.id === s)

/** Which tabs a notice shows under besides All: a direct or group chat's under DMs, an @mention (or @everyone) under
 * Mentions, a reply in a thread under Threads. A notice of the app's own is under All only. */
export function inFilter(item: InboxNotification, filter: Filter): boolean {
  if (filter === 'all') return true
  const room = item.room
  if (!room || (item.code !== 'room.dm' && item.code !== 'room.mention')) return false
  if (filter === 'dms') return room.kind === 'dm' || room.kind === 'group'
  if (filter === 'mentions') return item.code === 'room.mention' || room.reason === 'mention' || room.reason === 'everyone'
  return !!room.thread
}

const at = (item: InboxNotification) => item.room?.at ?? item.createdAt

/** The day heading: Today, Yesterday, or the weekday and date ("Tuesday, November 3"; the year when not this year). */
function dayLabel(iso: string, t: T, locale: ReturnType<typeof useLocale>, now = new Date()): string {
  const d = new Date(iso)
  const today = localDay(now)
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const day = localDay(d)
  if (day === today) return t('feed.today')
  if (day === yesterday) return t('sidebar.yesterday')
  return new Intl.DateTimeFormat(intlTag(locale), { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) }).format(d)
}

const timeOf = (iso: string, locale: ReturnType<typeof useLocale>) => new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))

export default function Activity() {
  const t = useT(), locale = useLocale()
  const [params, setParams] = useSearchParams()
  const filter: Filter = isFilter(params.get('tab')) ? (params.get('tab') as Filter) : 'all'
  const setFilter = (f: Filter) => setParams((p) => { const n = new URLSearchParams(p); if (f === 'all') n.delete('tab'); else n.set('tab', f); return n }, { replace: true })
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<InboxNotification[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const life = useRef(0), sequence = useRef(0), shown = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const roomTitle = useRoomTitle()
  const rooms = useRooms((s) => s.rooms)
  useEffect(() => { life.current++; return () => { life.current++ } }, [])

  // a read again keeps the pages already loaded ("Load more"), up to the API's 100
  const load = useCallback(async (after?: string) => {
    const generation = life.current, seq = ++sequence.current
    try {
      const inbox = await api.call(API.listNotifications, { query: { limit: after ? 30 : Math.min(100, Math.max(30, shown.current)), cursor: after } })
      if (generation !== life.current || seq !== sequence.current) return
      setItems((previous) => {
        const next = after && previous ? [...new Map([...previous, ...inbox.items].map((item) => [item.id, item])).values()] : inbox.items
        shown.current = next.length
        return next
      })
      setCursor(inbox.nextCursor); setError(null)
    } catch (e) { if (generation === life.current && seq === sequence.current) setError(errorText(e, locale, t('error.network'))) }
    // useT returns a fresh function; its translations change only with locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])
  useEffect(() => {
    void load()
    const off = notificationsChanged.on(() => void load()), reload = reloadAsked.on(() => void load())
    const access = accessChanged.on(() => { setItems(null); void load() })
    // a conversation row grows while its run goes on (another reply in the thread) without a new notice: read the rows
    // again once the rooms have been quiet for a second, and at least every 5 seconds while they keep changing
    let timer: ReturnType<typeof setTimeout> | undefined, since = 0
    const off2 = useRooms.subscribe((s, before) => {
      if (s.rooms === before.rooms) return
      const now = Date.now()
      if (!since) since = now
      clearTimeout(timer)
      timer = setTimeout(() => { since = 0; void load() }, now - since >= 5000 ? 0 : 1000)
    })
    return () => { off(); reload(); access(); off2(); clearTimeout(timer) }
  }, [load])

  const read = async (item: InboxNotification) => {
    if (item.readAt) return
    const generation = life.current
    // shown read at once; the server's answer follows
    setItems((cur) => cur?.map((x) => (x.id === item.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? null)
    try { await api.call(API.markNotificationRead, { params: { id: item.id } }); if (generation === life.current) await load() }
    catch (e) { if (generation === life.current) { setError(errorText(e, locale, t('error.network'))); void load() } }
  }

  /** the words a row can be found by: who, where and the line of a conversation; the text of the app's own notice */
  const wordsOf = (item: InboxNotification): string => {
    if (isRoomRow(item)) {
      const listed = rooms.find((r) => r.id === item.room.id)
      const { who, where, line } = roomRowText(item.room, t, listed ? roomTitle(listed) : null)
      return `${who} ${where} ${line}`
    }
    const text = noticeText(item, t, locale)
    return typeof text === 'string' ? text : ''
  }

  const unreadIn = (f: Filter) => !!items?.some((x) => !x.readAt && inFilter(x, f))
  const q = query.trim().toLocaleLowerCase()
  const visible = useMemo(() => (items ?? [])
    .filter((x) => inFilter(x, filter) && (!unreadOnly || !x.readAt) && (!q || wordsOf(x).toLocaleLowerCase().includes(q)))
    .sort((a, b) => at(b).localeCompare(at(a))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [items, filter, unreadOnly, q, rooms, locale])
  const groups = useMemo(() => {
    const out: { day: string; label: string; items: InboxNotification[] }[] = []
    for (const item of visible) {
      const day = localDay(new Date(at(item)))
      const last = out[out.length - 1]
      if (last?.day === day) last.items.push(item)
      else out.push({ day, label: dayLabel(at(item), t, locale), items: [item] })
    }
    return out
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, locale])

  const toolBtn = 'inline-flex h-9 items-center gap-1.5 rounded-lg border border-field-border bg-surface px-3 text-sm font-medium text-ink hover:bg-hover'
  return (
    // the scroll bar's room is kept when a tab's list is short (Windows, a Mac with a mouse): a tab never moves the page
    <div className="flex h-full flex-col overflow-y-auto [scrollbar-gutter:stable]" data-testid="activity">
      <div className={clsx(stickyCls, 'shrink-0 border-b border-line')}>
        <div className={clsx(pageColumn, 'px-4 pt-4 sm:px-6 sm:pt-5 max-md:pt-1')}>
          <div className="flex items-center justify-between gap-3 max-md:block">
            {/* phones: the top bar says the page's name (components/PhoneTopBar.tsx); here for screen readers only */}
            <h1 className="text-xl font-semibold tracking-tight max-md:sr-only">{t('inbox.title')}</h1>
            <Tooltip label={t('feed.settings')}>
              <Link to="/settings/notifications" className="ml-auto inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink max-md:hidden" aria-label={t('feed.settings')} data-testid="activity-settings">
                <Settings size={18} aria-hidden />
              </Link>
            </Tooltip>
          </div>
          <div role="tablist" aria-label={t('inbox.title')} className="scroll-thin -mb-px mt-2 flex max-md:mt-0 gap-1 overflow-x-auto" data-testid="activity-tabs">
            {FILTERS.map(({ id, label, icon: Icon }) => {
              const on = filter === id
              return (
                <button key={id} type="button" role="tab" aria-selected={on} onClick={() => setFilter(id)}
                  className={clsx(tabCls, on ? 'border-ink font-semibold text-ink' : 'border-transparent text-muted hover:text-ink')}
                  data-testid={`activity-tab-${id}`}>
                  {Icon && <Icon size={15} aria-hidden />}
                  {/* as wide as when bold, so the selected tab does not push the others */}
                  <span className="grid">
                    <span className="col-start-1 row-start-1">{t(label)}</span>
                    <span aria-hidden className="invisible col-start-1 row-start-1 font-semibold">{t(label)}</span>
                  </span>
                  {unreadIn(id) && <span className="size-1.5 rounded-full bg-accent" data-testid={`activity-tab-${id}-unread`}><span className="sr-only">{t('notifications.unreadMark')}</span></span>}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className={clsx(pageColumn, 'flex-1 px-4 pb-6 sm:px-6')}>
        {/* the tools: unread only, and a search of what is loaded */}
        <div className="flex flex-wrap items-center gap-2 py-3" data-testid="activity-tools">
          <button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly((v) => !v)} className={clsx(toolBtn, unreadOnly && 'border-accent bg-accent-soft text-accent-text')} data-testid="activity-unreads">
            <BellRing size={15} aria-hidden /> {t('feed.unreads')}
          </button>
          {searching
            ? <div className="relative min-w-0 flex-1 sm:max-w-xs">
                <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
                <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); setSearching(false) } }}
                  placeholder={t('feed.search')} aria-label={t('feed.search')} className={`${inputCls} h-9 pr-9 pl-9`} data-testid="activity-search" data-own-clear autoFocus />
                <IconButton label={t('picker.clearSearch')} className="absolute top-1/2 right-1 -translate-y-1/2" onClick={() => { setQuery(''); setSearching(false) }} data-testid="activity-search-clear">
                  <X size={14} aria-hidden />
                </IconButton>
              </div>
            : <IconButton label={t('feed.search')} className="size-9 border border-field-border" onClick={() => setSearching(true)} data-testid="activity-search-open"><Search size={16} aria-hidden /></IconButton>}
          {/* phones: the gear sits here (the title row is the top bar there) */}
          <Tooltip label={t('feed.settings')}>
            <Link to="/settings/notifications" className="ml-auto inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink md:hidden" aria-label={t('feed.settings')} data-testid="activity-settings-phone">
              <Settings size={18} aria-hidden />
            </Link>
          </Tooltip>
        </div>

        {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
        {!items && !error && <Skeleton lines={4} />}
        {items && !visible.length && (
          <EmptyState icon={<Inbox size={28} />} title={items.length && (filter !== 'all' || unreadOnly || q) ? t('feed.emptyFiltered') : t('notifications.empty')} />
        )}
        {groups.map((g, i) => (
          <section key={g.day} aria-labelledby={`activity-day-${g.day}`} data-testid="activity-day">
            <h2 id={`activity-day-${g.day}`} className={clsx('-mx-4 border-line px-4 pt-4 pb-1 text-sm font-semibold text-ink sm:-mx-6 sm:px-6', i > 0 && 'mt-1 border-t')}>{g.label}</h2>
            <ul data-testid="notifications-inbox">
              {g.items.map((item) => isRoomRow(item)
                ? <RoomRow key={item.id} item={item} onOpen={() => void read(item)} />
                : <NoticeRow key={item.id} item={item} onRead={() => void read(item)} onChanged={() => void load()} />)}
            </ul>
          </section>
        ))}
        {cursor && items && <div className="pt-3"><Button onClick={() => void load(cursor)}>{t('common.loadMore')}</Button></div>}
      </div>
    </div>
  )
}

const rowCls = '-mx-2 flex min-w-0 items-start gap-3 rounded-lg px-2 py-3 hover:bg-hover'

/** One row's frame: the photo, who and the time on one line, the line, and where it was under it; on the right, while
 * unread, the count (or a dot). */
function RowBody({ face, who, iso, unread, line, context, count }: { face: ReactNode; who: ReactNode; iso: string; unread: boolean; line: ReactNode; context: ReactNode; count?: ReactNode }) {
  const locale = useLocale()
  return <>
    {face}
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className={clsx('min-w-0 truncate text-sm text-ink', unread ? 'font-bold' : 'font-medium')}>{who}</span>
        <time dateTime={iso} className="shrink-0 text-xs text-faint">{timeOf(iso, locale)}</time>
      </span>
      <span className={clsx('mt-0.5 block text-sm break-words', unread ? 'text-ink' : 'text-muted')}>{line}</span>
      {context && <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted">{context}</span>}
    </span>
    {unread && <span className="mt-0.5 shrink-0">{count ?? <span className="block size-2 rounded-full bg-accent" />}</span>}
  </>
}

/** A conversation: who wrote (and how many more), the newest line, and where (Direct message, #room, › Thread), the
 * count of what is unread there on the right. Opens the place at my first unread message. */
function RoomRow({ item, onOpen }: { item: RoomNotice; onOpen: () => void }) {
  const t = useT()
  const title = useRoomTitle()
  const listed = useRooms((s) => s.rooms.find((r) => r.id === item.room.id) ?? null)
  const { who, where, line, mark } = roomRowText(item.room, t, listed ? title(listed) : null)
  const unread = !item.readAt
  const n = item.room.count ?? 1
  const PlaceIcon = item.room.thread ? MessagesSquare : item.room.kind === 'dm' || item.room.kind === 'group' ? MessageCircle : Hash
  return (
    <li data-testid="notification-item">
      <Link to={roomNoticeLink(item.room)} onClick={onOpen} className={rowCls} data-testid="notification-room-row" data-unread={unread ? '' : undefined}>
        <RowBody
          face={<Face room={item.room} />}
          who={<bdi data-testid="notification-room-who">{who}</bdi>}
          iso={item.room.at ?? item.createdAt}
          unread={unread}
          line={<span className="line-clamp-2" data-testid="notification-room-line">
            {mark && <><span aria-hidden className="mr-1 font-semibold text-accent-text">@</span><span className="sr-only">{mark}: </span></>}
            <bdi>{line}</bdi>
          </span>}
          context={<><PlaceIcon size={13} aria-hidden className="shrink-0" /><bdi className="truncate" data-testid="notification-room-where">{mark ? t('feed.mentionIn', { where }) : where}</bdi></>}
          count={<span className="rounded-full bg-accent px-1.5 text-micro font-medium text-accent-ink" data-testid="notification-room-count">
            <span aria-hidden>{badgeText(n)}</span><span className="sr-only">{t('rooms.unread', { n })}</span>
          </span>}
        />
      </Link>
    </li>
  )
}

/** A notice of the app's own: a bell for a photo, the app's name, the notice's words; under them what it is about (the
 * project). With a place to open the row is that link; without, it keeps "Mark as read". A job's log and a handover's
 * buttons sit under the row, not in the link. */
function NoticeRow({ item, onRead, onChanged }: { item: InboxNotification; onRead: () => void; onChanged: () => void }) {
  const t = useT(), locale = useLocale()
  const unread = !item.readAt
  const link = noticeLink(item)
  const d = item.devEnv
  const project = item.link === 'project' && d?.projectName && !(item.code === 'dev_env.box' && (d.stopCode === 'disk' || d.stopCode === 'busy_max')) ? d.projectName : null
  const below = item.handover || d?.job?.tail ? <>
    {item.handover && <HandoverNoticeExtras item={item} onRead={onRead} onChanged={onChanged} />}
    {d?.job?.tail && <pre className="mt-1 max-h-40 overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-faint" data-testid="notification-job-tail">{d.job.tail}</pre>}
  </> : null
  const body = <RowBody
    face={<span aria-hidden className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-hover text-muted"><Bell size={16} /></span>}
    who={aiName(t)}
    iso={item.createdAt}
    unread={unread && !!link}
    line={<span data-testid="notification-text">{noticeText(item, t, locale)}</span>}
    context={project || (d?.job?.exitCode === null && d.job.note)
      ? <span className="min-w-0">
          {project && <span className="block truncate" data-testid="notification-project"><bdi>{project}</bdi></span>}
          {d?.job?.exitCode === null && d.job.note && <span className="block" data-testid="notification-job-note">{d.job.note}</span>}
        </span>
      : null}
    count={unread && link ? <span className="block size-2 rounded-full bg-accent" data-testid="notification-unread"><span className="sr-only">{t('notifications.unreadMark')}</span></span> : undefined}
  />
  if (!link) return (
    <li data-testid="notification-item" data-unread={unread ? '' : undefined}>
      <div className="flex min-w-0 items-start gap-3 py-3">
        {body}
        {unread && <Button size="sm" onClick={onRead}>{t('notifications.markRead')}</Button>}
      </div>
      {below && <div className="-mt-2 min-w-0 pb-3 pl-12">{below}</div>}
    </li>
  )
  return (
    <li data-testid="notification-item">
      <Link to={link.to} onClick={onRead} className={rowCls} data-testid={link.testId} data-unread={unread ? '' : undefined}>{body}</Link>
      {below && <div className="-mt-2 min-w-0 pb-3 pl-12">{below}</div>}
    </li>
  )
}
