// The image viewer's document stage (components/ImageViewer.tsx; docs/DECISIONS.md "The room file viewer"): a file sent
// in a room, DM, group chat or thread, opened from its chip, drawn by FileBody (the side panel's body: the same
// renderers, limits and reads through the room) in a reading column up to 960 px wide that scrolls by itself. A PDF
// keeps its own toolbar (zoom, fit to width) and, on a computer, gets its page thumbnails in a rail left of the column
// (viewers/PdfView `thumbnails`), a sheet keeps its tabs; the keys ↑ ↓ PageUp PageDown Space scroll it (it is in
// the Tab order, named by the file); the wheel over the dark sides scrolls it too. A link in it that opens the side
// panel (a team file named in a Markdown file) closes the viewer, which would cover the panel.
// A file with no preview here (no viewer for its kind, a Hangul file while the HWP preview is off, past the preview
// limit) is its card at once, with nothing read: its type, name, size, why, and the download. So is a download-only
// file (the inline read answers 503 quarantined) and one the read could not find, once read. A file whose message was
// deleted while it was open is the card that says it is no longer available, without the download.
// Phones: a swipe sideways steps to the next or previous file, only where nothing under the finger scrolls sideways (a
// zoomed PDF, a wide sheet or code block keep their own scroll); a frame (HTML, SVG) never passes touches up, so the
// bar's ‹ › step there.
import { Download, File as FileIcon, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Presentation } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { closeImageViewer, documentSwipe, type ViewerItem } from '../lib/imageViewer'
import { formatSize } from '../lib/format'
import { extOf } from '../lib/paths'
import { iconKind, type FileIconKind } from '../lib/preview'
import { getSidePanel, type PreviewFile } from '../lib/sidePanel'
import { useLocale, useT } from '../i18n'
import FileBody, { bodyRenderer, useFileBlob } from './FileBody'
import { Button } from './ui'

const ICONS: Record<FileIconKind, typeof FileIcon> = { folder: Folder, image: FileImage, pdf: FileText, doc: FileText, sheet: FileSpreadsheet, slides: Presentation, audio: FileAudio, video: FileVideo, code: FileCode, archive: FileArchive, text: FileText, other: FileIcon }

/** a picture inside a document is shown where it is: no second viewer over this one */
const stay = () => {}

type Swipe = (dir: 'next' | 'prev') => void

/** A finger's swipe sideways on a document or a card steps (phones), unless something under it scrolls sideways. */
function useSwipe(onSwipe: Swipe) {
  const touch = useRef<{ x: number; y: number; t: number; sideways: boolean } | null>(null)
  return {
    onTouchStart: (e: React.TouchEvent<HTMLElement>) => {
      const p = e.touches[0]
      touch.current = e.touches.length === 1 && p ? { x: p.clientX, y: p.clientY, t: e.timeStamp, sideways: scrollsSideways(e.target as Element, e.currentTarget) } : null
    },
    onTouchEnd: (e: React.TouchEvent<HTMLElement>) => {
      const s = touch.current
      touch.current = null
      const p = e.changedTouches[0]
      if (!s || s.sideways || !p) return
      const dir = documentSwipe(p.clientX - s.x, p.clientY - s.y, e.timeStamp - s.t)
      if (dir) onSwipe(dir)
    },
    onTouchCancel: () => {
      touch.current = null
    },
  }
}

/** `onMissing`: the read found no such file (the bar then drops its download too). */
export function ViewerDocument({ item, gone, onSwipe, onMissing }: { item: ViewerItem; gone: boolean; onSwipe: Swipe; onMissing: () => void }) {
  const t = useT()
  const locale = useLocale()
  const swipe = useSwipe(onSwipe)
  if (gone)
    return (
      <div className="h-full overflow-auto" {...swipe}>
        <FileCard item={item} note={t('viewer.gone')} />
      </div>
    )
  if (item.card || !item.file)
    return (
      <div className="h-full overflow-auto" {...swipe}>
        <FileCard item={item} note={item.card === 'large' && item.size !== undefined ? t('preview.tooLarge', { size: formatSize(item.size, locale) }) : t('preview.unsupported')} download={item.download} />
      </div>
    )
  return <DocumentBody key={item.key} item={item} file={item.file} onSwipe={onSwipe} onMissing={onMissing} />
}

