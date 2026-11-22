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
// The Trina history has the same sections over my AI chats (kind 'chats', docs/decisions/20261122-trina-history-sections.md):
// every part here takes the kind, through one small adapter per kind (KINDS: what an item's section is now, how it is
// filed, its words), so there is one sections system and one name in both lists (nav/HistorySections.tsx draws them).
import clsx from 'clsx'
import { ArrowDown, ArrowUp, Hash, ListMinus, ListPlus, MoveRight, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useId, useMemo, useState, type ReactNode, type RefObject } from 'react'
import { create } from 'zustand'
import { graphemeCount, NAV_FOLDER_NAME_MAX, NavFolderName, type Chat, type NavFolder, type NavFolderKind, type Room } from '@mycel/shared/api'
import { t, useT, type MessageKey } from '../../i18n'
import { listedRoom } from '../../lib/rooms'
import { chatFolderOf, createFolder, deleteFolder, fileChat, fileRoom, moveFolder, nameTaken, renameFolder, sectionErrorText, useNavFolders } from '../../store/navFolders'
import { useChatGroups } from '../../store/chatGroups'
import { useChats } from '../../store/chats'
import { useRooms } from '../../store/rooms'
import { isUnused } from '../chat/ChatState'
import { toast } from '../../store/ui'
import { Button, confirmDialog, inputCls, Modal, promptDialog } from '../ui'
import { MenuButton, type MenuItem } from '../rooms/MenuButton'
import { RoomIcon, useRoomTitle } from '../rooms/RoomIcon'
import { useMeStrict } from '../../store/session'
import { SectionAddButton, useDropTarget, useFolders } from './NavFolders'

type T = ReturnType<typeof useT>

/** my sections of one list in their order, read when first needed and kept current ('rooms': the Chats list's,
 * 'chats': the Trina history's) */
export const useSections = (kind: NavFolderKind = 'rooms', on = true): NavFolder[] => useFolders(kind, on)

/** a conversation that can go in a section now: one in my list (not hidden) */
export const canSection = (room: Room): boolean => !room.hidden && listedRoom(room)

/** Why an AI chat of my list cannot go in a section, by the server's own rule (server/src/chat/nav-folders.ts
 * setChatFolder): 'side' (a room's side chat: no section items at all), 'shared' (someone else shared it with me by
 * name or group; its creator may file it), 'project' (it is in a project, or shared through one). null: it can. */
export type ChatSectionBlock = 'side' | 'shared' | 'project' | null
export function chatSectionBlock(chat: Pick<Chat, 'sideRoomId' | 'projectId' | 'shared'>, me: string): ChatSectionBlock {
  if (chat.sideRoomId) return 'side'
  if (chat.shared?.kind === 'people' && chat.shared.by.id !== me) return 'shared'
  if (chat.projectId || (chat.shared && chat.shared.kind !== 'people')) return 'project'
  return null
}

/** The words that differ between the lists: "conversations" in Chats, "chats" in the Trina history. */
const WORDS = {
  rooms: { add: 'sidebarSections.add', addTitle: 'sidebarSections.addTitle', addButton: 'sidebarSections.addButton', addNone: 'sidebarSections.addNone', search: 'sidebarSections.search', emptyComputer: 'sidebarSections.emptyComputer', movedMany: 'sidebarSections.movedMany', addFailed: 'sidebarSections.addFailed', deleteBody: 'sidebarSections.deleteBody', deleteBodyNone: 'sidebarSections.deleteBodyNone' },
  chats: { add: 'sidebarSections.chats.add', addTitle: 'sidebarSections.chats.addTitle', addButton: 'sidebarSections.chats.addButton', addNone: 'sidebarSections.chats.addNone', search: 'sidebarSections.chats.search', emptyComputer: 'sidebarSections.chats.emptyComputer', movedMany: 'sidebarSections.chats.movedMany', addFailed: 'sidebarSections.chats.addFailed', deleteBody: 'sidebarSections.chats.deleteBody', deleteBodyNone: 'sidebarSections.chats.deleteBodyNone' },
} as const satisfies Record<NavFolderKind, Record<string, MessageKey>>

/** What one list's items are to its sections: the section an item is in now, how one is filed, whether it is pinned
 * (it stays under Pinned), and how many of mine a section holds (the delete question). */
