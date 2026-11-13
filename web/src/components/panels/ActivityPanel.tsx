// 활동's list panel beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1).
// 활동 holds the notices that are not conversations: mentions and thread replies are 대화's
// (멘션·스레드), and one quiet line on top says so and goes there. Its header: the gear (Settings › Notifications) and,
// while something is unread, "Mark all as read" (these notices only: GET/POST /api/notifications only=notices). Then the
// owner's setup row while it shows, the chips 전체 · 트리나 · 요청 (lib/activityKinds.ts; 요청 for the owner and admins),
// and the notices, unread first, then the read ones under "읽음". A notice opens on the right while 활동 stays lit
// (lib/rail.ts railState): its chat, project, scheduled task or setup page; one with no page of its own, or with
// buttons or a job's log under it, opens as itself (/activity?n=<id>, pages/Activity.tsx). Opening one reads it.
// The rail's 활동 mark is the same count (store/inbox.ts useActivityUnread).
import clsx from 'clsx'
import { AtSign, Bell, CalendarClock, CheckCheck, ChevronRight, Plug, Settings } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { InboxNotification } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { api, API, errorText } from '../../lib/api'
import { chipOf, chipsFor, inChip, unreadFirst, type ActivityChip } from '../../lib/activityKinds'
import { listTime } from '../../lib/format'
import { ACTIVITY_OPENED_KEY } from '../../lib/localData'
import { RAIL_STATE_KEY, useRailHere } from '../../lib/rail'
import { CHATS_ACTIVITY } from '../../lib/screens'
import { aiName } from '../../lib/tabs'
import { accessChanged, notificationsChanged, reloadAsked } from '../../store/live'
import { keepPendingReads, markAllNoticesRead, markNoticeRead } from '../../store/inbox'
import { peekCached, rememberCached } from '../../store/listCache'
import { isAdmin, useMe } from '../../store/session'
import { SetupRow } from '../onboarding/SetupRow'
import { noticeLink, noticeText } from '../settings/Notifications'
import { Tooltip } from '../Tooltip'
import { IconButton } from '../ui'
import { ListRow } from '../list/List'
import { PanelFrame, PanelSection, panelRowBox } from './PanelFrame'

/** while the unread ones are not all loaded, this many older pages are read by themselves */
const AUTO_PAGES = 9
const PAGE = 30

/** A notice opens as itself in the main area (not at its link) when it has no page of its own or carries what only its
 * own view shows: a handover's buttons, a job's log, an ask to add an app with its button. */
export function opensAsItself(item: InboxNotification): boolean {
  return !noticeLink(item) || !!item.handover || !!item.devEnv?.job?.tail || (item.code === 'service.request' && !!item.serviceRequest?.open)
}

/** the history entry's state key that names the notice opened from here (its page can be another notice's too) */
export const NOTICE_STATE_KEY = 'notice'

/** where a notice opens: its own view, or its page with 활동 kept lit and the notice named (openNotice) */
export function noticeTarget(item: InboxNotification): { to: string; state?: Record<string, string> } {
  if (opensAsItself(item)) return { to: `/activity?n=${encodeURIComponent(item.id)}` }
  return { to: noticeLink(item)!.to, state: { [RAIL_STATE_KEY]: 'activity', [NOTICE_STATE_KEY]: item.id } }
}

/** The one notice open on the right, or none: its own view (?n=); else, while 활동 is lit, the notice this entry was
 * opened from (its state names it, or `kept` names it for this page: the rail's 활동 reopening it), or, with no name (a link from elsewhere that lit 활동), the only notice that leads to this page. Two notices
 * can lead to one page (two people joined one project): the page alone then picks none, so at most one row is selected. */
