// @트리나 as someone in a room: beside its answers, on its status line, in the "@" menu, in the head of an answer
// shared into a room, on the Inbox row of its answer, on the AI chat's pinned row of the rooms list. Where the product
// is named after its AI (PRODUCT_NAMED_AFTER_AI, as the name 트리나 is shown) it is Trina's star (TrinaStar) on the
// neutral circle of a person without a photo; elsewhere the sparkle on the accent circle as before. The other AI
// sparkles (the phone's AI tab, Files' "AI에게 묻기", skills) are things to do, not someone in the room, and stay.
// Decorative (aria-hidden): the name is next to it.
import clsx from 'clsx'
import { Sparkles } from 'lucide-react'
import { PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { TrinaStar } from '../TrinaStar'

/** the circle's size: 32 beside a message and on the status line, 22 in the "@" menu, 36 on an Inbox row, 40 on the
 * rooms list (as the rooms' own pictures there) */
type Size = 22 | 32 | 36 | 40
const SPARKLE: Record<Size, number> = { 22: 12, 32: 15, 36: 16, 40: 18 }
/** the star's box on the circle (the star is thin: it fills about 4/5 of its box) */
const STAR: Record<Size, number> = { 22: 16, 32: 22, 36: 26, 40: 28 }
const BOX: Record<Size, string> = { 22: 'size-[22px]', 32: 'size-8', 36: 'size-9', 40: 'size-10' }

/** `named`: the product is named after its AI (this build's, PRODUCT_NAMED_AFTER_AI; a prop so both looks are tested) */
export function AiFace({ size, className, named = PRODUCT_NAMED_AFTER_AI }: { size: Size; className?: string; named?: boolean }) {
  return (
    <span aria-hidden className={clsx('flex shrink-0 items-center justify-center rounded-full', BOX[size], named ? 'bg-hover' : 'bg-accent-soft text-accent-text', className)} data-testid="ai-face">
      {named ? <TrinaStar size={STAR[size]} /> : <Sparkles size={SPARKLE[size]} />}
    </span>
  )
}

/** Beside a line of small text (12 px, the "트리나 답변" head of a shared answer): no circle. */
export function AiFaceInline({ className, named = PRODUCT_NAMED_AFTER_AI }: { className?: string; named?: boolean }) {
  return named ? <TrinaStar size={14} className={className} /> : <Sparkles size={12} className={clsx('shrink-0 text-accent-text', className)} aria-hidden />
}
