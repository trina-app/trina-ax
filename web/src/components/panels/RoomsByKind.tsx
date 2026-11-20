// 대화's whole list beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1): every conversation of
// mine. 고정 first (all my pins, the most recently pinned first), then 채널 (전체 first, the others
// by name) and 다이렉트 메시지 (1:1s and group chats together, latest activity first:
// docs/decisions/20261116-sidebar-channels-dms.md): nav/RoomsList.tsx roomSections and its rows. The rooms I hid
// are left out (the one on screen still shows); "숨긴 대화 N" at the end opens the conversations page, where they are.
// Long lists stay cheap (the plan's rendering budget, measured with 200 rooms): each section is skipped by the browser
// while it is off screen (content-visibility), and past 200 rows the rest is drawn 200 at a time as the list scrolls
// near its end (the room on screen is always drawn).
// Each kind is a section whose label folds it (PanelFrame.tsx PanelSection, its count beside it while folded), as
// Slack's sidebar sections. Folded (docs/decisions/20261116-collapsible-chat-sections.md), a section keeps only the
// room on screen under it, and its header says what waits inside: bold with one pill (roomFolderPill, "@" for a
// mention › how many of its rooms have unread messages). The phone's 대화 tab folds the same sections with the same
// keys (pages/Rooms.tsx), and the folds are kept on the account (panels/folds.ts).
// The team's categories (nav/RoomCategories.tsx) come between 고정 and 채널: one section each, the same for everyone,
// holding the channels of it I am in (an admin also sees empty ones, with their "⋯"). A room shows in one place only:
// pinned › its category › its kind. The personal conversation folders are no longer shown.
import { EyeOff, Pin, Tag } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { Room, RoomCategory } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { pinnedRooms, shownInLists } from '../../lib/rooms'
import { useRooms } from '../../store/rooms'
import { RoomFolderPillView, roomFolderBold, roomFolderPill } from '../nav/NavFolders'
import { CategoryMenu, NewCategoryButton, NewCategoryRow, canCategorize, useCategories, useManagesCategories } from '../nav/RoomCategories'
import { RoomRow, RoomSectionAction, roomSections, SECTION_WORD } from '../nav/RoomsList'
import { useRoomTitle } from '../rooms/RoomIcon'
import { PanelSection, panelRowBox } from './PanelFrame'
import { useFolds } from './folds'

/** rows drawn at first, and added each time the list's end comes near */
export const ROOMS_BUDGET = 200
const ROW_PX = 30

const noop = () => {}

type Section = { key: 'pinned' | 'team' | 'dm'; rooms: Room[]; category?: undefined } | { key: 'category'; rooms: Room[]; category: RoomCategory }

/** The sections in their order, each with its rooms: 고정, then the team's categories (in their order, by name inside;
 * one with no room of mine is left out unless `keepEmpty`, an admin who fills them), then the kinds. A room is in one
 * place: pinned › its category › its kind. */
export function roomsByKind(rooms: Room[], titleOf: (r: Room) => string, locale: string, categories: RoomCategory[] = [], keepEmpty = false): Section[] {
  const pins = pinnedRooms(rooms)
  const ids = new Set(categories.map((c) => c.id))
  const filed = (r: Room) => !!r.categoryId && ids.has(r.categoryId) && canCategorize(r)
  const rest = rooms.filter((r) => !r.pinnedAt && !filed(r))
  const collator = new Intl.Collator(locale, { numeric: true })
  return [
    ...(pins.length ? [{ key: 'pinned' as const, rooms: pins }] : []),
    ...categories
      .map((c) => ({ key: 'category' as const, category: c, rooms: rooms.filter((r) => !r.pinnedAt && filed(r) && r.categoryId === c.id).sort((a, b) => collator.compare(titleOf(a), titleOf(b))) }))
      .filter((s) => keepEmpty || s.rooms.length > 0),
    ...roomSections(rest, titleOf, locale).map((s) => ({ key: s.section, rooms: s.rooms })),
  ]
}

/** How many rows to draw: the budget, grown to hold the row at `openAt` (its place in the whole list, or -1). */
export const rowsToDraw = (budget: number, openAt: number) => Math.max(budget, openAt + 1)

