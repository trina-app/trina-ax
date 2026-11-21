// My sidebar sections (docs/decisions/20261121-personal-sidebar-sections.md): each person sorts their own Chats list
// into sections, as Slack's sidebar sections. Under the hood a section is one of my list folders of kind 'rooms'
// (store/navFolders.ts, shared/src/api/nav-folders.ts): mine only, nobody else sees, lists or counts it, and it never
// changes who is in a conversation. Channels, DMs and group DMs all go in. On screen it is never a "folder":
//   - New section: the Channels header's "+" menu (useSectionActions().create, then Add conversations), and "New
//     section…" at the end of every Move to section list;
//   - Add conversations (AddConversationsDialog): tick boxes of my conversations, right after New section and from a
//     section's "⋯";
//   - a conversation's Move to section / Remove from section (useSectionRowItems), second in its row "⋯", its phone
//     long-press sheet and its header "⋯";
//   - drag (a mouse): a row onto a section moves it in; onto the Channels or Direct messages header takes it out
//     (useSectionDrop, NavFolders.tsx dragRow / useDropTarget);
//   - a section's "⋯" (SectionMenu): Add conversations · Rename · Move up · Move down · Delete section;
//   - an empty section says how to fill it, with a button (SectionEmpty).
// Every move says where it went in a toast with Undo.
import clsx from 'clsx'
import { ArrowDown, ArrowUp, Hash, ListMinus, ListPlus, MoveRight, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode, type RefObject } from 'react'
import { create } from 'zustand'
import { graphemeCount, NAV_FOLDER_NAME_MAX, NavFolderName, type NavFolder, type Room } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { listedRoom } from '../../lib/rooms'
import { createFolder, deleteFolder, fileRoom, moveFolder, nameTaken, renameFolder, useNavFolders } from '../../store/navFolders'
import { useRooms } from '../../store/rooms'
import { toast } from '../../store/ui'
import { Button, confirmDialog, inputCls, Modal, promptDialog } from '../ui'
import { MenuButton, type MenuItem } from '../rooms/MenuButton'
import { RoomIcon, useRoomTitle } from '../rooms/RoomIcon'
import { SectionAddButton, useDropTarget, useFolders } from './NavFolders'

type T = ReturnType<typeof useT>

/** my sections in their order, read when first needed and kept current */
export const useSections = (on = true): NavFolder[] => useFolders('rooms', on)

/** a conversation that can go in a section now: one in my list (not hidden) */
export const canSection = (room: Room): boolean => !room.hidden && listedRoom(room)

function nameCheck(t: T, except?: string) {
  return (v: string): string | null => {
    if (!v.trim()) return null
    if (graphemeCount(v.normalize('NFC').trim()) > NAV_FOLDER_NAME_MAX) return t('navFolders.tooLong', { n: NAV_FOLDER_NAME_MAX })
    if (!NavFolderName.safeParse(v).success) return t('navFolders.nameInvalid')
    if (nameTaken(useNavFolders.getState().folders, 'rooms', v, except)) return t('sidebarSections.nameTaken')
    return null
  }
}

/** the live copy of a section (its name may have changed since a menu was drawn) */
const liveSection = (id: string): NavFolder | null => useNavFolders.getState().folders?.find((f) => f.id === id) ?? null