export function openNotice(
  items: readonly InboxNotification[],
  at: { pathname: string; search: string; state?: unknown; lit: string | null },
  kept?: { here: string; id: string } | null,
): string | null {
  if (at.pathname === '/activity') return new URLSearchParams(at.search).get('n')
  if (at.lit !== 'activity') return null
  const here = `${at.pathname}${at.search}`
  const leadsHere = (x: InboxNotification) => !opensAsItself(x) && noticeLink(x)?.to === here
  const named = namedNotice(at.state) ?? (kept?.here === here ? kept.id : null)
  if (named) {
    const item = items.find((x) => x.id === named)
    return item && leadsHere(item) ? named : null
  }
  const matches = items.filter(leadsHere)
  return matches.length === 1 ? matches[0]!.id : null
}
const namedNotice = (state: unknown): string | null => {
  const v = state && typeof state === 'object' ? (state as Record<string, unknown>)[NOTICE_STATE_KEY] : undefined
  return typeof v === 'string' ? v : null
}
/** the notice last opened from here and its page, for this browser tab (sessionStorage, as lib/rail.ts keeps each
 * place's page, so the rail's 활동 reopening that page after a reload still names it; signing out clears it): another
 * page with 활동 lit forgets it */
type Kept = { here: string; id: string }
function readKept(): Kept | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(ACTIVITY_OPENED_KEY) ?? 'null') as Partial<Kept> | null
    return v && typeof v.here === 'string' && typeof v.id === 'string' ? { here: v.here, id: v.id } : null
  } catch {
    return null
  }
}
function writeKept(v: Kept | null) {
  try {
    if (v) sessionStorage.setItem(ACTIVITY_OPENED_KEY, JSON.stringify(v))
    else sessionStorage.removeItem(ACTIVITY_OPENED_KEY)
  } catch {
    /* not kept: a private window may refuse */
  }
}
/** what is kept, brought up to date with the entry on screen (only while 활동 is lit on a page of its notices) */
function keptFor(at: { pathname: string; search: string; state?: unknown; lit: string | null }): Kept | null {
  const kept = readKept()
  if (at.lit !== 'activity' || at.pathname === '/activity') return kept
  const named = namedNotice(at.state), here = `${at.pathname}${at.search}`
  if (named) {
    if (kept?.here !== here || kept.id !== named) writeKept({ here, id: named })
    return { here, id: named }
  }
  if (kept && kept.here !== here) {
    writeKept(null)
    return null
  }
  return kept
}

/** what 활동's list keeps between visits */
type KeptFeed = { items: InboxNotification[]; cursor: string | null; unread: number }
const FEED_KEY = 'feed:panel'

