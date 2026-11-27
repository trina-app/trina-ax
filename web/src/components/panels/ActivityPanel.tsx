// 활동's list panel beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1): the one Activity, like Slack's
// (docs/decisions/20261126-one-activity.md), made lean (docs/decisions/20261127-activity-lean.md): mentions, thread
// replies and the app's own notices together. Its header: the "안 읽음 / Unreads" switch (lib/unreadsOnly.ts: off by
// default, remembered, the phone's too; below a 1052 px window its bell alone) and, while the filter has something
// unread, "Mark all as read" (전체 · DM · 멘션 · 스레드: the server reads that tab's rows, and a conversation row's room or
// thread is read to its newest message too). Notification settings are in Settings and beside this list on the right
// (pages/Activity.tsx), not here. Then the owner's setup row while it shows, one line of filters that never wraps
// (lib/activityKinds.ts): 전체 · 멘션 · 스레드, a filter picked from "⋯" as its own chip, then "⋯" (DM, 트리나, 요청 for
// the owner and admins; a chip the line has no room for moves in there; a link's `?tab=` picks one), and the notices,
// newest first, read and unread together. A row is two lines: a conversation's where and when, then "who: line" (a 1:1
// DM: the person's name, then the line); a notice's words and when. A notice opens on the right while 활동 stays lit
// (lib/rail.ts railState): its chat, project, scheduled task or setup page; one with no page of its own, or with
// buttons or a job's log under it, opens as itself (/activity?n=<id>, pages/Activity.tsx). Opening one reads it.
// The rail's 활동 mark is the same count (store/inbox.ts useActivityUnread).
// Opening a conversation row opens its room or thread on the right with 활동 still lit, as Slack does.
import clsx from 'clsx'
import { Bell, BellRing, CalendarClock, CheckCheck, MessagesSquare, MoreHorizontal, Plug } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import type { InboxNotification } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { api, API, errorText } from '../../lib/api'
import { chipOf, chipOfParam, chipsFor, fitChips, inChip, isServerChip, MORE_CHIPS, newestFirst, VISIBLE_CHIPS, type ActivityChip } from '../../lib/activityKinds'
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
import { IconButton, useMediaQuery } from '../ui'
import { MenuButton } from '../rooms/MenuButton'
import { PANEL_ALWAYS_PX } from '../rail/railPanel'
import { useUnreadsOnly } from '../../lib/unreadsOnly'
import { ListRow } from '../list/List'
import { PanelFrame, panelRowBox } from './PanelFrame'

