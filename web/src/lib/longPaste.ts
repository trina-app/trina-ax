// A paste that would take a message box over what a message holds: an AI chat's (MESSAGE_TEXT_MAX; the full chat's,
// components/chat/Composer.tsx, and the side chat's, components/rooms/SideChatPanel.tsx; both through
// components/chat/ComposerFiles.tsx onPaste) or a room's own box (ROOM_MESSAGE_MAX,
// components/rooms/RoomComposer.tsx). Never cut: the pasted text goes in as a text file where the box takes files, or the paste is refused with a message (docs/decisions/20261118-audit2-web-limits.md).
import { MESSAGE_TEXT_MAX } from '@mycel/shared/api'

/** The box's text and selection when the paste lands. */
export interface PasteTarget {
  value: string
  selectionStart: number | null
  selectionEnd: number | null
}

/** Whether pasting `pasted` over the selection of `box` makes its text longer than `max`. */
export function pasteOverLimit(box: PasteTarget, pasted: string, max = MESSAGE_TEXT_MAX): boolean {
  const start = box.selectionStart ?? box.value.length
  const end = box.selectionEnd ?? start
  return box.value.length - Math.max(0, end - start) + pasted.length > max
}

/** Whether a message's text is longer than a message holds (said before sending, the text kept). */
export const textOverLimit = (text: string, max = MESSAGE_TEXT_MAX): boolean => text.length > max

/** The pasted text as a file for the box's files (`name` without its extension: the person's language). */
export const pastedTextFile = (text: string, name: string): File => new File([text], `${name}.txt`, { type: 'text/plain' })
