// "Source code (AGPL-3.0)": the source of the version this server runs (AGPL-3.0 §13, review OSS-02, control-plane
// SV-8). The release tag once the repository is public; until then a mail request (shared/src/source.ts).
import { useEffect, useState } from 'react'
import { sourceCodeLink } from '@mycel/shared'
import { api, API } from '../lib/api'
import { useT } from '../i18n'

let versionOnce: Promise<string | null> | null = null
/** the server's version from GET /api/health (asked once per page load; absent on the office internet address) */
export const serverVersion = (): Promise<string | null> => (versionOnce ??= api.call(API.health).then((h) => h.version ?? null, () => null))

export function SourceCodeLink({ className }: { className?: string }) {
  const t = useT()
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void serverVersion().then((v) => { if (live) setVersion(v) })
    return () => { live = false }
  }, [])
  const link = sourceCodeLink(version)
  return (
    <a href={link.href} target={link.kind === 'tag' ? '_blank' : undefined} rel="noopener noreferrer" className={className} data-testid="source-code-link">
      {t(link.kind === 'tag' ? 'about.source' : 'about.sourceRequest')}
    </a>
  )
}
