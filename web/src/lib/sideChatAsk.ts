// "Ask Trina about this file" in the file preview (components/FilePanel.tsx) and in the file viewer on a phone, for a
// file sent in a room: the room's page (pages/Room.tsx) opens its side chat with the file quoted
// (components/rooms/SideChatPanel.tsx SideSeed.file). The preview panel and the viewer are the app's, the side chat the
// room page's: this is the one line between them. The asks themselves (a message, a file) are made here too.
import type { RoomMessage } from '@mycel/shared/api'
import type { SideSeed } from '../components/rooms/SideChatPanel'

/** "Ask Trina about this" on a message of the room: who wrote it (the AI by its name), when, its text. */
export function messageSeed(m: Pick<RoomMessage, 'id' | 'authorKind' | 'author' | 'createdAt' | 'body'>, ai: string): SideSeed {
  return { key: `${m.id}:${Date.now()}`, author: m.authorKind === 'ai' ? ai : m.author?.name ?? '', at: m.createdAt, text: m.body }
}
/** "Ask Trina about this file" on a file sent in the room (its preview panel, the file viewer): its id and name, which
 * the AI opens with room_file. */
export function fileSeed(fileId: string, name: string): SideSeed {
  return { key: `${fileId}:${Date.now()}`, author: '', at: new Date().toISOString(), text: '', file: { id: fileId, name } }
}

type Ask = { roomId: string; seed: SideSeed }
const listeners = new Set<(a: Ask) => void>()

/** the room page of `roomId` (when it is open) opens its side chat with this seed; false: no room page listens */
export function askTrinaInRoom(roomId: string, seed: SideSeed): boolean {
  let heard = false
  for (const l of listeners) { l({ roomId, seed }); heard = true }
  return heard
}
export function onAskTrinaInRoom(l: (a: Ask) => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
