// My list folders on screen: the parts both lists' sections use (nav/SidebarSections.tsx; the Chats list's sections and
// the Trina history's, docs/decisions/20261121-personal-sidebar-sections.md and 20261122-trina-history-sections.md):
//   - useFolders: my folders of one kind, read when first needed and kept current;
//   - SectionAddButton: a section header's "+";
//   - drag (a mouse): dragRow on a row, useDropTarget on a section (a row says its kind in the drag's type, so a
//     section only takes its own kind);
//   - a folded room section's one pill (roomFolderPill): the strongest of its rooms, "@" › how many rooms are unread.
// On screen they are never "folders". They are mine only: nothing here is shown to or sent for anyone else.
import { Plus } from 'lucide-react'
import { useEffect, useState, type DragEvent } from 'react'
import type { NavFolder, NavFolderKind, CountedRoomFields } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { badgeText, roomCounts } from '../../lib/rooms'
import { foldersOf, useNavFolders, watchNavFolders } from '../../store/navFolders'
import { CountPill } from '../CountPill'
import { Tooltip } from '../Tooltip'

/** my folders of one kind, read when first needed and kept current */
export function useFolders(kind: NavFolderKind, on = true): NavFolder[] {
  const all = useNavFolders((s) => s.folders)
  useEffect(() => {
    if (on) watchNavFolders()
  }, [on])
  return foldersOf(all, kind)
}

/** A section header's "+" (the folders' New folder, the Chats list's Create a channel and New message): one size and
 * look for every section action, its words on hover and for screen readers. A finger gets 44px: on a phone from touch-hit,
 * on a touch screen wider than a phone a 44px box that takes only the 24px slot (as list/List.tsx GroupChevron). */
export function SectionAddButton({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  return (
    <Tooltip label={label}>
      <button type="button" aria-label={label} onClick={onClick} className="touch-hit flex size-6 items-center justify-center rounded text-faint hover:bg-hover hover:text-ink md:pointer-coarse:-m-2.5 md:pointer-coarse:size-11" data-testid={testId}>
        <Plus size={14} aria-hidden />
      </button>
    </Tooltip>
  )
}

// Drag a row onto a folder (a mouse; the menu above is the keyboard's and a finger's way). A row says what it carries
// in its drag's type, so a folder knows while the pointer is over it whether it takes it (a project chat carries none).
export const DRAG_TYPE: Record<NavFolderKind, string> = { chats: 'application/x-trina-chat', rooms: 'application/x-trina-room' }

/** Spread on a row that may go in a folder (`can`: false for a project chat or a hidden room). */
export function dragRow(kind: NavFolderKind, id: string, can: boolean) {
  if (!can) return {}
  return {
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(DRAG_TYPE[kind], id)
      e.dataTransfer.effectAllowed = 'copyMove'
    },
  }
}

/** A folder that takes a dragged row of its kind: `over` while one is held over it. */
export function useDropTarget(kind: NavFolderKind, onDrop: (id: string) => void) {
  const [over, setOver] = useState(false)
  const takes = (e: DragEvent) => [...e.dataTransfer.types].includes(DRAG_TYPE[kind])
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!takes(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!over) setOver(true)
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      },
      onDrop: (e: DragEvent) => {
        if (!takes(e)) return
        e.preventDefault()
        setOver(false)
        const id = e.dataTransfer.getData(DRAG_TYPE[kind])
        if (id) onDrop(id)
      },
    },
  }
}
/** how a folder looks while a row is held over it */
export const DROP_OVER = 'rounded-lg bg-accent-soft ring-2 ring-accent ring-inset'

/** A folded room folder's (or 대화 section's) one pill: the strongest of its rooms, "@" (an unread mention) › how many of its rooms
 * count (shared roomCounts, as the 대화 count: muted rooms left out, a room at 멘션만 only with a mention; a followed thread's
 * reply without a mention adds nothing: docs/decisions/20261119-room-unread-after-read.md). */
export type RoomFolderPill = { kind: 'mention' } | { kind: 'unread'; n: number }
export function roomFolderPill(rooms: CountedRoomFields[]): RoomFolderPill | null {
  const loud = rooms.map(roomCounts).filter((c) => c.counts)
  if (loud.some((c) => c.mention)) return { kind: 'mention' }
  return loud.length ? { kind: 'unread', n: loud.length } : null
}

/** A folded room folder's (or 대화 section's) name is bold while one of its rooms is (roomCounts `bold`), muted ones left
 * out: a room at 멘션만 with only plain messages has no pill but still makes it bold, as its row is. */
export const roomFolderBold = (rooms: CountedRoomFields[]): boolean => rooms.some((r) => {
  const c = roomCounts(r)
  return c.bold && !c.quiet
})

/** The pill of a folded room folder or a folded section of the 대화 list (List.tsx ListSection `pill`): the rows' own
 * badge look; its words for a screen reader. */
export function RoomFolderPillView({ pill, className, testId = 'room-folder-pill' }: { pill: RoomFolderPill; className?: string; testId?: string }) {
  const t = useT()
  const words = pill.kind === 'mention' ? t('rooms.mentionedYou') : t('navFolders.unreadRooms', { n: pill.n })
  return <CountPill text={pill.kind === 'mention' ? '@' : badgeText(pill.n)} label={words} className={className} testId={testId} data-kind={pill.kind} />
}
