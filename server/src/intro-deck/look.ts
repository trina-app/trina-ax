// The intro deck's themes, round 2 (docs/DECISIONS.md "D2", round 2; the design system's §4): every colour is computed
// from one brand colour B, never picked by hand. Each ground yields the same tokens:
//   text · dim (softened until 4.5:1 is the limit) · mute (until 3:1) · line (a hairline) · lineStrong (connectors, held
//   at 3:1) · mark (B as a shape, ≥ 3:1) · accent (B as type, ≥ 4.5:1) · t05 / t10 / t20 / t40 (tints of the mark) ·
//   onMark (white or near-black on the mark, whichever reads better).
// "Lift" raises B's HSL lightness at the same hue and saturation until a ratio is reached (a vivid colour stays vivid
// on ink, where round 1 washed it toward white); "reach" mixes toward black (or white) until it is.
//   ink   — mix(#08090C, B, 0.06), text #EEF1F8 (warm #F3EEE6 when B's hue is 20–70°): vivid colours, and deep colours
//           when the chosen pictures are mostly dark (the AI's tone notes).
//   paper — mix(#F7F5F0, accent, 0.02), text #171513, the accent B darkened to 4.5:1; a B without hue takes its accent
//           from the brand pictures (k-means, render.ts) or stays monochrome. Feature ground (cover, closing): warm
//           near-black #171513, or B itself when B carries white at 4.5:1.
//   brand — white content pages (text mix(#111, B, 0.06), one soft corner glow of B ≤ 0.09); the cover, numbers and
//           closing on a mesh of B (three blobs: hue −26° L+4 %, L−16 %, hue +24° L+6 %), white type.
import type { DeckTheme } from '@mycel/shared/api'
import { contrast, luminance, mix } from '../promo-video/colors'
import { fromHsl, hsl, usableBrand } from '../promo-video/palette'
import { colourClass } from './theme'

/** One ground's tokens (round 2). */
export interface G2 {
  bg: string
  text: string
  dim: string
  mute: string
  line: string
  lineStrong: string
  mark: string
  accent: string
  onMark: string
  t05: string
  t10: string
  t20: string
  t40: string
  dark: boolean
}

/** A blob of a drawn mesh or glow: centre, radius (ry = r × 0.8 unless given), colour, opacity at the centre. */
export interface Blob { x: number; y: number; r: number; ry?: number; color: string; a: number }

export interface Look2 {
  theme: DeckTheme
  brand: string | null
  /** one corner radius for every picture and panel: paper 4, ink and brand 16 */
  radius: number
  /** content slides */
  content: G2
  /** cover, numbers (ink, brand), closing, drawn openings */
  feature: G2
  /** type over a photograph */
  photo: G2
  /** how the feature ground is drawn: a glow of B on ink or warm black, or the brand mesh */
  featureKind: 'glow' | 'mesh'
  /** the colour of glows (B, or the sampled accent on paper); null: none */
  glow: string | null
  /** the brand mesh's three colours (brand theme) */
  mesh: [string, string, string] | null
}

