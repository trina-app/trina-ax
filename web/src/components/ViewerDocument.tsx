// The image viewer's document stage (components/ImageViewer.tsx; docs/DECISIONS.md "The room file viewer"): a file sent
// in a room, DM, group chat or thread, opened from its chip, drawn by FileBody (the side panel's body: the same
// renderers, limits and reads through the room) in a reading column up to 960 px wide that scrolls by itself. A PDF
// keeps its own toolbar (zoom, fit to width); the keys ↑ ↓ PageUp PageDown Space scroll it; the wheel over the dark
// sides scrolls it too.
// A file with no preview here (no viewer for its kind, a Hangul file while the HWP preview is off, past the preview
// limit) is its card at once, with nothing read: its type, name, size, why, and the download. So is a download-only
// file (the inline read answers 503 quarantined) and one the read could not find, once read. A file whose message was
// deleted while it was open is the card that says it is no longer available, without the download.
// Phones: a swipe sideways steps to the next or previous file, only where nothing under the finger scrolls sideways (a
// zoomed PDF, a wide sheet or code block keep their own scroll); a frame (HTML, SVG) never passes touches up, so the
// bar's ‹ › step there.
import { Download, File as FileIcon, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Presentation } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { documentSwipe, type ViewerItem } from '../lib/imageViewer'
import { formatSize } from '../lib/format'
import { extOf } from '../lib/paths'
import { iconKind, type FileIconKind } from '../lib/preview'
import type { PreviewFile } from '../lib/sidePanel'
import { useLocale, useT } from '../i18n'
import FileBody, { bodyRenderer, useFileBlob } from './FileBody'
import { Button } from './ui'

const ICONS: Record<FileIconKind, typeof FileIcon> = { folder: Folder, image: FileImage, pdf: FileText, doc: FileText, sheet: FileSpreadsheet, slides: Presentation, audio: FileAudio, video: FileVideo, code: FileCode, archive: FileArchive, text: FileText, other: FileIcon }

/** a picture inside a document is shown where it is: no second viewer over this one */
const stay = () => {}

export function ViewerDocument({ item, gone, onSwipe }: { item: ViewerItem; gone: boolean; onSwipe: (dir: 'next' | 'prev') => void }) {
  const t = useT()
  const locale = useLocale()
  if (gone) return <div className="h-full overflow-auto"><FileCard item={item} note={t('viewer.gone')} /></div>
  if (item.card || !item.file)
    return (
      <div className="h-full overflow-auto">
        <FileCard item={item} note={item.card === 'large' && item.size !== undefined ? t('preview.tooLarge', { size: formatSize(item.size, locale) }) : t('preview.unsupported')} download={item.download} />
      </div>
    )
  return <DocumentBody key={item.key} item={item} file={item.file} onSwipe={onSwipe} />
}

function DocumentBody({ item, file, onSwipe }: { item: ViewerItem; file: PreviewFile; onSwipe: (dir: 'next' | 'prev') => void }) {
  const t = useT()
  const [rev, setRev] = useState(0)
  const loaded = useFileBlob(file, rev)
  const renderer = bodyRenderer(loaded)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
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
    if (box && (!a || a === document.body || a === box.parentElement)) box.focus({ preventScroll: true })
  }, [box])
  // the wheel over the dark sides scrolls the column, as Slack's does (a pinch or ⌘/Ctrl + wheel is left to the page)
  useEffect(() => {
    const stage = box?.parentElement
    if (!box || !stage) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || box.contains(e.target as Node)) return
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.clientHeight : 1
      box.scrollBy({ left: e.deltaX * k, top: e.deltaY * k })
    }
    stage.addEventListener('wheel', onWheel, { passive: true })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [box])
  const touch = useRef<{ x: number; y: number; t: number; sideways: boolean } | null>(null)
  // download-only (the safety check holds it), a format the server could not convert, or the read failed: the card with
  // the read's own words (a file not found has nothing to download), in the same scroll box, so the focus stays
  const card = renderer === 'card' || renderer === 'error'

  return (
    <div
      ref={setBox}
      tabIndex={-1}
      className={card ? 'h-full w-full overflow-auto outline-none' : 'mx-auto h-full w-full max-w-[960px] overflow-auto bg-surface text-ink outline-none select-text'}
      onTouchStart={(e) => {
        const p = e.touches[0]
        touch.current = e.touches.length === 1 && p ? { x: p.clientX, y: p.clientY, t: e.timeStamp, sideways: scrollsSideways(e.target as Element, e.currentTarget) } : null
      }}
      onTouchEnd={(e) => {
        const s = touch.current
        touch.current = null
        const p = e.changedTouches[0]
        if (!s || s.sideways || !p) return
        const dir = documentSwipe(p.clientX - s.x, p.clientY - s.y, e.timeStamp - s.t)
        if (dir) onSwipe(dir)
      }}
      onTouchCancel={() => {
        touch.current = null
      }}
      data-testid="file-viewer-body"
      data-renderer={renderer}
    >
      {card ? (
        <FileCard item={item} note={loaded.error?.text ?? t('preview.unsupported')} download={loaded.error?.kind === 'missing' ? undefined : item.download} />
      ) : (
        <div className="min-h-full bg-subtle/50">
          <FileBody file={file} loaded={loaded} width={width} download={item.download ?? stay} onRetry={() => setRev((v) => v + 1)} openPicture={stay} />
        </div>
      )}
    </div>
  )
}

/** Whether something between the finger and the column (the column too) scrolls sideways: a zoomed PDF, a wide sheet or
 * table, a long code line. A swipe there is that scroll's, never a step. */
function scrollsSideways(from: Element | null, column: Element): boolean {
  for (let el: Element | null = from; el; el = el === column ? null : el.parentElement) {
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
