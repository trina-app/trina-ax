// An SVG logo drawn to a PNG, for the team logo's AI help only (docs/decisions/20261128-team-icon-ai-assist.md): when a
// company's logo exists only as SVG (gojek, many shops), the AI's look (onboarding/site-icon-ai.ts logo_look) draws it
// here and then judges and normalises the PNG like any other picture. The rules (site-icon.ts) still never take SVG.
//
// The browser is HTML to PDF's (files/html-pdf.ts runBrowser: the pinned chrome-headless-shell of
// scripts/system/packages.json, found by findPdfBrowser, in the converters' isolation with no network and a host resolver
// that resolves nothing, never as root, killed with all its processes at the end, memory and disk caps). On top of that:
// - JavaScript off (browserArgs without scripts, and Emulation.setScriptExecutionDisabled).
// - The SVG is shown as an <img> of a fixed page: a browser draws an SVG image in its secure static mode (no scripts, no
//   animation, no external resource of any kind), and the page's CSP is default-src 'none' with only that one image.
// - Every request is answered by the server (DevTools Fetch): the page, the one SVG; anything else is failed.
// - One time limit (SVG_RASTER_LIMITS.timeoutMs) and one of HTML to PDF's print slots (tryRenderSlot: a busy server skips).
// - At most SVG_RASTER_LIMITS.maxSvgBytes of SVG; its size from the root <svg>'s width, height or viewBox (svgAspect), the
//   long side drawn at SVG_RASTER_LIMITS.side px, so a wide wordmark stays wide (and then fails the square rule).
// Without a browser or the isolation: null (the SVG is skipped, as before).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findPdfBrowser, htmlPdfUnavailable, HtmlPdfError, runBrowser, tryRenderSlot, type Cdp } from '../files/html-pdf'
import { makeWorkDir } from '../tools/isolate'

export const SVG_RASTER_LIMITS = {
  timeoutMs: 10_000,
  maxSvgBytes: 512 * 1024,
  /** the long side of the drawn picture */
  side: 512,
  maxRssMiB: 768,
  maxWorkBytes: 64 * 1024 * 1024,
}
const ORIGIN = 'https://svg-raster.invalid'
const PAGE = `${ORIGIN}/`
const IMAGE = `${ORIGIN}/logo.svg`
const CSP = `default-src 'none'; img-src ${ORIGIN}; style-src 'unsafe-inline'`
let draws = 0

/** Is it SVG by its bytes (an XML or <svg> start, a root <svg> element in the first 64 KiB)? Never by a name or a type. */
export function isSvgBytes(b: Uint8Array): boolean {
  const head = Buffer.from(b.buffer, b.byteOffset, Math.min(b.byteLength, 64 * 1024)).toString('utf8').replace(/^﻿/, '').trimStart()
  if (!/^(<\?xml|<!--|<!doctype svg|<svg[\s>])/i.test(head)) return false
  return /<svg[\s>]/i.test(head)
}

const length = (raw: string | undefined): number | null => {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(raw ?? '')
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 && n < 100_000 ? n : null
}

/** width / height of an SVG from its root element: width and height in px (or plain numbers), else the viewBox; null
 * when it says neither (a picture whose shape is unknown is not drawn). */
