// The image viewer's zoom and pan (components/ImageViewer.tsx), as plain numbers so they are unit-tested
// (web/test/unit/image-zoom.test.ts). A picture of `natural` size is drawn at `scale` with its top-left corner at x, y of
// the stage (the area under the bar). Fitted, it is centred and never larger than its own size: a small picture stays
// small. Zoomed, it can be panned but never leaves an empty band on a side where it is larger than the stage.

export interface Size { width: number; height: number }
export interface Point { x: number; y: number }
export interface View { scale: number; x: number; y: number }

/** the largest zoom: 400 % */
export const MAX_SCALE = 4
/** one step of +/− (keys and the bar's buttons) */
export const ZOOM_STEP = 1.5

const ok = (s: Size) => s.width > 0 && s.height > 0

/** The scale that shows the whole picture in the stage, at most 100 %. */
export function fitScale(natural: Size, stage: Size): number {
  if (!ok(natural) || !ok(stage)) return 1
  return Math.min(1, stage.width / natural.width, stage.height / natural.height)
}

/** The picture fitted and centred. */
export function fitView(natural: Size, stage: Size): View {
  const scale = fitScale(natural, stage)
  return { scale, x: (stage.width - natural.width * scale) / 2, y: (stage.height - natural.height * scale) / 2 }
}

/** Zoomed in past the fitted size (a hair over it counts as fitted). */
export const isZoomed = (view: View, natural: Size, stage: Size) => view.scale > fitScale(natural, stage) * 1.001

/** One axis: centred where the picture is smaller than the stage, else no empty band at either edge. */
function clampAxis(pos: number, size: number, room: number): number {
  if (size <= room) return (room - size) / 2
  return Math.min(0, Math.max(room - size, pos))
}

/** The view kept between the fitted size and the largest zoom, and inside the stage. */
export function clampView(view: View, natural: Size, stage: Size): View {
  const fit = fitScale(natural, stage)
  const scale = Math.min(MAX_SCALE, Math.max(fit, view.scale))
  return { scale, x: clampAxis(view.x, natural.width * scale, stage.width), y: clampAxis(view.y, natural.height * scale, stage.height) }
}

/** Zoom to `scale` keeping the point of the picture under `at` (a stage point) where it is. */
export function zoomAt(view: View, scale: number, at: Point, natural: Size, stage: Size): View {
  const fit = fitScale(natural, stage)
  const next = Math.min(MAX_SCALE, Math.max(fit, scale))
  const k = next / view.scale
  return clampView({ scale: next, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }, natural, stage)
}

/** A click's zoom from the fitted size: 100 %, or twice the fitted size for a picture already shown at 80 % or more
 * (a small picture gets 2×). */
export const clickScale = (fit: number) => (fit < 0.8 ? 1 : fit * 2)

/** A click (or a double tap) on the picture: fitted → zoomed in centred on the point; zoomed → fitted again. */
export function toggleAt(view: View, at: Point, natural: Size, stage: Size): View {
  if (isZoomed(view, natural, stage)) return fitView(natural, stage)
  return zoomAt(view, clickScale(fitScale(natural, stage)), at, natural, stage)
}

/** One step in (+1) or out (−1), stopping at 100 % on the way across it (or landing within 5 % of it) and at the fitted
 * size. */
export function stepScale(scale: number, dir: 1 | -1, fit: number): number {
  const next = dir > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP
  if (dir > 0 && scale < 0.999 && next > 0.95) return 1
  if (dir < 0 && scale > 1.001 && next < 1.05) return Math.max(1, fit)
  return Math.min(MAX_SCALE, Math.max(fit, next))
}

/** A wheel event with ⌘/Ctrl (a trackpad pinch in Chromium comes this way too): the scale it asks for. A mouse wheel's
 * notch (100 px) is about 30 %; a pinch sends many small ones. Lines (Firefox) count as 16 px. */
export function wheelScale(scale: number, deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  return scale * 2 ** (-Math.max(-50, Math.min(50, px)) / 100)
}

/** Two fingers: the start view, the fingers' distance and midpoint then and now. The point under the first midpoint
 * follows the fingers while the picture grows or shrinks with their distance. */
export function pinchView(start: View, d0: number, d1: number, m0: Point, m1: Point, natural: Size, stage: Size): View {
  if (d0 <= 0) return start
  const fit = fitScale(natural, stage)
  const scale = Math.min(MAX_SCALE, Math.max(fit, start.scale * (d1 / d0)))
  const k = scale / start.scale
  return clampView({ scale, x: m1.x - (m0.x - start.x) * k, y: m1.y - (m0.y - start.y) * k }, natural, stage)
}

/** Whether a stage point is on the picture as drawn (else it is the dark backdrop). */
export function onPicture(view: View, natural: Size, at: Point): boolean {
  return at.x >= view.x && at.y >= view.y && at.x <= view.x + natural.width * view.scale && at.y <= view.y + natural.height * view.scale
}

/** A finger let go after moving the fitted picture by dx, dy at vx, vy (px per ms): what it asks for. Down past a fifth
 * of the height, or a quick flick down, closes; sideways past a fifth of the width, or a quick flick, steps; anything
 * else puts the picture back. */
export function swipeResult(dx: number, dy: number, vx: number, vy: number, stage: Size): 'close' | 'next' | 'prev' | null {
  const flick = 0.5
  if (Math.abs(dy) >= Math.abs(dx)) return dy > stage.height / 5 || (vy > flick && dy > 40) ? 'close' : null
  if (Math.abs(dx) > stage.width / 5 || (Math.abs(vx) > flick && Math.abs(dx) > 40)) return dx < 0 ? 'next' : 'prev'
  return null
}

/** The size to lay a picture out at before its original has loaded: the original's stored size when its shape matches
 * the thumbnail's (a photo stored landscape before the server knew it was upright would not), else the thumbnail's. */
export function layoutSize(original: Size | null, stored: Partial<Size> | undefined, thumb: Size | null): Size | null {
  if (original && ok(original)) return original
  const known = stored?.width && stored.height ? { width: stored.width, height: stored.height } : null
  if (known && (!thumb || !ok(thumb) || Math.abs(known.width / known.height - thumb.width / thumb.height) < 0.05)) return known
  return thumb && ok(thumb) ? thumb : known
}
