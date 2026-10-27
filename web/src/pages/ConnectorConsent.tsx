import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { REMOTE_MCP, type RemoteConsentInfo } from '@mycel/shared/api'
import { api, errorText } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { Button, ErrorNote, Skeleton } from '../components/ui'

/** A redirect is returned only after authenticated, CSRF-protected explicit consent. */
export default function ConnectorConsent() {
  const [params] = useSearchParams(), id = params.get('id') ?? '', t = useT(), locale = useLocale()
  const [request, setRequest] = useState<RemoteConsentInfo | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const life = useRef(0), writing = useRef(false)
  useEffect(() => {
    const generation = ++life.current
    setRequest(null); setError(null); setBusy(false); writing.current = false
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) { setError(t('connectors.expired')); return () => { life.current++ } }
    void api.call(REMOTE_MCP.getRemoteConnectorConsent, { params: { id } }).then(value => {
      if (generation === life.current) setRequest(value)
    }).catch(e => { if (generation === life.current) setError(errorText(e, locale, t('error.network'))) })
    return () => { life.current++ }
    // Locale is presentation only; it must not reset or unlock a pending consent decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  const decide = async (allow: boolean) => {
    if (!request || writing.current) return
    writing.current = true; setBusy(true); setError(null)
    const generation = life.current
    try {
      const result = await api.call(REMOTE_MCP.decideRemoteConnectorConsent, { params: { id }, body: { allow } })
      if (generation !== life.current) return
      const target = new URL(result.redirectUrl)
      const hosted = target.origin === 'https://claude.ai' && target.pathname === '/api/mcp/auth_callback'
      const native = target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/callback'
      if (target.username || target.password || target.hash || (!hosted && !native)) throw new Error('Invalid callback')
      window.location.assign(target.href)
    } catch (e) { if (generation === life.current) setError(errorText(e, locale, t('error.network'))) }
    finally { if (generation === life.current) { writing.current = false; setBusy(false) } }
  }
  const label = (scope: string) => scope === 'mcp:write' ? t('connectors.write') : scope === 'offline_access' ? t('connectors.offline') : t('connectors.read')
  return <section className="mx-auto max-w-2xl space-y-5 p-6" data-testid="connector-consent">
    <div><h1 className="text-xl font-semibold">{t('connectors.consentTitle')}</h1><p className="mt-2 text-sm text-muted">{t('connectors.consentDescription')}</p></div>
    {error && <ErrorNote>{error}</ErrorNote>}
    {!request && !error && <Skeleton lines={4} />}
    {request && <>
      <dl className="space-y-3 rounded-xl border border-line p-4 text-sm">
        <div><dt className="text-muted">{t('connectors.client')}</dt><dd className="break-words font-medium">{request.clientName}</dd></div>
        <div><dt className="text-muted">{t('connectors.callback')}</dt><dd className="break-all">{request.redirectOrigin}</dd></div>
        <div><dt className="text-muted">{t('connectors.address')}</dt><dd className="break-all">{request.resource}</dd></div>
      </dl>
      <ul className="list-disc space-y-2 pl-5 text-sm">{request.scopes.map(scope => <li key={scope}>{label(scope)}</li>)}</ul>
      <p className="text-sm text-muted">{t('connectors.sessionBound')}</p><p className="text-sm text-muted">{t('connectors.scopeLimit')}</p>
      <div className="flex gap-3"><Button variant="primary" busy={busy} disabled={busy} onClick={() => void decide(true)} data-testid="connector-allow">{t('connectors.allow')}</Button><Button disabled={busy} onClick={() => void decide(false)} data-testid="connector-deny">{t('connectors.deny')}</Button></div>
    </>}
  </section>
}
