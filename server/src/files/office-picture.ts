// What edit_office's insert_picture and move_picture share for PowerPoint and Excel (pptx-edit.ts, xlsx-edit.ts).
export const mmToEmu = (mm: number) => Math.round(mm * 36_000)
export const emuToMm = (emu: number) => Math.round(emu / 3_600) / 10
export const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
export const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DEFAULT_WIDTH_MM = 50

/** A picture's size in EMU, keeping the shape w:h: from a width, a height, or inside both. Neither: `current`, or the default width. */
export function fitPicture(w: number, h: number, widthMm?: number, heightMm?: number, current?: { cx: number; cy: number }): { cx: number; cy: number } {
  const W = widthMm === undefined ? undefined : mmToEmu(widthMm), H = heightMm === undefined ? undefined : mmToEmu(heightMm)
  if (W === undefined && H === undefined && current) return current
  const k = W !== undefined && H !== undefined ? Math.min(W / w, H / h) : W !== undefined ? W / w : H !== undefined ? H / h : mmToEmu(DEFAULT_WIDTH_MM) / w
  return { cx: Math.max(1, Math.round(w * k)), cy: Math.max(1, Math.round(h * k)) }
}

/** The picture a change names: its number (1-based) or its name, any case. */
export function pickPicture<T>(pics: T[], nameOf: (p: T) => string, sel: unknown): T | undefined {
  return typeof sel === 'number' ? pics[sel - 1] : pics.find((p) => nameOf(p).toLowerCase() === String(sel).trim().toLowerCase())
}
export const pictureList = <T>(pics: T[], nameOf: (p: T) => string) => pics.map((p, k) => `${k + 1} ${JSON.stringify(nameOf(p))}`).join(', ') || 'none'

/** A name no other picture on the slide or sheet has. */
export function freePictureName(names: Set<string>, id: number): string {
  let n = id
  while (names.has(`picture ${n}`)) n++
  names.add(`picture ${n}`)
  return `Picture ${n}`
}
export const shapeIds = (xml: string) => [...xml.matchAll(/<(?:[\w.-]+:)?cNvPr\b[^>]*?\sid\s*=\s*["'](\d+)/g)].map((m) => Number(m[1]))
export const shapeNames = (xml: string) => new Set([...xml.matchAll(/<(?:[\w.-]+:)?cNvPr\b[^>]*?\sname\s*=\s*["']([^"']*)/g)].map((m) => m[1]!.toLowerCase()))
