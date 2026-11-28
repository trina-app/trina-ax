// /browser-ask/<id>: one of my own MCP apps (Claude Code, Codex, Claude) wants to open a site in one of my linked browser
// profiles that nobody allowed there, an address that is not plain, or an office-network address
// (server/src/chrome/asks.ts). The app sends me here (MCP URL elicitation, its tool error, or the realtime notice); I
// answer once, Always (kept for that profile, as the site card's Always) or no. Only the person it is for sees it:
// another person's, an answered or an expired question is the server's 404, said in plain words. The look is the
// consent page's (pages/ConnectorConsent.tsx).
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { API, REMOTE_MCP, type BrowserAskView } from '@mycel/shared/api'
import { api, ApiError, errorText } from '../lib/api'
import { formatDate } from '../lib/format'
import { useLocale, useT } from '../i18n'
import { Button, ErrorNote, Skeleton } from '../components/ui'
import { destructive } from '../lib/destructive'

type Decision = 'once' | 'always' | 'no'
type State = { kind: 'loading' } | { kind: 'open'; ask: BrowserAskView } | { kind: 'gone' } | { kind: 'done'; name: string } | { kind: 'disconnected'; name: string }
const gone = (e: unknown) => e instanceof ApiError && e.status === 404

export default function BrowserAsk() {
  const { id = '' } = useParams(), t = useT(), locale = useLocale()
  const [state, setState] = useState<State>({ kind: 'loading' }), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null)
  const life = useRef(0), writing = useRef(false)
  useEffect(() => {
    const generation = ++life.current
    setState({ kind: 'loading' }); setError(null); setBusy(null); writing.current = false
    void api.call(API.browserAsk, { params: { id } }).then((ask) => { if (generation === life.current) setState({ kind: 'open', ask }) })
      .catch((e) => { if (generation === life.current) { if (gone(e)) setState({ kind: 'gone' }); else setError(errorText(e, locale, t('error.network'))) } })
    return () => { life.current++ }
    // Locale is presentation only; it must not reload an open question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  const act = async (what: string, run: () => Promise<unknown>, after: State) => {
    if (writing.current) return
    writing.current = true; setBusy(what); setError(null)
    const generation = life.current
    try { await run(); if (generation === life.current) setState(after) }
    catch (e) { if (generation === life.current) { if (gone(e)) setState({ kind: 'gone' }); else setError(errorText(e, locale, t('error.network'))) } }
    finally { if (generation === life.current) { writing.current = false; setBusy(null) } }
  }
  const ask = state.kind === 'open' ? state.ask : null
  const decide = (decision: Decision) => ask && void act(decision, () => api.call(API.browserAskDecide, { params: { id }, body: { decision } }), { kind: 'done', name: ask.client.name })
  // it cannot be taken back (the app signs in again), so it asks first; the page says it was done, no toast
  const disconnect = async () => {
    if (!ask || writing.current) return
    await destructive({
      confirm: { title: t('aiApps.disconnectTitle', { name: ask.client.name }), confirm: t('connectors.disconnect') },
      run: () => act('disconnect', () => api.call(REMOTE_MCP.revokeRemoteConnector, { params: { id: ask.client.connectionId } }), { kind: 'disconnected', name: ask.client.name }).then(() => true),
      done: () => null,
    })
  }
  return <div className="flex h-full flex-col overflow-y-auto" data-testid="browser-ask-scroll">
    <section className="mx-auto w-full max-w-2xl space-y-5 p-6" data-testid="browser-ask">
      {error && <ErrorNote>{error}</ErrorNote>}
      {state.kind === 'loading' && !error && <Skeleton lines={4} />}
      {state.kind === 'gone' && <p className="text-sm text-muted" data-testid="browser-ask-gone">{t('browserAsk.gone')}</p>}
      {state.kind === 'done' && <p className="text-sm" data-testid="browser-ask-done">{t('browserAsk.done', { name: state.name })}</p>}
      {state.kind === 'disconnected' && <p className="text-sm" data-testid="browser-ask-disconnected">{t('browserAsk.disconnected', { name: state.name })}</p>}
      {ask && <>
        <h1 className="text-title font-semibold break-words" data-testid="browser-ask-title">{t('browserAsk.title', { name: ask.client.name })}</h1>
        <dl className="space-y-3 rounded-xl border border-line p-4 text-sm">
          <div><dt className="text-muted">{t('browserAsk.profile')}</dt><dd className="break-words font-medium" data-testid="browser-ask-profile">{ask.profile}</dd></div>
          <div><dt className="text-muted">{t('browserAsk.address')}</dt><dd className="font-mono text-xs break-all" data-testid="browser-ask-url">{ask.url}</dd></div>
          {ask.kind !== 'site' && <div><dd className="text-muted" data-testid="browser-ask-note">{t(ask.kind === 'office' ? 'browserAsk.officeNote' : 'browserAsk.addressNote')}</dd></div>}
        </dl>
        <p className="text-sm text-muted break-words" data-testid="browser-ask-app">{t('browserAsk.app', { name: ask.client.name, date: formatDate(ask.client.connectedAt, locale) })}</p>
        <div className="flex flex-wrap gap-3" data-testid="browser-ask-actions">
          <Button variant="primary" busy={busy === 'once'} disabled={busy !== null} onClick={() => decide('once')} data-testid="browser-ask-once">{t('browserAsk.once')}</Button>
          {/* a long profile name is cut in the button (the Profile row above has it whole) */}
          {ask.always && <Button className="min-w-0 max-w-full" busy={busy === 'always'} disabled={busy !== null} onClick={() => decide('always')} data-testid="browser-ask-always"><span className="truncate">{t('browserAsk.always', { profile: ask.profile })}</span></Button>}
          <Button variant="ghost" busy={busy === 'no'} disabled={busy !== null} onClick={() => decide('no')} data-testid="browser-ask-no">{t('browserAsk.no')}</Button>
        </div>
        <button type="button" className="text-xs text-muted underline underline-offset-2 hover:text-ink disabled:opacity-50 max-md:min-h-11" disabled={busy !== null} onClick={() => void disconnect()} data-testid="browser-ask-disconnect">{t('browserAsk.disconnect')}</button>
      </>}
    </section>
  </div>
}