type Kind = {
  current: (id: string) => string | null
  file: (id: string, to: string | null, o?: { quiet?: boolean }) => Promise<{ ok: boolean; newest?: boolean; error?: unknown }>
  pinned: (id: string) => boolean
  count: (sectionId: string) => number
}
const KINDS: Record<NavFolderKind, Kind> = {
  rooms: {
    current: (id) => useRooms.getState().rooms.find((r) => r.id === id)?.folderId ?? null,
    file: (id, to, o) => fileRoom(id, to, o),
    pinned: (id) => !!useRooms.getState().rooms.find((r) => r.id === id)?.pinnedAt,
    // every conversation of mine in it, pinned ones too (a hidden one is not on this device, so a section that looks
    // empty may still hold one: it is never deleted without a word)
    count: (sid) => useRooms.getState().rooms.filter((r) => r.folderId === sid).length,
  },
  chats: {
    // the chats store's copy, else the Trina list's last read (a chat no page has brought yet)
    current: (id) => chatFolderOf(id),
    file: (id, to, o) => fileChat(id, to, o),
    pinned: (id) => !!(useChats.getState().chats.find((c) => c.id === id)?.pinnedAt ?? useChatGroups.getState().groups?.pinned.some((c) => c.id === id)),
    // the server's count (what I can open in it now, the chats no page has brought too), never less than what is here
    count: (sid) => Math.max(useChatGroups.getState().groups?.folders.find((f) => f.id === sid)?.count ?? 0, useChats.getState().chats.filter((c) => c.folderId === sid && !c.deletedAt).length),
  },
}

function nameCheck(t: T, kind: NavFolderKind, except?: string) {
  return (v: string): string | null => {
    if (!v.trim()) return null
    if (graphemeCount(v.normalize('NFC').trim()) > NAV_FOLDER_NAME_MAX) return t('navFolders.tooLong', { n: NAV_FOLDER_NAME_MAX })
    if (!NavFolderName.safeParse(v).success) return t('navFolders.nameInvalid')
    if (nameTaken(useNavFolders.getState().folders, kind, v, except)) return t('sidebarSections.nameTaken')
    return null
  }
}

/** the live copy of a section of that list (its name may have changed since a menu was drawn) */
const liveSection = (kind: NavFolderKind, id: string): NavFolder | null => useNavFolders.getState().folders?.find((f) => f.id === id && f.kind === kind) ?? null

/** One move a toast can take back: the conversation or chat, the section it went to (null: out) and where it was. */
type Move = { id: string; to: string | null; back: string | null }

/** Undo of a toast's moves. One moved again since (by me, here or in another window) is left where it is now, and one
 * whose section went away stays out of it: the toast never undoes a later change or asks for a section that is gone,
 * and says so in one line instead. */
export async function undoMoves(t: T, moves: Move[], kind: NavFolderKind = 'rooms') {
  const k = KINDS[kind]
  const can = moves.filter((m) => k.current(m.id) === m.to && (!m.back || !!liveSection(kind, m.back)))
  if (can.length < moves.length) toast({ level: 'info', text: t('sidebarSections.undoStale') })
  const done = await Promise.all(can.map((m) => k.file(m.id, m.back, { quiet: true })))
  const failed = done.filter((r) => !r.ok)
  if (failed.length) toast({ level: 'error', text: sectionErrorText(failed[0]!.error, kind) })
}

