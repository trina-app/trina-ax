// A PowerPoint deck drawn as a PDF, a page per slide: make_file's PDF of a deck (tools/make-file.ts fromDeck) and the
// AI looking at slides (read / chat_file / room_file with pages or as_images: files/service.ts readDeck,
// chat/room-tools.ts), whose PDF then goes through the PDF page-image path (files/vision.ts). The deck is untrusted:
// it is drawn only in the office worker (files/pptx-html.ts, no network, time and memory limits) and printed by the
// isolated headless browser (files/html-pdf.ts: bwrap / sandbox-exec, no network, the print cgroup, a temp work
// folder); the page's pictures are answered from the deck's own bytes by name, never from the team folder.
// docs/decisions/20261116-pptx-to-pdf.md, docs/decisions/20261121-ai-sees-slides.md.
//
// The AI reads a deck in parts (slides 1-5, then 6-10): the PDF is kept in memory by the deck's sha256 (a few decks,
// bytes capped), so a deck is drawn once, and reads of one deck at the same time share one drawing. The cache is
// reached only after the caller's own read check of these bytes, and it is keyed by their content.
import crypto from 'node:crypto'
import { officeWorkerWrite } from './extract'
import { findPdfBrowser, HTML_PDF_LIMITS, htmlPdfUnavailable, renderHtmlPdf, renderSlot, serverFontDirs } from './html-pdf'
import { PPTX_HTML_MODE, PPTX_SLIDES_MODE, type SlidesHtml } from './pptx-html'

export interface DrawnDeck {
  pdf: Uint8Array
  /** pages in the PDF: the shown slides, or with `withHidden` every slide */
  pages: number
  /** slides hidden in the deck: left out of the PDF, unless `withHidden` */
  hidden: number
  /** with `withHidden`: the pages (= slide numbers) of the slides hidden in the deck */
  hiddenSlides: number[]
  notDrawn: SlidesHtml['notDrawn']
}

/** Why this server cannot draw a deck (null: it can): no headless browser, no isolation, too little memory. */
export function deckPdfUnavailable(): string | null {
  return htmlPdfUnavailable() ?? (findPdfBrowser() ? null : 'no headless browser is installed on this server')
}

const CACHE_ENTRIES = 6
const CACHE_BYTES = 120 * 1024 * 1024
const cache = new Map<string, DrawnDeck>()
const drawing = new Map<string, Promise<DrawnDeck>>()
let cacheBytes = 0
/** drawings done (tests: a second read of a deck draws nothing) */
export const deckPdfStats = { draws: 0 }
/** tests */
export function forgetDeckPdfs() { cache.clear(); cacheBytes = 0 }

function remember(key: string, d: DrawnDeck) {
  if (d.pdf.byteLength > CACHE_BYTES / 2) return
  cache.set(key, d)
  cacheBytes += d.pdf.byteLength
  for (const [k, v] of cache) {
    if (cache.size <= CACHE_ENTRIES && cacheBytes <= CACHE_BYTES) break
    cache.delete(k)
    cacheBytes -= v.pdf.byteLength
  }
}

/**
 * The deck as a PDF. `withHidden`: every slide, hidden ones too, so page N is slide N (the AI looking at it); without
 * it the shown slides only, as PowerPoint's PDF export (make_file). Throws ToolError (not a deck, too large, the
 * worker's limits) or HtmlPdfError (the print); the caller checks deckPdfUnavailable() first.
 */
