// A picture attached in a message box, before it is sent (components/rooms/RoomComposer.tsx, components/chat/
// Composer.tsx): a 64 px square of the picture itself above the text, as Slack and iMessage show one, not a file chip.
// A picked or pasted one is drawn from the file itself, so it shows at once while the upload runs; a photo of a room send
// the server gave back shows its room thumbnail (`src`). A picture that cannot be drawn (a HEIC photo in Chrome, a
// thumbnail that did not load) shows a square with a picture icon. Its name is its tip and its alt text; what the chip
// says (uploading, attached, its size) is for screen readers, beside it in each box.
import clsx from 'clsx'
import { FileImage, Loader2, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Tooltip } from './Tooltip'

/** A file this computer gave as a picture (its type, as the browser reports it; a chip given back by the server has
 * none). */
export const isLocalImage = (file: File): boolean => typeof file.type === 'string' && file.type.startsWith('image/')

const SQUARE = 'size-16 shrink-0 rounded-lg'

export function ChipThumb({ file, src, alt = '', fallback = null, className }: { file?: File; src?: string; alt?: string; fallback?: ReactNode; className?: string }) {
  const [url, setUrl] = useState<string | null>(file ? null : (src ?? null))
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    setBroken(false)
    if (!file) return setUrl(src ?? null)
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file, src])
  if (broken) return <>{fallback}</>
  // (its place is kept for the moment before the file's address is made: nothing moves under the pointer)
  if (!url) return <span aria-hidden className={clsx(SQUARE, 'block bg-subtle', className)} />
  return <img src={url} alt={alt} onError={() => setBroken(true)} className={clsx(SQUARE, 'object-cover', className)} data-testid="chip-thumb" />
}

/** The picture's square in the row above the box: a hairline edge (a white screenshot on the white box), a spinner over
 * it while it uploads (with `percent` when it is known), a red edge when it failed (the box says why beside it), and its
 * ✕ on the top corner, a dark dot that takes a 36 px tap (44 px on phones), reaching further out to the right than over
 * the picture (a tap meant for the picture stays the picture's), and not above the box's edge. The dot stands 6 px out of the square: its row item keeps
 * that room (`pt-1.5 pr-1.5`), so it touches neither the box's edge nor the next picture, which, painted after it, keeps
 * its own clicks. `onOpen`: a click on the picture opens it (the AI chat's preview). */
export function PictureTile({ name, file, src, busy, percent = null, failed, removeLabel, onRemove, onOpen }: {
  name: string
  file?: File
  src?: string
  busy: boolean
  percent?: number | null
  failed: boolean
  removeLabel: string
  onRemove: () => void
  onOpen?: () => void
}) {
  const picture = (
    <ChipThumb
      file={file}
      src={src}
      alt={name}
      fallback={
        <span role="img" aria-label={name} className={clsx(SQUARE, 'flex items-center justify-center bg-subtle text-muted')}>
          <FileImage size={20} aria-hidden />
        </span>
      }
    />
  )
  return (
    <span className={clsx('relative block', SQUARE, failed ? 'ring-2 ring-danger' : 'ring-1 ring-line')}>
      {onOpen ? (
        <Tooltip label={name}>
          <button type="button" aria-label={name} onClick={onOpen} className={clsx('block', SQUARE)}>
            {picture}
          </button>
        </Tooltip>
      ) : (
        <Tooltip label={name}>
          <span className={clsx('block', SQUARE)}>{picture}</span>
        </Tooltip>
      )}
      {busy && (
        // the picture a shade darker, the spinner on a dark pill of its own: seen on a light or a dark picture alike
        <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-black/20">
          <span className="flex items-center gap-1 rounded-full bg-black/65 p-1 text-white">
            <Loader2 size={16} className="animate-spin" />
            {percent !== null && <span className="pr-1 text-micro leading-none font-medium tabular-nums">{percent}%</span>}
          </span>
        </span>
      )}
      <Tooltip label={removeLabel}>
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ink text-canvas ring-2 ring-surface transition after:absolute after:-inset-y-2 after:-right-3 after:-left-1 hover:opacity-80 max-md:after:-inset-y-3 max-md:after:-right-4 max-md:after:-left-2"
        >
          <X size={12} strokeWidth={2.5} aria-hidden />
        </button>
      </Tooltip>
    </span>
  )
}
