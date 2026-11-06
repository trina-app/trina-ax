// The intro deck's three themes (docs/DECISIONS.md "D2"): token sets over one layout, chosen from the brand colour.
//   paper — warm white tinted ≤ 2 % by the brand; the brand as the accent when it reads on paper, else near-black type
//           with the brand as a mark; cover, numbers and contact on the brand colour when its text reaches 4.5:1,
//           else near-black. Light colours, muted colours and no colour start here (and print well).
//   ink   — near-black warmed by the brand (the promo video's ink), the brand brightened to ≥ 4.5:1 as the accent, a
//           soft glow on the cover and the numbers only. Vivid colours start here.
//   brand — white content pages; the cover, numbers and contact on the solid brand colour. Colours that carry white
//           (or near-black) text at 4.5:1 and are deep or mid start here.
// Every text colour is solid (mixed with its ground), so a viewer that ignores transparency shows the same; only type
// over a photograph uses white with alpha.
import type { DeckTheme } from '@mycel/shared/api'
import { contrast, mix, onColor, towardContrast } from '../promo-video/colors'
import { hsl, lightTo, usableBrand } from '../promo-video/palette'

export interface Ground {
  bg: string
  text: string
  dim: string
  mute: string
  line: string
  /** the accent as type (≥ 4.5:1 on bg) */
  accent: string
  /** the accent as a mark (bars, dots): the brand colour itself where it shows */
  mark: string
  /** a lifted surface for cards */
  panel: string
  dark: boolean
  /** a soft light behind the cover and the numbers (ink only) */
  glow: string | null
}

export interface DeckLook {
  theme: DeckTheme
  /** one corner radius for every picture and card of the deck */
  radius: number
  /** content slides */
  light: Ground
  /** cover (type-only and split), numbers, contact */
  feature: Ground
  /** type over a photograph (cover A, scene) */
  photo: Ground
  /** the photo scrim's colour */
  scrim: string
  brand: string | null
}

export type ColourClass = 'none' | 'light' | 'muted' | 'deep' | 'vivid'

/** What kind of colour the brand colour is: none (grey or absent), light (pastel), muted (low saturation), deep (a mid
 * or deep colour that carries white type at 4.5:1), vivid (bright and saturated: better as light on black). */
export function colourClass(brand: string | null | undefined): ColourClass {
  if (!usableBrand(brand)) return 'none'
  const [, s, l] = hsl(brand)
  if (l >= 0.8) return 'light'
  if (s < 0.25) return 'muted'
  if (contrast(brand, '#ffffff') >= 4.5) return 'deep'
  return s >= 0.5 ? 'vivid' : 'muted'
}

/** The themes that fit a brand colour, best first (the server's choice is the first; the AI may pick another of these). */
export function fittingThemes(brand: string | null | undefined): DeckTheme[] {
  const c = colourClass(brand)
  const solid = usableBrand(brand) && contrast(onColor(brand), brand) >= 4.5
  if (c === 'deep') return ['brand', 'paper', 'ink']
  if (c === 'vivid') return solid ? ['ink', 'paper', 'brand'] : ['ink', 'paper']
  if (c === 'muted') return solid ? ['paper', 'brand', 'ink'] : ['paper', 'ink']
  return ['paper', 'ink']
}

const PAPER = '#f7f6f2'
/** `text` moved toward `bg` by `t` at most, as far as it still reaches `ratio` on `bg` (dim type 4.5:1, mute 3:1). */
function soft(text: string, bg: string, t: number, ratio: number): string {
  for (let k = t; k > 0; k -= 0.02) { const c = mix(text, bg, k); if (contrast(c, bg) >= ratio) return c }
  return text
}
const NEAR_BLACK = '#141414'
const INK_TEXT = '#f2f2f0'

/** A dark ground's tokens (near-black or ink). */
function darkGround(bg: string, brand: string | null, glow: boolean): Ground {
  const accent = brand ? lightTo(brand, bg, 4.5, hsl(brand)[2]) : '#ffffff'
  return {
    bg, text: INK_TEXT, dim: soft(INK_TEXT, bg, 0.36, 4.5), mute: soft(INK_TEXT, bg, 0.56, 3), line: mix(INK_TEXT, bg, 0.84),
    accent, mark: brand ? accent : '#ffffff', panel: mix(bg, '#ffffff', 0.055), dark: true,
    glow: glow ? (brand ?? '#9aa0aa') : null,
  }
}

/** The solid brand ground's tokens (its type white or near-black, whichever reaches 4.5:1). */
function brandGround(brand: string): Ground {
  const text = onColor(brand)
  const dark = text === '#ffffff'
  return {
    bg: brand, text, dim: soft(text, brand, 0.26, 4.5), mute: soft(text, brand, 0.42, 3), line: mix(text, brand, 0.74),
    accent: text, mark: text, panel: mix(brand, dark ? '#ffffff' : '#000000', 0.08), dark, glow: null,
  }
}

function lightGround(bg: string, brand: string | null, panelTint: number): Ground {
  // the brand as type when darkening keeps it a colour (it reads at 3:1 already); a light brand stays a mark only
  const reads = brand && contrast(brand, bg) >= 3
  const accent = brand ? (reads ? towardContrast(brand, bg, 4.5, '#000000') : NEAR_BLACK) : '#2b2b2b'
  return {
    bg, text: '#111111', dim: soft('#111111', bg, 0.3, 4.5), mute: soft('#111111', bg, 0.5, 3), line: mix('#111111', bg, 0.86),
    accent, mark: brand ?? NEAR_BLACK, panel: mix(bg, brand ?? '#000000', panelTint), dark: false, glow: null,
  }
}

const PHOTO: Ground = {
  bg: '#0a0a0a', text: '#ffffff', dim: '#ffffffd9', mute: '#ffffffa6', line: '#ffffff40', accent: '#ffffff', mark: '#ffffff',
  panel: '#ffffff1f', dark: true, glow: null,
}

export function lookFor(theme: DeckTheme, brandIn: string | null | undefined): DeckLook {
  const brand = usableBrand(brandIn) ? brandIn.toLowerCase() : null
  const solid = !!brand && contrast(onColor(brand), brand) >= 4.5
  if (theme === 'ink') {
    const bg = brand ? mix('#0b0b0c', brand, 0.045) : '#0a0a0b'
    const g = darkGround(bg, brand, false)
    return { theme, radius: 16, light: g, feature: darkGround(bg, brand, true), photo: PHOTO, scrim: '#050505', brand }
  }
  if (theme === 'brand' && brand && solid) {
    const light = lightGround('#ffffff', brand, 0.05)
    return { theme, radius: 16, light, feature: brandGround(brand), photo: PHOTO, scrim: '#080808', brand }
  }
  const paper = brand ? mix(PAPER, brand, 0.02) : PAPER
  const light = lightGround(paper, brand, 0.035)
  const feature = brand && solid && colourClass(brand) !== 'light' ? brandGround(brand) : darkGround(NEAR_BLACK, brand, false)
  return { theme: 'paper', radius: 0, light, feature, photo: PHOTO, scrim: '#080808', brand }
}

/** The theme a deck gets: the one asked for when it fits the colour, else the first that fits. */
export function themeFor(asked: DeckTheme | undefined, brand: string | null | undefined): { theme: DeckTheme; replaced: boolean } {
  const fits = fittingThemes(brand)
  if (asked && fits.includes(asked)) return { theme: asked, replaced: false }
  return { theme: fits[0]!, replaced: !!asked }
}
