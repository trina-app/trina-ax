import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { REMOTE_MCP, type RemoteConsentInfo } from '@mycel/shared/api'
import { api, errorText } from '../lib/api'
import { useLocale, useT } from '../i18n'
import { Button, ErrorNote, Skeleton } from '../components/ui'

/** The connector scopes the person chooses here (server policy.ts OPTIONAL_SCOPES), whatever the app asked for. Group
 * management (mcp:admin) is no choice: an owner's or admin's connection gets it (`request.admin`). Reading the
 * person's conversations starts ticked; sending in them as the person starts unticked and needs reading. */
const WRITE_SCOPE = 'mcp:write', ROOMS_SCOPE = 'mcp:rooms', ROOMS_WRITE_SCOPE = 'mcp:rooms.write'
/** where a decision may send the browser: Claude's and ChatGPT's own callbacks (server policy.ts HOSTED), or an app on
 * this computer */
const HOSTED_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect']

/** One optional permission: a checkbox with its name and a plain line on what it allows. */
function Choice({ testId, checked, disabled, onChange, title, hint }: { testId: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void; title: string; hint: string }) {
  return <label className="flex items-start gap-3 rounded-xl border border-line p-4" data-testid={testId}>
    <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} data-testid={testId + '-check'} />
    <span className="min-w-0"><span className="block font-medium">{title}</span><span className="mt-1 block text-muted">{hint}</span></span>
  </label>
}

/** A redirect is returned only after authenticated, CSRF-protected explicit consent. */
export default function ConnectorConsent() {
  const [params] = useSearchParams(), id = params.get('id') ?? '', t = useT(), locale = useLocale()
  const [request, setRequest] = useState<RemoteConsentInfo | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false)
  // Reading files is always granted. Writing starts ticked only when the app asked for it; reading conversations
  // starts ticked, writing in them unticked
  const [write, setWrite] = useState(false), [rooms, setRooms] = useState(true), [roomsWrite, setRoomsWrite] = useState(false)
  const life = useRef(0), writing = useRef(false)
  useEffect(() => {
    const generation = ++life.current
    setRequest(null); setError(null); setBusy(false); setWrite(false); setRooms(true); setRoomsWrite(false); writing.current = false
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) { setError(t('connectors.expired')); return () => { life.current++ } }
    void api.call(REMOTE_MCP.getRemoteConnectorConsent, { params: { id } }).then(value => {
      if (generation === life.current) { setRequest(value); setWrite(value.scopes.includes(WRITE_SCOPE)) }
    }).catch(e => { if (generation === life.current) setError(errorText(e, locale, t('error.network'))) })
    return () => { life.current++ }
    // Locale is presentation only; it must not reset or unlock a pending consent decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  const offers = (scope: string) => !!request?.optional.includes(scope)
  const decide = async (allow: boolean) => {
    if (!request || writing.current) return
    writing.current = true; setBusy(true); setError(null)
    const generation = life.current
    try {
      // the conversation boxes only when the server offers them (an older server's body has no such fields)
      const talk = offers(ROOMS_SCOPE) ? { rooms, roomsWrite: rooms && offers(ROOMS_WRITE_SCOPE) && roomsWrite } : {}
      const body = allow ? { allow, write: offers(WRITE_SCOPE) && write, ...talk } : { allow }
      const result = await api.call(REMOTE_MCP.decideRemoteConnectorConsent, { params: { id }, body })
      if (generation !== life.current) return
      const target = new URL(result.redirectUrl)
      const hosted = HOSTED_CALLBACKS.includes(target.origin + target.pathname)
      const native = target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/callback'
      if (target.username || target.password || target.hash || (!hosted && !native)) throw new Error('Invalid callback')
      window.location.assign(target.href)
    } catch (e) { if (generation === life.current) setError(errorText(e, locale, t('error.network'))) }
    finally { if (generation === life.current) { writing.current = false; setBusy(false) } }
  }
  // its own scroll inside the app shell (which does not scroll), with Allow / Deny kept in view at the bottom: the page
  // is longer than a 1280x720 window or a phone (QA TC-168)
  return <div className="flex h-full flex-col overflow-y-auto [scroll-padding-bottom:6rem]" data-testid="connector-consent-scroll">
  <section className="mx-auto w-full max-w-2xl space-y-5 p-6 pb-0" data-testid="connector-consent">
    <div><h1 className="text-xl font-semibold">{t('connectors.consentTitle')}</h1><p className="mt-2 text-sm text-muted">{t('connectors.consentDescription')}</p></div>
    {error && <ErrorNote>{error}</ErrorNote>}
    {!request && !error && <Skeleton lines={4} />}
    {request && <>
      <dl className="space-y-3 rounded-xl border border-line p-4 text-sm">
        <div><dt className="text-muted">{t('connectors.client')}</dt><dd className="break-words font-medium">{request.clientName}</dd></div>
        <div><dt className="text-muted">{t('connectors.callback')}</dt><dd className="break-all">{request.redirectOrigin}</dd></div>
        <div><dt className="text-muted">{t('connectors.address')}</dt><dd className="break-all">{request.resource}</dd></div>
      </dl>
      <div className="space-y-2 text-sm">
        <p className="text-xs font-medium text-muted">{t('connectors.always')}</p>
        <ul className="list-disc space-y-2 pl-5" data-testid="connector-granted">
          <li>{t('connectors.read')}</li>
          {request.scopes.includes('offline_access') && <li>{t('connectors.offline')}</li>}
        </ul>
      </div>
      {request.optional.length > 0 && <fieldset className="space-y-2 text-sm" data-testid="connector-optional">
        <legend className="mb-2 text-xs font-medium text-muted">{t('connectors.choose')}</legend>
        {offers(WRITE_SCOPE) && <Choice testId="connector-write" checked={write} disabled={busy} onChange={setWrite} title={t('connectors.writeOptIn')} hint={t('connectors.write')} />}
        {offers(ROOMS_SCOPE) && <Choice testId="connector-rooms" checked={rooms} disabled={busy} onChange={(v) => { setRooms(v); if (!v) setRoomsWrite(false) }} title={t('connectors.roomsOptIn')} hint={t('connectors.rooms')} />}
        {offers(ROOMS_SCOPE) && offers(ROOMS_WRITE_SCOPE) && <Choice testId="connector-rooms-write" checked={rooms && roomsWrite} disabled={busy || !rooms} onChange={setRoomsWrite} title={t('connectors.roomsWriteOptIn')} hint={t('connectors.roomsWrite')} />}
      </fieldset>}
      {request.admin && <p className="text-sm" data-testid="connector-admin">{t('connectors.adminIncluded')}</p>}
      <p className="text-sm text-muted">{t('connectors.sessionBound')}</p><p className="text-sm text-muted">{t('connectors.scopeLimit')}</p>
      <div className="sticky bottom-0 z-20 -mx-6 flex gap-3 border-t border-line bg-[var(--sticky-bg)] px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]" data-testid="connector-actions"><Button variant="primary" busy={busy} disabled={busy} onClick={() => void decide(true)} data-testid="connector-allow">{t('connectors.allow')}</Button><Button disabled={busy} onClick={() => void decide(false)} data-testid="connector-deny">{t('connectors.deny')}</Button></div>
    </>}
    {!request && <div className="pb-6" />}
  </section>
  </div>
}