/** What changes my sections, each with its question; a move says where it went in a toast with Undo. */
export function useSectionActions() {
  const t = useT()
  /** where a conversation went (or that it came out), with Undo back to where it was */
  const said = (roomId: string, to: NavFolder | null, from: NavFolder | null) => {
    const text = to ? t('sidebarSections.moved', { name: to.name }) : from ? t('sidebarSections.removed', { name: from.name }) : null
    if (text) toast({ level: 'success', text, action: { label: t('common.undo'), run: () => void fileRoom(roomId, from?.id ?? null) } })
  }
  const act = {
    /** "New section": a name, then made; `thenAdd`: Add conversations opens on it right after (null: cancelled or refused) */
    async create(o: { thenAdd?: boolean } = {}): Promise<NavFolder | null> {
      const name = await promptDialog({ title: t('sidebarSections.new'), body: t('sidebarSections.onlyYou'), label: t('sidebarSections.nameLabel'), confirm: t('sidebarSections.create'), validate: nameCheck(t), maxLength: 200 })
      if (!name?.trim()) return null
      const made = await createFolder('rooms', name.trim())
      if (made && o.thenAdd) openAddConversations(made)
      return made
    },
    async rename(f: NavFolder) {
      const name = await promptDialog({ title: t('sidebarSections.rename'), label: t('sidebarSections.nameLabel'), initial: f.name, confirm: t('common.save'), validate: nameCheck(t, f.id), maxLength: 200 })
      if (!name?.trim() || name.trim() === f.name) return
      await renameFolder(f, name.trim())
    },
    /** asks first only when something is in it (`count`: what I see in it now) */
    async remove(f: NavFolder, count: number) {
      if (count > 0 && !(await confirmDialog({ title: t('sidebarSections.deleteTitle', { name: f.name }), body: t('sidebarSections.deleteBody', { n: count }), confirm: t('sidebarSections.delete'), danger: true }))) return
      await deleteFolder(f)
    },
    async move(f: NavFolder, by: -1 | 1) {
      await moveFolder(useNavFolders.getState().folders ?? [], f, by).catch(() => {})
    },
    /** a conversation into a section (or out: null); the row moves at once, the toast once the server has it */
    async file(roomId: string, to: NavFolder | null) {
      const was = useRooms.getState().rooms.find((r) => r.id === roomId)?.folderId ?? null
      if ((to?.id ?? null) === was) return
      const from = was ? liveSection(was) : null
      const r = await fileRoom(roomId, to?.id ?? null)
      if (r.ok && r.newest) said(roomId, to, from)
    },
  }
  return act
}

// ---------------- Add conversations ----------------

const useAdding = create<{ section: NavFolder | null }>(() => ({ section: null }))
/** Open Add conversations on a section (after New section, or from its "⋯") */
export const openAddConversations = (section: NavFolder) => useAdding.setState({ section })

/** Mounted once (App.tsx), so Add conversations opens from wherever New section was asked for. */
export function AddConversationsHost() {
  const section = useAdding((s) => s.section)
  if (!section) return null
  return <AddConversationsDialog key={section.id} section={section} onClose={() => useAdding.setState({ section: null })} />
}

/** Past this many conversations the list gets a search field. */
const SEARCH_FROM = 8

/** My conversations not in this section yet, with tick boxes (each says the section it is in now); Add moves the
 * ticked ones in, Skip leaves the section as it is. */
