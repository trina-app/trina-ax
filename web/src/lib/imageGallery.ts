// The pictures of one message as an even gallery, like Slack's (docs/AGENTS/plan/20261122-0419-image-gallery-rows.md):
// rows of 2 or 3, every row as wide as the gallery, every tile in a row the same height, each picture cropped to fill
// its tile. A tile's width follows the picture's shape, kept between TALL and WIDE so no tile is a sliver, then all of a
// row's tiles widen or narrow together so the row's height stays between a lowest and a highest at GALLERY_PX wide
// (closer together when there are several rows).
// The ratios go into CSS (`aspect-ratio` with `flex-grow` of the same number), so a narrower column (a phone) scales
// the rows down and nothing is measured in script; the space is held before the thumbnails load.

/** the gallery's widest, the width the row heights below are worked out at */
export const GALLERY_PX = 480
/** the gap between tiles, in rows and between rows */
export const GALLERY_GAP_PX = 4
/** a row's lowest and highest at GALLERY_PX: one row may vary more; rows of a taller gallery stay close to each other,
 * so a tall pair under three wide pictures does not tower over them */
const ONE_ROW = { min: 120, max: 240 }
const MANY_ROWS = { min: 150, max: 190 }
const TALL = 0.6
const WIDE = 1.9

export type GalleryTile<T> = { file: T; ratio: number }

/** How many pictures go in each row: 2 → [2], 3 → [3], 4 → [2, 2], 5 → [3, 2], 7 → [3, 2, 2]: threes first, never a
 * picture alone on a row. */
export function rowSizes(n: number): number[] {
  if (n <= 0) return []
  if (n === 1) return [1]
  const sizes: number[] = []
  let left = n
  while (left > 0) {
    const size = left === 4 || left === 2 ? 2 : 3
    sizes.push(size)
    left -= size
  }
  return sizes
}

/** The rows of pictures with each tile's width : height. A picture without a stored size counts as square. */
export function galleryRows<T extends { width?: number | null; height?: number | null }>(files: readonly T[]): GalleryTile<T>[][] {
  const rows: GalleryTile<T>[][] = []
  let at = 0
  const sizes = rowSizes(files.length)
  const { min, max } = sizes.length > 1 ? MANY_ROWS : ONE_ROW
  for (const size of sizes) {
    const row = files.slice(at, at + size)
    at += size
    const shapes = row.map((f) => (f.width && f.height ? Math.min(WIDE, Math.max(TALL, f.width / f.height)) : 1))
    const sum = shapes.reduce((a, b) => a + b, 0)
    const inner = GALLERY_PX - GALLERY_GAP_PX * (row.length - 1)
    // the row's height is inner / sum: widen every tile when it would be too tall, narrow them when too low
    const scale = inner / sum > max ? inner / max / sum : inner / sum < min ? inner / min / sum : 1
    rows.push(row.map((file, i) => ({ file, ratio: Math.round(shapes[i] * scale * 1000) / 1000 })))
  }
  return rows
}
