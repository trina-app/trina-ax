// 대화's whole list beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1, phase P3): every conversation of
// mine, no "더 보기" cap. 고정 first (all my pins, the most recently pinned first), then 팀 대화방 (전체 first, the others
// by name), 그룹 대화 and 1:1 대화 (latest activity first): nav/RoomsList.tsx roomSections and its rows. The rooms I hid
// are left out (the one on screen still shows); "숨긴 대화 N" at the end opens the conversations page, where they are.
// Long lists stay cheap (the plan's rendering budget, measured with 200 rooms): each section is skipped by the browser
// while it is off screen (content-visibility), and past 200 rows the rest is drawn 200 at a time as the list scrolls
// near its end (the room on screen is always drawn).
import { EyeOff, Pin } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { Room } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { pinnedRooms, shownInLists } from '../../lib/rooms'
import { useRooms } from '../../store/rooms'
import { RoomRow, roomSections, SECTION_WORD } from '../nav/RoomsList'
import { useRoomTitle } from '../rooms/RoomIcon'
import { PanelLabel, panelRow } from './PanelFrame'

/** rows drawn at first, and added each time the list's end comes near */
export const ROOMS_BUDGET = 200
const ROW_PX = 36

const noop = () => {}

type Section = { key: 'pinned' | 'team' | 'group' | 'dm'; rooms: Room[] }

/** The sections in their order, each with its rooms (no empty section). */
export function roomsByKind(rooms: Room[], titleOf: (r: Room) => string, locale: string): Section[] {
  const pins = pinnedRooms(rooms)
  const rest = rooms.filter((r) => !r.pinnedAt)
  return [...(pins.length ? [{ key: 'pinned' as const, rooms: pins }] : []), ...roomSections(rest, titleOf, locale).map((s) => ({ key: s.section, rooms: s.rooms }))]
}

/** How many rows to draw: the budget, grown to hold the row at `openAt` (its place in the whole list, or -1). */
export const rowsToDraw = (budget: number, openAt: number) => Math.max(budget, openAt + 1)

export function RoomsByKind() {
  const t = useT()
  const locale = useLocale()
  const titleOf = useRoomTitle()
  const everyRoom = useRooms((s) => s.rooms)
  const loaded = useRooms((s) => s.loaded)
  const { pathname } = useLocation()
  const openId = /^\/rooms\/([^/]+)/.exec(pathname)?.[1] ?? null
  const rooms = shownInLists(everyRoom, openId)
  const hidden = everyRoom.length - rooms.length
  const sections = roomsByKind(rooms, titleOf, locale)
  const flat = sections.flatMap((s) => s.rooms)
  const [budget, setBudget] = useState(ROOMS_BUDGET)
  const draw = rowsToDraw(budget, openId ? flat.findIndex((r) => r.id === openId) : -1)
  const more = flat.length > draw
  // the end of what is drawn comes near: the next rows
  const end = useRef<HTMLLIElement>(null)
  useEffect(() => {
    const el = end.current
    if (!el || !more) return
    // the panel's own scroll box, so the look-ahead is measured there
    const root = el.closest<HTMLElement>('[data-testid="panel-scroll"]')
    const seen = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setBudget((b) => b + ROOMS_BUDGET), { root, rootMargin: '400px 0px' })
    seen.observe(el)
    return () => seen.disconnect()
  }, [more, draw])

  let left = draw
  const out: ReactNode[] = []
  for (const s of sections) {
    if (left <= 0) break
    const shown = s.rooms.slice(0, left)
    left -= shown.length
    const id = `chats-panel-${s.key}`
    out.push(
      <section
        key={s.key}
        aria-labelledby={id}
        className="[content-visibility:auto]"
        style={{ containIntrinsicSize: `auto ${32 + shown.length * ROW_PX}px` }}
        data-testid="chats-panel-section"
        data-section={s.key}
      >
        <PanelLabel id={id} icon={s.key === 'pinned' ? <Pin size={12} aria-hidden /> : undefined} testId="chats-panel-label">
          {s.key === 'pinned' ? t('chat.pinned') : t(SECTION_WORD[s.key])}
        </PanelLabel>
        <ul>
          {shown.map((r) => (
            <RoomRow key={r.id} room={r} onNavigate={noop} section={s.key} />
          ))}
        </ul>
      </section>,
    )
  }
  return (
    <div data-testid="sidebar-rooms-list" data-rooms={flat.length} data-drawn={Math.min(draw, flat.length)}>
      {loaded && !everyRoom.length && <p className="px-3 py-2 text-sm text-faint">{t('rooms.listEmpty')}</p>}
      {out}
      {more && <ul aria-hidden><li ref={end} className="h-px" data-testid="chats-panel-more" /></ul>}
      {/* not on the conversations page itself, which lists them already */}
      {hidden > 0 && pathname !== '/rooms' && (
        <Link to="/rooms" className={`${panelRow} mt-2 text-xs text-muted`} data-testid="chats-panel-hidden">
          <EyeOff size={14} aria-hidden />
          <span className="truncate">{t('rooms.hidden.title', { n: hidden })}</span>
        </Link>
      )}
    </div>
  )
}
