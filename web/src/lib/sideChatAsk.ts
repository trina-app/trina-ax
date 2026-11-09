// "Ask Trina about this file" in the file preview (components/FilePanel.tsx) for a file sent in a room: the room's page
// (pages/Room.tsx) opens its side chat with the file quoted (components/rooms/SideChatPanel.tsx SideSeed.file). The
// preview panel is the app's, the side chat the room page's: this is the one line between them.
import type { SideSeed } from '../components/rooms/SideChatPanel'

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
