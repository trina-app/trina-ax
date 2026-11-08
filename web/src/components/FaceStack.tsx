// People's pictures overlapping, at most 3 and then "+N"; on a phone at most 2, so the row's text keeps its room. Used
// for who wrote in a shared project chat (chat/SharedChat.tsx ChatFaces; docs/DECISIONS.md "The faces on the project
// page") and for a group's members (Admin › Groups). Decorative (aria-hidden): the row says the names in words. It takes
// a ref and handlers (the rest of its props go to its element), so a Tooltip can wrap it.
import clsx from 'clsx'
import type { ComponentPropsWithRef } from 'react'
import { CHAT_PEOPLE_SHOWN } from '@mycel/shared/api'
import { Avatar, type AvatarUser } from './Avatar'

/** faces on a computer: as many as the server gives a shared chat's row */
export const FACES_SHOWN = CHAT_PEOPLE_SHOWN
/** faces on a phone: the third one (STACK) hides there */
const PHONE_SHOWN = 2
/** each face the next one is tucked 4 px under (each one sits a step lower), so a letter on its tile still shows whole */
const STACK = ['relative z-[3]', 'relative z-[2] -ml-1', 'relative z-[1] -ml-1 max-sm:hidden'] as const satisfies { length: typeof FACES_SHOWN }
/** the "+N" after the faces: a tile like a face's (as high, in px like the pictures), tucked under the last face like
 * the others, its count kept clear of that face's edge (the wider padding on the left) */
const MORE = '-ml-1 flex h-[20px] min-w-[20px] shrink-0 items-center justify-center rounded-full bg-hover pr-[5px] pl-[7px] text-[0.6875rem] leading-none font-semibold text-muted tabular-nums'

/**
 * `people`: the first ones (only FACES_SHOWN of them show); `count`: how many there are in all. Each face has a ring of
 * the page's colour; `hoverRing`: the hover colour on a hovered row (a `group` around it). `testId`: the stack is
 * `<testId>-people`, the "+N" tiles `<testId>-more` (a computer) and `<testId>-more-phone`.
 */
export function FaceStack({ people, count, hoverRing, testId, ...rest }: {
  people: readonly AvatarUser[]
  count: number
  hoverRing?: boolean
  testId: string
} & Omit<ComponentPropsWithRef<'span'>, 'children' | 'className'>) {
  const ring = clsx('ring-2 ring-canvas', hoverRing && 'group-hover:ring-hover')
  return (
    <span {...rest} className="isolate flex shrink-0 items-center" aria-hidden data-testid={`${testId}-people`}>
      {people.slice(0, FACES_SHOWN).map((p, i) => (
        <Avatar key={p.id} user={p} size={20} className={clsx(ring, STACK[i])} />
      ))}
      {count > FACES_SHOWN && <span className={clsx(MORE, ring, 'max-sm:hidden')} data-testid={`${testId}-more`}>+{count - FACES_SHOWN}</span>}
      {count > PHONE_SHOWN && <span className={clsx(MORE, ring, 'sm:hidden')} data-testid={`${testId}-more-phone`}>+{count - PHONE_SHOWN}</span>}
    </span>
  )
}
