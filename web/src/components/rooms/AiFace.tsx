// @트리나 as someone in a room: beside its answers, on its status line, in the "@" menu, in the head of an answer
// shared into a room, on the Inbox row of its answer, on the AI chat's pinned row of the rooms list. Where the product
// is named after its AI (PRODUCT_NAMED_AFTER_AI, as the name 트리나 is shown) it is Trina's star (TrinaStar) on the
// neutral circle of a person without a photo; elsewhere the sparkle on the accent circle as before. A button that asks
// it (the room header's ✦, a message's hover bar and menu, the image viewer's bar, and "트리나에게 묻기": the sidebar's
// first row, ⌘K's action and a phone AI chat's new-chat button) has its mark without a circle (AiMark), so ✦ always
// means asking it. The other AI sparkles (the phone's AI tab, Files' "AI에게 묻기", skills) are things to do, not someone in
// the room, and stay. Decorative (aria-hidden): the name is next to it.
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

/** A button's mark (no circle) that asks the AI: `toolbar` in the room header (✦ opens the side chat), the image
 * viewer's bar and a phone AI chat's header (a new chat), `bar` in a message's hover bar, `menu` in a menu row (the
 * long-press sheet on a phone), `nav` in a row of 16 px icons (the sidebar, ⌘K). The star is thin
 * (it fills about 4/5 of its box and a seventh of its area), so it is drawn larger than the stroked icons beside it to
 * read as big as they do (the owner, 2026-11-10: "좀더 크게 시원시원하게"). Where its button has no fixed size it
 * overhangs its slot by a negative margin, so the button, the header and a menu row keep their size: `star` / `sparkle`
 * is the drawn size, the slot that size less twice the margin. */
const MARK = {
  /** beside the 16 px bell and ⋯ (18 px icons in the viewer): drawn 24, in the 20 px slot the star had (the sparkle 18
   * in 16) */
  toolbar: { star: 24, starFit: '-m-0.5', sparkle: 18, sparkleFit: '-m-px' },
  /** a 28 px button beside the 16 px emoji and icons of the hover bar */
  bar: { star: 22, starFit: undefined, sparkle: 18, sparkleFit: undefined },
  /** the 14 px icon slot of a menu item: drawn 18 (the sparkle 16) */
  menu: { star: 18, starFit: '-m-0.5', sparkle: 16, sparkleFit: '-m-px' },
  /** a row of 16 px icons (the sidebar's and ⌘K's "Ask Trina"): drawn 18 in the 16 px slot, as tall as the icons below
   * it; the sparkle 16, as they are */
  nav: { star: 18, starFit: '-m-px', sparkle: 16, sparkleFit: undefined },
} as const
export type AiMarkPlace = keyof typeof MARK

export function AiMark({ place = 'toolbar', named = PRODUCT_NAMED_AFTER_AI }: { place?: AiMarkPlace; named?: boolean }) {
  const m = MARK[place]
  return named ? <TrinaStar size={m.star} className={m.starFit} /> : <Sparkles size={m.sparkle} aria-hidden className={clsx('shrink-0', m.sparkleFit)} />
}
