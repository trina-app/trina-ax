// List folders (docs/DECISIONS.md "List folders"). Owner: B (server/src/chat/nav-folders.ts, registered by
// server/src/routes/nav-folders.ts; migration 289).
//
// A person's own folders for sorting their lists: kind 'chats' holds their own AI chats (the Trina list), kind 'rooms'
// holds rooms, DMs and group chats they are in (the 대화 list). Only the maker sees them: nobody else, owners and admins
// included, can list, name, count or change them, and no response to anyone else carries one. A folder holds no files,
// instructions or permissions and never changes who sees a chat or a room. It never shows something its maker cannot
// open now: a chat in the trash or in a project, a room they left, an archived room or one they hide is not listed and
// not counted (a hidden room comes back to its folder when it shows again). A project chat stays in its project and
// cannot be filed. Deleting a folder only lets its chats and rooms go back to their usual place.
//
// Not to be confused with a person's own files folder ("내 폴더", users/<name>/) or the team drive's folders.
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { NAME_FORBIDDEN, NAME_FORBIDDEN_FIELD } from '../name-chars'
import { endpoint, empty } from './endpoint'
import { Chat } from './entities'
import { Room } from './rooms'

/** Folders per person and kind (409 nav_folders_full). */
export const NAV_FOLDERS_MAX = 30
/** Chats or rooms per folder (409 nav_folder_full). */
export const NAV_FOLDER_ITEMS_MAX = 500
/** A folder name's length in characters as people see them (grapheme clusters), after trimming. */
export const NAV_FOLDER_NAME_MAX = 40
/** How many of a folder's chats come with the list (NavFolder.top), the most recently active first. */
export const NAV_FOLDER_TOP = 3

export const NavFolderKind = z.enum(['chats', 'rooms'])
export type NavFolderKind = z.infer<typeof NavFolderKind>

export const NavFolder = z.object({
  id: Uuid7,
  kind: NavFolderKind,
  name: z.string(),
  /** its place in its list, 0 first */
  position: z.number().int().nonnegative(),
  /** the chats or rooms in it that I can open now (never one I cannot) */
  count: z.number().int().nonnegative(),
  /** kind 'chats': its first NAV_FOLDER_TOP chats, the most recently active first (the rest page through
   * GET /api/chats?folderId=). Kind 'rooms': empty (GET /api/rooms carries every room with its folderId). */
  top: z.array(Chat),
})
export type NavFolder = z.infer<typeof NavFolder>

export const NavFolderList = z.object({ items: z.array(NavFolder) })
export type NavFolderList = z.infer<typeof NavFolderList>

/** ...and a name must show something: at least one letter, number, symbol or punctuation mark */
const NAME_VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u
/** A folder name as the server keeps it: NFC, trimmed. */
export const navFolderName = (s: string): string => s.normalize('NFC').trim()
/** Characters as people see them (grapheme clusters: one emoji or one Hangul syllable is one). */
export function graphemeCount(s: string): number {
  try { return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length } catch { return [...s].length }
}
/** A folder name as typed: after trimming 1–40 characters, none invisible or a control character (../name-chars.ts). */
export const NavFolderName = z.string().max(400)
  .refine((s) => navFolderName(s).length > 0, { message: 'required' })
  .refine((s) => !NAME_FORBIDDEN.test(navFolderName(s)) && NAME_VISIBLE.test(navFolderName(s)), { message: NAME_FORBIDDEN_FIELD })
  .refine((s) => graphemeCount(navFolderName(s)) <= NAV_FOLDER_NAME_MAX, { message: `at most ${NAV_FOLDER_NAME_MAX} characters` })
const FolderName = NavFolderName

export const CreateNavFolderBody = z.strictObject({ kind: NavFolderKind, name: FolderName })
export type CreateNavFolderBody = z.infer<typeof CreateNavFolderBody>
export const UpdateNavFolderBody = z.strictObject({ name: FolderName })
export type UpdateNavFolderBody = z.infer<typeof UpdateNavFolderBody>
/** Any of my folders of that kind, in the order wanted: those come first in this order, the rest follow in their
 * order before; ids that are not my folders of that kind are ignored. */
export const OrderNavFoldersBody = z.strictObject({ kind: NavFolderKind, ids: z.array(Uuid7).max(200) })
export type OrderNavFoldersBody = z.infer<typeof OrderNavFoldersBody>
/** null: out of its folder */
export const SetFolderBody = z.strictObject({ folderId: Uuid7.nullable() })
export type SetFolderBody = z.infer<typeof SetFolderBody>

export const NAV_FOLDERS = {
  listNavFolders: endpoint({ method: 'GET', path: '/api/nav-folders', auth: 'user', owner: 'B', response: NavFolderList,
    summary: 'My own list folders, both kinds, each in its order, with how many chats or rooms in it I can open now and (chat folders) its 3 most recently active chats. Nobody else\'s.' }),
  createNavFolder: endpoint({ method: 'POST', path: '/api/nav-folders', auth: 'user', owner: 'B', status: 201, body: CreateNavFolderBody, response: NavFolder,
    summary: 'A new folder of mine at the end of its list. At most 30 per kind (409 nav_folders_full); a name I already use for that kind (any letter case): 409 nav_folder_name_taken. My other windows hear it (navFolders.changed).' }),
  updateNavFolder: endpoint({ method: 'PATCH', path: '/api/nav-folders/:id', auth: 'user', owner: 'B', body: UpdateNavFolderBody, response: NavFolder,
    summary: 'Rename a folder of mine (404 for anyone else\'s). My other windows hear it (navFolders.changed).' }),
  deleteNavFolder: endpoint({ method: 'DELETE', path: '/api/nav-folders/:id', auth: 'user', owner: 'B', response: empty, status: 204,
    summary: 'Delete a folder of mine (404 for anyone else\'s). Only the folder goes: its chats and rooms go back to their usual place, nothing else changes.' }),
  orderNavFolders: endpoint({ method: 'PUT', path: '/api/nav-folders/order', auth: 'user', owner: 'B', body: OrderNavFoldersBody, response: NavFolderList,
    summary: 'Put my folders of one kind in this order: the ids given first, in that order, then the rest in their order before (ids that are not my folders of that kind are ignored, so two devices never refuse each other). Returns all my folders.' }),
  setChatFolder: endpoint({ method: 'PUT', path: '/api/chats/:id/folder', auth: 'user', owner: 'B', body: SetFolderBody, response: Chat,
    summary: 'Put my own chat in one of my chat folders (moving it from another), or take it out (null). Never a project chat (409 folder_project_chat): it stays in its project. A chat I cannot open, in the trash or the server\'s own draft: 404. A full folder: 409 nav_folder_full.' }),
  setRoomFolder: endpoint({ method: 'PUT', path: '/api/rooms/:id/folder', auth: 'user', owner: 'B', body: SetFolderBody, response: Room,
    summary: 'Put a room I am in in one of my conversation folders (moving it from another), or take it out (null). Nobody else is told. A room I am not in or an archived one: 404; a hidden one: 409 room_hidden (show it first). A full folder: 409 nav_folder_full.' }),
} as const
