// Style families of the promo video (docs/DECISIONS.md "V"): the ground, the light and the accent of every beat, from
// the brand colour. The server decides which families fit a brand colour; the AI picks only among those.
//   ink  — near-black ground warmed by the brand, the brand as a fire-bright accent and glow (vivid brands)
//   deep — a ground made of the brand's own hue at night depth, a soft light tint of it as the accent (any real colour)
//   mono — graphite and white, silver light (no usable brand colour, or a premium black-and-white look)
import { contrast, isGrey, mix } from './colors'

export const FAMILIES = ['ink', 'deep', 'mono'] as const
export type Family = (typeof FAMILIES)[number]

type Rgb = [number, number, number]
const rgbOf = (hex: string): Rgb => { const n = Number.parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
const hexOf = ([r, g, b]: Rgb) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
export const rgba = (hex: string, a: number) => { const [r, g, b] = rgbOf(hex); return `rgba(${r},${g},${b},${Math.round(a * 1000) / 1000})` }

function hsl(hex: string): [number, number, number] {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255) as Rgb
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}
function fromHsl(h: number, s: number, l: number): string {
  if (s === 0) return hexOf([l * 255, l * 255, l * 255])
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
  const f = (t: number) => { t = ((t % 1) + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p }
  return hexOf([f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255])
}

/** A brand colour that reads as a colour (not grey, not near-black or near-white). */
export function usableBrand(brand: string | null | undefined): brand is string {
  if (!brand || !/^#[0-9a-f]{6}$/i.test(brand) || isGrey(brand)) return false
  const [, s, l] = hsl(brand)
  return s >= 0.18 && l >= 0.08 && l <= 0.94
}

/** The families that fit a brand colour, best first (the server's default is the first). */
export function fittingFamilies(brand: string | null | undefined): Family[] {
  if (!usableBrand(brand)) return ['mono']
  const [, s, l] = hsl(brand)
  // a vivid colour burns well as light on black; a deep or muted one makes a better ground than a spark
  const vivid = s >= 0.55 && l >= 0.38 && l <= 0.75
  return vivid ? ['ink', 'deep', 'mono'] : ['deep', 'ink', 'mono']
}

export interface Palette {
  family: Family
  /** the ground (near-black, warmed or tinted) */
  ground: string
  /** a second, slightly lifted ground for cards and the window bar */
  ground2: string
  /** main type */
  text: string
  dim: string
  mute: string
  /** the accent as type on the ground (≥ 4.5:1) */
  accent: string
  /** the accent's light end and dark end, for the big numbers' gradient */
  accentHi: string
  accentLo: string
  /** text on an accent-filled pill */
  onAccent: string
  /** the light: glows and threads */
  glow: string
  glow2: string
  /** hairlines on the ground */
  line: string
  hasBrand: boolean
}

const PAPER = '#f4f1ea'

function lightTo(color: string, bg: string, ratio: number, minL = 0.5): string {
  const [h, s] = hsl(color)
  let [, , l] = hsl(color)
  l = Math.max(l, minL)
  for (; l <= 0.96; l += 0.01) {
    const c = fromHsl(h, Math.max(s, 0.5), l)
    if (contrast(c, bg) >= ratio) return c
  }
  return '#ffffff'
}

export function paletteFor(family: Family, brandIn: string | null | undefined): Palette {
  const has = usableBrand(brandIn)
  const brand = has ? brandIn!.toLowerCase() : '#8a8f98'
  const [h, s] = hsl(brand)
  if (family === 'mono' || !has) {
    const ground = '#0a0a0b'
    return {
      family: 'mono', ground, ground2: '#151517', text: '#dcdcd8', dim: 'rgba(235,235,232,.62)', mute: 'rgba(245,245,243,.42)',
      accent: '#ffffff', accentHi: '#ffffff', accentLo: '#9a9ca3', onAccent: '#0a0a0b', glow: '#c9ccd4', glow2: '#6c717c',
      line: 'rgba(245,245,243,.16)', hasBrand: has,
    }
  }
  if (family === 'ink') {
    const ground = mix('#0b0b0c', brand, 0.045)
    const accent = lightTo(brand, ground, 4.5, hsl(brand)[2])
    return {
      family, ground, ground2: mix('#161617', brand, 0.06), text: PAPER, dim: 'rgba(244,241,234,.68)', mute: 'rgba(244,241,234,.44)',
      accent, accentHi: mix(accent, '#ffffff', 0.45), accentLo: mix(accent, '#000000', 0.18), onAccent: contrast(accent, '#ffffff') >= contrast(accent, '#111111') ? '#ffffff' : '#111111',
      glow: brand, glow2: mix(brand, '#000000', 0.35), line: rgba(accent, 0.24), hasBrand: true,
    }
  }
  // deep: the brand's hue at night depth; the accent a soft light tint of it
  const ground = fromHsl(h, Math.min(Math.max(s, 0.3), 0.55), 0.07)
  const accent = fromHsl(h, Math.min(Math.max(s * 0.6, 0.28), 0.5), 0.74)
  const mid = fromHsl(h, Math.min(Math.max(s, 0.35), 0.6), 0.36)
  return {
    family, ground, ground2: fromHsl(h, Math.min(s, 0.4), 0.11), text: '#f1ede5', dim: 'rgba(241,237,229,.68)', mute: 'rgba(241,237,229,.44)',
    accent: contrast(accent, ground) >= 4.5 ? accent : lightTo(accent, ground, 4.5), accentHi: mix(accent, '#ffffff', 0.5), accentLo: mix(accent, mid, 0.45),
    onAccent: '#0e0e0e', glow: mid, glow2: fromHsl(h, Math.min(s, 0.5), 0.22), line: rgba(accent, 0.22), hasBrand: true,
  }
}