export function AddConversationsDialog({ section, onClose }: { section: NavFolder; onClose: () => void }) {
  const t = useT()
  const titleOf = useRoomTitle()
  const rooms = useRooms((s) => s.rooms)
  const sections = useSections()
  const live = sections.find((f) => f.id === section.id) ?? section
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const candidates = useMemo(() => {
    const list = rooms.filter((r) => canSection(r) && r.folderId !== section.id)
    const channel = (r: Room) => r.kind === 'all' || r.kind === 'team' || (r.kind === 'group' && !!r.name)
    // channels first (by name), then direct messages (by name)
    return list.map((r) => ({ room: r, title: titleOf(r), channel: channel(r) })).sort((a, b) => Number(b.channel) - Number(a.channel) || a.title.localeCompare(b.title))
  }, [rooms, section.id, titleOf])
  const needle = q.trim().toLocaleLowerCase()
  const shown = needle ? candidates.filter((c) => c.title.toLocaleLowerCase().includes(needle)) : candidates
  const nameOf = (id?: string) => (id ? sections.find((f) => f.id === id)?.name : undefined)
  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })
  const add = async () => {
    const ids = [...picked]
    if (!ids.length) return onClose()
    setBusy(true)
    const before = new Map(ids.map((id) => [id, rooms.find((r) => r.id === id)?.folderId ?? null]))
    const done = await Promise.all(ids.map((id) => fileRoom(id, section.id)))
    setBusy(false)
    onClose()
    const moved = ids.filter((_, i) => done[i]!.ok)
    if (moved.length)
      toast({
        level: 'success',
        text: t('sidebarSections.movedMany', { n: moved.length, name: live.name }),
        action: { label: t('common.undo'), run: () => void Promise.all(moved.map((id) => fileRoom(id, before.get(id) ?? null))) },
      })
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('sidebarSections.addTitle', { name: live.name })}
      footer={
        <>
          <Button onClick={onClose} data-testid="add-conversations-skip">{t('sidebarSections.skip')}</Button>
          <Button variant="primary" busy={busy} disabled={!picked.size} onClick={() => void add()} data-testid="add-conversations-add">
            {picked.size ? t('sidebarSections.addButton', { n: picked.size }) : t('sidebarSections.add')}
          </Button>
        </>
      }
    >
      <div data-testid="add-conversations">
        {candidates.length > SEARCH_FROM && (
          <label className="relative mb-3 block">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('sidebarSections.search')} aria-label={t('sidebarSections.search')} className={clsx(inputCls, 'pl-8')} data-testid="add-conversations-search" />
          </label>
        )}
        {!candidates.length && <p className="py-2 text-sm text-muted" data-testid="add-conversations-none">{t('sidebarSections.addNone')}</p>}
        <ul className="-mx-2">
          {shown.map(({ room, title }) => {
            const where = nameOf(room.folderId)
            return (
              <li key={room.id}>
                <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-hover max-md:min-h-12" data-testid="add-conversations-row">
                  <input type="checkbox" checked={picked.has(room.id)} onChange={() => toggle(room.id)} className="size-4 shrink-0 accent-[var(--c-accent)]" />
                  <RoomIcon room={room} size={20} faces />
                  <span className="min-w-0 flex-1 truncate text-row">{title}</span>
                  {where && <span className="shrink-0 truncate text-meta text-faint">{t('sidebarSections.inOther', { name: where })}</span>}
                </label>
              </li>
            )
          })}
        </ul>
      </div>
    </Modal>
  )
}

// ---------------- a section's header ----------------