function DocumentBody({ item, file: given, onSwipe, onMissing }: { item: ViewerItem; file: PreviewFile; onSwipe: Swipe; onMissing: () => void }) {
  const t = useT()
  // the file as first given: the chip builds its item anew on each render, and a new object would read it again (the
  // body is drawn anew, keyed, for another file)
  const [file] = useState(given)
  const [rev, setRev] = useState(0)
  const loaded = useFileBlob(file, rev)
  const renderer = bodyRenderer(loaded)
  const missing = loaded.error?.kind === 'missing'
  useEffect(() => {
    if (missing) onMissing()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing])
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  // a PDF's page thumbnails, left of the column (viewers/PdfView draws them in it on computers; empty otherwise)
  const [rail, setRail] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  // the viewers fit the column's width (a PDF's pages, a deck's slides)
  useLayoutEffect(() => {
    if (!box) return
    const ro = new ResizeObserver(() => setWidth(box.clientWidth))
    ro.observe(box)
    setWidth(box.clientWidth)
    return () => ro.disconnect()
  }, [box])
  // the keys scroll the column: it takes the focus from the stage around it (not from a button the person is on)
  useEffect(() => {
    const a = document.activeElement
    if (box && (!a || a === document.body || a === stageOf(box))) box.focus({ preventScroll: true })
  }, [box])
  // the wheel over the dark sides scrolls the column, as Slack's does (a pinch or ⌘/Ctrl + wheel is left to the page);
  // the thumbnails scroll themselves
  useEffect(() => {
    const stage = box && stageOf(box)
    if (!box || !stage) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || box.contains(e.target as Node) || rail?.contains(e.target as Node)) return
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.clientHeight : 1
      box.scrollBy({ left: e.deltaX * k, top: e.deltaY * k })
    }
    stage.addEventListener('wheel', onWheel, { passive: true })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [box, rail])
  // a link in the document that opens the side panel (a team file named in a Markdown file): the panel is under the
  // viewer, so the viewer closes and leaves it in view, as 패널에서 열기 does
  const onClickCapture = () => {
    const before = getSidePanel()
    // after the click's handlers have all run
    setTimeout(() => {
      if (getSidePanel() !== before) closeImageViewer()
    })
  }
  const swipe = useSwipe(onSwipe)
  // download-only (the safety check holds it), a format the server could not convert, or the read failed: the card with
  // the read's own words (a file not found has nothing to download), in the same scroll box, so the focus stays
  const card = renderer === 'card' || renderer === 'error'

  // the side panel's shape: a surface, and in it the scroll box FileBody fills (a sheet keeps its tabs in view); a PDF's
  // thumbnails on its left, the two centred together
  return (
    <div className="flex h-full w-full justify-center">
      <div ref={setRail} className="h-full shrink-0 empty:hidden" data-testid="file-viewer-rail" />
      <div className={card ? 'h-full w-full' : 'h-full w-full max-w-[960px] min-w-0 bg-surface text-ink'}>
        <div
          ref={setBox}
          tabIndex={0}
          role="region"
          aria-label={item.name}
          className={card ? 'h-full overflow-auto outline-none' : 'h-full overflow-auto bg-subtle/50 outline-none select-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset'}
          onClickCapture={onClickCapture}
          {...swipe}
          data-testid="file-viewer-body"
          data-renderer={renderer}
        >
          {card ? (
            <FileCard item={item} note={loaded.error?.text ?? t('preview.unsupported')} download={missing ? undefined : item.download} />
          ) : (
            <FileBody file={file} loaded={loaded} width={width} download={item.download ?? stay} onRetry={() => setRev((v) => v + 1)} openPicture={stay} thumbnails={rail} />
          )}
        </div>
      </div>
    </div>
  )
}

/** the viewer's stage around a document */
const stageOf = (el: Element) => el.closest<HTMLElement>('[data-viewer-stage]')

/** Whether something between `from` (a finger, a focused element) and `until` (the column or the stage, included)
 * scrolls sideways: a zoomed PDF, a wide sheet or table, a long code line. A swipe or ← → there is that scroll's, never
 * a step. */
export function scrollsSideways(from: Element | null, until: Element): boolean {
  for (let el: Element | null = from; el; el = el === until ? null : el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const x = getComputedStyle(el).overflowX
      if (x === 'auto' || x === 'scroll') return true
    }
  }
  return false
}

/** The file's card on the dark stage: its type, name and size, a line saying why there is no preview, and the download
 * when there is one. */
function FileCard({ item, note, download }: { item: ViewerItem; note: string; download?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const Icon = ICONS[iconKind(item.name)]
  const type = extOf(item.name).toUpperCase()
  const size = item.size === undefined ? null : formatSize(item.size, locale)
  return (
    <div className="flex min-h-full items-center justify-center p-6" data-testid="file-viewer-card">
      <div className="flex w-full max-w-sm flex-col items-center gap-2 rounded-2xl border border-white/10 bg-[#1c1c1b] px-6 py-8 text-center">
        <Icon size={44} strokeWidth={1.5} className="mb-1 text-white/70" aria-hidden />
        <p className="max-w-full text-base font-medium break-words text-white" data-testid="file-viewer-card-name">{item.name}</p>
        {(type || size) && <p className="text-xs text-white/60 tabular-nums">{[type, size].filter(Boolean).join(' · ')}</p>}
        <p className="mt-1 text-sm break-keep text-white/80" role="status" data-testid="file-viewer-card-note">{note}</p>
        {download && (
          <Button variant="primary" onClick={download} className="mt-3" data-testid="file-viewer-card-download">
            <Download size={16} aria-hidden /> {t('common.download')}
          </Button>
        )}
      </div>
    </div>
  )
}