const rgbOf = (hex: string) => { const n = Number.parseInt(hex.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const }
/** HSL shift: hue in degrees, lightness and saturation in 0–1 steps (the mock's `hue`). */
export function shift(c: string, deg: number, dl = 0, ds = 0): string {
  const [h, s, l] = hsl(c)
  return fromHsl((((h * 360 + deg) % 360) + 360) % 360 / 360, Math.max(0, Math.min(1, s + ds)), Math.max(0, Math.min(1, l + dl)))
}
/** move `c` toward white (on a dark bg) or black until it reaches `ratio` on bg */
export function reach(c: string, bg: string, ratio: number): string {
  const to = luminance(bg) < 0.2 ? '#ffffff' : '#000000'
  for (let t = 0; t <= 1.0001; t += 0.01) { const m = mix(c, to, t); if (contrast(m, bg) >= ratio) return m }
  return to
}
/** raise lightness (hue and saturation kept) until `ratio` on a dark bg */
export function lift(c: string, bg: string, ratio: number): string {
  for (let dl = 0; dl <= 1.0001; dl += 0.01) { const m = shift(c, 0, dl); if (contrast(m, bg) >= ratio) return m }
  return '#ffffff'
}
/** text softened toward bg as far as it still reaches ratio */
export function soften(text: string, bg: string, t: number, ratio: number): string {
  for (let k = t; k > 0; k -= 0.01) { const c = mix(text, bg, k); if (contrast(c, bg) >= ratio) return c }
  return text
}
export const isDark = (bg: string) => luminance(bg) < 0.2
/** "#rrggbb" with an alpha 0–1 → "#rrggbbaa" */
export const alpha = (hex: string, a: number) => hex.slice(0, 7) + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')

/** One ground's tokens from its background, its text colour and the brand colour as a mark. */
export function ground(bg: string, text: string, markIn: string): G2 {
  const dark = isDark(bg)
  const fix = (c: string, r: number) => (contrast(c, bg) >= r ? c : dark ? lift(c, bg, r) : reach(c, bg, r))
  const mark = fix(markIn, 3)
  const accent = fix(markIn, 4.5)
  return {
    bg, text, dark, mark, accent,
    dim: soften(text, bg, 0.34, 4.5), mute: soften(text, bg, 0.55, 3),
    line: mix(bg, text, dark ? 0.16 : 0.13),
    lineStrong: soften(text, bg, 0.62, 3),
    t05: mix(bg, mark, 0.05), t10: mix(bg, mark, dark ? 0.14 : 0.1), t20: mix(bg, mark, dark ? 0.26 : 0.2), t40: mix(bg, mark, 0.45),
    onMark: contrast('#ffffff', mark) >= contrast('#0b0b0b', mark) ? '#ffffff' : '#0b0b0b',
  }
}

/** A ground on the brand colour itself (the brand theme's feature): white type, the mark white, tints of white. */
function brandFeature(B: string): G2 {
  const text = contrast('#ffffff', B) >= 4.5 ? '#ffffff' : '#0b0b0b'
  const g = ground(B, text, text)
  return {
    ...g, mark: text, accent: text, onMark: B,
    dim: soften(text, B, 0.22, 4.5), mute: soften(text, B, 0.4, 3),
    line: mix(B, text, 0.24), lineStrong: mix(B, text, 0.6),
    t05: mix(B, text, 0.08), t10: mix(B, text, 0.16), t20: mix(B, text, 0.26), t40: mix(B, text, 0.4),
    dark: text === '#ffffff',
  }
}

const PHOTO = (scrimBg: string, mark: string): G2 => ({ ...ground(scrimBg, '#ffffff', mark), text: '#ffffff' })

/** B without a usable hue (grey, near-black, near-white). */
export const hueless = (b: string | null | undefined) => !b || hsl(b)[1] < 0.12 || !usableBrand(b)

/** The themes that fit (best first), round 2: as round 1, and ink first for a deep colour whose pictures are mostly dark. */
export function fittingThemes2(brand: string | null | undefined, picturesDark: boolean): DeckTheme[] {
  const c = colourClass(brand)
  const solid = !!brand && usableBrand(brand) && (contrast('#ffffff', brand) >= 4.5 || contrast('#111111', brand) >= 4.5)
  if (c === 'deep') return picturesDark ? ['ink', 'brand', 'paper'] : ['brand', 'paper', 'ink']
  if (c === 'vivid') return solid ? ['ink', 'paper', 'brand'] : ['ink', 'paper']
  if (c === 'muted') return solid ? ['paper', 'brand', 'ink'] : ['paper', 'ink']
  return ['paper', 'ink']
}
export function themeFor2(asked: DeckTheme | undefined, brand: string | null | undefined, picturesDark: boolean): { theme: DeckTheme; replaced: boolean } {
  const fits = fittingThemes2(brand, picturesDark)
  if (asked && fits.includes(asked)) return { theme: asked, replaced: false }
  return { theme: fits[0]!, replaced: !!asked }
}

/** The look of a deck: `sampled` is the accent taken from the brand pictures when B has no hue (paper). */
export function lookFor2(theme: DeckTheme, brandIn: string | null | undefined, sampled: string | null = null): Look2 {
  const B = usableBrand(brandIn) ? brandIn.toLowerCase() : null
  if (theme === 'ink') {
    const bg = B ? mix('#08090c', B, 0.06) : '#0a0b0d'
    const h = B ? hsl(B)[0] * 360 : 0
    const text = B && h >= 20 && h <= 70 ? '#f3eee6' : '#eef1f8'
    const g = ground(bg, text, B ?? sampled ?? '#c9ced8')
    return { theme, brand: B, radius: 16, content: g, feature: g, photo: PHOTO(bg, g.mark), featureKind: 'glow', glow: B ?? sampled ?? null, mesh: null }
  }
  if (theme === 'brand' && B && (contrast('#ffffff', B) >= 4.5 || contrast('#111111', B) >= 4.5)) {
    const content = ground('#ffffff', mix('#111111', B, 0.06), B)
    const feature = brandFeature(B)
    const mesh: [string, string, string] = [shift(B, -26, 0.04), shift(B, 0, -0.16), shift(B, 24, 0.06)]
    return { theme: 'brand', brand: B, radius: 16, content, feature, photo: PHOTO('#08080c', content.mark), featureKind: 'mesh', glow: B, mesh }
  }
  // paper: the brand as the accent; a hueless brand takes the sampled accent, else stays monochrome
  const acc = B && !hueless(B) ? B : sampled
  const paper = acc ? mix('#f7f5f0', acc, 0.02) : '#f6f4ef'
  const content = ground(paper, '#171513', acc ?? '#2b2a28')
  const solidB = !!B && !hueless(B) && contrast('#ffffff', B) >= 4.5 && colourClass(B) !== 'light'
  const feature = solidB ? brandFeature(B!) : ground('#171513', '#f3eee6', acc ?? '#d8d2c8')
  return { theme: 'paper', brand: B, radius: 4, content, feature, photo: PHOTO('#120f0c', content.mark), featureKind: solidB ? 'mesh' : 'glow', glow: acc, mesh: solidB ? [shift(B!, -26, 0.04), shift(B!, 0, -0.16), shift(B!, 24, 0.06)] : null }
}

/** Mean luminance of colours (for the tone fallback when there are no notes). */
export const meanLum = (cs: string[]) => cs.length ? cs.reduce((a, c) => a + luminance(c), 0) / cs.length : 0.5
export { rgbOf }
