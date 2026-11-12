// The phone's screens (below 768 px): one table for every address of the app, saying which tab's stack it starts, the
// screen one level up (its parent), what makes two addresses the same screen, and its name for a ‹ label. The phone's
// history (lib/screenHistory.ts) keeps each tab's stack as the screen hierarchy with it: Back goes to the parent, an
// address opened from outside gets its parents put under it, and a folder in Files always has the folder above it under
// it. docs/DECISIONS.md "Phone navigation: four tabs" (the tabs, lib/tabs.ts), "Admin and Settings on phones: a list you
// tap into" (lib/backStack.ts).
//
// Parents: a page under a tab's ☰ or list → that tab's root (트리나 /, 대화 /rooms, 파일 /files, 나 /settings); one project →
// /projects; one chat → its project when this window knows it, else /; a room's thread → the room; a folder → the folder
// above it, a file → its folder; a Settings section → /settings (the account deletion page → the profile); Activity and
// Admin → /settings; an Admin page → /admin; a group of Team settings → /admin/settings; a connector → /connectors.
import { parsePath } from 'react-router-dom'
import { useCallback } from 'react'
import { useT, type MessageKey } from '../i18n'
import { settingsPageName } from '../pages/settingsTabs'
import { useChats } from '../store/chats'
import { useProjects } from '../store/projects'
import { useRooms } from '../store/rooms'
import { useRoomTitle } from '../components/rooms/RoomIcon'
import { useFolderName } from './folderLabels'
import { aiName, TAB_ROOT, type Tab } from './tabs'

export interface Screen {
  /** the tab whose stack the address starts when it is opened from outside (null: none, e.g. the sign-in pages) */
  tab: Tab | null
  /** the address one level up (null: a tab's root, or no parent) */
  parent: string | null
  /** what makes two addresses the same screen (two Files addresses of one folder are one screen, whatever else their
   * query says: the Trash view, a row picked out, a panel to open) */
  id: string
  /** Files' folders and files: a tree, where Back is always the folder above */
  tree?: boolean
}

const q = (search: string) => new URLSearchParams(search)
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const folder = (p: string) => (p ? `/files?path=${encodeURIComponent(p)}` : '/files')

/** The pieces of an address ("/files?path=a#x" → pathname, search, hash). */
function split(to: string) {
  const p = parsePath(to)
  return { pathname: p.pathname || '/', search: p.search ?? '' }
}

/** A chat's project as this window knows it (the chats list), else null. */
function chatProject(id: string): string | null {
  try {
    const c = useChats.getState().chats.find((x) => x.id === id)
    return c?.projectId ?? null
  } catch {
    return null
  }
}

export function screenOf(to: string): Screen {
  const { pathname, search } = split(to)
  const exact = `${pathname}${search}`
  const seg = pathname.split('/').filter(Boolean)
  const [a, b, c, d] = seg
  const s = (tab: Tab | null, parent: string | null, id = exact): Screen => ({ tab, parent, id })
  if (pathname === '/') {
    const project = q(search).get('project')
    // a project's new chat is reached from the project; Home with ?prompt= (from a file's menu) is Home
    return s('ai', project ? `/projects/${encodeURIComponent(project)}` : null, project ? `/?project=${project}` : '/')
  }
  switch (a) {
    case 'c': {
      const project = b ? chatProject(b) : null
      return s('ai', project ? `/projects/${project}` : '/', pathname)
    }
    case 'projects':
      return b ? s('ai', '/projects', pathname) : s('ai', '/', pathname)
    case 'scheduled':
      return b ? s('ai', '/scheduled', pathname) : s('ai', '/')
    case 'skills':
      // the ready-made skills unfolded (?catalog=open) are the same page
      return b === 'share' && c ? s('ai', '/skills') : s('ai', '/', '/skills')
    case 'trash':
      return s('ai', '/')
    case 'connectors':
      if (b === 'authorize') return s(null, null)
      if (b === 'mcp' && c) return s('ai', '/connectors')
      return b ? s('ai', '/connectors') : s('ai', '/')
    case 'rooms':
      // a room or a thread with a message picked out (?m=) is the same screen
      if (b && c === 't' && d) return s('chats', `/rooms/${b}`, pathname)
      return b ? s('chats', '/rooms', pathname) : s('chats', null)
    case 'files': {
      const path = q(search).get('path') ?? ''
      if (b === 'view') return { tab: 'files', parent: folder(dirOf(path)), id: `file:${path}`, tree: true }
      if (b) return s('files', null)
      // the Trash view and a picked-out row are this folder still
      return { tab: 'files', parent: path ? folder(dirOf(path)) : null, id: `folder:${path}`, tree: true }
    }
    case 'settings':
      // a page under a section (the account deletion request is under the profile; 보안 › 비밀번호, 보안 › 기기 under 보안)
      if (b === 'account' && c === 'delete') return s('me', '/settings/profile')
      if (c) return s('me', `/${seg.slice(0, -1).join('/')}`)
      return b ? s('me', '/settings') : s('me', null)
    case 'activity':
      return s('me', '/settings')
    case 'admin':
      if (b === 'settings' && c) return s('me', '/admin/settings')
      return b ? s('me', '/admin') : s('me', '/settings')
    default:
      return s(null, null)
  }
}

