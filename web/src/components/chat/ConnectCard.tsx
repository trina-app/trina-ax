// connect_service: the AI filled in a connection to a service (or Google Drive) and the person finishes it here
// (docs/INTEGRATIONS.md "Connecting from a chat"). Nothing is connected until the person presses this card's button.
// The AI chose the address, so where it connects is the card's main line (the host, then the full address and what kind
// of connection it is, with the header a key goes in), with a caution when no word of the name is in the host; the
// title shows the whole name. An HTTP API's usage notes, which are saved with the connection and given to the AI in
// later chats, are shown in full (read-only, scrolling) before the person connects.
// By case (lib/connectCard.ts): paste a key into the password box (sealed in this browser, lib/seal.ts, and sent only
// to POST /api/turns/:id/connect; the box says where it goes and that the AI never sees it), sign in at the service
// (a window reserved during the click, like Settings > External services: useSignIn), connect with nothing to give,
// or the Google Drive flow of Settings (useDriveFlow). A team connection: who may use it, just the admin or everyone.
// "Not now" skips. A failed check keeps the card and the box for another key. The card closes when the server sends
// turn.request.closed, and right away here after a connected or skipped answer. Never answered from the message box.
import clsx from 'clsx'
import { Globe, Lock, LogIn, Plug, TriangleAlert } from 'lucide-react'
import { useId, useState } from 'react'
import type { TurnConnectResult } from '@mycel/shared/api'
import { errorText, isApiError } from '../../lib/api'
import { connectCase, connectWithKey, connectWithoutKey, finishConnect, hostOffName, skipConnect, type ConnectAccess, type ConnectServiceRequest } from '../../lib/connectCard'
import { mobileApp } from '../../lib/mobile'
import { canSeal } from '../../lib/seal'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { reserveSignInWindow, useSignIn } from '../integrations/IntegrationRow'
import { DriveFlowPanel, useDriveFlow } from '../settings/DriveConnection'
import { Badge, Button, ErrorNote, inputCls } from '../ui'

type Busy = 'connect' | 'done' | 'skip' | null

