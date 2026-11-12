// "Alice is typing…" (docs/DECISIONS.md "입력 중 표시"): what this window says while its person writes in a room's or a
// thread's box, and the words of the line other people see.
//
// - TypingSender: "typing" at most every ROOM_TYPING_EVERY_MS while the text changes; "stopped" at once when the box is
//   sent, emptied, left (blur) or the room closes, but only after a "typing" that has not run out on the receivers yet
//   (nothing to stop otherwise).
// - typingWords: one name, two names, or "several people" (three or more); null with nobody.
import { ROOM_TYPING_EVERY_MS, ROOM_TYPING_EXPIRES_MS } from '@mycel/shared/api'
import type { MessageKey } from '../i18n/ko'

type Out = (roomId: string, threadRootId: string | null, typing: boolean) => void
let out: Out = () => {}
/** Where this window's `room.typing` frames go (store/live.ts: the socket; tests: a list). */
export function setTypingOut(fn: Out) { out = fn }
/** This window's person is writing in a room's box (threadRootId null) or a thread's box, or stopped. */
export const sendTyping: Out = (roomId, threadRootId, typing) => out(roomId, threadRootId, typing)

export class TypingSender {
  /** when the last "typing" went (-Infinity: none, or a stop came after it) */
  private sentAt = -Infinity
  constructor(private send: (typing: boolean) => void, private now: () => number = () => Date.now()) {}

  /** The box's text changed by the person's hand. */
  input(text: string) {
    if (!text.trim()) return this.stop()
    const n = this.now()
    if (n - this.sentAt < ROOM_TYPING_EVERY_MS) return
    this.sentAt = n
    this.send(true)
  }

  /** Sent, emptied, left: "stopped", when a "typing" is still showing on the others' screens. */
  stop() {
    if (this.sentAt === -Infinity) return
    const live = this.now() - this.sentAt < ROOM_TYPING_EXPIRES_MS
    this.sentAt = -Infinity
    if (live) this.send(false)
  }
}

type T = (key: MessageKey, params?: Record<string, string | number>) => string

/** The line's words for these people (in the order they started), or null when nobody is typing. */
export function typingWords(t: T, names: readonly string[]): string | null {
  if (!names.length) return null
  if (names.length === 1) return t('rooms.typingOne', { name: names[0]! })
  if (names.length === 2) return t('rooms.typingTwo', { a: names[0]!, b: names[1]! })
  return t('rooms.typingMany')
}
