// A picture in a message box's file chip, before it is sent (components/rooms/RoomComposer.tsx, components/chat/
// Composer.tsx): a picked or pasted one drawn from the file itself, so it shows at once while the upload runs; or, for a
// photo of a room send the server gave back, its room thumbnail (`src`). A picture that cannot be drawn (a HEIC photo
// in Chrome, a thumbnail that did not load) shows `fallback` instead.
import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'

/** A file this computer gave as a picture (its type, as the browser reports it; a chip given back by the server has
 * none). */
export const isLocalImage = (file: File): boolean => typeof file.type === 'string' && file.type.startsWith('image/')

export function ChipThumb({ file, src, fallback = null, className }: { file?: File; src?: string; fallback?: ReactNode; className?: string }) {
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
  // (its place is kept for the moment before the file's address is made: the chip does not grow under the pointer)
  if (!url) return <span aria-hidden className={clsx('size-8 shrink-0 rounded bg-subtle', className)} />
  return <img src={url} alt="" onError={() => setBroken(true)} className={clsx('size-8 shrink-0 rounded object-cover', className)} data-testid="chip-thumb" />
}