/** A section's "⋯": Add conversations, Rename, Move up, Move down, Delete section. `count`: what I see in it. */
export function SectionMenu({ section, count, className, buttonClassName }: { section: NavFolder; count: number; className?: string; buttonClassName?: string }) {
  const t = useT()
  const act = useSectionActions()
  const list = useSections()
  const i = list.findIndex((f) => f.id === section.id)
  const items: MenuItem[] = [
    { label: t('sidebarSections.add'), icon: <ListPlus size={14} aria-hidden />, onSelect: () => openAddConversations(section), testId: 'section-menu-add' },
    { label: t('sidebarSections.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: () => void act.rename(section), testId: 'section-menu-rename' },
    ...(i > 0 ? [{ label: t('navFolders.moveUp'), icon: <ArrowUp size={14} aria-hidden />, onSelect: () => void act.move(section, -1), testId: 'section-menu-up' }] : []),
    ...(i >= 0 && i < list.length - 1 ? [{ label: t('navFolders.moveDown'), icon: <ArrowDown size={14} aria-hidden />, onSelect: () => void act.move(section, 1), testId: 'section-menu-down' }] : []),
    { label: t('sidebarSections.delete'), icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: () => void act.remove(section, count), testId: 'section-menu-delete' },
  ]
  return <MenuButton label={t('sidebarSections.menu', { name: section.name })} tip={t('sidebarSections.menu', { name: section.name })} items={items} compact className={className} buttonClassName={buttonClassName} sheetTitle={section.name} testId="section-menu" />
}

/** An empty section's line: how to fill it, and the button that does (a phone has no drag, so its words differ). */
export function SectionEmpty({ section, className }: { section: NavFolder; className?: string }) {
  const t = useT()
  return (
    <div className={clsx('flex flex-col items-start gap-1 px-3 py-1.5', className)} data-testid="section-empty">
      <p className="text-meta text-muted">
        <span className="max-md:hidden pointer-coarse:hidden">{t('sidebarSections.emptyComputer')}</span>
        <span className="md:pointer-fine:hidden">{t('sidebarSections.emptyPhone')}</span>
      </p>
      <button type="button" onClick={() => openAddConversations(section)} className="flex items-center gap-1.5 rounded-md text-meta font-medium text-accent-text hover:underline max-md:min-h-11" data-testid="section-empty-add">
        <ListPlus size={14} aria-hidden />
        {t('sidebarSections.add')}
      </button>
    </div>
  )
}

/** Drop a dragged conversation here: into `section`, or out of its section (null: the Channels or Direct messages
 * header). `over` while one is held over it. */
export function useSectionDrop(section: NavFolder | null) {
  const act = useSectionActions()
  return useDropTarget('rooms', (id) => {
    const room = useRooms.getState().rooms.find((r) => r.id === id)
    if (!room) return
    if (section ? room.folderId === section.id : !room.folderId) return
    void act.file(id, section)
  })
}

// ---------------- the Channels header's "+" ----------------

/** The Channels header's "+": a small menu, Create a channel and New section (then Add conversations). A guest, who
 * makes no channel, gets a "+" that is New section itself. */
export function ChannelsAddMenu({ canMakeChannel, onNewChannel }: { canMakeChannel: boolean; onNewChannel: () => void }) {
  const t = useT()
  const act = useSectionActions()
  const look = 'touch-hit flex size-6 items-center justify-center rounded text-faint hover:bg-hover hover:text-ink md:pointer-coarse:-m-2.5 md:pointer-coarse:size-11'
  const newSection = () => void act.create({ thenAdd: true })
  if (!canMakeChannel) return <SectionAddButton label={t('sidebarSections.new')} onClick={newSection} testId="rooms-new-section" />
  const items: MenuItem[] = [
    { label: t('rooms.section.newChannel'), icon: <Hash size={14} aria-hidden />, onSelect: onNewChannel, testId: 'rooms-new-channel' },
    { label: t('sidebarSections.new'), icon: <ListPlus size={14} aria-hidden />, onSelect: newSection, testId: 'rooms-new-section' },
  ]
  return <MenuButton label={t('sidebarSections.addMenu')} tip={t('sidebarSections.addMenu')} items={items} bare icon={<Plus size={14} aria-hidden />} buttonClassName={look} testId="rooms-channels-add" />
}

// ---------------- a conversation's Move to section ----------------

/** A conversation's section items for its "⋯" (Move to section; Remove from section when it is in one) and the list
 * they open (`picker`, drawn beside the "⋯"): my sections, the current one ticked, then New section…. `on`: none at all
 * (a hidden conversation, a side chat). `more`: the "⋯", where the keyboard goes back from the list. */
export function useSectionRowItems(o: { on: boolean; room: Room; more: RefObject<HTMLButtonElement | null> }): { items: MenuItem[]; picker: ReactNode } {
  const t = useT()
  const sections = useSections(o.on)
  const act = useSectionActions()
  const [pick, setPick] = useState(0)
  if (!o.on) return { items: [], picker: null }
  const current = sections.find((f) => f.id === o.room.folderId) ?? null
  const items: MenuItem[] = [
    { label: t('sidebarSections.moveTo'), icon: <MoveRight size={14} aria-hidden />, onSelect: () => setPick((n) => n + 1), testId: 'row-section-move' },
    ...(current ? [{ label: t('sidebarSections.remove'), icon: <ListMinus size={14} aria-hidden />, onSelect: () => void act.file(o.room.id, null), testId: 'row-section-remove' }] : []),
  ]
  const choices: MenuItem[] = [
    ...sections.map((f) => ({ label: f.name, checked: f.id === current?.id, onSelect: () => void act.file(o.room.id, f), testId: 'row-section-pick' })),
    {
      label: t('sidebarSections.newFromMove'),
      icon: <ListPlus size={14} aria-hidden />,
      onSelect: async () => {
        const f = await act.create()
        if (f) await act.file(o.room.id, f)
      },
      testId: 'row-section-pick-new',
    },
  ]
  const picker = pick > 0 && (
    <MenuButton
      label={t('sidebarSections.moveTo')}
      heading={t('sidebarSections.heading')}
      items={choices}
      openRequest={pick}
      className="absolute right-1.5 bottom-0"
      buttonClassName="hidden!"
      focusBack={() => o.more.current?.focus()}
      testId="row-section-picker"
    />
  )
  return { items, picker }
}
