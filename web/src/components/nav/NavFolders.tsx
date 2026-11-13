// My list folders on screen (docs/DECISIONS.md "List folders on screen", the navigation plan's phase P4b; only while
// the server's `navRail` switch is on). The parts both lists use, the Trina list (panels/TrinaList.tsx, chat folders)
// and 대화's (panels/RoomsByKind.tsx, room folders), on a computer's panel and in the phone's lists alike:
//   - "새 폴더" (NewFolderRow, or the + on the folders' label): a name, then the folder is last in its list;
//   - a folder's "⋯" (FolderMenu): 이름 바꾸기 · 위로 · 아래로 · 폴더 지우기 (a confirm only when something is in it: only the
//     folder goes);
//   - a row's "폴더로 옮기기" / "폴더에서 빼기" (useFolderRowItems): the first opens a second small menu of my folders and
//     "새 폴더 만들어 넣기" where the row's "⋯" is. That is the keyboard's way (and a phone's long press); a mouse may also
//     drag a row onto a folder (dragRow, useDropTarget). A project's chat cannot go in a folder: its item is off and the
//     menu says why under it;
//   - a folded room folder's one pill (roomFolderPill): the strongest of its rooms, "?" › "@" › how many rooms are unread.
// Folders are mine only: nothing here is shown to or sent for anyone else.
import clsx from 'clsx'
import { ArrowDown, ArrowUp, Folder, FolderInput, FolderMinus, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useState, type DragEvent, type ReactNode, type RefObject } from 'react'
import { graphemeCount, NAV_FOLDER_NAME_MAX, NavFolderName, type NavFolder, type NavFolderKind, type Room } from '@mycel/shared/api'
import { errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { roomUnread } from '../../lib/rooms'
import { createFolder, deleteFolder, fileChat, fileRoom, foldersOf, moveFolder, nameTaken, renameFolder, useNavFolders, watchNavFolders } from '../../store/navFolders'
import { toast } from '../../store/ui'
import { confirmDialog, promptDialog } from '../ui'
import { MenuButton, type MenuItem } from '../rooms/MenuButton'
import { panelRow } from '../../components/panels/PanelFrame'

/** my folders of one kind, read when first needed and kept current */
export function useFolders(kind: NavFolderKind, on = true): NavFolder[] {
  const all = useNavFolders((s) => s.folders)
  useEffect(() => {
    if (on) watchNavFolders()
  }, [on])
  return foldersOf(all, kind)
}

type T = ReturnType<typeof useT>

/** The name field's check: 1–40 characters, something visible, not a name I already use for that kind. */
function nameCheck(t: T, kind: NavFolderKind, except?: string) {
  return (v: string): string | null => {
    if (!v.trim()) return null
    if (graphemeCount(v.normalize('NFC').trim()) > NAV_FOLDER_NAME_MAX) return t('navFolders.tooLong', { n: NAV_FOLDER_NAME_MAX })
    if (!NavFolderName.safeParse(v).success) return t('navFolders.nameInvalid')
    if (nameTaken(useNavFolders.getState().folders, kind, v, except)) return t('navFolders.nameTaken')
    return null
  }
}

/** What changes my folders, each with its question and its error said in a toast. */
export function useFolderActions(kind: NavFolderKind) {
  const t = useT()
  const locale = useLocale()
  const fail = (e: unknown) => {
    toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    return null
  }
  return {
    /** "새 폴더": its name, then made (null: cancelled or refused) */
    async create(): Promise<NavFolder | null> {
      const name = await promptDialog({ title: t('navFolders.new'), label: t('navFolders.nameLabel'), confirm: t('navFolders.make'), validate: nameCheck(t, kind), maxLength: 200 })
      if (!name?.trim()) return null
      return createFolder(kind, name.trim()).catch(fail)
    },
    async rename(f: NavFolder) {
      const name = await promptDialog({ title: t('navFolders.rename'), label: t('navFolders.nameLabel'), initial: f.name, confirm: t('common.save'), validate: nameCheck(t, kind, f.id), maxLength: 200 })
      if (!name?.trim() || name.trim() === f.name) return
      await renameFolder(f, name.trim()).catch(fail)
    },
    /** asks first only when something is in it (`count`: what I can see in it now) */
    async remove(f: NavFolder, count: number) {
      if (count > 0 && !(await confirmDialog({ title: t('navFolders.deleteTitle', { name: f.name }), body: t(kind === 'chats' ? 'navFolders.deleteBodyChats' : 'navFolders.deleteBodyRooms'), confirm: t('navFolders.delete'), danger: true }))) return
      await deleteFolder(f).catch(fail)
    },
    async move(f: NavFolder, by: -1 | 1) {
      await moveFolder(useNavFolders.getState().folders ?? [], f, by).catch(fail)
    },
    /** a chat or room into a folder (or out: null), said in a toast (a keyboard or a screen reader hears where it went) */
    async file(id: string, to: NavFolder | null, from?: NavFolder | null) {
      try {
        if (kind === 'chats') await fileChat(id, to?.id ?? null)
        else await fileRoom(id, to?.id ?? null)
      } catch (e) {
        return fail(e)
      }
      if (to) toast({ level: 'success', text: t('navFolders.moved', { name: to.name }) })
      else if (from) toast({ level: 'success', text: t('navFolders.takenOut', { name: from.name }) })
      return true
    },
  }
}

/** "새 폴더" as a quiet row (no folder yet: no label to hold a +). */
export function NewFolderRow({ kind, className }: { kind: NavFolderKind; className?: string }) {
  const t = useT()
  const act = useFolderActions(kind)
  return (
    <button type="button" className={clsx(panelRow, 'h-8 text-muted', className)} onClick={() => void act.create()} data-testid={`${kind}-folder-new`}>
      <FolderPlus size={16} className="text-faint" aria-hidden /> <span className="truncate">{t('navFolders.new')}</span>
    </button>
  )
}

/** The + on the folders' label. */
export function NewFolderButton({ kind }: { kind: NavFolderKind }) {
  const t = useT()
  const act = useFolderActions(kind)
  return (
    <button type="button" aria-label={t('navFolders.new')} title={t('navFolders.new')} onClick={() => void act.create()} className="touch-hit flex size-6 items-center justify-center rounded text-faint hover:bg-hover hover:text-ink" data-testid={`${kind}-folder-new`}>
      <Plus size={14} aria-hidden />
    </button>
  )
}

/** The folders' label's words: "폴더 · 나만 보여요" */
export function FoldersLabelWords() {
  const t = useT()
  return (
    <>
      {t('trinaList.folders')} <span className="font-normal">· {t('trinaList.onlyYou')}</span>
    </>
  )
}
export const FolderIcon = ({ className }: { className?: string }) => <Folder size={12} className={clsx('shrink-0', className)} aria-hidden />

/** A folder's "⋯": rename, up, down, delete. `count`: what I can see in it (a confirm only when it holds something). */
export function FolderMenu({ folder, count, className, buttonClassName }: { folder: NavFolder; count: number; className?: string; buttonClassName?: string }) {
  const t = useT()
  const act = useFolderActions(folder.kind)
  const list = useFolders(folder.kind)
  const i = list.findIndex((f) => f.id === folder.id)
  const items: MenuItem[] = [
    { label: t('navFolders.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: () => void act.rename(folder), testId: 'folder-menu-rename' },
    ...(i > 0 ? [{ label: t('navFolders.moveUp'), icon: <ArrowUp size={14} aria-hidden />, onSelect: () => void act.move(folder, -1), testId: 'folder-menu-up' }] : []),
    ...(i >= 0 && i < list.length - 1 ? [{ label: t('navFolders.moveDown'), icon: <ArrowDown size={14} aria-hidden />, onSelect: () => void act.move(folder, 1), testId: 'folder-menu-down' }] : []),
    { label: t('navFolders.delete'), icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: () => void act.remove(folder, count), testId: 'folder-menu-delete' },
  ]
  return <MenuButton label={t('navFolders.menu', { name: folder.name })} tip={t('navFolders.menu', { name: folder.name })} items={items} compact className={className} buttonClassName={buttonClassName} sheetTitle={folder.name} testId="folder-menu" />
}

/**
 * A row's folder items for its "⋯" (`items`, put among the row's own), the folder picker they open (`picker`, drawn in
 * the row), and the words under the menu when the row cannot go in a folder (`footer`, a project's chat). `blocked`:
 * why it cannot (a project chat); `on`: nothing at all when off (the old navigation); `more`: the row's "⋯", where the keyboard goes back from the picker.
 */
export function useFolderRowItems(o: { on: boolean; kind: NavFolderKind; id: string; folderId?: string | null; blocked?: boolean; more: RefObject<HTMLButtonElement | null> }): { items: MenuItem[]; footer?: ReactNode; picker: ReactNode } {
  const t = useT()
  const footerId = useId()
  const folders = useFolders(o.kind, o.on)
  const act = useFolderActions(o.kind)
  const [pick, setPick] = useState(0)
  const current = folders.find((f) => f.id === o.folderId) ?? null
  if (!o.on) return { items: [], picker: null }
  if (o.blocked)
    return {
      items: [{ label: t('navFolders.moveTo'), icon: <FolderInput size={14} aria-hidden />, onSelect: () => {}, disabled: true, describedBy: footerId, testId: 'row-folder-move' }],
      footer: <p id={footerId} className="max-w-56 px-2 pt-1 pb-1.5 text-xs text-muted max-md:px-3 max-md:pb-2" data-testid="row-folder-why">{t('navFolders.projectStays')}</p>,
      picker: null,
    }
  const items: MenuItem[] = [
    { label: t('navFolders.moveTo'), icon: <FolderInput size={14} aria-hidden />, onSelect: () => setPick((n) => n + 1), testId: 'row-folder-move' },
    ...(current ? [{ label: t('navFolders.takeOut'), icon: <FolderMinus size={14} aria-hidden />, onSelect: () => void act.file(o.id, null, current), testId: 'row-folder-out' }] : []),
  ]
  const choices: MenuItem[] = [
    ...folders.map((f) => ({ label: f.name, icon: <Folder size={14} aria-hidden />, checked: f.id === current?.id, onSelect: () => void (f.id !== current?.id && act.file(o.id, f, current)), testId: 'row-folder-pick' })),
    {
      label: t('navFolders.newAndMove'),
      icon: <FolderPlus size={14} aria-hidden />,
      onSelect: async () => {
        const f = await act.create()
        if (f) await act.file(o.id, f, current)
      },
      testId: 'row-folder-pick-new',
    },
  ]
  const picker = (
    <MenuButton
      label={t('navFolders.moveTo')}
      heading={t('navFolders.moveTo')}
      items={choices}
      openRequest={pick}
      className="absolute right-1.5 bottom-0"
      buttonClassName="hidden!"
      focusBack={() => o.more.current?.focus()}
      testId="row-folder-picker"
    />
  )
  return { items, picker }
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

/** A folded room folder's one pill: the strongest of its rooms, "?" (a room's AI waits on me) › "@" (an unread
 * mention) › how many of its rooms have unread messages. Muted rooms are left out, as the 대화 count leaves them. */
export type RoomFolderPill = { kind: 'ask' } | { kind: 'mention' } | { kind: 'unread'; n: number }
export function roomFolderPill(rooms: Pick<Room, 'aiWaits' | 'mentioned' | 'muted' | 'unreadCount' | 'threadsUnread'>[]): RoomFolderPill | null {
  if (rooms.some((r) => r.aiWaits)) return { kind: 'ask' }
  const loud = rooms.filter((r) => !r.muted && roomUnread(r) > 0)
  if (loud.some((r) => r.mentioned)) return { kind: 'mention' }
  return loud.length ? { kind: 'unread', n: loud.length } : null
}

export function RoomFolderPillView({ pill, className }: { pill: RoomFolderPill; className?: string }) {
  const t = useT()
  const words = pill.kind === 'ask' ? t('rooms.aiWaits') : pill.kind === 'mention' ? t('rooms.mentionedYou') : t('navFolders.unreadRooms', { n: pill.n })
  return (
    <span className={clsx('shrink-0 rounded-full px-1.5 text-micro font-medium', pill.kind === 'ask' ? 'bg-warn font-bold text-canvas' : 'bg-accent text-accent-ink', className)} data-testid="room-folder-pill" data-kind={pill.kind}>
      <span aria-hidden>{pill.kind === 'ask' ? '?' : pill.kind === 'mention' ? '@' : pill.n > 99 ? '99+' : pill.n}</span>
      <span className="sr-only">{words}</span>
    </span>
  )
}