export function ActivityPanel() {
  const t = useT(), locale = useLocale()
  const admin = isAdmin(useMe())
  const chips = chipsFor(admin)
  const [chip, setChip] = useState<ActivityChip>('all')
  const shownChip = chips.includes(chip) ? chip : 'all'
  // the list as this window last showed it (store/listCache.ts): 활동 again shows it at once and reads it behind it
  const [kept] = useState(() => peekCached<KeptFeed>(FEED_KEY))
  const [items, setItems] = useState<InboxNotification[] | null>(kept?.items ?? null)
  const [cursor, setCursor] = useState<string | null>(kept?.cursor ?? null)
  const [unread, setUnread] = useState(kept?.unread ?? 0)
  useEffect(() => { rememberCached<KeptFeed>(FEED_KEY, items ? { items, cursor, unread } : undefined) }, [items, cursor, unread])
  const [error, setError] = useState<string | null>(null)
  const [paging, setPaging] = useState(false)
  const [marking, setMarking] = useState(false)
  const pages = useRef(0)
  const itemsRef = useRef<InboxNotification[] | null>(items)
  const life = useRef(0)
  // the newest read again wins: an older answer that lands late (or one sent before a row was read here) is dropped
  const sequence = useRef(0)
  useEffect(() => {
    life.current++
    return () => void life.current++
  }, [])

  /** the newest rows again (as many as are loaded), or `after` the next older page */
  const load = useCallback(async (after?: string) => {
    const generation = life.current
    const seq = after ? sequence.current : ++sequence.current
    if (after) setPaging(true)
    try {
      const limit = after ? PAGE : Math.min(100, Math.max(PAGE, itemsRef.current?.length ?? 0))
      const r = await api.call(API.listNotifications, { query: { limit, only: 'notices', ...(after ? { cursor: after } : {}) } })
      if (generation !== life.current || seq !== sequence.current) return
      if (!after) pages.current = 0
      // (a row being marked read here keeps its mark: this read may be from before it)
      const next = keepPendingReads(after ? [...new Map([...(itemsRef.current ?? []), ...r.items].map((x) => [x.id, x])).values()] : r.items, itemsRef.current)
      itemsRef.current = next
      setItems(next)
      setCursor(r.nextCursor)
      setUnread(r.noticeUnreadCount ?? r.items.filter((x) => !x.readAt).length)
      setError(null)
    } catch (e) {
      if (generation === life.current) setError(errorText(e, locale, t('error.network')))
    } finally {
      if (generation === life.current && after) setPaging(false)
    }
    // useT returns a fresh function; its translations change only with locale
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])
  useEffect(() => {
    void load()
    const offs = [notificationsChanged.on(() => void load()), reloadAsked.on(() => void load()), accessChanged.on(() => void load())]
    return () => offs.forEach((off) => off())
  }, [load])
  // unread ones not loaded yet (the list is unread first): the older pages, by themselves, a few at most
  const loadedUnread = items?.filter((x) => !x.readAt).length ?? 0
  useEffect(() => {
    if (!cursor || paging || loadedUnread >= unread || pages.current >= AUTO_PAGES) return
    pages.current++
    void load(cursor)
  }, [cursor, paging, loadedUnread, unread, load])

  /** the rows through `f`, on screen and for the reads after */
  const patch = (f: (x: InboxNotification) => InboxNotification) => {
    const next = itemsRef.current?.map(f) ?? null
    itemsRef.current = next
    setItems(next)
  }
  // read at once, with the rail's number (store/inbox.ts); a failure puts it back with a toast
  const read = (item: InboxNotification) => {
    if (item.readAt) return
    sequence.current++
    let shown = false
    void markNoticeRead(item, (readAt) => {
      patch((x) => (x.id === item.id ? { ...x, readAt } : x))
      if (!!readAt === shown) return
      shown = !!readAt
      setUnread((n) => Math.max(0, n + (readAt ? -1 : 1)))
    })
  }
  const markAll = async () => {
    if (marking) return
    setMarking(true)
    sequence.current++
    const was = unread
    const marked = new Set(itemsRef.current?.filter((x) => !x.readAt).map((x) => x.id))
    await markAllNoticesRead('all', 'notices', (readAt) => {
      patch((x) => (marked.has(x.id) && !x.readAt === !!readAt ? { ...x, readAt } : x))
      setUnread(readAt ? 0 : was)
    })
    // the server says so to every window too; this one reads again now
    notificationsChanged.emit()
    setMarking(false)
  }

  // the row open on the right: its own view (?n=), or its page opened from here (활동 still lit)
  // (one row at most: openNotice)
  const { pathname, search, state } = useLocation()
  const lit = useRailHere()
  const at = { pathname, search, state, lit }
  const openId = openNotice(items ?? [], at, keptFor(at))
  const isOpen = (item: InboxNotification) => openId !== null && openId === item.id

  // what was unread when this list showed it stays on top while the list is open (read now, its dot goes): a row never
  // jumps away from under the pointer as it opens
  const wasUnread = useRef(new Set<string>())
  for (const x of items ?? []) if (!x.readAt) wasUnread.current.add(x.id)
  const shown = (items ?? []).filter((x) => inChip(x, shownChip))
  const { unread: fresh, read: old } = unreadFirst(shown, (x) => wasUnread.current.has(x.id))
  const row = (item: InboxNotification) => <NoticeRow key={item.id} item={item} open={isOpen(item)} onOpen={() => read(item)} />
  return (
    <PanelFrame
      title={t('inbox.title')}
      testId="activity-panel"
      actions={
        <>
          {/* the whole list's, so only under 전체: a chip never reads what it does not show */}
          {unread > 0 && shownChip === 'all' && (
            <IconButton label={t('feed.markAllRead')} onClick={() => void markAll()} disabled={marking} data-testid="activity-panel-mark-all">
              <CheckCheck size={16} aria-hidden />
            </IconButton>
          )}
          <Tooltip label={t('feed.settings')}>
            <Link to="/settings/notifications" aria-label={t('feed.settings')} className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink" data-testid="activity-panel-settings">
              <Settings size={16} aria-hidden />
            </Link>
          </Tooltip>
        </>
      }
      top={
        <>
          <SetupRow />
          {/* two lines when the words are long (English, Spanish): never cut */}
          <Link to={CHATS_ACTIVITY} className={clsx(panelRowBox, 'py-1 text-row text-muted')} data-testid="activity-panel-to-chats">
            <AtSign size={16} className="shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{t('activity.inChats')}</span>
            <ChevronRight size={14} className="shrink-0 text-faint" aria-hidden />
          </Link>
          {chips.length > 1 && (
            <div role="group" aria-label={t('activity.chips')} className="flex flex-wrap gap-1.5 px-1 pt-1" data-testid="activity-panel-chips">
              {chips.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={shownChip === c}
                  // a touch screen: the chip takes taps from a 44 px box around it (its ::after: 26 px inside the border + 2 × 9), and
                  // looks the same
                  onClick={() => setChip(c)}
                  className={clsx("relative inline-flex h-7 items-center rounded-full border px-3 text-meta font-medium pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-[9px] pointer-coarse:after:content-['']", shownChip === c ? 'border-ink bg-ink text-canvas' : 'border-field-border text-muted hover:bg-hover hover:text-ink')}
                  data-testid={`activity-chip-${c}`}
                >
                  {c === 'all' ? t('feed.tab.all') : c === 'trina' ? aiName(t) : t('activity.chip.requests')}
                </button>
              ))}
            </div>
          )}
        </>
      }
    >
      {error && <p role="alert" className="px-3 py-2 text-meta text-danger">{error}</p>}
      {!items && !error && <div className="mx-auto mt-4 size-4 animate-spin rounded-full border-2 border-line border-t-faint" role="status" aria-label={t('common.loading')} />}
      {items && !shown.length && !cursor && <p className="px-3 py-2 text-sm text-faint" data-testid="activity-panel-empty">{shownChip === 'all' ? t('notifications.empty') : t('feed.emptyFiltered')}</p>}
      {fresh.length > 0 && <ul aria-label={t('notifications.unread', { count: fresh.length })} data-testid="activity-panel-unread">{fresh.map(row)}</ul>}
      {old.length > 0 && (
        <PanelSection id="activity-panel-read" foldKey="activity:read" label={t('activity.read')} count={old.length} labelTestId="activity-panel-label" data-testid="activity-panel-read">
          <ul>{old.map(row)}</ul>
        </PanelSection>
      )}
      {cursor && items && (
        <button type="button" onClick={() => void load(cursor)} disabled={paging} className={clsx(panelRowBox, 'text-meta text-muted')} data-testid="activity-panel-more">
          {t('common.loadMore')}
        </button>
      )}
    </PanelFrame>
  )
}

/** One notice: its kind's icon, its words (two lines at most), when; a dot while unread. A link to where it opens
 * (noticeTarget), so it can also open in a new tab. */
function NoticeRow({ item, open, onOpen }: { item: InboxNotification; open: boolean; onOpen: () => void }) {
  const t = useT(), locale = useLocale()
  const unread = !item.readAt
  const kind = chipOf(item)
  const Icon = kind === 'trina' ? CalendarClock : kind === 'requests' ? Plug : Bell
  const target = noticeTarget(item)
  return (
    <ListRow
      to={target.to}
      state={target.state}
      onClick={onOpen}
      selected={open}
      unread={unread}
      wrap
      icon={<Icon />}
      name={noticeText(item, t, locale)}
      nameTestId="activity-panel-text"
      meta={<time dateTime={item.createdAt}>{listTime(item.createdAt, locale, t('sidebar.yesterday'))}</time>}
      end={
        unread && (
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent max-md:mt-0" data-testid="activity-panel-dot">
            <span className="sr-only">{t('notifications.unreadMark')}</span>
          </span>
        )
      }
      testId="activity-panel-row"
      link={{ 'data-unread': unread ? '' : undefined, 'data-chip': kind ?? 'other' }}
    />
  )
}
