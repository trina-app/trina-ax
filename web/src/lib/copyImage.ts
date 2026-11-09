// A picture on the clipboard: the image viewer's 복사 and ⌘C / Ctrl+C (components/ImageViewer.tsx, docs/DECISIONS.md
// "The image viewer's 복사").
// - What goes: the picture the viewer drew, never a new request or address. A PNG whose bytes the page has goes as it
//   is; anything else (a JPEG, WebP or GIF, the server's JPEG of a HEIC, a PNG drawn from its address) is drawn on a
//   canvas and goes as a PNG, the one picture type every browser takes. Nothing is painted behind it: transparency
//   stays. A canvas too big to make (iOS Safari's limit) is tried once more within the limits, and the result says so.
// - How: one ClipboardItem whose PNG is a promise, made and written inside the click or key press (Safari takes the
//   write only there; the drawing may finish later). A copy given up (another copy, the viewer closed) writes nothing:
//   its PNG never comes, so a picture never lands on the clipboard over something copied since.
// - Where: only where it works (canCopyImage), so the button is never one that does nothing: a secure page (the async
//   clipboard exists only there) with ClipboardItem that takes image/png. The desktop app's team page may write the
//   clipboard (desktop/src/main/security.ts) and is always https or this machine. An Android WebView (the phone app's,
//   a chat app's in-app browser) puts no picture on the clipboard, so it has no button; the iPhone app's WebView and
//   Safari take one.
import { mobileApp } from './mobile'

type ItemClass = typeof ClipboardItem & { supports?: (type: string) => boolean }

export interface CopyImageEnv {
  clipboard?: Pick<Clipboard, 'write'> | null
  ClipboardItem?: ItemClass | null
  /** inside an Android WebView (the phone app's, an in-app browser's): it writes no picture to the clipboard */
  androidWebView?: boolean
}

/** An Android WebView says so in its user agent ("; wv)"); the phone app's is one. */
export const isAndroidWebView = (ua: string): boolean => /Android/i.test(ua) && /;\s*wv\)/.test(ua)

const pageEnv = (): CopyImageEnv => ({
  clipboard: typeof navigator !== 'undefined' ? (navigator.clipboard ?? null) : null,
  ClipboardItem: typeof ClipboardItem !== 'undefined' ? ClipboardItem : null,
  androidWebView: mobileApp()?.platform === 'android' || (typeof navigator !== 'undefined' && isAndroidWebView(navigator.userAgent ?? '')),
})

/** Whether this page can put a picture on the clipboard (else the viewer shows no 복사). */
export function canCopyImage(env: CopyImageEnv = pageEnv()): boolean {
  const Item = env.ClipboardItem
  if (!Item || typeof env.clipboard?.write !== 'function' || env.androidWebView) return false
  // ClipboardItem.supports (Chromium 121, Safari 17.4, Firefox 127): asked where the browser has it
  return typeof Item.supports !== 'function' || Item.supports('image/png') === true
}

/** ⌘C or Ctrl+C, held down once. With a Korean (or any non-Latin) input source the key is that letter (ㅊ): the key's
 * place then says it is C. */
export function isCopyKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.repeat) return false
  return e.key.toLowerCase() === 'c' || (e.code === 'KeyC' && !/^[a-z]$/i.test(e.key))
}

/** A picture to draw: the element on the page and the size to draw it at. */
export interface Drawn {
  img: CanvasImageSource
  width: number
  height: number
}

/** The picture the viewer shows: the original once it has loaded, else the thumbnail on screen (`thumb`); null: none. */
export type PickPicture = () => Promise<{ drawn: Drawn; thumb: boolean } | null>

export interface CopyRequest {
  /** the picture's own bytes, when the page has them (a picture in a message box, the panel's): a PNG goes as it is */
  blob?: Blob | null
  pick: PickPicture
  /** aborted: the copy is given up (another copy, the viewer closed); nothing is written */
  signal?: AbortSignal
}

/** Why a copy did not happen: the browser refused the clipboard, the picture is too big to draw, nothing has loaded,
 * anything else; `cancelled`: given up on purpose (the signal), nothing to tell. */
export type CopyFailure = 'denied' | 'tooBig' | 'notLoaded' | 'failed' | 'cancelled'

