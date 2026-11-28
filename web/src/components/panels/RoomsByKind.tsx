// 대화's whole list beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1): every conversation of
// mine. 고정 first (all my pins, the most recently pinned first), then my sections, then 채널 (전체 first, the others
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
// My sections (docs/decisions/20261121-personal-sidebar-sections.md, nav/SidebarSections.tsx) come between 고정 and
// 채널, each a top-level section like 채널: its "⋯" (SectionMenu), the conversations I keep in it by latest activity,
// and, empty, a line that says how to fill it. A conversation shows in one place only: pinned › its section › its
// kind. A row dragged onto a section goes in; onto the 채널, 프로젝트 or 다이렉트 메시지 header it comes out.
// 프로젝트 (docs/decisions/20261121-sidebar-projects-group.md) sits between 채널 and 다이렉트 메시지: each team project's
// own chat room (Room.projectRoom) by name, no "+", shown while I have one listed anywhere.
import clsx from 'clsx'
import { EyeOff, Pin } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRowMenu } from '../rooms/MenuButton'
import { Link, useLocation } from 'react-router-dom'
import type { NavFolder, Room } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { isProjectRoom, pinnedRooms, shownInLists } from '../../lib/rooms'
import { useRooms } from '../../store/rooms'
import { DROP_OVER, RoomFolderPillView, roomFolderBold, roomFolderPill } from '../nav/NavFolders'
import { SectionEmpty, SectionMenu, useSectionDrop, useSections } from '../nav/SidebarSections'
import { RoomRow, RoomSectionAction, roomSections, SECTION_WORD } from '../nav/RoomsList'
import { useRoomTitle } from '../rooms/RoomIcon'
import { PanelSection, panelRowBox } from './PanelFrame'
import { useFolds } from './folds'

/** rows drawn at first, and added each time the list's end comes near */
export const ROOMS_BUDGET = 200
const ROW_PX = 30

const noop = () => {}

export type Section = { key: 'pinned' | 'team' | 'project' | 'dm'; rooms: Room[]; folder?: undefined } | { key: 'folder'; rooms: Room[]; folder: NavFolder }

/** The sections in their order, each with its rooms (no empty kind section: withKinds adds them; every section of
 * mine, empty or not, after 고정). A room is in one place: pinned › the section it is in (one of `folders`, my list
 * folders of kind 'rooms') › its kind. */
