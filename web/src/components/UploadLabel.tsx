import { useT } from '../i18n'
import { uploadLabel, type Running } from '../lib/upload'

/** A running upload's words, for inside a live region. What shows changes all the time, and with several files a screen
 * reader would read out each phase and number of each, with no name: it gets `busy` instead, one fixed text with the name. */
export function UploadLabel({ progress, busy }: { progress: Running; busy: string }) {
  const t = useT()
  return (
    <>
      <span aria-hidden="true">{uploadLabel(progress, t)}</span>
      <span className="sr-only">{busy}</span>
    </>
  )
}