/** ok: on the clipboard; `smaller`: not the original (`thumb`: the thumbnail, as no original was drawn; `scaled`: the
 * original drawn smaller, as it was too big for a canvas). */
export type CopyResult = { ok: true; smaller: 'thumb' | 'scaled' | null } | { ok: false; reason: CopyFailure }

/** PNG bytes of a drawn picture at this size; null: no canvas this big could be made. Throws for anything else. */
export type EncodePng = (d: Drawn, width: number, height: number) => Promise<Blob | null>

/** iOS Safari's largest canvas (4096 × 4096 pixels) and the longest side every browser draws: the limits a picture too
 * big for a canvas is tried again within */
export const SAFE_CANVAS_AREA = 4096 * 4096
export const SAFE_CANVAS_SIDE = 16384

/** The picture drawn on a canvas as a PNG (alpha kept: nothing is painted first). */
export const canvasPng: EncodePng = (d, width, height) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext('2d')
  if (!g) return Promise.resolve(null)
  g.drawImage(d.img, 0, 0, width, height)
  return new Promise<Blob | null>((resolve, reject) => {
    try {
      canvas.toBlob(resolve, 'image/png')
    } catch (e) {
      reject(e) // a canvas the page may not read (never for the app's own pictures)
    }
  }).finally(() => {
    // the memory goes at once (Safari keeps a canvas's pixels until it is collected)
    canvas.width = 0
    canvas.height = 0
  })
}

class Refused extends Error {
  constructor(readonly reason: CopyFailure) {
    super(reason)
  }
}

async function pngOf(req: CopyRequest, encode: EncodePng): Promise<{ blob: Blob; smaller: 'thumb' | 'scaled' | null }> {
  if (req.blob?.type === 'image/png') return { blob: req.blob, smaller: null }
  const got = await req.pick()
  if (req.signal?.aborted) throw new Refused('cancelled')
  if (!got || !got.drawn.width || !got.drawn.height) throw new Refused('notLoaded')
  const { drawn, thumb } = got
  const full = await encode(drawn, drawn.width, drawn.height)
  if (full) return { blob: full, smaller: thumb ? 'thumb' : null }
  if (req.signal?.aborted) throw new Refused('cancelled')
  const k = Math.min(Math.sqrt(SAFE_CANVAS_AREA / (drawn.width * drawn.height)), SAFE_CANVAS_SIDE / Math.max(drawn.width, drawn.height))
  if (k >= 1) throw new Refused('failed')
  const less = await encode(drawn, Math.max(1, Math.floor(drawn.width * k)), Math.max(1, Math.floor(drawn.height * k)))
  if (!less) throw new Refused('tooBig')
  return { blob: less, smaller: thumb ? 'thumb' : 'scaled' }
}

/** The signal's abort as a rejection (never settles without one). */
function onAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return
    const stop = () => reject(new Refused('cancelled'))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
}

/** Put the picture on the clipboard as a PNG. Call it inside the click or key press. Never rejects. */
export async function copyImage(req: CopyRequest, env: CopyImageEnv = pageEnv(), encode: EncodePng = canvasPng): Promise<CopyResult> {
  const Item = env.ClipboardItem
  if (!Item || !env.clipboard) return { ok: false, reason: 'failed' }
  // set before the write hears of it: a picture that could not be drawn (or a copy given up) is the reason, not the
  // write's own error
  let drawFailure: CopyFailure | null = null
  let smaller: 'thumb' | 'scaled' | null = null
  // a copy given up while its picture loads or draws: the PNG never comes, so the write puts nothing on the clipboard
  const bytes = Promise.race([pngOf(req, encode), onAbort(req.signal)]).then(
    (p) => {
      smaller = p.smaller
      return p.blob
    },
    (err: unknown) => {
      drawFailure = err instanceof Refused ? err.reason : 'failed'
      throw err
    },
  )
  // the write may fail before it reads the promise (no click to copy in): nothing is left unhandled
  bytes.catch(() => {})
  try {
    await env.clipboard.write([new Item({ 'image/png': bytes })])
    return { ok: true, smaller }
  } catch (e) {
    if (drawFailure) return { ok: false, reason: drawFailure }
    if (req.signal?.aborted) return { ok: false, reason: 'cancelled' }
    return { ok: false, reason: (e as { name?: unknown } | null)?.name === 'NotAllowedError' ? 'denied' : 'failed' }
  }
}