export default function ConnectCard({ request: r }: { request: ConnectServiceRequest }) {
  const t = useT()
  const locale = useLocale()
  const id = useId()
  const [key, setKey] = useState('')
  const [access, setAccess] = useState<ConnectAccess>('me')
  const [busy, setBusy] = useState<Busy>(null)
  /** a network or server error of the last button */
  const [error, setError] = useState<string | null>(null)
  /** the server's check failed (state retry): why, in words a person can act on */
  const [lastError, setLastError] = useState<string | null>(null)
  /** added, now to sign in at the service (also when the server finds a sign-in the AI did not expect) */
  const [signInId, setSignInId] = useState<string | null>(null)
  /** signed in / Drive connected but telling the server failed: offer it again */
  const [doneFailed, setDoneFailed] = useState(false)
  const signIn = useSignIn(() => void finish())
  const drive = useDriveFlow((c) => {
    if (c.status === 'connected') void finish()
  })
  const kase = signInId ? 'sign_in' : connectCase(r)
  const service = r.service
  const host = service?.host ?? ''
  const team = r.scope === 'team' && r.target === 'service'
  const phone = !!mobileApp()
  const secure = canSeal()
  const flow = signIn.state
  const working = busy !== null || (!!flow && ['starting', 'pending', 'exchanging'].includes(flow.state))

  const outcome = (res: TurnConnectResult | null) => {
    if (!res) return
    if (res.state === 'connected') toast({ level: 'success', text: t('connect.done', { name: r.name }) })
    else if (res.state === 'retry') setLastError(res.lastError || t('connect.failed'))
    else if (res.state === 'sign_in') {
      // to sign in at the service (next click); after a sign-in that did not take, the server says why
      if (res.integrationId) setSignInId(res.integrationId)
      if (res.lastError || !res.integrationId) setLastError(res.lastError || t('integrations.signIn.failed'))
    }
  }
  const run = async (what: Exclude<Busy, null>, call: () => Promise<TurnConnectResult | null>) => {
    setBusy(what)
    setError(null)
    setLastError(null)
    try {
      outcome(await call())
      return true
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
      return false
    } finally {
      setBusy(null)
    }
  }

  const connectKey = async () => {
    if (!key.trim() || !secure || working) return
    try {
      setBusy('connect')
      setError(null)
      setLastError(null)
      const res = await connectWithKey(r, key, access)
      // the server has the key now (or refused it): it is not kept here
      setKey('')
      outcome(res)
    } catch (e) {
      // the server refused it: this key is done with. On a network failure it stays for another try.
      if (isApiError(e)) setKey('')
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(null)
    }
  }
  /** in the click: the window first (opened later it would be blocked), then add the connection and sign in */
  const startSignIn = async () => {
    if (working) return
    if (signInId) return void signIn.start(signInId)
    const win = reserveSignInWindow()
    setBusy('connect')
    setError(null)
    setLastError(null)
    try {
      const res = await connectWithoutKey(r, access)
      if (res?.state === 'sign_in' && res.integrationId) {
        setSignInId(res.integrationId)
        void signIn.start(res.integrationId, win)
        return
      }
      win?.close()
      outcome(res)
    } catch (e) {
      win?.close()
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(null)
    }
  }
  const finish = async () => {
    setDoneFailed(false)
    if (!(await run('done', () => finishConnect(r)))) setDoneFailed(true)
  }
  const skip = () => {
    signIn.cancel()
    if (drive.inProgress) void drive.cancel()
    void run('skip', () => skipConnect(r))
  }

  const primary = doneFailed ? (
    <Button size="sm" variant="primary" busy={busy === 'done'} onClick={() => void finish()} data-testid="connect-finish">
      {t('common.retry')}
    </Button>
  ) : kase === 'key' ? (
    <Button size="sm" variant="primary" type="submit" disabled={!key.trim() || !secure || working} busy={busy === 'connect'} data-testid="connect-submit">
      {t('connect.connect')}
    </Button>
  ) : kase === 'sign_in' ? (
    !phone &&
    !flow && (
      <Button size="sm" variant="primary" className="min-w-0 max-w-full" disabled={working} busy={busy === 'connect'} onClick={() => void startSignIn()} data-testid="connect-sign-in">
        <LogIn size={14} aria-hidden /> <span className="truncate">{t('connect.signIn', { name: r.name })}</span>
      </Button>
    )
  ) : kase === 'google_drive' ? (
    !drive.inProgress && (
      <Button size="sm" variant="primary" busy={drive.busy} disabled={working} onClick={() => void drive.start()} data-testid="connect-drive">
        {t('drive.connect')}
      </Button>
    )
  ) : (
    <Button size="sm" variant="primary" disabled={working} busy={busy === 'connect'} onClick={() => void run('connect', () => connectWithoutKey(r, access))} data-testid="connect-submit">
      {t('connect.connect')}
    </Button>
  )

  return (
    <form
      className="my-3 overflow-hidden rounded-2xl border border-line"
      aria-labelledby={`${id}-title`}
      data-testid="connect-card"
      data-case={kase}
      onSubmit={(e) => {
        e.preventDefault()
        if (kase === 'key') void connectKey()
      }}
    >
      <div className="flex items-start gap-2 bg-subtle px-4 py-2.5 text-sm font-semibold">
        <Plug size={16} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
        {/* the whole name, on more lines when it is long: it is what the person checks against the address */}
        <span id={`${id}-title`} className="min-w-0 flex-1 [overflow-wrap:anywhere]" data-testid="connect-title">
          {r.template ? t('connect.templateTitle', { name: r.name }) : t('connect.title', { name: r.name })}
        </span>
        {team && <Badge tone="accent">{t('connect.team')}</Badge>}
        {r.template && <Badge tone="accent">{t('connect.fromTeam')}</Badge>}
      </div>
      <div className="space-y-3 px-4 pt-3 pb-3 text-sm">
        {/* the server's line on why it asks (a chat that read a room: this card stands in for the room card) */}
        {r.lead && <p className="text-muted [overflow-wrap:anywhere]" data-testid="connect-lead">{r.lead}</p>}
        {service && (
          <div data-testid="connect-address">
            <p className="flex items-start gap-1.5 font-semibold text-ink" data-testid="connect-host">
              <Globe size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 [overflow-wrap:anywhere]">{host}</span>
            </p>
            {/* the whole address: a long one scrolls, never cut */}
            <p className="scroll-thin mt-0.5 max-h-16 overflow-y-auto font-mono text-xs text-faint [overflow-wrap:anywhere]" data-testid="connect-url">
              {service.url}
            </p>
            {/* what kind of connection, and where a key goes when it is not "Authorization: Bearer" */}
            <p className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere]" data-testid="connect-kind">
              {t(service.kind === 'mcp' ? 'connect.kindMcp' : 'connect.kindHttp')}
              {service.auth === 'header' && service.authHeader && ` · ${t('connect.headerKey', { header: service.authHeader })}`}
            </p>
            {hostOffName(r.name, host) && (
              <p className="mt-1.5 flex items-start gap-1.5 text-xs text-warn" data-testid="connect-host-caution">
                <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
                <span className="min-w-0 [overflow-wrap:anywhere]">{t('connect.hostCaution', { name: r.name })}</span>
              </p>
            )}
          </div>
        )}
        {/* an admin's template: the address and sign-in are the team's; the key is the person's own, used only in their chats */}
        {r.template && <p className="text-xs text-muted [overflow-wrap:anywhere]" data-testid="connect-template-note">{t('connect.templateNote')}</p>}
        {r.why && <p className="whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{r.why}</p>}
        {r.notes && (
          <div data-testid="connect-notes">
            <p id={`${id}-notes`} className="mb-1 text-xs font-medium text-ink">
              {t('connect.notes')}
            </p>
            <pre
              className="scroll-thin max-h-40 overflow-auto rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted [overflow-wrap:anywhere]"
              role="group"
              aria-labelledby={`${id}-notes`}
              tabIndex={0}
              data-testid="connect-notes-text"
            >
              {r.notes}
            </pre>
          </div>
        )}

        {kase === 'key' && (
          <div>
            <label className="block">
              <span className="mb-1.5 block text-label font-medium text-ink">{t('connect.key', { name: r.name })}</span>
              <input
                className={inputCls}
                type="password"
                name="connect-key"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                value={key}
                disabled={!secure}
                aria-describedby={`${id}-where`}
                onChange={(e) => setKey(e.target.value)}
                data-testid="connect-key"
              />
            </label>
            <p id={`${id}-where`} className="mt-1.5 flex items-start gap-1.5 text-xs text-muted" data-testid="connect-where">
              <Lock size={12} className="mt-0.5 shrink-0" aria-hidden />
              <span className="min-w-0 [overflow-wrap:anywhere]">{t('connect.keyWhere', { host })}</span>
            </p>
            {!secure && (
              <p className="mt-1.5 text-xs text-warn" data-testid="connect-https-only">
                {t('credentials.httpsOnly')}
              </p>
            )}
          </div>
        )}
        {kase === 'sign_in' && (
          <p className="flex items-start gap-1.5 text-muted" data-testid="connect-where">
            <Lock size={14} className="mt-0.5 shrink-0" aria-hidden />
            <span className="min-w-0 [overflow-wrap:anywhere]">{t('connect.signInWhere')}</span>
          </p>
        )}
        {kase === 'sign_in' && phone && <p className="text-xs text-faint">{t('integrations.signIn.phone')}</p>}
        {kase === 'none' && (
          <p className="text-muted [overflow-wrap:anywhere]" data-testid="connect-where">
            {t('connect.noKey', { host })}
          </p>
        )}
        {kase === 'google_drive' && (
          <>
            <p className="text-muted">{t('drive.description')}</p>
            <p className="rounded-xl bg-subtle p-3 text-xs text-muted">{t('drive.privacy')}</p>
            {phone && <p className="text-xs text-muted">{t('drive.mobileBrowserLogin')}</p>}
            {drive.inProgress && drive.flow && <DriveFlowPanel d={drive} flow={drive.flow} />}
            {drive.error && <ErrorNote>{t('drive.failed')}</ErrorNote>}
          </>
        )}

        {team && !signInId && (
          <fieldset>
            <legend className="mb-1.5 text-label font-medium text-ink">{t('connect.access')}</legend>
            <div className="flex flex-wrap gap-2">
              {(['me', 'everyone'] as const).map((a) => (
                <label key={a} className={clsx('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2', access === a ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}>
                  <input type="radio" name={`${id}-access`} value={a} checked={access === a} disabled={working} onChange={() => setAccess(a)} className="accent-[var(--c-accent)]" data-testid={`connect-access-${a}`} />
                  {t(a === 'me' ? 'connect.access.me' : 'connect.access.everyone')}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {flow && (
          <div className="space-y-2 rounded-xl border border-line bg-subtle p-3" data-testid="connect-signin">
            {['starting', 'pending', 'exchanging'].includes(flow.state) ? (
              <p role="status">{t('integrations.signIn.waiting')}</p>
            ) : (
              <p role="alert" className="text-danger">
                {flow.state === 'expired' ? t('integrations.signIn.expired') : flow.reason || t('integrations.signIn.failed')}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {flow.url && ['pending', 'exchanging'].includes(flow.state) && (
                <a href={flow.url} target="_blank" rel="noopener noreferrer" className="text-sm text-accent-text underline">
                  {t('integrations.signIn.open')}
                </a>
              )}
              {['failed', 'expired'].includes(flow.state) && (
                <Button size="sm" onClick={() => void signIn.start(flow.id)}>
                  {t('common.retry')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={signIn.cancel}>
                {['failed', 'expired'].includes(flow.state) ? t('common.close') : t('common.cancel')}
              </Button>
            </div>
          </div>
        )}

        {(busy === 'connect' || busy === 'done') && (
          <p role="status" className="text-xs text-muted" data-testid="connect-progress">
            {t('connect.checking')}
          </p>
        )}
        {lastError && (
          <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-danger" data-testid="connect-last-error">
            <p className="[overflow-wrap:anywhere]">{t('connect.retry', { reason: lastError })}</p>
            {kase === 'key' && <p className="mt-1 text-xs">{t('connect.retryKey')}</p>}
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger [overflow-wrap:anywhere]" data-testid="connect-error">
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-2.5">
        <Button size="sm" variant="ghost" disabled={busy !== null} busy={busy === 'skip'} onClick={skip} data-testid="connect-skip">
          {t('connect.notNow')}
        </Button>
        {primary}
      </div>
    </form>
  )
}
