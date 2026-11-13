// People's pictures overlapping, at most 3 and then "+N"; on a phone at most 2, so the row's text keeps its room. Used
// for who wrote in a shared project chat (chat/SharedChat.tsx ChatFaces; docs/DECISIONS.md "The faces on the project
// page"), for a group's members (Admin › Groups) and for who is in a team project (ProjectPeople.tsx: 4 faces, also on a
// phone, each with its name on hover: `shown`, `phoneShown`, `tips`). Decorative (aria-hidden): the row says the names in
// words. It takes a ref and handlers (the rest of its props go to its element), so a Tooltip can wrap it.
import clsx from 'clsx'
import type { ComponentPropsWithRef } from 'react'
import { Tooltip } from './Tooltip'
import { CHAT_PEOPLE_SHOWN } from '@mycel/shared/api'
import { Avatar, type AvatarUser } from './Avatar'

/** faces on a computer: as many as the server gives a shared chat's row */
export const FACES_SHOWN = CHAT_PEOPLE_SHOWN
/** faces on a phone: the third one (STACK) hides there */
const PHONE_SHOWN = 2
/** the most faces any stack shows (a project's people) */
export const FACES_MAX = 4
/** each face the next one is tucked 4 px under (each one sits a step lower), so a letter on its tile still shows whole */
const STACK = ['relative z-[3]', 'relative z-[2] -ml-1', 'relative z-[1] -ml-1', 'relative z-0 -ml-1'] as const satisfies { length: typeof FACES_MAX }
/** the "+N" after the faces: a tile like a face's (as high, in px like the pictures), tucked under the last face like
 * the others, its count kept clear of that face's edge (the wider padding on the left) */
const MORE = '-ml-1 flex shrink-0 items-center justify-center rounded-full bg-hover pr-[5px] pl-[7px] text-nano leading-none font-semibold text-muted tabular-nums'

/**
 * `people`: the first ones (only `shown` of them show, FACES_SHOWN unless given; on a phone `phoneShown`, 2 unless given);
 * `count`: how many there are in all. Each face has a ring of the page's colour; `hoverRing`: the hover colour on a
 * hovered row (a `group` around it). `tips`: each face says its name on hover (with a mouse). `testId`: the stack is
 * `<testId>-people`, the "+N" tiles `<testId>-more` (a computer) and `<testId>-more-phone` (only when the phone shows
 * fewer). `size`: each face's size (20 unless given).
 */
export function FaceStack({ people, count, hoverRing, testId, shown = FACES_SHOWN, phoneShown = PHONE_SHOWN, tips, size = 20, ...rest }: {
  people: readonly AvatarUser[]
  count: number
  hoverRing?: boolean
  testId: string
  shown?: 1 | 2 | 3 | 4
  phoneShown?: 1 | 2 | 3 | 4
  tips?: boolean
  /** each face's size in px: 20, 24 (a project's people under its name) or 28 (the member picker's group rows) */
  size?: 20 | 24 | 28
} & Omit<ComponentPropsWithRef<'span'>, 'children' | 'className'>) {
  const ring = clsx('ring-2 ring-canvas', hoverRing && 'group-hover:ring-hover')
  // the "+N" tile as high as a face
  const more = clsx(MORE, size === 28 ? 'h-[28px] min-w-[28px]' : size === 24 ? 'h-[24px] min-w-[24px]' : 'h-[20px] min-w-[20px]')
  const phone = Math.min(phoneShown, shown)
  const place = (i: number) => clsx(STACK[i], i >= phone && 'max-sm:hidden')
  return (
    <span {...rest} className="isolate flex shrink-0 items-center" aria-hidden data-testid={`${testId}-people`}>
      {people.slice(0, shown).map((p, i) => tips ? (
        <Tooltip key={p.id} label={p.name}>
          <span className={clsx('flex rounded-full', place(i))} data-testid={`${testId}-face`}>
            <Avatar user={p} size={size} className={ring} />
          </span>
        </Tooltip>
      ) : (
        <Avatar key={p.id} user={p} size={size} className={clsx(ring, place(i))} />
      ))}
      {count > shown && <span className={clsx(more, ring, phone < shown && 'max-sm:hidden')} data-badge="" data-testid={`${testId}-more`}>+{count - shown}</span>}
      {phone < shown && count > phone && <span className={clsx(more, ring, 'sm:hidden')} data-badge="" data-testid={`${testId}-more-phone`}>+{count - phone}</span>}
    </span>
  )
}