/** The parent of an address (see the top of this file), or null. */
export const parentOf = (to: string) => screenOf(to).parent

/** The addresses from the top of its tree down to `to`, `to` last ("/files?path=a/b" → /files, /files?path=a, itself). */
export function chainOf(to: string): string[] {
  const out = [to]
  for (let p = parentOf(to); p && out.length < 64; p = parentOf(p)) out.unshift(p)
  return out
}

/** Are two addresses one screen? */
export const sameScreen = (x: string, y: string) => screenOf(x).id === screenOf(y).id

/** The tab whose root an address is (its own list: /, /rooms, /files, /settings), else null. */
export function rootTab(to: string): Tab | null {
  const sc = screenOf(to)
  return sc.tab && sc.parent === null && sameScreen(TAB_ROOT[sc.tab], to) ? sc.tab : null
}

const TITLES: [RegExp, MessageKey][] = [
  [/^\/projects$/, 'projects.title'],
  [/^\/scheduled(\/|$)/, 'settings.schedules'],
  [/^\/skills(\/|$)/, 'skills.title'],
  [/^\/connectors(\/|$)/, 'integrations.title'],
  [/^\/trash$/, 'trash.title'],
  [/^\/admin$/, 'admin.title'],
  [/^\/rooms$/, 'tabs.chats'],
]

/**
 * The name of a screen for a ‹ label ("‹ 설정", "‹ 회사", "‹ 프로젝트 이름"), or null when it has none here (an Admin page:
 * Admin names its own, pages/admin/AdminLayout.tsx). Settings' come from pages/settingsTabs.ts.
 */
export function useScreenName(): (to: string) => string | null {
  const t = useT()
  const roomName = useRoomTitle()
  const folderName = useFolderName()
  // the stores as they are when the label is drawn (no new drawing of the page for every chat or room update)
  return useCallback((to: string) => {
    const projects = useProjects.getState().byId
    const chats = useChats.getState().chats
    const rooms = useRooms.getState().rooms
    const { pathname, search } = split(to)
    const seg = pathname.split('/').filter(Boolean)
    if (pathname === '/') {
      const project = q(search).get('project')
      return project ? (projects[project]?.name ?? t('projects.title')) : aiName(t)
    }
    if (seg[0] === 'c' && seg[1]) {
      const chat = chats.find((x) => x.id === seg[1])
      return chat ? chat.title || t('chat.untitled') : aiName(t)
    }
    if (seg[0] === 'projects' && seg[1]) return projects[seg[1]]?.name ?? t('projects.title')
    if (seg[0] === 'rooms' && seg[1]) {
      const room = rooms.find((x) => x.id === seg[1])
      return room ? roomName(room) : t('tabs.chats')
    }
    if (seg[0] === 'files') {
      const path = q(search).get('path') ?? ''
      if (seg[1] === 'view') return path.slice(path.lastIndexOf('/') + 1) || null
      if (q(search).get('view') === 'trash') return t('files.trash')
      return path ? folderName(path) : t('tabs.files')
    }
    const settings = settingsPageName(pathname, t)
    if (settings) return settings
    const key = TITLES.find(([re]) => re.test(pathname))?.[1]
    return key ? t(key) : null
  }, [t, roomName, folderName])
}
