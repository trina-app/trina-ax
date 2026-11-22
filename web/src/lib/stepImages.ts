// Pictures a step shows by itself (Step.images: change_banner_text's sizes, a saved connection picture, a shared browser
// screenshot). The answer under those steps does not draw them a second time: the AI used to retype the banner's
// Markdown and showed the 1080x1080 file twice and the story size never (replay, 11-22); a repeat of a path a step
// shows is left out of the answer (components/Markdown.tsx TeamImage).
import { createContext } from 'react'
import type { Step } from '@mycel/shared/api'

/** the team paths the answer's steps show already (empty outside an answer) */
export const StepShownImages = createContext<ReadonlySet<string>>(new Set())

/** every picture of the steps, in order, each path once */
export function stepImages(steps: readonly Step[] | undefined): NonNullable<Step['images']> {
  const seen = new Set<string>()
  const out: NonNullable<Step['images']> = []
  for (const s of steps ?? []) for (const im of s.images ?? []) if (!seen.has(im.path)) { seen.add(im.path); out.push(im) }
  return out
}
