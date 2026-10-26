// Operator-provided source URL and request contact are separate. No source export or external fetch occurs here.
import { useEffect, useState } from 'react'
import { SOURCE_CODE, sourceCodeLink, sourceCodeOffer, type SourceCodeOffer } from '@mycel/shared'
import { api, API } from '../lib/api'
import { useT } from '../i18n'
import { useSession } from '../store/session'
import { useUi } from '../store/ui'

type SourceInfo = { version: string | null; offer: SourceCodeOffer }
const unavailable: SourceInfo = { version: null, offer: sourceCodeOffer(null) }

/** Reconnect and session changes invalidate both the request and the render's data key. An anonymous null version
 * is never cached across sign-in; a late response cannot restore a previous session/server's offer. */
export function useServerSource(): SourceInfo {
  const session = useSession(s => s.status.kind === 'signed-in' ? `${s.status.me.user.id}:${s.status.me.session.id}` : s.status.kind)
  const conn = useUi(s => s.conn)
  const key = JSON.stringify([location.origin, session, conn])
  const [result, setResult] = useState<{ key: string; info: SourceInfo } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    let live = true
    setResult(null)
    void api.call(API.health, { signal: controller.signal }).then(h => {
      if (live) setResult({ key, info: {
        version: h.version ?? null,
        offer: sourceCodeOffer(h.version, { requestEmail: h.sourceCode?.requestEmail, release: h.sourceCode?.download ?? undefined }),
      } })
    }, () => { if (live) setResult(null) })
    return () => { live = false; controller.abort() }
  }, [key])
  return result?.key === key ? result.info : unavailable
}

export function SourceCodeLink({ className }: { className?: string }) {
  const info = useServerSource()
  return <SourceCodeLinks info={info} className={className} />
}

export function SourceCodeLinks({ info, className }: { info: SourceInfo; className?: string }) {
  const t = useT()
  const { version, offer } = info
  const request = sourceCodeLink(version, { ...SOURCE_CODE, published: false, requestEmail: offer.requestEmail })
  return (
    <span className={className}>
      {offer.download && <><a href={offer.download.url} target="_blank" rel="noopener noreferrer" data-testid="source-code-download">{t('about.sourceDownload', { version: offer.download.version })}</a><span aria-hidden> · </span></>}
      <a href={request.href} rel="noopener noreferrer" data-testid="source-code-link">{t('about.sourceRequest')}</a>
    </span>
  )
}
