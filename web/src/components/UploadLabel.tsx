import { useT } from '../i18n'
import { uploadLabel, uploadPercent, type Running } from '../lib/upload'

/** A running upload's words, for inside a live region. A screen reader would read out every new number, so a number stays
 * hidden from it and `busy`, a fixed text, stands in; the words before and after it are read as they are. */
export function UploadLabel({ progress, busy }: { progress: Running; busy: string }) {
  const t = useT()
  const number = uploadPercent(progress) !== null
  return (
    <>
      <span aria-hidden={number || undefined}>{uploadLabel(progress, t)}</span>
      {number && <span className="sr-only">{busy}</span>}
    </>
  )
}