export async function deckPdf(bytes: Uint8Array, o: { user: string; workBase: string; withHidden?: boolean; signal?: AbortSignal }): Promise<DrawnDeck> {
  const key = `${crypto.createHash('sha256').update(bytes).digest('hex')}:${o.withHidden ? 'all' : 'shown'}`
  const hit = cache.get(key)
  if (hit) {
    // the most recent last
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const running = drawing.get(key)
  if (running) {
    try { return await running } catch (e) {
      // the first reader stopped (its turn ended): draw it for this one
      if (!(e instanceof Error && e.name === 'AbortError') || o.signal?.aborted) throw e
    }
  }
  const p = draw(bytes, o)
  drawing.set(key, p)
  try {
    const d = await p
    remember(key, d)
    return d
  } finally { if (drawing.get(key) === p) drawing.delete(key) }
}

async function draw(bytes: Uint8Array, o: { user: string; workBase: string; withHidden?: boolean; signal?: AbortSignal }): Promise<DrawnDeck> {
  const browser = findPdfBrowser()
  if (!browser) throw new Error('no headless browser')
  const drawn = JSON.parse((await officeWorkerWrite(o.withHidden ? PPTX_SLIDES_MODE : PPTX_HTML_MODE, bytes, o.signal)).toString('utf8')) as SlidesHtml
  // the page's pictures are answered only from the deck's own, by name (m<n>.<ext>)
  const page = 'deck/slides.html'
  const release = await renderSlot(o.user, o.signal)
  let printed: Awaited<ReturnType<typeof renderHtmlPdf>>
  try {
    printed = await renderHtmlPdf({
      browser, html: Buffer.from(drawn.html, 'utf8'), page, workBase: o.workBase, fonts: serverFontDirs(), signal: o.signal,
      limits: { maxHtmlBytes: Math.max(HTML_PDF_LIMITS.maxHtmlBytes, 32 * 1024 * 1024) },
      asset: (p) => {
        const name = p.startsWith('deck/') ? p.slice('deck/'.length) : ''
        const b64 = /^m\d+\.[a-z]+$/.test(name) ? drawn.media[name] : undefined
        return b64 ? Buffer.from(b64, 'base64') : null
      },
    })
  } finally { release() }
  deckPdfStats.draws++
  return { pdf: new Uint8Array(printed.pdf), pages: printed.pages, hidden: drawn.hidden, hiddenSlides: drawn.hiddenSlides ?? [], notDrawn: drawn.notDrawn }
}

// ---------------- the AI's words (read, chat_file, room_file) ----------------

/** the extensions whose slides can be seen as images: what files/pptx-html.ts draws (Office Open XML decks) */
export const SLIDE_IMAGE_EXT = new Set(['pptx'])

/** The refusal of `pages` / `as_images` for a file that is neither a PDF nor a .pptx deck. */
export function pagesOnlyText(e: string): string {
  return ['ppt', 'pps', 'odp', 'key', 'pptm', 'ppsx', 'potx'].includes(e)
    ? `pages and as_images are for PDF files and PowerPoint .pptx decks; slides of a .${e} file cannot be shown as images here. Read it without them for its text, and tell the user that a copy saved as .pptx (or PDF) can be looked at slide by slide`
    : ['docx', 'xlsx'].includes(e)
    ? `this server cannot draw the pages of a .${e} file. Read it without pages and as_images for its text, and tell the user you did not see how its pages look`
    : 'pages and as_images are only for PDF files and PowerPoint (.pptx) decks'
}

/** This server cannot draw slides: what the AI does instead. */
export function slidesUnavailableText(label: string, why: string): string {
  return `the slides of ${label} cannot be shown as images on this server (${why}). Read it without pages and as_images for its text (every slide's text, speaker notes and chart data), and tell the user plainly that this server cannot show the slide pictures; never guess how a slide looks`
}

/** A drawing that failed (the worker's or the print's limits, a damaged deck). */
export function slidesFailedText(label: string, e: unknown): string {
  const why = e instanceof Error && e.message ? e.message.replace(/; nothing was saved\.?$/, '').replace(/[\r\n]+/g, ' ').slice(0, 300) : 'the drawing failed'
  return `the slides of ${label} could not be drawn as images (${why}). Its text can still be read without pages and as_images`
}

/** The first line of a deck's pages for the model (files/service.ts pdfPagesForModel `head`). */
export function slidesHead(label: string, n: number, pages: number[], list: (p: number[]) => string): string {
  return `PowerPoint ${label}: ${n} slide${n === 1 ? '' : 's'}; ${pages.length === n ? 'all slides' : `slides ${list(pages)}`} below, each drawn by the server as a picture (page N is slide N) with its text.`
}

/** What the pictures leave out, after a deck's pages: so a drawing gap is never reported as a fault of the deck. */
export function slidesNotes(d: DrawnDeck, pages: number[], list: (p: number[]) => string): string[] {
  const out: string[] = []
  const hidden = d.hiddenSlides.filter((p) => pages.includes(p))
  if (hidden.length) out.push(`Slide${hidden.length === 1 ? '' : 's'} ${list(hidden)} ${hidden.length === 1 ? 'is' : 'are'} hidden in the deck: drawn here, but left out of a slideshow and of PowerPoint's PDF export.`)
  const n = d.notDrawn
  const gaps = [
    n.charts && `${n.charts} chart${n.charts === 1 ? '' : 's'}`,
    n.diagrams && `${n.diagrams} SmartArt diagram${n.diagrams === 1 ? '' : 's'}`,
    n.objects && `${n.objects} other embedded object${n.objects === 1 ? '' : 's'}`,
    n.pictures && `${n.pictures} picture${n.pictures === 1 ? '' : 's'} in a format the drawing cannot show (EMF, WMF, TIFF) or over its limits`,
  ].filter(Boolean)
  const total = n.charts + n.diagrams + n.objects + n.pictures
  const lead = gaps.length ? `In this deck ${gaps.join(', ')} ${total === 1 ? 'is drawn as a light grey box' : 'are drawn as light grey boxes'} (chart data is in the deck's text: read it without pages). ` : ''
  out.push(`${lead}The server draws slides itself, close to PowerPoint but not exactly: shadows, gradients beyond their first colour, WordArt effects and animations are not drawn, and fonts the server lacks are replaced. Do not report these as faults of the deck.`)
  return out
}
