// The one way a file an AI made opens from a message (docs/decisions/20261126-shared-message-actions.md): a picture in
// the image viewer (its zoom, ← → through the pane's pictures), any other file in the right panel (the side panel,
// beside the conversation; the whole screen on a phone), as the AI chat opens its answers' files. The same document then
// opens the same way in the chat it was made in and in the room it was sent to; a room file someone uploaded keeps the
// room's full-window viewer (docs/DECISIONS.md "The room file viewer").
import type { RoomMessage } from '@mycel/shared/api'
import { openFilePreview, type PreviewFile } from './sidePanel'

/** a room message whose files an AI made: an answer sent from someone's AI chat (its files went with it) or an older
 * room-AI answer */
export const aiMadeFiles = (m: Pick<RoomMessage, 'sharedAnswer' | 'authorKind'>): boolean => !!m.sharedAnswer || m.authorKind === 'ai'

/** Opens a file an AI made. `picture`: opens it in the image viewer (the caller's `useViewerItem(...).open`), given for
 * a file drawn as a picture; any other file goes to the right panel. */
export function openMessageFile(file: PreviewFile, picture?: (() => void) | null): void {
  if (picture) return picture()
  openFilePreview(file)
}
