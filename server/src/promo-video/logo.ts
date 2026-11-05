// How the logo sits on the dark end card of the promo video (docs/DECISIONS.md "V"): the whole logo, never split into
// parts. From its pixels (64×64 point-sampled RGBA by the isolated ffmpeg, the same way the website reading finds a logo's colour):
//   tile   — (almost) no transparency: the logo with its own background, rounded, as an app icon;
//   direct — transparent and light or bright enough to read on the dark ground: as it is;
//   white  — transparent, dark and without colour (a black wordmark): drawn white;
//   chip   — transparent, dark and in colour: on a light rounded card, so its colours stay true.
// Without ffmpeg the safe choice: a JPEG is a tile, anything else a chip.
import { contrast } from './colors'
import { rawRgba } from '../onboarding/brand-assets'

export type LogoTreat = 'direct' | 'white' | 'chip' | 'tile'

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0')

/** The treatment for RGBA pixels on a ground colour (exported for tests). */
export function logoTreatFromPixels(raw: Uint8Array, ground: string): LogoTreat {
  const n = Math.floor(raw.length / 4)
  if (!n) return 'chip'
  let opaque = 0, ink = 0, dark = 0, colour = 0
  for (let i = 0; i < n; i++) {
    const r = raw[i * 4]!, g = raw[i * 4 + 1]!, b = raw[i * 4 + 2]!, a = raw[i * 4 + 3]!
    if (a >= 250) opaque++
    if (a < 160) continue
    ink++
    if (contrast('#' + hex2(r) + hex2(g) + hex2(b), ground) < 2.4) dark++
    if (Math.max(r, g, b) - Math.min(r, g, b) > 48) colour++
  }
  // a filled shape (an app icon with rounded corners, a logo on its own square): it carries its background
  if (opaque / n >= 0.8) return 'tile'
  if (!ink) return 'chip'
  if (dark / ink < 0.22) return 'direct'
  return colour / ink < 0.15 ? 'white' : 'chip'
}

export async function logoTreat(bytes: Buffer, ext: 'png' | 'jpg' | 'webp', ground: string): Promise<LogoTreat> {
  const raw = await rawRgba(bytes, ext, 64)
  if (!raw) return ext === 'jpg' ? 'tile' : 'chip'
  return logoTreatFromPixels(raw, ground)
}
