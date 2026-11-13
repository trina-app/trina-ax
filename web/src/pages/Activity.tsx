// Activity (what used to be the Inbox, in Settings › Notifications): a page of its own, read like Slack's Activity. The
// title and its tabs (All · DMs · Mentions · Threads, a dot on a tab with something unread); under them "Unreads" and a
// search that narrow what is loaded; the notices grouped under their day (Today, Yesterday, a date), newest first. A row
// is the writer's photo (a bell for a notice of the app's own), who and the time, the line, and underneath where it was
// (a DM, #room › Thread) or what it is about. The unread count sits on the right. The whole row opens the place and reads
// it; a notice with nowhere to open keeps its "Mark as read". The preferences stay in Settings › Notifications (the gear).
// Opened from a phone's 대화 tab (its 멘션·스레드 row, `?in=chats`: lib/screens.ts CHATS_ACTIVITY) it is that tab's page of
// the conversations only: All · Mentions · Threads, rows of rooms (no notice of the app's own: the server sends only
// those, GET /api/notifications?only=rooms), named "멘션·스레드". "Nothing here" is never said while older pages are left:
// a tab, "Unreads" or a search that shows nothing of what is loaded reads the next pages by itself (AUTO_PAGES of them,
// once for that choice), then says "not in the latest N" with "Load more". A read again (a new notice, the rooms
// changing) is one request: the newest rows, with the older ones already loaded kept after them. "Mark all as read" (at
// the end of the tools, while the tab has something unread) reads the whole tab on the server in one call, the rows not
// loaded yet too (POST /api/notifications/read, the same tab rule: activityTabHas).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { AtSign, Bell, BellRing, Check, CheckCheck, Hash, Inbox, MessageCircle, MessagesSquare, Search, Settings, X } from 'lucide-react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { activityTabHas, type ActivityTab, type InboxNotification } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { intlTag, localDay } from '../lib/format'
import { badgeText } from '../lib/rooms'
import { aiName } from '../lib/tabs'
import { activityInChats, CHATS_ACTIVITY } from '../lib/screens'
import { useActivityUnread } from '../store/inbox'
import { useLocale, useT, type MessageKey } from '../i18n'
import { accessChanged, notificationsChanged, reloadAsked } from '../store/live'
import { useRooms } from '../store/rooms'
import { Button, EmptyState, ErrorNote, IconButton, Skeleton, inputCls, pageColumn, stickyCls, useMediaQuery } from '../components/ui'
import { PhoneBarAction } from '../components/phone/PhoneBarAction'
import { Face, isRoomRow, roomNoticeLink, roomRowText, type RoomNotice } from '../components/settings/RoomNoticeRow'
import { noticeLink, noticeText } from '../components/settings/Notifications'
import { HandoverNoticeExtras } from '../components/handover/HandoverNotice'
import { useRoomTitle } from '../components/rooms/RoomIcon'
import { requestableName } from '../lib/googleApps'
import { Tooltip } from '../components/Tooltip'

type T = ReturnType<typeof useT>
type Filter = ActivityTab
/** `short`: the word on a phone, where the four share the width */
const FILTERS: { id: Filter; label: MessageKey; short?: MessageKey; icon?: typeof Bell }[] = [
  { id: 'all', label: 'feed.tab.all' },
  { id: 'dms', label: 'feed.tab.dms', short: 'feed.tab.dmsShort', icon: MessageCircle },
  { id: 'mentions', label: 'feed.tab.mentions', icon: AtSign },
  { id: 'threads', label: 'feed.tab.threads', icon: MessagesSquare },
]
/** A tab. The tab list scrolls sideways, which cuts anything drawn outside it: the focus ring is drawn inside the tab.
 * A phone: the four share the width equally, 44px tall, words only (no icons), never scrolling sideways. */
export const tabCls = 'inline-flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm transition focus-visible:-outline-offset-2 max-md:h-11 max-md:min-w-0 max-md:justify-center max-md:px-1'
const isFilter = (s: string | null): s is Filter => FILTERS.some((f) => f.id === s)
/** while nothing loaded shows, this many older pages (30 rows each) are read by themselves, once per tab, Unreads and
 * search text: 300 rows with the first page, then "Load more" */
const AUTO_PAGES = 9
/** the conversations' tabs (opened from 대화): DMs are that tab's own list */
const CHATS_FILTERS = FILTERS.filter((f) => f.id !== 'dms')