/** a section's fold key in the account's folds (panels/folds.ts) */
export const sectionFoldKey = (s: Section) => (s.category ? `chats:category:${s.category.id}` : `chats:${s.key}`)

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
  const categories = useCategories()
  const admin = useManagesCategories()
  const { folds } = useFolds()
  const sections = roomsByKind(rooms, titleOf, locale, categories, admin)
  // a folded section draws no rows but the room on screen (it stays in sight, as in Slack's sidebar)
  const isFolded = (s: Section) => folds[`section:${sectionFoldKey(s)}`] === 'folded'
  const drawnOf = (s: Section) => (isFolded(s) ? s.rooms.filter((r) => r.id === openId) : s.rooms)
  const flat = sections.flatMap(drawnOf)
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
    const shown = drawnOf(s).slice(0, left)
    left -= shown.length
    const key = s.category ? `category-${s.category.id}` : s.key
    const id = `chats-panel-${key}`
    const folded = isFolded(s)
    out.push(
      <PanelSection
        key={key}
        id={id}
        foldKey={sectionFoldKey(s)}
        label={s.category ? s.category.name : s.key === 'pinned' ? t('chat.pinned') : t(SECTION_WORD[s.key])}
        icon={s.key === 'pinned' ? <Pin size={14} className="text-muted" aria-hidden /> : s.category ? <Tag size={14} className="text-muted" aria-hidden /> : undefined}
        count={s.rooms.length}
        {...foldedLook(s.rooms, 'chats-panel-section-pill')}
        keep={folded && shown.length ? <RoomRows rooms={shown} section={s.key} /> : undefined}
        action={s.category ? <CategoryMenu category={s.category} /> : s.key === 'pinned' ? undefined : s.key === 'team' ? <span className="flex items-center"><NewCategoryButton /><RoomSectionAction section="team" /></span> : <RoomSectionAction section={s.key} />}
        labelTestId="chats-panel-label"
        // a row's open menu is drawn past the section's box: content-visibility clips what is inside (it contains paint),
        // so the section is drawn plainly while one is open
        className="[content-visibility:auto] has-[[aria-expanded=true]]:[content-visibility:visible]"
        style={{ containIntrinsicSize: `auto ${46 + shown.length * ROW_PX}px` }}
        data-testid="chats-panel-section"
        data-section={s.key}
      >
        <RoomRows rooms={shown} section={s.key} />
        {s.category && !s.rooms.length && <p className="px-3 py-1.5 text-meta text-faint" data-testid="room-category-empty">{t('roomCategories.empty')}</p>}
      </PanelSection>,
    )
  }
  return (
    <div data-testid="sidebar-rooms-list" data-rooms={flat.length} data-drawn={Math.min(draw, flat.length)}>
      {loaded && !everyRoom.length && <p className="px-3 py-2 text-sm text-faint">{t('rooms.listEmpty')}</p>}
      {out}
      {more && <ul aria-hidden><li ref={end} className="h-px" data-testid="chats-panel-more" /></ul>}
      {/* an admin with no category yet: one quiet row to make the first */}
      {loaded && !categories.length && everyRoom.length > 0 && <NewCategoryRow className="mt-2" />}
      {/* not on the conversations page itself, which lists them already */}
      {hidden > 0 && pathname !== '/rooms' && (
        <Link to="/rooms" className={`${panelRowBox} mt-2 text-meta text-muted`} data-testid="chats-panel-hidden">
          <EyeOff size={14} aria-hidden />
          <span className="truncate">{t('rooms.hidden.title', { n: hidden })}</span>
        </Link>
      )}
    </div>
  )
}

function RoomRows({ rooms, section }: { rooms: Room[]; section: Section['key'] }) {
  return (
    <ul>
      {rooms.map((r) => (
        <RoomRow key={r.id} room={r} onNavigate={noop} section={section} />
      ))}
    </ul>
  )
}

/** A folded section's look in the 대화 list (here and on the phone's 대화 tab): bold while one of its rooms is
 * (roomFolderBold), with the pill of what waits in its rooms (roomFolderPill), nothing when all is read. Spread on a
 * ListSection. */
export function foldedLook(rooms: Room[], testId: string) {
  const pill = roomFolderPill(rooms)
  return { unread: !!pill || roomFolderBold(rooms), pill: pill ? <RoomFolderPillView pill={pill} testId={testId} /> : undefined }
}
