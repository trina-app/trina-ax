// A chat's thread opened from outside the chat (an Activity row, a push tap, a link: /c/<chat>/t/<answer>): the chat
// beside it goes to the answer the thread is under and lights it for a moment, as Slack does with a thread's parent
// (pages/Chat.tsx). A thread opened from the chat itself leaves the chat where it was. The same for a shared chat of
// someone else's and a project's chat. Pure: test/unit/linked-answer.test.ts.

/** How many older pages are read to find that answer (pages of 50: the chat's last 500 messages); past them, or on
 * another version of the chat (its thread panel says which), the chat stays where it is. */
export const LINKED_PAGES = 10

/** The answer the chat goes to: the thread's, unless the thread was opened by a click in this chat (`openedHere`). */
export const linkedAnswer = (threadRoot: string | null, openedHere: boolean): string | null => (threadRoot && !openedHere ? threadRoot : null)

/** What to do now: `show` (it is on the page), `older` (read an older page and look again), `none` (not here). */
export function linkedStep(o: { id: string; ids: readonly string[]; hasOlder: boolean; tries: number }): 'show' | 'older' | 'none' {
  if (o.ids.includes(o.id)) return 'show'
  return o.hasOlder && o.tries < LINKED_PAGES ? 'older' : 'none'
}

/** Closing a thread puts the focus back on the answer's thread line (QA TC-3888) without scrolling to it: a reader who
 * scrolled the chat elsewhere while the thread was open stays where they are (the browser's focus() would scroll). */
export const focusInPlace = (el: HTMLElement | null): void => el?.focus({ preventScroll: true })