/** Which tabs a notice shows under (shared: the server marks a tab read by the same rule) */
export const inFilter = activityTabHas

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

/** The page for the address: the conversations' (from 대화) or the whole Activity, each with its own state, so going from one
 * to the other (a tab of the phone's bar) starts afresh. On a computer 활동's list is the panel beside the rail (components/panels/ActivityPanel.tsx): this page is then the notice opened
 * from it (`?n=<id>`) or, with none, where to look; an old link to the Mentions or Threads tab goes to 대화's
 * 멘션·스레드, where those are now. */
export default function Activity() {
  const [params] = useSearchParams()
  const chats = activityInChats(params.toString())
  const computer = useMediaQuery('(min-width: 768px)')
  if (computer && !chats) {
    const tab = params.get('tab')
    if (tab === 'mentions' || tab === 'threads') return <Navigate to={`${CHATS_ACTIVITY}&tab=${tab}`} replace />
    // the DMs tab (back on dev with #666): direct and group chats are 대화's own list, its 멘션·스레드 has no DMs tab
    if (tab === 'dms') return <Navigate to={CHATS_ACTIVITY} replace />
    return <ActivityOpened key={params.get('n') ?? ''} id={params.get('n')} />
  }
  return <ActivityPage key={chats ? 'chats' : 'all'} chats={chats} />
}

