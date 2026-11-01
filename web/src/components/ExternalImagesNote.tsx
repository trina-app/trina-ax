// Above a preview or artifact frame: how many images from the web the page names, which the frame never loads (its CSP
// lets nothing out), and what to do instead: have the AI save them into the team folder (save_url) and point the page
// at those files (lib/frame-files.ts inlines them).
import { ImageOff } from 'lucide-react'
import { useT } from '../i18n'

export default function ExternalImagesNote({ count }: { count: number }) {
  const t = useT()
  if (count <= 0) return null
  return (
    <p role="status" className="flex shrink-0 items-start gap-2 border-b border-line bg-subtle px-3 py-2 text-xs text-muted" data-testid="external-images-note">
      <ImageOff size={14} className="mt-px shrink-0" aria-hidden />
      {t('preview.externalImages', { n: count })}
    </p>
  )
}
