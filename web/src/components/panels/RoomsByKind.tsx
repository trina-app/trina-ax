// 대화's whole list beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1): every conversation of
// mine. 고정 first (all my pins, the most recently pinned first), then 팀 대화방 (전체 first, the others
// by name), 그룹 대화 and 1:1 대화 (latest activity first): nav/RoomsList.tsx roomSections and its rows. The rooms I hid
// are left out (the one on screen still shows); "숨긴 대화 N" at the end opens the conversations page, where they are.
// Long lists stay cheap (the plan's rendering budget, measured with 200 rooms): each section is skipped by the browser
// while it is off screen (content-visibility), and past 200 rows the rest is drawn 200 at a time as the list scrolls
// near its end (the room on screen is always drawn).
// Each kind is a section whose label folds it (PanelFrame.tsx PanelSection, its count beside it while folded), as
// Slack's sidebar sections.
// My folders (docs/DECISIONS.md "List folders on screen") come between 고정 and 팀 대화방: "대화 폴더 · 나만 보여요"
// with its +, then each folder as a group in that section (fold ▾, its "⋯", the rooms I keep in it by latest activity; a
// folded one keeps one pill). A room shows in one place only: pinned › its folder › its kind. With no folder yet, one
// quiet row "새 폴더" ends the list.
import clsx from 'clsx'
import { ChevronRight, EyeOff, Pin } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { NavFolder, Room } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { pinnedRooms, shownInLists } from '../../lib/rooms'
import { useRooms } from '../../store/rooms'
import { DROP_OVER, FolderIcon, FolderMenu, FoldersLabelWords, NewFolderButton, NewFolderRow, RoomFolderPillView, roomFolderPill, useFolderActions, useFolders, useDropTarget } from '../nav/NavFolders'
import { RoomRow, roomSections, SECTION_WORD } from '../nav/RoomsList'
import { useRoomTitle } from '../rooms/RoomIcon'
import { groupHead, groupRows, PanelSection, panelRowBox } from './PanelFrame'
import { useFolds } from './folds'

/** rows drawn at first, and added each time the list's end comes near */
export const ROOMS_BUDGET = 200
const ROW_PX = 30

const noop = () => {}

type Section = { key: 'pinned' | 'team' | 'group' | 'dm'; rooms: Room[]; folder?: undefined } | { key: 'folder'; rooms: Room[]; folder: NavFolder }

