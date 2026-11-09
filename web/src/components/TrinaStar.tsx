// Trina's brand mark: the four-point star of trina.app (a straight-edged star with a longer bottom spike, in an orange
// gradient), as the site draws it. Shown only where the product is named after its AI (PRODUCT_NAMED_AFTER_AI), as the
// name 트리나 is: rooms/AiFace.tsx. The square viewBox is centred on the crossing of the arms (y 236 of the 512 square),
// where the eye puts the star's middle, so it sits centred in a round avatar. The same gradient in both looks.
// Decorative (aria-hidden): a name always stands next to it.
import clsx from 'clsx'
import { useId } from 'react'

export const TRINA_STAR = 'M256 40 L296 196 L452 236 L296 276 L256 472 L216 276 L60 236 L216 196 Z'

export function TrinaStar({ size, className }: { size: number; className?: string }) {
  // one gradient per drawing: stars share a page (every answer in a room), and a url(#id) of a hidden one would blank the rest
  const gradient = `trina-star${useId().replace(/[^\w-]/g, '')}`
  return (
    <svg width={size} height={size} viewBox="16 -4 480 480" aria-hidden focusable="false" className={clsx('shrink-0', className)} data-trina-star>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFB060" />
          <stop offset="1" stopColor="#FF7A1A" />
        </linearGradient>
      </defs>
      <path fill={`url(#${gradient})`} d={TRINA_STAR} />
    </svg>
  )
}