export function svgAspect(svg: string): number | null {
  const m = /<svg\b([^>]{0,4000})>/i.exec(svg.slice(0, 64 * 1024))
  if (!m) return null
  const attrs = new Map<string, string>()
  for (const a of m[1]!.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs.set(a[1]!.toLowerCase(), a[3] ?? a[4] ?? '')
  const w = length(attrs.get('width')), h = length(attrs.get('height'))
  if (w && h) return w / h
  const vb = (attrs.get('viewbox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0) return vb[2]! / vb[3]!
  return null
}

/** The drawn size for an aspect: the long side SVG_RASTER_LIMITS.side, the short at least 1 px. */
export function drawnSize(aspect: number, side = SVG_RASTER_LIMITS.side): { width: number; height: number } {
  const a = Math.min(Math.max(aspect, 1 / 64), 64)
  return a >= 1 ? { width: side, height: Math.max(1, Math.round(side / a)) } : { width: Math.max(1, Math.round(side * a)), height: side }
}

export interface SvgRasterOptions {
  /** the browser (default: findPdfBrowser when the isolation is here); null: none */
  browser?: string | null
  signal?: AbortSignal
  limits?: Partial<typeof SVG_RASTER_LIMITS>
  workBase?: string
}

/** The SVG drawn as a PNG with a see-through background, or null (not an SVG, too large, no shape, no browser, a busy
 * server, a failure or the time limit). */
export async function rasteriseSvg(svgBytes: Uint8Array, o: SvgRasterOptions = {}): Promise<Buffer | null> {
  const L = { ...SVG_RASTER_LIMITS, ...o.limits }
  if (svgBytes.byteLength > L.maxSvgBytes || !isSvgBytes(svgBytes)) return null
  const aspect = svgAspect(Buffer.from(svgBytes).toString('utf8'))
  if (!aspect) return null
  const browser = o.browser === undefined ? (htmlPdfUnavailable() ? null : findPdfBrowser()) : o.browser
  if (!browser || o.signal?.aborted) return null
  const release = tryRenderSlot(`svg-raster:${++draws}`)
  if (!release) return null
  let work: string | null = null
  try {
    work = makeWorkDir(path.join(o.workBase ?? os.tmpdir(), 'work'))
    const size = drawnSize(aspect, L.side)
    const { value } = await runBrowser(work, {
      browser, signal: o.signal, limits: { timeoutMs: L.timeoutMs, maxRssMiB: L.maxRssMiB, maxWorkBytes: L.maxWorkBytes }, scripts: false,
      maxMessage: 16 * 1024 * 1024, tooLarge: () => new HtmlPdfError('protocol', 'the drawn logo is too large'),
      timeoutText: 'the logo took too long to draw', memoryText: 'the logo needs too much memory to draw',
    }, (cdp, race) => draw(cdp, race, Buffer.from(svgBytes), size, L.timeoutMs))
    return value
  } catch {
    return null
  } finally {
    release()
    if (work) fs.rmSync(work, { recursive: true, force: true })
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function draw(cdp: Cdp, race: <T>(x: Promise<T>) => Promise<T>, svg: Buffer, size: { width: number; height: number }, timeoutMs: number): Promise<Buffer | null> {
  const deadline = Date.now() + timeoutMs
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}img{display:block;width:${size.width}px;height:${size.height}px}</style></head><body><img src="${IMAGE}" alt=""></body></html>`
  let pageServed = false, imageServed = false
  const life = new Map<string, Set<string>>()
  cdp.on('Page.lifecycleEvent', (e: { name: string; loaderId: string }) => { const s = life.get(e.loaderId) ?? new Set(); s.add(e.name); life.set(e.loaderId, s) })
  const { targetId } = await race(cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }))
  const { sessionId } = await race(cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }))
  const s = <T = unknown>(method: string, params: Record<string, unknown> = {}) => race(cdp.send<T>(method, params, sessionId))
  cdp.on('Fetch.requestPaused', (e: { requestId: string; request: { url: string; method: string }; resourceType: string }, sid) => {
    const fail = () => cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }, sid)
    const fulfill = (type: string, body: Buffer, extra: { name: string; value: string }[] = []) => cdp.send('Fetch.fulfillRequest', {
      requestId: e.requestId, responseCode: 200, body: body.toString('base64'),
      responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'X-Content-Type-Options', value: 'nosniff' }, { name: 'Cache-Control', value: 'no-store' }, ...extra],
    }, sid)
    const answer = (): Promise<unknown> => {
      if (e.request.method !== 'GET') return fail()
      // the page, once, and the one picture, once; nothing else (a font, another picture, a frame, a reload)
      if (e.resourceType === 'Document' && e.request.url === PAGE && !pageServed) { pageServed = true; return fulfill('text/html; charset=utf-8', Buffer.from(html), [{ name: 'Content-Security-Policy', value: CSP }]) }
      if (e.resourceType === 'Image' && e.request.url === IMAGE && !imageServed) { imageServed = true; return fulfill('image/svg+xml', svg) }
      return fail()
    }
    answer().catch(() => {})
  })
  await race(cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {}))
  await s('Page.enable')
  await s('Page.setLifecycleEventsEnabled', { enabled: true })
  await s('Emulation.setScriptExecutionDisabled', { value: true })
  await s('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false })
  await s('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  await s('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  const nav = await s<{ errorText?: string; loaderId?: string }>('Page.navigate', { url: PAGE })
  if (nav.errorText || !nav.loaderId) return null
  const has = (name: string) => life.get(nav.loaderId!)?.has(name) ?? false
  while (!has('load') && Date.now() < deadline) await race(wait(25))
  if (!has('load') || !imageServed) return null
  const shot = await s<{ data?: string }>('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }, captureBeyondViewport: false })
  const png = shot.data ? Buffer.from(shot.data, 'base64') : null
  return png && png.length > 8 && png[0] === 0x89 && png[1] === 0x50 ? png : null
}
