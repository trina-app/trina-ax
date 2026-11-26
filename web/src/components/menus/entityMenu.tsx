// The one list of what a chat's, a room's or a project's menu may hold, in one order (docs/decisions/20261126-shared-menus.md):
// the title menu at the top of each (an AI chat's name ▾, a room's "···", a project's name) and the "···" of each row
// in a list. Each kind of item has one label, one icon and one place here; a surface only says which kinds it offers
// and what each does (components/chat/ChatTitleMenu.tsx, chat/chatMenuItems.tsx, rooms/RoomMenu.tsx,
// projectActions.tsx useProjectMenuItems, pages/Projects.tsx). So "Copy link" is never 2nd in one menu and 9th in
// another, and "Rename" is never "Edit" on the page and "Rename" on its row.
// Order, in groups: a tool on the conversation (search, the room header's only), keep it in my list (pin, section),
// notifications, the link, its name, where it lives, people and tools, then the ways out (hide, leave, delete: always
// last, leave and delete in the danger style). A phone's sheet still puts the danger items under a line at its end
// (rooms/MenuButton.tsx sheetOrder), which this order already does; a phone room header's "threads with new replies"
// (a status, not an action) stays above the list.
import { Bell, BellOff, Blocks, Eye, EyeOff, FolderInput, FolderPlus, Link2, ListMinus, Lock, LogOut, Monitor, MoveRight, Pencil, Pin, PinOff, Search, Settings, Trash2, UserPlus, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import type { MessageKey } from '../../i18n'
import type { MenuItem } from '../rooms/MenuButton'

/** Every kind, in the order the menus show them. */
export const MENU_ORDER = [
  // 0. a tool on the conversation itself, first where a menu has it (the room header's "이 대화에서 검색", as ⌘F:
  //    docs/decisions/20261120-search-shortcuts-slack.md)
  'search',
  // 1. keep it in my list (a room's and an AI chat's sections, docs/decisions/20261121-personal-sidebar-sections.md and
  //    20261122-trina-history-sections.md)
  'pin',
  'unpin',
  'section',
  'unsection',
  // 2. notifications
  'notify',
  'mute',
  'unmute',
  // 3. its link
  'copyLink',
  'openInApp',
  // 4. its name
  'rename',
  'makePrivate',
  // 5. where it lives
  'move',
  'makeProject',
  'dmProject',
  // 6. people and tools
  'share',
  'members',
  'invite',
  'apps',
  'continuePrivately',
  'settings',
  // 7. the ways out
  'hide',
  'show',
  'leave',
  'delete',
] as const

export type MenuKind = (typeof MENU_ORDER)[number]

/** Leave and delete: the danger style wherever they show. */
const DANGER: ReadonlySet<MenuKind> = new Set<MenuKind>(['leave', 'delete'])

/** One label and one icon per kind. A kind whose words depend on the thing (Move to project / Change project, Leave
 * this chat / Leave project, Delete / Move to trash, the apps count, the 1:1's name) takes its label from the caller. */
const KINDS: Record<MenuKind, { label?: MessageKey; icon: (p: { size: number; 'aria-hidden': true }) => ReactNode }> = {
  pin: { label: 'chat.pin', icon: (p) => <Pin {...p} /> },
  unpin: { label: 'chat.unpin', icon: (p) => <PinOff {...p} /> },
  section: { label: 'sidebarSections.moveTo', icon: (p) => <MoveRight {...p} /> },
  unsection: { label: 'sidebarSections.remove', icon: (p) => <ListMinus {...p} /> },
  notify: { label: 'rooms.menu.notify', icon: (p) => <Bell {...p} /> },
  mute: { label: 'chat.mute', icon: (p) => <BellOff {...p} /> },
  unmute: { label: 'chat.unmute', icon: (p) => <Bell {...p} /> },
  copyLink: { label: 'rooms.menu.copyLink', icon: (p) => <Link2 {...p} /> },
  openInApp: { label: 'auth.openInApp', icon: (p) => <Monitor {...p} /> },
  rename: { label: 'chat.rename', icon: (p) => <Pencil {...p} /> },
  makePrivate: { label: 'rooms.menu.makePrivate', icon: (p) => <Lock {...p} /> },
  move: { icon: (p) => <FolderInput {...p} /> },
  makeProject: { label: 'rooms.makeProject.menu', icon: (p) => <FolderPlus {...p} /> },
  dmProject: { icon: (p) => <FolderPlus {...p} /> },
  share: { label: 'chat.share.menu', icon: (p) => <Users {...p} /> },
  members: { label: 'projects.participants', icon: (p) => <Users {...p} /> },
  invite: { icon: (p) => <UserPlus {...p} /> },
  apps: { icon: (p) => <Blocks {...p} /> },
  search: { label: 'rooms.menu.search', icon: (p) => <Search {...p} /> },
  continuePrivately: { label: 'chat.continuePrivately', icon: (p) => <Lock {...p} /> },
  settings: { label: 'projects.settings', icon: (p) => <Settings {...p} /> },
  hide: { label: 'chat.hide', icon: (p) => <EyeOff {...p} /> },
  show: { label: 'rooms.menu.show', icon: (p) => <Eye {...p} /> },
  leave: { icon: (p) => <LogOut {...p} /> },
  delete: { label: 'common.delete', icon: (p) => <Trash2 {...p} /> },
}

/** An item of a chat's, room's or project's menu: its kind and what it does. */
export type EntityItem = MenuItem & { kind: MenuKind; testId: string }

type T = (key: MessageKey, params?: Record<string, string | number>) => string

/** One item of `kind`: the list's label, icon and style, the caller's action and test id. `label` only where the kind
 * takes the caller's words (see KINDS). */
export function menuItem(t: T, kind: MenuKind, o: { onSelect: () => void; testId: string; label?: string } & Pick<MenuItem, 'hint' | 'disabled' | 'keys' | 'describedBy'>): EntityItem {
  const k = KINDS[kind]
  // (a kind without words of its own and none given: its name, which test/unit/shared-menus.test.tsx catches)
  const label = o.label ?? (k.label ? t(k.label) : kind)
  return { ...o, kind, label, icon: k.icon({ size: 14, 'aria-hidden': true }), ...(DANGER.has(kind) ? { danger: true } : {}) }
}

/** The menu in the one order (a stable sort: two items of a kind keep the caller's order). */
export function orderMenu(items: EntityItem[]): EntityItem[] {
  const at = (k: MenuKind) => MENU_ORDER.indexOf(k)
  return items.map((it, i) => ({ it, i })).sort((a, b) => at(a.it.kind) - at(b.it.kind) || a.i - b.i).map((x) => x.it)
}
