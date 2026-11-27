// 활동's list panel beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1): the one Activity, like Slack's
// (docs/decisions/20261126-one-activity.md): mentions, thread replies and the app's own notices together. Its header:
// the gear (Settings › Notifications) and, while the chip has something unread, "Mark all as read" (전체 · DM · 멘션 ·
// 스레드: the server reads that tab's rows, and a conversation row's room or thread is read to its newest message too).
// Then the owner's setup row while it shows, the chips 전체 · DM · 멘션 · 스레드 · 트리나 · 요청 (lib/activityKinds.ts;
// 요청 for the owner and admins; a link's `?tab=` picks one), and the notices, unread first, then the read ones under
// "읽음". A conversation row has the writer's photo, who and the line, and where (#room › 스레드, a DM). A notice opens on the right while 활동 stays lit
// (lib/rail.ts railState): its chat, project, scheduled task or setup page; one with no page of its own, or with
// buttons or a job's log under it, opens as itself (/activity?n=<id>, pages/Activity.tsx). Opening one reads it.
// The rail's 활동 mark is the same count (store/inbox.ts useActivityUnread).
// Opening a conversation row opens its room or thread on the right with 활동 still lit, as Slack does.
import clsx from 'clsx'
import { Bell, CalendarClock, CheckCheck, MessagesSquare, Plug, Settings } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import type { InboxNotification } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { api, API, errorText } from '../../lib/api'
import { chipOf, chipOfParam, chipsFor, inChip, isServerChip, unreadFirst, type ActivityChip } from '../../lib/activityKinds'
import { listTime } from '../../lib/format'
import { ACTIVITY_OPENED_KEY } from '../../lib/localData'
import { RAIL_STATE_KEY, useRailHere } from '../../lib/rail'
import { aiName, TAB_ROOT } from '../../lib/tabs'
import { accessChanged, notificationsChanged, reloadAsked } from '../../store/live'
import { keepPendingReads, markAllNoticesRead, markNoticeRead } from '../../store/inbox'
import { peekCached, rememberCached } from '../../store/listCache'
import { useRooms } from '../../store/rooms'
import { unreadRooms } from '../rail/railBadges'
import { isAdmin, useMe } from '../../store/session'
import { SetupRow } from '../onboarding/SetupRow'
import { chatThreadRowLine, noticeLink, noticeText } from '../settings/Notifications'
import { isRoomRow, roomRowText } from '../settings/RoomNoticeRow'
import { useRoomTitle } from '../rooms/RoomIcon'
import { Avatar } from '../Avatar'
import { TrinaStar } from '../TrinaStar'
import { useAvatarOf } from '../../store/people'
import { Tooltip } from '../Tooltip'
import { IconButton } from '../ui'
import { ListRow } from '../list/List'
import { PanelFrame, PanelSection, panelRowBox } from './PanelFrame'

/** while the unread ones are not all loaded, this many older pages are read by themselves */
const AUTO_PAGES = 9
const PAGE = 30

/** A notice opens as itself in the main area (not at its link) when it has no page of its own or carries what only its
 * own view shows: a handover's buttons, an ask to add an app with its button, a paused room app's Resume now. */
export function opensAsItself(item: InboxNotification): boolean {
  return !noticeLink(item) || !!item.handover || (item.code === 'service.request' && !!item.serviceRequest?.open)
    // an app paused in a room that can still be resumed: its Resume now (components/rooms/apps/PausedNotice.tsx)
    || (item.code === 'room_app.paused' && !!item.roomApp?.canResume && !!item.roomApp.pausedUntil)
}

/** A page's address as a notice leads there: a room's or thread's `?m=` (the message it starts at, which the room drops
 * once it has scrolled there) is the same page. */
