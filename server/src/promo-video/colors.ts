// Brand colour rules of the promo video templates (docs/DECISIONS.md "V"), the card news' rule by ratio carried over:
// text on a brand-coloured area is white or near-black, whichever reaches 4.5:1 (the higher one when neither does); the
// brand colour used as text on paper is darkened, hue kept, until it reaches 4.5:1; used as light on the dark style it
// is lightened until it reaches 4.5:1 there. A colour is only ever "#rrggbb" here (the server checked it).

type Rgb = [number, number, number]

export const isHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s)

function rgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const hex = ([r, g, b]: Rgb) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')

/** WCAG relative luminance */
export function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

/** `a` moved toward `b` by `t` (0–1) */
export function mix(a: string, b: string, t: number): string {
  const p = rgb(a), q = rgb(b)
  return hex([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t])
}

export const WHITE = '#ffffff'
export const INK = '#111111'

/** Text on a brand-coloured area: white or near-black by 4.5:1. */
export function onColor(bg: string): string {
  const w = contrast(bg, WHITE), k = contrast(bg, INK)
  if (w >= 4.5) return WHITE
  if (k >= 4.5) return INK
  return w >= k ? WHITE : INK
}

/** The colour itself when it reaches `ratio` against `bg`; else moved step by step toward `toward` (black to darken,
 * white to lighten) until it does. */
export function towardContrast(color: string, bg: string, ratio: number, toward: string): string {
  if (contrast(color, bg) >= ratio) return color
  for (let t = 0.05; t <= 1; t += 0.05) {
    const c = mix(color, toward, t)
    if (contrast(c, bg) >= ratio) return c
  }
  return toward
}

function hsl(hexColor: string): [number, number, number] {
  const [r, g, b] = rgb(hexColor).map((v) => v / 255) as Rgb
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}
function fromHsl([h, s, l]: [number, number, number]): string {
  if (s === 0) return hex([l * 255, l * 255, l * 255])
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
  const f = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p }
  return hex([f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255])
}
/** The colour made lighter with its hue and saturation kept (a dark brand as a light on the dark style), until it
 * reaches `ratio` against `bg`; white when even that does not. */
export function lightenToContrast(color: string, bg: string, ratio: number): string {
  if (contrast(color, bg) >= ratio) return color
  const [h, s, l] = hsl(color)
  for (let x = l; x <= 0.97; x += 0.02) {
    const c = fromHsl([h, Math.max(s, 0.45), x])
    if (contrast(c, bg) >= ratio) return c
  }
  return '#ffffff'
}

/** A saturated-enough colour to read as a brand colour, not a grey (a grey brand keeps the neutral palette). */
export function isGrey(color: string): boolean {
  const [r, g, b] = rgb(color)
  return Math.max(r, g, b) - Math.min(r, g, b) < 18
}