export function roomsByKind(rooms: Room[], titleOf: (r: Room) => string, locale: string, folders: NavFolder[] = []): Section[] {
  const pins = pinnedRooms(rooms)
  const ids = new Set(folders.map((f) => f.id))
  const filed = (r: Room) => !!r.folderId && ids.has(r.folderId)
  const rest = rooms.filter((r) => !r.pinnedAt && !filed(r))
  return [
    ...(pins.length ? [{ key: 'pinned' as const, rooms: pins }] : []),
    ...folders.map((f) => ({ key: 'folder' as const, folder: f, rooms: rooms.filter((r) => !r.pinnedAt && r.folderId === f.id) })),
    ...roomSections(rest, titleOf, locale).map((s) => ({ key: s.section, rooms: s.rooms })),
  ]
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
  // only the conversations I hid (not a project room still waiting for its first message), the page's own count
  const hidden = everyRoom.filter((r) => r.hidden && r.id !== openId).length
  const folders = useSections()
  const { folds } = useFolds()
  // the kind sections stay even when empty (their "+" is where New section and Create a channel are)
  const sections = withKinds(roomsByKind(rooms, titleOf, locale, folders))
  // a folded section draws no rows but the room on screen (it stays in sight, as in Slack's sidebar)
  const isFolded = (s: Section) => folds[foldOf(s)] === 'folded'
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
    if (left <= 0 && s.rooms.length) break
    const shown = drawnOf(s).slice(0, Math.max(left, 0))
    left -= shown.length
    out.push(<ChatsSection key={s.folder ? `section-${s.folder.id}` : s.key} s={s} shown={shown} folded={isFolded(s)} />)
  }
  return (
    <div data-testid="sidebar-rooms-list" data-rooms={flat.length} data-drawn={Math.min(draw, flat.length)}>
      {loaded && !everyRoom.length && <p className="px-3 py-2 text-sm text-faint">{t('rooms.listEmpty')}</p>}
      {out}
      {more && <ul aria-hidden><li ref={end} className="h-px" data-testid="chats-panel-more" /></ul>}
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

/** The kind sections, Channels and Direct messages, always there (empty when every conversation of theirs is pinned or
 * in a section): their header holds the "+" and takes a dragged row out of its section. Projects between them while I
 * have a listed project room anywhere, pinned or in a section of mine too, so a project room can always be dropped back
 * (docs/decisions/20261121-sidebar-projects-group.md). */
export function withKinds(sections: Section[]): Section[] {
  const kind = (key: 'team' | 'project' | 'dm'): Section => sections.find((s) => s.key === key) ?? { key, rooms: [] }
  const projects = sections.some((s) => s.rooms.some(isProjectRoom))
  return [...sections.filter((s) => s.key === 'pinned' || s.key === 'folder'), kind('team'), ...(projects ? [kind('project')] : []), kind('dm')]
}

/** a section's fold key in the account's folds (panels/folds.ts): my sections keep the key of the phone's list */
export const foldOf = (s: Section) => (s.folder ? `room-folder:${s.folder.id}` : `section:chats:${s.key}`)

/** One section of the list: 고정, one of mine, 채널 or 다이렉트 메시지. Mine and the kinds take a dragged row: into mine,
 * out of its section onto a kind. */
function ChatsSection({ s, shown, folded }: { s: Section; shown: Room[]; folded: boolean }) {
  const t = useT()
  const drop = useSectionDrop(s.folder ?? null)
  const takes = s.key !== 'pinned'
  // a personal section's header: a right-click (a long press, the menu key) opens its "⋯"; the kinds' headers have none
  const menu = useRowMenu({ off: !s.folder })
  const key = s.folder ? `section-${s.folder.id}` : s.key
  return (
    <PanelSection
      id={`chats-panel-${key}`}
      foldKey={`chats:${s.key}`}
      foldId={s.folder ? `room-folder:${s.folder.id}` : undefined}
      label={s.folder ? s.folder.name : s.key === 'pinned' ? t('chat.pinned') : t(SECTION_WORD[s.key])}
      icon={s.key === 'pinned' ? <Pin size={14} className="text-muted" aria-hidden /> : undefined}
      count={s.rooms.length}
      {...foldedLook(s.rooms, 'chats-panel-section-pill')}
      keep={folded && shown.length ? <RoomRows rooms={shown} section={s.key} /> : undefined}
      action={s.folder ? <SectionMenu section={s.folder} buttonClassName="size-6" open={menu.open} /> : s.key === 'pinned' ? undefined : <RoomSectionAction section={s.key} />}
      headProps={s.folder ? menu.row : undefined}
      labelTestId="chats-panel-label"
      // a row's open menu is drawn past the section's box: content-visibility clips what is inside (it contains paint),
      // so the section is drawn plainly while one is open
      className={clsx('[content-visibility:auto] has-[[aria-expanded=true]]:[content-visibility:visible]', takes && drop.over && DROP_OVER)}
      style={{ containIntrinsicSize: `auto ${46 + Math.max(shown.length, 1) * ROW_PX}px` }}
      {...(takes ? drop.props : {})}
      data-testid="chats-panel-section"
      data-section={s.key}
      data-section-id={s.folder?.id}
      data-drop={takes && drop.over ? '' : undefined}
    >
      <RoomRows rooms={shown} section={s.key} />
      {s.folder && !s.rooms.length && <SectionEmpty section={s.folder} />}
    </PanelSection>
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