export function noticePage(to: string): string {
  const at = to.indexOf('?')
  if (at < 0 || !/^\/rooms\//.test(to)) return to
  const q = new URLSearchParams(to.slice(at + 1))
  q.delete('m')
  const rest = q.toString()
  return rest ? `${to.slice(0, at)}?${rest}` : to.slice(0, at)
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
  const here = noticePage(`${at.pathname}${at.search}`)
  const leadsHere = (x: InboxNotification) => { const to = noticeLink(x)?.to; return !opensAsItself(x) && !!to && noticePage(to) === here }
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
  const named = namedNotice(at.state), here = noticePage(`${at.pathname}${at.search}`)
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
export type KeptFeed = { items: InboxNotification[]; cursor: string | null; unread: number }
export const FEED_KEY = 'feed:panel'

export function ActivityPanel() {
  const t = useT(), locale = useLocale()
  const admin = isAdmin(useMe())
  const newInChats = useRooms((s) => unreadRooms(s.rooms) > 0)
  const { pathname, search, state, key } = useLocation()
  const navigationType = useNavigationType()
  const navigate = useNavigate()
  // a link to a chip (/activity?tab=mentions, an old link to 대화's 멘션·스레드 too) picks it: as the list opens, and when
  // a link is followed later. Back and Forward (POP) never put an older chip back over the one picked since; a chip
  // picked on /activity writes the address (a replace), so Back to it finds the chip picked there
  const asked = pathname === '/activity' ? chipOfParam(new URLSearchParams(search).get('tab')) : null
  const [chip, setChip] = useState<ActivityChip>(asked ?? 'all')
  useEffect(() => { if (asked && navigationType !== 'POP') setChip(asked) }, [asked, key, navigationType])
  const pick = (c: ActivityChip) => {
    setChip(c)
    if (pathname !== '/activity') return
    const next = new URLSearchParams(search)
    if (c === 'all') next.delete('tab')
    else next.set('tab', c)
    const rest = next.toString()
    navigate(rest ? `/activity?${rest}` : '/activity', { replace: true, state })
  }
  // the list as this window last showed it (store/listCache.ts): 활동 again shows it at once and reads it behind it
  const [kept] = useState(() => peekCached<KeptFeed>(FEED_KEY))
  const [items, setItems] = useState<InboxNotification[] | null>(kept?.items ?? null)
  const chips = chipsFor(admin, items ?? [])
  const shownChip = chips.includes(chip) ? chip : 'all'
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
      const r = await api.call(API.listNotifications, { query: { limit, ...(after ? { cursor: after } : {}) } })
      if (generation !== life.current || seq !== sequence.current) return
      if (!after) pages.current = 0
      // (a row being marked read here keeps its mark: this read may be from before it)
      const next = keepPendingReads(after ? [...new Map([...(itemsRef.current ?? []), ...r.items].map((x) => [x.id, x])).values()] : r.items, itemsRef.current)
      itemsRef.current = next
      setItems(next)
      setCursor(r.nextCursor)
      setUnread(r.unreadCount)
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
    const tab = shownChip
    if (marking || !isServerChip(tab)) return
    setMarking(true)
    sequence.current++
    const was = unread
    const marked = new Set(itemsRef.current?.filter((x) => !x.readAt && inChip(x, tab)).map((x) => x.id))
    await markAllNoticesRead(tab, (readAt) => {
      patch((x) => (marked.has(x.id) && !x.readAt === !!readAt ? { ...x, readAt } : x))
      // another chip empties only part of the count: the read after says how much
      if (tab === 'all') setUnread(readAt ? 0 : was)
    })
    // the server says so to every window too; this one reads again now
    notificationsChanged.emit()
    setMarking(false)
  }

  // the row open on the right: its own view (?n=), or its page opened from here (활동 still lit)
  // (one row at most: openNotice)
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
          {/* the chip's, under the chips the server reads alone: a chip never reads what it does not show */}
          {isServerChip(shownChip) && (shownChip === 'all' ? unread > 0 : shown.some((x) => !x.readAt)) && (
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
          {chips.length > 1 && (
            <div role="group" aria-label={t('activity.chips')} className="flex flex-wrap gap-1 px-1 pt-1" data-testid="activity-panel-chips">
              {chips.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={shownChip === c}
                  // a touch screen: the chip takes taps from a 44 px box around it (its ::after: 26 px inside the border + 2 × 9) and
                  // is at least 44 px wide (DM's short word is narrower), and looks the same
                  onClick={() => pick(c)}
                  className={clsx("relative inline-flex h-7 items-center justify-center rounded-full border px-2.5 text-meta font-medium pointer-coarse:min-w-11 pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-[9px] pointer-coarse:after:content-['']", shownChip === c ? 'border-ink bg-ink text-canvas' : 'border-field-border text-muted hover:bg-hover hover:text-ink')}
                  data-testid={`activity-chip-${c}`}
                >
                  {chipLabel(c, t)}
                </button>
              ))}
            </div>
          )}
        </>
      }
    >
      {error && <p role="alert" className="px-3 py-2 text-meta text-danger">{error}</p>}
      {!items && !error && <div className="mx-auto mt-4 size-4 animate-spin rounded-full border-2 border-line border-t-faint" role="status" aria-label={t('common.loading')} />}
      {items && !shown.length && !cursor && <p className="px-3 py-2 text-sm text-faint" data-testid="activity-panel-empty">{shownChip === 'all' ? t('notifications.empty') : shownChip === 'dms' ? t('feed.dmsEmpty') : t('feed.emptyFiltered')}</p>}
      {/* 대화 has unread conversations (the rail's count): "nothing here" points there */}
      {items && !shown.length && !cursor && newInChats && <Link to={TAB_ROOT.chats} className="block px-3 pb-2 text-sm font-medium text-accent-text hover:underline" data-testid="activity-new-in-chats">{t('feed.newInChats')}</Link>}
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

type T = ReturnType<typeof useT>

/** a chip's word (DM's short one, as the phone's tab: the six chips stay in two rows of the narrow panel) */
function chipLabel(c: ActivityChip, t: T): string {
  if (c === 'trina') return aiName(t)
  if (c === 'requests') return t('activity.chip.requests')
  return t(c === 'all' ? 'feed.tab.all' : c === 'dms' ? 'feed.tab.dmsShort' : c === 'mentions' ? 'feed.tab.mentions' : 'feed.tab.threads')
}

/** The writer's photo in the row's people box: the AI's mark for an answer of the AI, the letter without a photo. */
function RowFace({ id, name, ai }: { id?: string | null; name?: string | null; ai?: boolean }) {
  const user = useAvatarOf(id && name ? { id, name } : null)
  if (ai) return <TrinaStar size={18} />
  return user ? <Avatar user={user} size="fill" /> : <MessagesSquare />
}

/** A conversation (a mention, a reply in a thread I follow, in a room or under a shared AI chat's answer): the writer's
 * photo; who and the line, which carries its own @name (two lines at most; a screen reader hears "mention" on the dot); where it was (#room › 스레드, a DM, the chat)
 * and when; a dot while unread. Opens the room or the thread (noticeTarget), 활동 still lit. */
function ConversationRow({ item, open, onOpen }: { item: InboxNotification; open: boolean; onOpen: () => void }) {
  const t = useT(), locale = useLocale()
  const title = useRoomTitle()
  const roomId = item.room?.id
  const listed = useRooms((s) => (roomId ? s.rooms.find((r) => r.id === roomId) ?? null : null))
  const unread = !item.readAt
  const target = noticeLink(item) ? noticeTarget(item) : null
  let face: ReactNode, who: string, line: ReactNode, where: string | null, mention: boolean
  if (isRoomRow(item)) {
    const words = roomRowText(item.room, t, listed ? title(listed) : null)
    face = <RowFace id={item.room.fromId} name={item.room.from} ai={item.room.ai} />
    who = words.who
    line = words.line
    mention = !!words.mark
    where = words.where
  } else {
    const th = item.chatThread
    face = <RowFace id={th?.byId} name={th?.name} />
    who = th?.name ?? aiName(t)
    // who is before the line and the chat under it: the line names neither
    line = chatThreadRowLine(item, t)
    mention = !!th?.mention && !th.gone
    where = th?.title && !th.gone ? th.title : null
  }
  return (
    <ListRow
      to={target?.to}
      state={target?.state}
      onClick={onOpen}
      selected={open}
      unread={unread}
      wrap
      face
      icon={face}
      name={<><bdi data-testid="activity-panel-who">{who}</bdi>{line ? <span className={unread ? 'text-ink' : 'text-muted'}>{': '}<bdi data-testid="activity-panel-line">{line}</bdi></span> : null}</>}
      nameTestId="activity-panel-text"
      meta={<>{where && <><bdi data-testid="activity-panel-where">{where}</bdi> · </>}<time dateTime={item.room?.at ?? item.createdAt}>{listTime(item.room?.at ?? item.createdAt, locale, t('sidebar.yesterday'))}</time></>}
      end={
        unread && (
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent max-md:mt-0" data-testid="activity-panel-dot">
            <span className="sr-only">{mention ? t('notifications.room.mention') : t('notifications.unreadMark')}</span>
          </span>
        )
      }
      testId="activity-panel-row"
      link={{ 'data-unread': unread ? '' : undefined, 'data-chip': 'conversation' }}
    />
  )
}

/** One notice: its kind's icon, its words (two lines at most), when; a dot while unread. A link to where it opens
 * (noticeTarget), so it can also open in a new tab. A conversation row is ConversationRow. */
function NoticeRow({ item, open, onOpen }: { item: InboxNotification; open: boolean; onOpen: () => void }) {
  const t = useT(), locale = useLocale()
  if (isRoomRow(item) || item.code === 'chat.thread_reply') return <ConversationRow item={item} open={open} onOpen={onOpen} />
  const unread = !item.readAt
  const kind = chipOf(item)
  const Icon = kind === 'trina' ? CalendarClock : kind === 'requests' ? Plug : Bell
  // a file shared with me that no longer opens (docs/decisions/20261120-file-share-gone-notice.md): muted, opens
  // nothing; while unread a press only reads it (read, it drops out of the list on the next load)
  const gone = item.code === 'file.shared' && !!item.fileShare?.gone
  const target = gone ? null : noticeTarget(item)
  return (
    <ListRow
      to={target?.to}
      state={target?.state}
      onClick={gone && !unread ? undefined : onOpen}
      selected={open}
      unread={unread && !gone}
      wrap
      icon={<Icon />}
      name={noticeText(item, t, locale)}
      nameTestId="activity-panel-text"
      // a chat shared with me: its title under the words, while I still see it
      meta={<>{item.code === 'chat.shared' && item.chatShared?.title ? <><bdi data-testid="activity-panel-chat">{item.chatShared.title}</bdi> · </> : item.code === 'chat.lost' && item.chatLost?.title ? <><bdi data-testid="activity-panel-chat">{item.chatLost.title}</bdi> · </> : item.code === 'chat.left' && item.chatLeft?.title ? <><bdi data-testid="activity-panel-chat">{item.chatLeft.title}</bdi> · </> : null}<time dateTime={item.createdAt}>{listTime(item.createdAt, locale, t('sidebar.yesterday'))}</time></>}
      end={
        unread && (
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent max-md:mt-0" data-testid="activity-panel-dot">
            <span className="sr-only">{t('notifications.unreadMark')}</span>
          </span>
        )
      }
      testId="activity-panel-row"
      link={{ 'data-unread': unread ? '' : undefined, 'data-chip': kind ?? 'other', ...(gone ? { 'data-gone': '' } : {}) }}
    />
  )
}