/** with 안 읽음 on, while the unread ones are not all loaded, this many older pages are read by themselves */
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
  // 안 읽음: only what is unread (lib/unreadsOnly.ts); below 1052 px the header also has "목록 숨기기", so the switch is
  // its bell alone there, its word the tooltip and the name
  const unreadsOnly = useUnreadsOnly((s) => s.on)
  const wide = useMediaQuery(`(min-width: ${PANEL_ALWAYS_PX}px)`)
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
  // 안 읽음 on and unread ones not loaded yet: the older pages, by themselves, a few at most (with it off the list is
  // newest first, and "Load more" reads further)
  const loadedUnread = items?.filter((x) => !x.readAt).length ?? 0
  useEffect(() => {
    if (!unreadsOnly || !cursor || paging || loadedUnread >= unread || pages.current >= AUTO_PAGES) return
    pages.current++
    void load(cursor)
  }, [unreadsOnly, cursor, paging, loadedUnread, unread, load])

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

  // with 안 읽음 on, a row read while the list is open stays (read now, its dot goes) until the list opens again or the
  // switch is flipped: a row never jumps away from under the pointer as it opens
  const wasUnread = useRef(new Set<string>())
  for (const x of items ?? []) if (!x.readAt) wasUnread.current.add(x.id)
  const flip = () => {
    wasUnread.current = new Set()
    useUnreadsOnly.getState().set(!unreadsOnly)
  }
  const shown = newestFirst((items ?? []).filter((x) => inChip(x, shownChip) && (!unreadsOnly || wasUnread.current.has(x.id))))
  const unreadIn = (c: ActivityChip) => (items ?? []).some((x) => !x.readAt && inChip(x, c))
  const row = (item: InboxNotification) => <NoticeRow key={item.id} item={item} open={isOpen(item)} onOpen={() => read(item)} />
  // nothing to show: with 안 읽음 on and every unread one loaded, "all caught up"
  const empty = !!items && !shown.length
  const caughtUp = empty && unreadsOnly && (!cursor || loadedUnread >= unread)
  return (
    <PanelFrame
      title={t('inbox.title')}
      testId="activity-panel"
      actions={
        <>
          <Tooltip label={t('feed.unreads')} disabled={wide}>
            <button
              type="button"
              aria-pressed={unreadsOnly}
              aria-label={wide ? undefined : t('feed.unreads')}
              onClick={flip}
              className={clsx(
                'inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium',
                wide ? 'h-7 rounded-full border px-2 text-meta' : 'size-8 rounded-lg',
                unreadsOnly ? (wide ? 'border-accent bg-accent-soft text-accent-text' : 'bg-accent-soft text-accent-text') : clsx(wide && 'border-field-border', 'text-muted hover:bg-hover hover:text-ink'),
              )}
              data-testid="activity-panel-unreads"
            >
              {wide ? t('feed.unreads') : <BellRing size={16} aria-hidden />}
            </button>
          </Tooltip>
          {/* the filter's, under the ones the server reads alone: a filter never reads what it does not show */}
          {isServerChip(shownChip) && (shownChip === 'all' ? unread > 0 : unreadIn(shownChip)) && (
            <IconButton label={t('feed.markAllRead')} onClick={() => void markAll()} disabled={marking} data-testid="activity-panel-mark-all">
              <CheckCheck size={16} aria-hidden />
            </IconButton>
          )}
        </>
      }
      top={
        <>
          <SetupRow />
          <FilterLine chips={chips} shown={shownChip} pick={pick} unreadIn={unreadIn} />
        </>
      }
    >
      {error && <p role="alert" className="px-3 py-2 text-meta text-danger">{error}</p>}
      {!items && !error && <div className="mx-auto mt-4 size-4 animate-spin rounded-full border-2 border-line border-t-faint" role="status" aria-label={t('common.loading')} />}
      {caughtUp ? (
        <div className="px-3 py-2 text-sm" data-testid="activity-panel-empty">
          <p className="text-faint">{t('feed.caughtUp')}</p>
          <button type="button" onClick={flip} className="mt-1 font-medium text-accent-text hover:underline" data-testid="activity-panel-show-all">{t('feed.showAll')}</button>
        </div>
      ) : empty && !cursor && <p className="px-3 py-2 text-sm text-faint" data-testid="activity-panel-empty">{shownChip === 'all' ? t('notifications.empty') : shownChip === 'dms' ? t('feed.dmsEmpty') : t('feed.emptyFiltered')}</p>}
      {/* 대화 has unread conversations (the rail's count): "nothing here" points there */}
      {empty && (caughtUp || !cursor) && newInChats && <Link to={TAB_ROOT.chats} className="block px-3 pb-2 text-sm font-medium text-accent-text hover:underline" data-testid="activity-new-in-chats">{t('feed.newInChats')}</Link>}
      {shown.length > 0 && <ul aria-label={t('inbox.title')} data-testid="activity-panel-list">{shown.map(row)}</ul>}
      {cursor && items && !caughtUp && (
        <button type="button" onClick={() => void load(cursor)} disabled={paging} className={clsx(panelRowBox, 'text-meta text-muted')} data-testid="activity-panel-more">
          {t('common.loadMore')}
        </button>
      )}
    </PanelFrame>
  )
}

type T = ReturnType<typeof useT>

/** a chip's word on the line (DM's short one, as the phone's tab; 트리나 the AI's name) */
function chipLabel(c: ActivityChip, t: T): string {
  if (c === 'trina') return aiName(t)
  if (c === 'requests') return t('activity.chip.requests')
  return t(c === 'all' ? 'feed.tab.all' : c === 'dms' ? 'feed.tab.dmsShort' : c === 'mentions' ? 'feed.tab.mentions' : 'feed.tab.threads')
}
/** its word in the "⋯" menu, where there is room to say more ("트리나가 한 일 / Done by Trina") */
function menuLabel(c: ActivityChip, t: T): string {
  if (c === 'trina') return t('activity.chip.trinaDid', { name: aiName(t) })
  if (c === 'dms') return t('feed.tab.dms')
  return chipLabel(c, t)
}

/** a chip (and "⋯"): 28 px, a touch screen takes taps from a 44 px box around it (its ::after: 26 px inside the border +
 * 2 × 9) and it is at least 44 px wide (DM's short word is narrower); the same look either way */
