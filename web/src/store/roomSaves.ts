// Where a room's files are in the team folder, for this viewer (GET /api/rooms/:id/saved-files; docs/decisions/
// 20261117-room-file-save-btn.md): read once per room per page load, the first time one of its file chips shows, and
// added to when this person saves. Someone else's save shows on the next load (no live update). Never for a guest: the
// server refuses them, so nothing is asked.
import { create } from 'zustand'
import { isProjectPlainName } from '@mycel/shared'
import type { Locale, Room } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { needsSheet, oneClickIds, oneClickOk, undoableCopies } from '../lib/roomSave'
import { useRooms } from './rooms'
import { toast } from './ui'
import { useSession } from './session'

interface RoomSavesState {
  /** room id → file id → team path */
  byRoom: Record<string, Record<string, string> | undefined>
  /** the save sheet: the room and the message's files, with the one tapped first */
  sheet: { roomId: string; fileIds: string[]; key: number; folder?: string } | null
  load: (roomId: string) => void
  put: (roomId: string, saved: { fileId: string; path: string }[]) => void
  /** `folder`: picked already (a linked channel's project folder, for files that need the sheet) */
  open: (roomId: string, fileIds: string[], folder?: string) => void
  close: () => void
}

const asked = new Set<string>()
/** counts resets: a saved list asked before one is not kept */
let resets = 0

export const useRoomSaves = create<RoomSavesState>((set) => ({
  byRoom: {},
  sheet: null,
  load(roomId) {
    if (asked.has(roomId)) return
    asked.add(roomId)
    const era = resets
    api.call(API.roomSavedFiles, { params: { id: roomId } }).then(
      // a reply that started before someone else signed in is the last person's: dropped
      (r) => era === resets && set((s) => ({ byRoom: { ...s.byRoom, [roomId]: { ...s.byRoom[roomId], ...Object.fromEntries(r.items.map((i) => [i.fileId, i.path])) } } })),
      // not known: the chips offer the save, which finds the file there (the same bytes count as saved); asked again on
      // the next page load, not by every chip
      () => undefined,
    )
  },
  put(roomId, saved) {
    set((s) => ({ byRoom: { ...s.byRoom, [roomId]: { ...s.byRoom[roomId], ...Object.fromEntries(saved.map((i) => [i.fileId, i.path])) } } }))
  },
  open(roomId, fileIds, folder) {
    set((s) => ({ sheet: { roomId, fileIds, key: (s.sheet?.key ?? 0) + 1, ...(folder ? { folder } : {}) } }))
  },
  close() {
    set({ sheet: null })
  },
}))

/** for tests: forget what was asked */
export function resetRoomSaves() {
  resets++
  asked.clear()
  useRoomSaves.setState({ byRoom: {}, sheet: null })
}

// another person signed in on this tab (signing out does not reload the page): nothing of the last one's is kept
let who: string | null = null
useSession.subscribe((st) => {
  const id = st.status.kind === 'signed-in' ? st.status.me?.user?.id ?? null : null
  if (id === who) return
  who = id
  resetRoomSaves()
})

// ---------------- Save to project (docs/decisions/20261119-channel-project-link.md D6) ----------------
/** How long the toast's Undo lasts: the toast's life. */
export const UNDO_MS = 10_000
type SaveWords = { t: (key: string, params?: Record<string, string | number>) => string; locale: Locale; open: (path: string) => void }

/**
 * Save to project, one click: the message's files go to the root of the linked project's folder when every one is a
 * document or media kind and none looks personal (the plan says), else the sheet opens with the project's folder
 * picked (and when the server says needs_sheet). The toast says where, how many people outside the channel can open
 * it, Open and Undo. Undo puts the copies this save made in the trash, each only while its bytes are what was saved.
 * A 404 (the link or the folder gone meanwhile): the room is read again, so the button goes.
 */
export async function saveToProject(roomId: string, project: NonNullable<Room['project']>, fileIds: string[], w: SaveWords): Promise<void> {
  const t = w.t
  const sheet = () => useRoomSaves.getState().open(roomId, fileIds, project.folderPath)
  try {
    const plan = await api.call(API.roomSavePlan, { params: { id: roomId }, body: { fileIds, folder: project.folderPath } })
    if (!oneClickOk(plan, isProjectPlainName)) {
      // every file there already: nothing to save, open it
      if (plan.files.length && plan.files.every((f) => f.savedPath)) { w.open(plan.files[0]!.savedPath!); return }
      sheet()
      return
    }
    const r = await api.call(API.saveRoomFilesToTeam, { params: { id: roomId }, body: { fileIds: oneClickIds(plan), folder: project.folderPath, oneClick: true } })
    useRoomSaves.getState().put(roomId, r.saved)
    // Undo takes back only the copies this save made (the server checks them against the room file's own bytes)
    const made = undoableCopies(r.saved)
    const outside = plan.folder?.outside ?? 0
    const first = r.saved[0]?.path
    toast({
      level: 'success',
      text: t('rooms.save.savedProject', { project: project.name }),
      ...(outside > 0 ? { detail: t('rooms.save.savedProjectOutside', { n: outside }) } : {}),
      ms: UNDO_MS,
      ...(first ? { more: { label: t('rooms.save.openSaved'), run: () => w.open(first) } } : {}),
      ...(made.length ? { action: { label: t('rooms.save.undo'), run: () => void undoSave(roomId, project, made, w) } } : {}),
    })
  } catch (e) {
    if (needsSheet(e)) { sheet(); return }
    if (isApiError(e, 'not_found')) void useRooms.getState().fetchRoom(roomId).catch(() => {})
    toast({ level: 'error', text: errorText(e, w.locale, t('rooms.save.failed')) })
  }
}

async function undoSave(roomId: string, project: NonNullable<Room['project']>, copies: { path: string; token: string }[], w: SaveWords) {
  const t = w.t
  // one call per copy, with the token its save gave: the server takes it back only for me, while it is the same copy with
  // the same bytes, once (POST /api/rooms/:id/save-undo); anything else is one plain 404: "it stays", never a guess
  let kept = 0, failed = 0
  const gone = new Set<string>()
  for (const c of copies) {
    try {
      await api.call(API.undoRoomSave, { params: { id: roomId }, body: { token: c.token } })
      gone.add(c.path)
    } catch (e) { if (isApiError(e, 'not_found')) kept++; else failed++ }
  }
  // the chips say "saved" no more for what went
  if (gone.size) useRoomSaves.setState((s) => {
    const room = { ...s.byRoom[roomId] }
    for (const [id, path] of Object.entries(room)) if (gone.has(path)) delete room[id]
    return { byRoom: { ...s.byRoom, [roomId]: room } }
  })
  if (failed) toast({ level: 'error', text: t('rooms.save.undoFailed') })
  else toast(kept ? { level: 'info', text: t('rooms.save.undoChanged', { project: project.name }) } : { level: 'success', text: t('rooms.save.undone', { project: project.name }) })
}