/** The main area beside 활동's list: the notice opened from it (read as it opens), or what the list is for. */
function ActivityOpened({ id }: { id: string | null }) {
  const t = useT(), locale = useLocale()
  const unread = useActivityUnread()
  const [item, setItem] = useState<InboxNotification | null>(null)
  const [error, setError] = useState<string | null>(null)
  const life = useRef(0)
  const load = useCallback(async () => {
    if (!id) return
    const generation = ++life.current
    try {
      let got = await api.call(API.getNotification, { params: { id } })
      if (!got.readAt) got = await api.call(API.markNotificationRead, { params: { id } })
      if (generation === life.current) (setItem(got), setError(null))
    } catch (e) {
      if (generation === life.current) setError(errorText(e, locale, t('error.network')))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, locale])
  useEffect(() => {
    void load()
    const off = notificationsChanged.on(() => void load())
    return () => (off(), void life.current++)
  }, [load])
  if (!id)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center" data-testid="activity-pick">
        <Bell size={28} className="text-faint" aria-hidden />
        <p className="text-sm font-semibold text-ink">{unread > 0 ? t('notifications.unread', { count: unread }) : t('notifications.empty')}</p>
        <p className="max-w-sm text-sm text-muted">{t('activity.pick')}</p>
      </div>
    )
  return (
    <div className="h-full overflow-y-auto" data-testid="activity-opened">
      <div className={clsx(pageColumn, 'px-4 pt-5 pb-6 sm:px-6')}>
        <h1 className="sr-only">{t('inbox.title')}</h1>
        {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
        {!item && !error && <Skeleton lines={3} />}
        {item && (
          <ul data-testid="notifications-inbox">
            <NoticeRow item={item} onRead={() => void load()} onChanged={() => void load()} />
          </ul>
        )}
      </div>
    </div>
  )
}

/** `chats`: the conversations only (opened from 대화): rows of rooms, without the DMs tab */
function ActivityPage({ chats }: { chats: boolean }) {
  const t = useT(), locale = useLocale()
  const [params, setParams] = useSearchParams()
  const filters = chats ? CHATS_FILTERS : FILTERS
  const asked = params.get('tab')
  const filter: Filter = isFilter(asked) && filters.some((f) => f.id === asked) ? asked : 'all'
  const shows = (item: InboxNotification, f: Filter) => inFilter(item, f) && (!chats || isRoomRow(item))
  const title = chats ? t('feed.chats') : t('inbox.title')
  const setFilter = (f: Filter) => setParams((p) => { const n = new URLSearchParams(p); if (f === 'all') n.delete('tab'); else n.set('tab', f); return n }, { replace: true })
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<InboxNotification[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // the server's unread count with the last read (this page's part of it: the conversation rows on 대화's page)
  const [serverUnread, setServerUnread] = useState(0)
  // the older page on its way (its cursor), and how many reads have ended: the reading of older pages looks again
  // after each, so a read that lands meanwhile never leaves it waiting
  const [paging, setPaging] = useState<string | null>(null)
  const [ended, setEnded] = useState(0)
  const life = useRef(0), sequence = useRef(0), shown = useRef(0)
  // what is on screen, for the reads that land later (a page goes on only where the list still ends)
  const itemsRef = useRef<InboxNotification[] | null>(null), cursorRef = useRef<string | null>(null), pagingRef = useRef<string | null>(null)
  const setList = (next: InboxNotification[] | null) => { itemsRef.current = next; shown.current = next?.length ?? 0; setItems(next) }
  const setEnd = (next: string | null) => { cursorRef.current = next; setCursor(next) }
  const searchRef = useRef<HTMLInputElement>(null)
  const roomTitle = useRoomTitle()
  const rooms = useRooms((s) => s.rooms)
  useEffect(() => { life.current++; return () => { life.current++ } }, [])

  /** `after`: the older page after that cursor (one at a time; its rows go on only while the list still ends there).
   * Else a read again: the newest rows (as many as are shown, up to the API's 100, in one request), with the older rows
   * already loaded kept after them from where the new first rows end in what was there; those keep how they were read. */
  const load = useCallback(async (after?: string) => {
    const generation = life.current
    const only = chats ? { only: 'rooms' as const } : {}
    if (after) {
      if (pagingRef.current === after) return
      pagingRef.current = after
      setPaging(after)
      try {
        const inbox = await api.call(API.listNotifications, { query: { limit: 30, cursor: after, ...only } })
        if (generation !== life.current || cursorRef.current !== after) return
        setList([...new Map([...(itemsRef.current ?? []), ...inbox.items].map((item) => [item.id, item])).values()])
        setEnd(inbox.nextCursor)
        setServerUnread(chats ? inbox.roomUnreadCount ?? 0 : inbox.unreadCount)
        setError(null)
      } catch (e) { if (generation === life.current && cursorRef.current === after) setError(errorText(e, locale, t('error.network'))) }
      finally {
        if (generation === life.current) {
          if (pagingRef.current === after) { pagingRef.current = null; setPaging(null) }
          setEnded((n) => n + 1)
        }
      }
      return
    }
    const seq = ++sequence.current
    try {
      const inbox = await api.call(API.listNotifications, { query: { limit: Math.min(100, Math.max(30, shown.current)), ...only } })
      if (generation !== life.current || seq !== sequence.current) return
      const fresh = inbox.items, tail = fresh.at(-1), previous = itemsRef.current ?? []
      const from = inbox.nextCursor && tail ? previous.findIndex((x) => x.id === tail.id) : -1
      const ids = new Set(fresh.map((x) => x.id))
      const older = from >= 0 ? previous.slice(from + 1).filter((x) => !ids.has(x.id)) : []
      setList([...fresh, ...older])
      setEnd(older.length ? cursorRef.current : inbox.nextCursor)
      setServerUnread(chats ? inbox.roomUnreadCount ?? 0 : inbox.unreadCount)
      setError(null)
    } catch (e) { if (generation === life.current && seq === sequence.current) setError(errorText(e, locale, t('error.network'))) }
    finally { if (generation === life.current) setEnded((n) => n + 1) }
    // useT returns a fresh function; its translations change only with locale. setList and setEnd use refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, chats])
  useEffect(() => {
    void load()
    const off = notificationsChanged.on(() => void load()), reload = reloadAsked.on(() => void load())
    const access = accessChanged.on(() => { setList(null); setEnd(null); void load() })
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
    setList(itemsRef.current?.map((x) => (x.id === item.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? null)
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

  const unreadIn = (f: Filter) => !!items?.some((x) => !x.readAt && shows(x, f))
  // the server's unread count: All has something unread beyond the loaded rows too
  const canMarkAll = unreadIn(filter) || (filter === 'all' && serverUnread > 0)
  const [marking, setMarking] = useState(false)
  /** every unread notice of the tab, on the server (the rows not loaded yet too): shown read at once, then read again
   * with the counts (the rail's, the tab dots; the rooms' badges follow their room.read events) */
  const markAll = async () => {
    if (marking) return
    const generation = life.current, tab = filter, at = new Date().toISOString()
    setMarking(true)
    setList(itemsRef.current?.map((x) => (!x.readAt && shows(x, tab) ? { ...x, readAt: at } : x)) ?? null)
    try {
      await api.call(API.markAllNotificationsRead, { body: { tab, ...(chats ? { only: 'rooms' as const } : {}) } })
      if (generation === life.current) setError(null)
    } catch (e) { if (generation === life.current) setError(errorText(e, locale, t('error.network'))) }
    finally {
      // the server says so to every window too; this one reads again now
      notificationsChanged.emit()
      if (generation === life.current) setMarking(false)
    }
  }
  const q = query.trim().toLocaleLowerCase()
  const visible = useMemo(() => (items ?? [])
    .filter((x) => shows(x, filter) && (!unreadOnly || !x.readAt) && (!q || wordsOf(x).toLocaleLowerCase().includes(q)))
    .sort((a, b) => at(b).localeCompare(at(a))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [items, filter, unreadOnly, q, rooms, locale, chats])
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
  // nothing loaded shows here and older pages are left: read them by themselves, one after another, at most AUTO_PAGES
  // for this choice of tab, Unreads and search (a read again keeps the rows, so it starts no new run)
  const choice = `${filter}|${unreadOnly}|${q}`
  const auto = useRef({ choice, pages: 0 })
  if (auto.current.choice !== choice) auto.current = { choice, pages: 0 }
  const empty = !!items && !visible.length && !!cursor && !error
  const seeking = empty && auto.current.pages < AUTO_PAGES
  useEffect(() => {
    // a page still on its way from where the list ended before (a read again moved the end) does not hold this one back
    if (!seeking || !cursor || paging === cursor || auto.current.choice !== choice) return
    auto.current.pages++
    void load(cursor)
  }, [seeking, cursor, paging, ended, choice, load])
  // waiting on an older page (asked by itself or with "Load more"), or about to ask: a skeleton, never "nothing here"
  const waiting = empty && (!!paging || seeking)

  const toolBtn = 'inline-flex h-9 items-center gap-1.5 rounded-lg border border-field-border bg-surface px-3 text-sm font-medium text-ink hover:bg-hover max-md:h-11 max-md:rounded-full max-md:border-transparent'
  // a phone: the tabs share the width; the search is in the top bar (phone/PhoneBarAction.tsx), its field opens here;
  // "Unreads" is a filled pill, every control 44px
  const phone = useMediaQuery('(max-width: 767.98px)')
  const openSearch = () => { setSearching(true); requestAnimationFrame(() => searchRef.current?.focus()) }
  return (
    // the scroll bar's room is kept when a tab's list is short (Windows, a Mac with a mouse): a tab never moves the page
    <div className="flex h-full flex-col overflow-y-auto [scrollbar-gutter:stable]" data-testid="activity">
      <div className={clsx(stickyCls, 'shrink-0 border-b border-line')}>
        <div className={clsx(pageColumn, 'px-4 pt-4 sm:px-6 sm:pt-5 max-md:pt-1')}>
          <div className="flex items-center justify-between gap-3 max-md:block">
            {/* phones: the top bar says the page's name (components/PhoneTopBar.tsx); here for screen readers only */}
            <h1 className="text-title font-semibold tracking-tight max-md:sr-only">{title}</h1>
            <Tooltip label={t('feed.settings')}>
              <Link to="/settings/notifications" className="ml-auto inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink max-md:hidden" aria-label={t('feed.settings')} data-testid="activity-settings">
                <Settings size={18} aria-hidden />
              </Link>
            </Tooltip>
          </div>
          <div role="tablist" aria-label={title} className="scroll-thin -mb-px mt-2 flex gap-1 overflow-x-auto max-md:mt-0 max-md:grid max-md:auto-cols-[minmax(0,1fr)] max-md:grid-flow-col max-md:gap-0 max-md:overflow-visible" data-testid="activity-tabs">
            {filters.map(({ id, label, short, icon: Icon }) => {
              const on = filter === id
              const word = phone && short ? t(short) : t(label)
              return (
                <button key={id} type="button" role="tab" aria-selected={on} onClick={() => setFilter(id)}
                  className={clsx(tabCls, on ? 'border-ink font-semibold text-ink' : 'border-transparent text-muted hover:text-ink')}
                  data-testid={`activity-tab-${id}`}>
                  {Icon && <Icon size={15} aria-hidden className="max-md:hidden" />}
                  {/* as wide as when bold, so the selected tab does not push the others */}
                  <span className="grid min-w-0">
                    <span className="col-start-1 row-start-1 truncate">{word}</span>
                    <span aria-hidden className="invisible col-start-1 row-start-1 truncate font-semibold">{word}</span>
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
          <button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly((v) => !v)} className={clsx(toolBtn, unreadOnly ? 'border-accent bg-accent-soft text-accent-text max-md:bg-accent-soft' : 'max-md:bg-subtle')} data-testid="activity-unreads">
            <BellRing size={15} aria-hidden /> {t('feed.unreads')}
          </button>
          {searching
            ? <div className="relative min-w-0 flex-1 sm:max-w-xs">
                <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
                <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); setSearching(false) } }}
                  placeholder={t('feed.search')} aria-label={t('feed.search')} className={`${inputCls} h-9 pr-9 pl-9 max-md:h-11 max-md:pr-11`} data-testid="activity-search" data-own-clear autoFocus />
                <IconButton label={t('picker.clearSearch')} className="absolute top-1/2 right-1 -translate-y-1/2 max-md:right-0 max-md:size-11" onClick={() => { setQuery(''); setSearching(false) }} data-testid="activity-search-clear">
                  <X size={14} aria-hidden />
                </IconButton>
              </div>
            : !phone && <IconButton label={t('feed.search')} className="size-9 border border-field-border" onClick={() => setSearching(true)} data-testid="activity-search-open"><Search size={16} aria-hidden /></IconButton>}
          {phone && !searching && (
            <PhoneBarAction>
              <IconButton label={t('feed.search')} className="size-11 text-muted" onClick={openSearch} data-testid="activity-search-open">
                <Search size={20} aria-hidden />
              </IconButton>
            </PhoneBarAction>
          )}
          {/* quiet, at the end of the row: only while the tab has something unread */}
          {canMarkAll && (
            <button type="button" onClick={() => void markAll()} disabled={marking} aria-busy={marking || undefined}
              className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted hover:bg-hover hover:text-ink disabled:opacity-50 max-md:h-11"
              data-testid="activity-mark-all-read">
              <CheckCheck size={15} aria-hidden /> {t('feed.markAllRead')}
            </button>
          )}
          {/* phones: the gear sits here (the title row is the top bar there) */}
          <Tooltip label={t('feed.settings')}>
            <Link to="/settings/notifications" className={clsx(!canMarkAll && 'ml-auto', 'inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink md:hidden max-md:size-11')} aria-label={t('feed.settings')} data-testid="activity-settings-phone">
              <Settings size={18} aria-hidden />
            </Link>
          </Tooltip>
        </div>

        {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
        {((!items && !error) || waiting) && <Skeleton lines={4} />}
        {/* "nothing here" only when no older page is left */}
        {items && !visible.length && !cursor && (
          <EmptyState icon={<Inbox size={28} />} title={items.some((x) => shows(x, 'all')) && (filter !== 'all' || unreadOnly || q) ? t('feed.emptyFiltered') : chats ? t('feed.chatsEmpty') : t('notifications.empty')} />
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
        {/* nothing among the rows read so far: says so, with the way to older ones */}
        {empty && !waiting && <p className="pt-3 text-sm text-muted" data-testid="activity-not-in-recent">{t('feed.notInRecent', { n: items!.length })}</p>}
        {cursor && items && !paging && !waiting && <div className="pt-3"><Button onClick={() => void load(cursor)} data-testid="activity-load-more">{t('common.loadMore')}</Button></div>}
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
  const project = item.link === 'project' && d?.projectName ? d.projectName : null
  // a member's ask to add an app (an owner or admin): what the row does while it waits, as a button inside the row's link
  // (the row opens the app's setup), and "Added" once members can connect it
  const sr = item.code === 'service.request' ? item.serviceRequest : undefined
  const ask = sr?.open
    ? <span className="mt-1 inline-flex h-8 items-center rounded-lg border border-field-border bg-surface px-3 text-sm font-medium text-ink" data-testid="notification-service-setup">{t('gapps.setUpLink', { name: requestableName(sr.service) })}</span>
    : sr?.added ? <span className="flex items-center gap-1 text-ok" data-testid="notification-service-added"><Check size={13} aria-hidden />{t('notifications.serviceRequest.added')}</span> : null
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
    context={ask ?? (project || (d?.job?.exitCode === null && d.job.note)
      ? <span className="min-w-0">
          {project && <span className="block truncate" data-testid="notification-project"><bdi>{project}</bdi></span>}
          {d?.job?.exitCode === null && d.job.note && <span className="block" data-testid="notification-job-note">{d.job.note}</span>}
        </span>
      : null)}
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