/** What changes my sections of one list, each with its question; a move says where it went in a toast with Undo. */
export function useSectionActions(kind: NavFolderKind = 'rooms') {
  const t = useT()
  const k = KINDS[kind]
  /** where it went (or that it came out), with Undo back to where it was; a pinned one stays under Pinned, and the
   * toast says so (it shows in its section once unpinned) */
  const said = (id: string, to: NavFolder | null, from: NavFolder | null) => {
    const text = to ? t(k.pinned(id) ? 'sidebarSections.movedPinned' : 'sidebarSections.moved', { name: to.name }) : from ? t('sidebarSections.removed', { name: from.name }) : null
    if (text) toast({ level: 'success', text, action: { label: t('common.undo'), run: () => void undoMoves(t, [{ id, to: to?.id ?? null, back: from?.id ?? null }], kind) } })
  }
  const act = {
    /** "New section": a name, then made; `thenAdd`: Add conversations (or Add chats) opens on it right after (null:
     * cancelled or refused) */
    async create(o: { thenAdd?: boolean } = {}): Promise<NavFolder | null> {
      const name = await promptDialog({ title: t('sidebarSections.new'), body: t('sidebarSections.onlyYou'), label: t('sidebarSections.nameLabel'), confirm: t('sidebarSections.create'), validate: nameCheck(t, kind), maxLength: 200 })
      if (!name?.trim()) return null
      const made = await createFolder(kind, name.trim())
      if (made && o.thenAdd) openAddConversations(made)
      return made
    },
    async rename(f: NavFolder) {
      const name = await promptDialog({ title: t('sidebarSections.rename'), label: t('sidebarSections.nameLabel'), initial: f.name, confirm: t('common.save'), validate: nameCheck(t, kind, f.id), maxLength: 200 })
      if (!name?.trim() || name.trim() === f.name) return
      await renameFolder(f, name.trim())
    },
    /** Always asks first, with how many of mine it holds (KINDS count) */
    async remove(f: NavFolder) {
      const n = k.count(f.id)
      const body = n > 0 ? t(WORDS[kind].deleteBody, { n }) : t(WORDS[kind].deleteBodyNone)
      if (!(await confirmDialog({ title: t('sidebarSections.deleteTitle', { name: f.name }), body, confirm: t('sidebarSections.delete'), danger: true }))) return
      await deleteFolder(f)
    },
    async move(f: NavFolder, by: -1 | 1) {
      await moveFolder(useNavFolders.getState().folders ?? [], f, by).catch(() => {})
    },
    /** one into a section (or out: null); the row moves at once, the toast once the server has it */
    async file(id: string, to: NavFolder | null) {
      const was = k.current(id)
      if ((to?.id ?? null) === was) return
      // a section deleted meanwhile (another window; a menu drawn before): nothing to move into
      if (to && !liveSection(kind, to.id)) return void toast({ level: 'info', text: t('sidebarSections.gone') })
      const from = was ? liveSection(kind, was) : null
      const r = await k.file(id, to?.id ?? null)
      if (r.ok && r.newest) said(id, to, from)
    },
  }
  return act
}

/** A chat moved to a project (or out of one) that was in one of my sections and is not now: a toast says it left it. */
export function leftSectionToast(before: Pick<Chat, 'folderId'>, after: Pick<Chat, 'folderId'>) {
  const was = before.folderId ? liveSection('chats', before.folderId) : null
  if (was && after.folderId !== was.id) toast({ level: 'info', text: t('sidebarSections.chats.left', { name: was.name }) })
}

// ---------------- Add conversations / Add chats ----------------

const useAdding = create<{ section: NavFolder | null }>(() => ({ section: null }))
/** Open Add conversations (a Chats section) or Add chats (a Trina history section) on a section (after New section,
 * from its empty line or its "⋯") */
export const openAddConversations = (section: NavFolder) => useAdding.setState({ section })

/** Mounted once (App.tsx), so Add conversations opens from wherever New section was asked for. */
export function AddConversationsHost() {
  const section = useAdding((s) => s.section)
  if (!section) return null
  const close = () => useAdding.setState({ section: null })
  return section.kind === 'chats' ? <AddChatsDialog key={section.id} section={section} onClose={close} /> : <AddConversationsDialog key={section.id} section={section} onClose={close} />
}

/** Past this many conversations the list gets a search field. */
const SEARCH_FROM = 8

/** one line of the Add list: its id, its words, how it looks, the section it is in now */
type Candidate = { id: string; title: string; icon?: ReactNode; folderId?: string }

/** My conversations not in this section yet, with tick boxes (each says the section it is in now); Add moves the
 * ticked ones in, Skip leaves the section as it is. */
export function AddConversationsDialog({ section, onClose }: { section: NavFolder; onClose: () => void }) {
  const titleOf = useRoomTitle()
  const rooms = useRooms((s) => s.rooms)
  const candidates = useMemo(() => {
    const list = rooms.filter((r) => canSection(r) && r.folderId !== section.id)
    const channel = (r: Room) => r.kind === 'all' || r.kind === 'team' || (r.kind === 'group' && !!r.name)
    // channels first (by name), then direct messages (by name)
    return list
      .map((r) => ({ room: r, title: titleOf(r), channel: channel(r) }))
      .sort((a, b) => Number(b.channel) - Number(a.channel) || a.title.localeCompare(b.title))
      .map(({ room, title }): Candidate => ({ id: room.id, title, icon: <RoomIcon room={room} size={20} faces />, folderId: room.folderId }))
  }, [rooms, section.id, titleOf])
  return <AddDialog kind="rooms" section={section} candidates={candidates} onClose={onClose} />
}

