// A picture picked or pasted into a message box, before it is sent: a small square of it in its chip, drawn from the
// file itself, so it shows at once while the upload runs (components/rooms/RoomComposer.tsx, components/chat/Composer.tsx).
// A picture the browser cannot draw (a HEIC photo in Chrome) shows `fallback` instead.
import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'

/** A file this computer gave as a picture (its type, as the browser reports it; a chip given back by the server has
 * none). */
export const isLocalImage = (file: File): boolean => typeof file.type === 'string' && file.type.startsWith('image/')

export function LocalThumb({ file, fallback = null, className }: { file: File; fallback?: ReactNode; className?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    const u = URL.createObjectURL(file)
    setUrl(u)
    setBroken(false)
    return () => URL.revokeObjectURL(u)
  }, [file])
  if (broken) return <>{fallback}</>
  // (its place is kept for the moment before the file's address is made: the chip does not grow under the pointer)
  if (!url) return <span aria-hidden className={clsx('size-8 shrink-0 rounded bg-subtle', className)} />
  return <img src={url} alt="" onError={() => setBroken(true)} className={clsx('size-8 shrink-0 rounded object-cover', className)} data-testid="local-thumb" />
}