/** The sections in their order, each with its rooms (no empty kind section; every folder of mine, empty or not, after
 * 고정). A room is in one place: pinned › the folder it is in (one of `folders`) › its kind. */
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
  const hidden = everyRoom.length - rooms.length
  const folders = useFolders('rooms')
  const { folds, set: setFold } = useFolds()
  const sections = roomsByKind(rooms, titleOf, locale, folders)
  // a folded folder draws no rows but the room on screen (it stays in sight, as in the Trina list)
  const drawnOf = (s: Section) => (s.folder && folds[`room-folder:${s.folder.id}`] === 'folded' ? s.rooms.filter((r) => r.id === openId) : s.rooms)
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

  const foldersSection = (nodes: ReactNode[]) => (
    <PanelSection key="folders" id="chats-panel-folders" foldKey="chats:folders" label={<FoldersLabelWords kind="rooms" />} count={folders.length} action={<NewFolderButton kind="rooms" />} labelTestId="chats-panel-label" data-testid="chats-panel-folders">
      {nodes}
    </PanelSection>
  )
  let left = draw
  const out: ReactNode[] = []
  // the folders, one section of their own ("대화 폴더 · 나만 보여요"), each folder a group in it
  const folderNodes: ReactNode[] = []
  let foldersOut = false
  for (const s of sections) {
    if (left <= 0) break
    if (s.folder) {
      const key = `room-folder:${s.folder.id}`
      const folded = folds[key] === 'folded'
      const shown = drawnOf(s).slice(0, left)
      left -= shown.length
      const inIt = rooms.filter((r) => r.folderId === s.folder.id).length
      folderNodes.push(<RoomFolder key={key} folder={s.folder} rooms={s.rooms} count={inIt} shown={shown} folded={folded} onFold={() => setFold(key, folded ? 'open' : 'folded')} />)
      continue
    }
    if (folderNodes.length && !foldersOut) {
      foldersOut = true
      out.push(foldersSection(folderNodes))
    }
    const shown = s.rooms.slice(0, left)
    left -= shown.length
    const id = `chats-panel-${s.key}`
    out.push(
      <PanelSection
        key={s.key}
        id={id}
        foldKey={`chats:${s.key}`}
        label={s.key === 'pinned' ? t('chat.pinned') : t(SECTION_WORD[s.key])}
        icon={s.key === 'pinned' ? <Pin size={14} className="text-muted" aria-hidden /> : undefined}
        count={s.rooms.length}
        labelTestId="chats-panel-label"
        // a row's open menu is drawn past the section's box: content-visibility clips what is inside (it contains paint),
        // so the section is drawn plainly while one is open
        className="[content-visibility:auto] has-[[aria-expanded=true]]:[content-visibility:visible]"
        style={{ containIntrinsicSize: `auto ${46 + shown.length * ROW_PX}px` }}
        data-testid="chats-panel-section"
        data-section={s.key}
      >
        <ul>
          {shown.map((r) => (
            <RoomRow key={r.id} room={r} onNavigate={noop} section={s.key} />
          ))}
        </ul>
      </PanelSection>,
    )
  }
  if (folderNodes.length && !foldersOut) out.push(foldersSection(folderNodes))
  return (
    <div data-testid="sidebar-rooms-list" data-rooms={flat.length} data-drawn={Math.min(draw, flat.length)}>
      {loaded && !everyRoom.length && <p className="px-3 py-2 text-row text-faint">{t('rooms.listEmpty')}</p>}
      {out}
      {more && <ul aria-hidden><li ref={end} className="h-px" data-testid="chats-panel-more" /></ul>}
      {loaded && !folders.length && everyRoom.length > 0 && <NewFolderRow kind="rooms" className="mt-2" />}
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

/** One room folder: its header (fold ▾ with the name, the pill of what it holds while folded, its "⋯") and its rooms; a
 * room dragged onto it goes in. */
function RoomFolder({ folder, rooms, count, shown, folded, onFold }: { folder: NavFolder; rooms: Room[]; count: number; shown: Room[]; folded: boolean; onFold: () => void }) {
  const t = useT()
  const listId = useId()
  const act = useFolderActions('rooms')
  const drop = useDropTarget('rooms', (id) => {
    if (!rooms.some((r) => r.id === id)) void act.file(id, folder)
  })
  const pill = folded ? roomFolderPill(rooms) : null
  return (
    <section aria-label={folder.name} className={clsx(drop.over && DROP_OVER)} {...drop.props} data-testid="room-folder" data-folded={folded ? '' : undefined}>
      <div className={clsx(groupHead, 'pr-9')} data-testid="room-folder-head">
        {/* the ▸ and the name both fold it (aria-expanded), as a disclosure */}
        <button type="button" aria-expanded={!folded} aria-controls={listId} onClick={onFold} className="flex h-full min-w-0 items-center gap-1 rounded" data-testid="room-folder-fold">
          <span className="touch-hit flex size-6 shrink-0 items-center justify-center text-muted">
            <ChevronRight size={14} className={clsx('transition-transform motion-reduce:transition-none', !folded && 'rotate-90')} aria-hidden />
          </span>
          <FolderIcon className="mr-0.5 text-muted" />
          <span className="truncate" title={folder.name} data-testid="room-folder-name">{folder.name}</span>
        </button>
        {pill && <RoomFolderPillView pill={pill} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 group-hover/head:opacity-0 group-has-[:focus-visible]/head:opacity-0 pointer-coarse:right-10 max-md:right-10" />}
        <FolderMenu
          folder={folder}
          count={count}
          className="absolute inset-y-0 right-1 flex items-center"
          buttonClassName="opacity-0 group-hover/head:opacity-100 group-has-[:focus-visible]/head:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100 max-md:opacity-100"
        />
      </div>
      <ul id={listId} hidden={folded && !shown.length} className={groupRows}>
        {shown.map((r) => (
          <RoomRow key={r.id} room={r} onNavigate={noop} section="folder" />
        ))}
        {!folded && !count && <li className="px-3 py-1.5 text-meta text-faint" data-testid="room-folder-empty">{t('navFolders.empty')}</li>}
      </ul>
    </section>
  )
}