/** My AI chats that can go in a section (chatSectionBlock) and are not in this one, the most recently active first,
 * from the chats my list has loaded (the rest come with "더 보기"). */
export function AddChatsDialog({ section, onClose }: { section: NavFolder; onClose: () => void }) {
  const t = useT()
  const chats = useChats((s) => s.chats)
  const me = useMeStrict().user.id
  const candidates = useMemo(
    () =>
      chats
        .filter((c) => !isUnused(c) && !c.deletedAt && !chatSectionBlock(c, me) && c.folderId !== section.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((c): Candidate => ({ id: c.id, title: c.title || t('chat.untitled'), folderId: c.folderId })),
    [chats, me, section.id, t],
  )
  return <AddDialog kind="chats" section={section} candidates={candidates} onClose={onClose} />
}

function AddDialog({ kind, section, candidates, onClose }: { kind: NavFolderKind; section: NavFolder; candidates: Candidate[]; onClose: () => void }) {
  const t = useT()
  const w = WORDS[kind]
  const k = KINDS[kind]
  const sections = useSections(kind)
  const live = sections.find((f) => f.id === section.id) ?? section
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
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
    const before = new Map(ids.map((id) => [id, k.current(id)]))
    // each one quietly: one line below says what was refused, not a toast each
    const done = await Promise.all(ids.map((id) => k.file(id, section.id, { quiet: true })))
    setBusy(false)
    onClose()
    const moved = ids.filter((_, i) => done[i]!.ok)
    const refused = done.filter((r) => !r.ok)
    if (moved.length)
      toast({
        level: 'success',
        text: t(w.movedMany, { n: moved.length, name: live.name }),
        action: { label: t('common.undo'), run: () => void undoMoves(t, moved.map((id) => ({ id, to: section.id, back: before.get(id) ?? null })), kind) },
      })
    if (refused.length) toast({ level: 'error', text: t(w.addFailed, { n: refused.length, reason: sectionErrorText(refused[0]!.error, kind) }) })
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t(w.addTitle, { name: live.name })}
      footer={
        <>
          <Button onClick={onClose} data-testid="add-conversations-skip">{t('sidebarSections.skip')}</Button>
          <Button variant="primary" busy={busy} disabled={!picked.size} onClick={() => void add()} data-testid="add-conversations-add">
            {picked.size ? t(w.addButton, { n: picked.size }) : t(w.add)}
          </Button>
        </>
      }
    >
      <div data-testid="add-conversations" data-kind={kind}>
        {candidates.length > SEARCH_FROM && (
          <label className="relative mb-3 block">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t(w.search)} aria-label={t(w.search)} className={clsx(inputCls, 'pl-8')} data-testid="add-conversations-search" />
          </label>
        )}
        {!candidates.length && <p className="py-2 text-sm text-muted" data-testid="add-conversations-none">{t(w.addNone)}</p>}
        <ul className="-mx-2">
          {shown.map((c) => {
            const where = nameOf(c.folderId)
            return (
              <li key={c.id}>
                <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-hover max-md:min-h-12" data-testid="add-conversations-row">
                  <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} className="size-4 shrink-0 accent-[var(--c-accent)]" />
                  {c.icon}
                  <span className="min-w-0 flex-1 truncate text-row">{c.title}</span>
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

/** A section's "⋯": Add conversations, Rename, Move up, Move down, Delete section. */
export function SectionMenu({ section, className, buttonClassName }: { section: NavFolder; className?: string; buttonClassName?: string }) {
  const t = useT()
  const act = useSectionActions(section.kind)
  const list = useSections(section.kind)
  const i = list.findIndex((f) => f.id === section.id)
  const items: MenuItem[] = [
    { label: t(WORDS[section.kind].add), icon: <ListPlus size={14} aria-hidden />, onSelect: () => openAddConversations(section), testId: 'section-menu-add' },
    { label: t('sidebarSections.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: () => void act.rename(section), testId: 'section-menu-rename' },
    ...(i > 0 ? [{ label: t('navFolders.moveUp'), icon: <ArrowUp size={14} aria-hidden />, onSelect: () => void act.move(section, -1), testId: 'section-menu-up' }] : []),
    ...(i >= 0 && i < list.length - 1 ? [{ label: t('navFolders.moveDown'), icon: <ArrowDown size={14} aria-hidden />, onSelect: () => void act.move(section, 1), testId: 'section-menu-down' }] : []),
    { label: t('sidebarSections.delete'), icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: () => void act.remove(section), testId: 'section-menu-delete' },
  ]
  return <MenuButton label={t('sidebarSections.menu', { name: section.name })} tip={t('sidebarSections.menu', { name: section.name })} items={items} compact className={className} buttonClassName={buttonClassName} sheetTitle={section.name} testId="section-menu" />
}

/** An empty section's line: how to fill it, and the button that does (a phone has no drag, so its words differ). */
export function SectionEmpty({ section, className }: { section: NavFolder; className?: string }) {
  const t = useT()
  return (
    <div className={clsx('flex flex-col items-start gap-1 px-3 py-1.5', className)} data-testid="section-empty">
      <p className="text-meta text-muted">
        <span className="max-md:hidden pointer-coarse:hidden">{t(WORDS[section.kind].emptyComputer)}</span>
        <span className="md:pointer-fine:hidden">{t('sidebarSections.emptyPhone')}</span>
      </p>
      <button type="button" onClick={() => openAddConversations(section)} className="flex items-center gap-1.5 rounded-md text-meta font-medium text-accent-text hover:underline max-md:min-h-11" data-testid="section-empty-add">
        <ListPlus size={14} aria-hidden />
        {t(WORDS[section.kind].add)}
      </button>
    </div>
  )
}

/** Drop a dragged conversation (or AI chat, kind 'chats') here: into `section`, or out of its section (null: the
 * Channels or Direct messages header; the Trina history's 트리나 기록). `over` while one is held over it. */
export function useSectionDrop(section: NavFolder | null, kind: NavFolderKind = section?.kind ?? 'rooms') {
  const act = useSectionActions(kind)
  return useDropTarget(kind, (id) => {
    if (kind === 'rooms' && !useRooms.getState().rooms.some((r) => r.id === id)) return
    const now = KINDS[kind].current(id)
    if (section ? now === section.id : !now) return
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

// ---------------- a conversation's (or chat's) Move to section ----------------

/** A conversation's or chat's section items for its "⋯" (Move to section; Remove from section when it is in one) and
 * the list they open (`picker`, drawn beside the "⋯"): my sections of that list, the current one ticked, then New
 * section…. `on`: none at all (a hidden conversation, a side chat, a task's folded runs). `blocked`: why it cannot go
 * in one (the server's own reason, chatSectionBlock): the item is shown off, and `footer` says why under the menu.
 * `more`: the "⋯", where the keyboard goes back from the list. */
export function useSectionRowItems(o: { on: boolean; kind?: NavFolderKind; id: string; folderId?: string | null; blocked?: 'shared' | 'project' | null; more: RefObject<HTMLButtonElement | null> }): { items: MenuItem[]; picker: ReactNode; footer?: ReactNode } {
  const t = useT()
  const kind = o.kind ?? 'rooms'
  const footerId = useId()
  const sections = useSections(kind, o.on)
  const act = useSectionActions(kind)
  const [pick, setPick] = useState(0)
  if (!o.on) return { items: [], picker: null }
  if (o.blocked)
    return {
      items: [{ label: t('sidebarSections.moveTo'), icon: <MoveRight size={14} aria-hidden />, onSelect: () => {}, disabled: true, describedBy: footerId, testId: 'row-section-move' }],
      footer: <p id={footerId} className="max-w-56 px-2 pt-1 pb-1.5 text-xs text-muted max-md:px-3 max-md:pb-2" data-testid="row-section-why">{t(o.blocked === 'shared' ? 'sidebarSections.chats.sharedChat' : 'sidebarSections.chats.projectChat')}</p>,
      picker: null,
    }
  const current = sections.find((f) => f.id === o.folderId) ?? null
  const items: MenuItem[] = [
    { label: t('sidebarSections.moveTo'), icon: <MoveRight size={14} aria-hidden />, onSelect: () => setPick((n) => n + 1), testId: 'row-section-move' },
    ...(current ? [{ label: t('sidebarSections.remove'), icon: <ListMinus size={14} aria-hidden />, onSelect: () => void act.file(o.id, null), testId: 'row-section-remove' }] : []),
  ]
  const choices: MenuItem[] = [
    ...sections.map((f) => ({ label: f.name, checked: f.id === current?.id, onSelect: () => void act.file(o.id, f), testId: 'row-section-pick' })),
    {
      label: t('sidebarSections.newFromMove'),
      icon: <ListPlus size={14} aria-hidden />,
      onSelect: async () => {
        const f = await act.create()
        if (f) await act.file(o.id, f)
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