const chipCls = (on: boolean) => clsx(
  "relative inline-flex h-7 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border px-2 text-meta font-medium pointer-coarse:min-w-11 pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-[9px] pointer-coarse:after:content-['']",
  on ? 'border-ink bg-ink text-canvas' : 'border-field-border text-muted hover:bg-hover hover:text-ink',
)
const GAP = 4

/** The one line of filters (lib/activityKinds.ts): 전체 · 멘션 · 스레드, a filter picked from the menu as its own chip,
 * then "⋯" pinned at the right end. It never wraps: a chip the line has no room for (a narrow panel, a long word, a
 * touch screen's 44 px chips) moves into "⋯", 스레드 first; 전체 and the picked chip never do. Measured on a hidden copy
 * of the chips whenever the line or the words change size. A dot: something unread under that filter ("⋯": under one
 * in its menu). */
function FilterLine({ chips, shown, pick, unreadIn }: { chips: readonly ActivityChip[]; shown: ActivityChip; pick: (c: ActivityChip) => void; unreadIn: (c: ActivityChip) => boolean }) {
  const t = useT()
  const line: ActivityChip[] = [...VISIBLE_CHIPS, ...(VISIBLE_CHIPS.includes(shown) ? [] : [shown])]
  const dots = new Set(chips.filter((c) => c !== 'all' && unreadIn(c)))
  const box = useRef<HTMLDivElement>(null), copy = useRef<HTMLDivElement>(null), more = useRef<HTMLDivElement>(null)
  const lineKey = `${line.join(',')}|${[...dots].join(',')}`
  const [fit, setFit] = useState(line.join(','))
  const refit = useCallback(() => {
    const row = box.current, measured = copy.current
    if (!row || !measured || !row.clientWidth) return setFit(line.join(','))
    const widths = new Map([...measured.children].map((el) => [(el as HTMLElement).dataset.chip, el.getBoundingClientRect().width]))
    const room = row.clientWidth - (more.current?.offsetWidth ?? 0) - GAP
    setFit(fitChips(line, (c) => widths.get(c) ?? 0, room, GAP, shown).join(','))
    // (lineKey stands for line, shown and the dots)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineKey])
  useLayoutEffect(() => refit(), [refit])
  useEffect(() => {
    if (typeof globalThis.ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => refit())
    for (const el of [box.current, copy.current]) if (el) ro.observe(el)
    return () => ro.disconnect()
  }, [refit])
  const on = fit.split(',')
  const onLine = line.filter((c) => on.includes(c))
  const inMenu = [...line.filter((c) => !on.includes(c)), ...MORE_CHIPS.filter((c) => chips.includes(c))]
  const dot = (c: ActivityChip) => dots.has(c) && <span className="size-1.5 shrink-0 rounded-full bg-accent" data-testid={`activity-chip-${c}-dot`}><span className="sr-only">{t('notifications.unreadMark')}</span></span>
  return (
    <div ref={box} role="group" aria-label={t('activity.chips')} className="relative flex items-center gap-1 pt-1" data-testid="activity-panel-chips">
      {/* the hidden copy the line is measured on */}
      <div ref={copy} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 flex gap-1">
        {line.map((c) => <span key={c} data-chip={c} className={chipCls(c === shown)}>{chipLabel(c, t)}{dots.has(c) && <span className="size-1.5 rounded-full" />}</span>)}
      </div>
      <div className="flex min-w-0 flex-1 gap-1 overflow-hidden">
        {onLine.map((c) => (
          <button key={c} type="button" aria-pressed={shown === c} onClick={() => pick(c)} className={chipCls(shown === c)} data-testid={`activity-chip-${c}`}>
            {chipLabel(c, t)}
            {dot(c)}
          </button>
        ))}
      </div>
      <div ref={more} className="shrink-0">
        <MenuButton
          label={t('feed.moreFilters')}
          bare
          buttonClassName={chipCls(false)}
          icon={<><MoreHorizontal size={16} aria-hidden />{inMenu.some((c) => c !== shown && dots.has(c)) && <span className="size-1.5 shrink-0 rounded-full bg-accent" data-testid="activity-chip-more-dot"><span className="sr-only">{t('notifications.unreadMark')}</span></span>}</>}
          items={inMenu.map((c) => ({ label: menuLabel(c, t), checked: shown === c, onSelect: () => pick(c), testId: `activity-more-${c}`, dot: dots.has(c) ? t('notifications.unreadMark') : undefined }))}
          testId="activity-chip-more"
        />
      </div>
    </div>
  )
}
/** The writer's photo in the row's people box: the AI's mark for an answer of the AI, the letter without a photo. */
function RowFace({ id, name, ai }: { id?: string | null; name?: string | null; ai?: boolean }) {
  const user = useAvatarOf(id && name ? { id, name } : null)
  if (ai) return <TrinaStar size={18} />
  return user ? <Avatar user={user} size="fill" /> : <MessagesSquare />
}

/** the row's dot while unread (a screen reader hears what it is) */
function UnreadDot({ label }: { label: string }) {
  return (
    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent max-md:mt-0" data-testid="activity-panel-dot">
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** A conversation (a mention, a reply in a thread I follow, in a room or under a shared AI chat's answer), two lines:
 * where it was (#room › 스레드, a group chat, the shared chat's title) and when, then "who: the line" cut to one line
 * (the line carries its own @name; a screen reader hears "mention" on the dot). A 1:1 DM says the person's name once,
 * on the first line. The writer's photo; a dot while unread. Opens the room or the thread (noticeTarget), 활동 still lit. */
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
    // a 1:1 DM: its person's name is the place (and once is enough)
    where = item.room.kind === 'dm' ? null : words.where
    if (item.room.kind === 'dm' && item.room.thread) who = `${who} › ${t('rooms.thread')}`
  } else {
    const th = item.chatThread
    face = <RowFace id={th?.byId} name={th?.name} />
    who = th?.name ?? aiName(t)
    // who is before the line and the chat above it: the line names neither
    line = chatThreadRowLine(item, t)
    mention = !!th?.mention && !th.gone
    where = th?.title && !th.gone ? th.title : null
  }
  const at = item.room?.at ?? item.createdAt
  return (
    <ListRow
      to={target?.to}
      state={target?.state}
      onClick={onOpen}
      selected={open}
      unread={unread}
      face
      icon={face}
      name={where ? <bdi data-testid="activity-panel-where">{where}</bdi> : <bdi data-testid="activity-panel-who">{who}</bdi>}
      nameEnd={<time dateTime={at}>{listTime(at, locale, t('sidebar.yesterday'))}</time>}
      nameTestId="activity-panel-text"
      meta={
        <span className={unread ? 'text-ink' : 'text-muted'}>
          {where && <><bdi data-testid="activity-panel-who">{who}</bdi>{line ? ': ' : null}</>}
          {line ? <bdi data-testid="activity-panel-line">{line}</bdi> : null}
        </span>
      }
      metaTestId="activity-panel-meta"
      end={unread && <UnreadDot label={mention ? t('notifications.room.mention') : t('notifications.unreadMark')} />}
      testId="activity-panel-row"
      link={{ 'data-unread': unread ? '' : undefined, 'data-chip': 'conversation' }}
    />
  )
}

/** the chat a notice is about (shared with me, lost, left), while I still see its title */
function noticeChat(item: InboxNotification): string | null {
  if (item.code === 'chat.shared') return item.chatShared?.title ?? null
  if (item.code === 'chat.lost') return item.chatLost?.title ?? null
  if (item.code === 'chat.left') return item.chatLeft?.title ?? null
  return null
}

/** One notice: its kind's icon, its words (two lines at most) with when at the first line's end; a dot while unread. A
 * notice about a chat says the words on one line and the chat's title under them. A link to where it opens
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
  const chat = noticeChat(item)
  return (
    <ListRow
      to={target?.to}
      state={target?.state}
      onClick={gone && !unread ? undefined : onOpen}
      selected={open}
      unread={unread && !gone}
      wrap={!chat}
      icon={<Icon />}
      name={noticeText(item, t, locale)}
      nameEnd={<time dateTime={item.createdAt}>{listTime(item.createdAt, locale, t('sidebar.yesterday'))}</time>}
      nameTestId="activity-panel-text"
      meta={chat ? <bdi data-testid="activity-panel-chat">{chat}</bdi> : undefined}
      end={unread && <UnreadDot label={t('notifications.unreadMark')} />}
      testId="activity-panel-row"
      link={{ 'data-unread': unread ? '' : undefined, 'data-chip': kind ?? 'other', ...(gone ? { 'data-gone': '' } : {}) }}
    />
  )
}
