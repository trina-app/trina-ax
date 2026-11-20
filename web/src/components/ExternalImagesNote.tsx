// Above a preview or artifact frame: how many images from the web the page names, which the frame never loads (its CSP
// lets nothing out), and what to do instead: have the AI save them into the team folder (save_url) and point the page
// at those files (lib/frame-files.ts inlines them). FrameNotes adds the same for scripts (lib/frame-scripts.ts): web
// scripts that do not run, and team script files that could not be put into the page.
import { FileWarning, ImageOff } from 'lucide-react'
import { useT } from '../i18n'
import type { FrameFiles } from '../lib/frame-files'

const NOTE = 'flex shrink-0 items-start gap-2 border-b border-line bg-subtle px-3 py-2 text-xs text-muted'
/** script names shown in the note; the rest are counted */
const NAMES_SHOWN = 3

export default function ExternalImagesNote({ count }: { count: number }) {
  const t = useT()
  if (count <= 0) return null
  return (
    <p role="status" className={NOTE} data-testid="external-images-note">
      <ImageOff size={14} className="mt-px shrink-0" aria-hidden />
      {t('preview.externalImages', { n: count })}
    </p>
  )
}

/** Whether FrameNotes shows anything for these files. */
export function hasFrameNotes(f: FrameFiles | null): boolean {
  return !!f && (f.external > 0 || f.externalScripts > 0 || f.missingScripts.length > 0 || f.withheldScripts > 0)
}

/** The notes above a frame that runs scripts: web images, web scripts, team scripts not put in. */
export function FrameNotes({ files }: { files: FrameFiles }) {
  const t = useT()
  const names = files.missingScripts.slice(0, NAMES_SHOWN).map((p) => p.split('/').pop() || p)
  const more = files.missingScripts.length - names.length
  return (
    <>
      <ExternalImagesNote count={files.external} />
      {files.externalScripts > 0 && (
        <p role="status" className={NOTE} data-testid="web-scripts-note">
          <FileWarning size={14} className="mt-px shrink-0" aria-hidden />
          {t('preview.webScripts', { n: files.externalScripts })}
        </p>
      )}
      {files.withheldScripts > 0 && (
        <p role="status" className={NOTE} data-testid="shared-scripts-note">
          <FileWarning size={14} className="mt-px shrink-0" aria-hidden />
          {t('preview.sharedChatScripts', { n: files.withheldScripts })}
        </p>
      )}
      {files.missingScripts.length > 0 && (
        <p role="status" className={NOTE} data-testid="missing-scripts-note">
          <FileWarning size={14} className="mt-px shrink-0" aria-hidden />
          {t('preview.missingScripts', { n: files.missingScripts.length, list: names.join(', ') + (more > 0 ? ` +${more}` : '') })}
        </p>
      )}
    </>
  )
}
