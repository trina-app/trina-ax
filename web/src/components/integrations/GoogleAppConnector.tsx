// Gmail, Google Calendar, Google Docs and Google Sheets for one person (docs/GOOGLE-APPS.md; the API is
// shared/src/api/google-apps.ts): one Google sign-in per app, the same steps as Google Drive's (useSignInFlow): Connect
// opens Google at once, back from it one line asks to confirm the account, then the app is connected. Its page
// (GoogleAppDetail, AppDetail.tsx) then offers Try in chat, Settings (ask before each change, or Always allow) and ⋯
// (Reconnect, Disconnect). An app that cannot be connected says why in plain words, an admin gets the way to set it up.
import { Settings2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { API, type GoogleAppId, type GoogleAppView } from '@mycel/shared/api'
import { api } from '../../lib/api'
import { mobileApp, openExternal } from '../../lib/mobile'
import { builtInLogo, builtInName, canChange, categoryKey, aboutKey, exampleKeys, GOOGLE_APP_ORDER, GOOGLE_PRIVACY, GOOGLE_TERMS, lineKey, unavailableKeys, developerKey } from '../../lib/googleApps'
import { useT } from '../../i18n'
import { isAdmin, useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { Button, Modal, confirmDialog } from '../ui'
import { useSignInFlow, type SignInOps } from '../settings/DriveConnection'
import { CardMenu } from './AppConnectorCard'
import { AppDetail } from './AppDetail'

const opsFor = (app: GoogleAppId, current: () => Promise<GoogleAppView>): SignInOps<GoogleAppView> => ({
  authorize: () => api.call(API.authorizeGoogleApp, { params: { app }, body: {} }),
  poll: (id) => api.call(API.googleAppFlow, { params: { app, id } }),
  complete: (id) => api.call(API.completeGoogleAppFlow, { params: { app, id }, body: {} }),
  cancel: (id) => api.call(API.cancelGoogleAppFlow, { params: { app, id } }),
  current,
})

/** One app's sign-in. `onConnected`: the app's view once it is connected (here or in another window). */
function useGoogleAppFlow(app: GoogleAppId, current: () => Promise<GoogleAppView>, onConnected: (v: GoogleAppView) => void) {
  const ops = useMemo(() => opsFor(app, current), [app, current])
  return useSignInFlow(ops, onConnected)
}
export type GoogleAppFlowState = ReturnType<typeof useGoogleAppFlow>

/**
 * The person's Google apps, for the Connectors page and each app's page: the views (null while loading; empty when this
 * server has none, an older server), one sign-in per app, Settings and Disconnect. Kept by the Connectors layout so a +
 * on a card can open Google during the click and the app's page shows the same sign-in.
 */
export function useGoogleApps() {
  const t = useT()
  const [apps, setApps] = useState<GoogleAppView[] | null>(null)
  const [busy, setBusy] = useState<GoogleAppId | null>(null)
  const life = useRef(0)
  const load = useCallback(async () => {
    const g = life.current
    try {
      const r = await api.call(API.myGoogleApps)
      if (g === life.current) setApps(r.apps)
    } catch { if (g === life.current) setApps((a) => a ?? []) }
  }, [])
  useEffect(() => { void load(); return () => { life.current++ } }, [load])
  const replace = useCallback((v: GoogleAppView) => setApps((a) => (a ? a.map((x) => (x.id === v.id ? v : x)) : [v])), [])
  const currentOf = useCallback((app: GoogleAppId) => async () => {
    const r = await api.call(API.myGoogleApps)
    setApps(r.apps)
    return r.apps.find((x) => x.id === app)!
  }, [])
  const cur = useMemo(() => Object.fromEntries(GOOGLE_APP_ORDER.map((id) => [id, currentOf(id)])) as Record<GoogleAppId, () => Promise<GoogleAppView>>, [currentOf])
  const done = (v: GoogleAppView) => { replace(v); toast({ level: 'success', text: t('gapps.connected', { name: builtInName(v.id) }) }) }
  // four fixed apps: one sign-in each, always in this order
  const flows: Record<GoogleAppId, GoogleAppFlowState> = {
    gmail: useGoogleAppFlow('gmail', cur.gmail, done),
    calendar: useGoogleAppFlow('calendar', cur.calendar, done),
    docs: useGoogleAppFlow('docs', cur.docs, done),
    sheets: useGoogleAppFlow('sheets', cur.sheets, done),
  }
  // the choice shows at once; it goes back if the server refuses
  const setPolicy = async (app: GoogleAppId, writePolicy: 'ask' | 'allow') => {
    const before = apps?.find((x) => x.id === app)?.writePolicy
    setApps((a) => a?.map((x) => (x.id === app ? { ...x, writePolicy } : x)) ?? a)
    setBusy(app)
    try { replace(await api.call(API.updateGoogleApp, { params: { app }, body: { writePolicy } })) }
    catch {
      if (before) setApps((a) => a?.map((x) => (x.id === app ? { ...x, writePolicy: before } : x)) ?? a)
      toast({ level: 'error', text: t('gapps.saveFailed') })
    }
    finally { setBusy(null) }
  }
  const disconnect = async (app: GoogleAppId) => {
    const name = builtInName(app)
    if (!await confirmDialog({ title: t('gapps.disconnectTitle', { name }), body: t('gapps.disconnectBody', { name }), confirm: t('drive.disconnect'), danger: true })) return
    setBusy(app)
    try {
      const r = await api.call(API.disconnectGoogleApp, { params: { app } })
      setApps((a) => a?.map((x) => (x.id === app ? { ...x, status: 'disconnected', account: null, serviceDown: false } : x)) ?? a)
      toast({ level: 'success', text: r.revocation === 'unavailable' ? t('gapps.disconnectedNoRevoke', { name }) : t('gapps.disconnected', { name }) })
      void load()
    } catch { toast({ level: 'error', text: t('gapps.saveFailed') }) }
    finally { setBusy(null) }
  }
  return { apps, load, flows, setPolicy, disconnect, busy }
}
export type GoogleAppsState = ReturnType<typeof useGoogleApps>

/** The steps of a sign-in under way, under the page's header: waiting for Google (with its link, and Cancel), then the
 * account to confirm. */
export function SignInSteps({ d, testId, failed }: { d: GoogleAppFlowState; testId: string; failed: string }) {
  const t = useT()
  const flow = d.inProgress ? d.flow : null
  return (
    <>
      {flow && flow.state !== 'ready' && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm" role="status" data-testid={`${testId}-waiting`}>
          <span className="text-muted">{t('drive.waitingShort')}</span>
          {d.authorizationUrl && (
            <a href={d.authorizationUrl} target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline"
              onClick={mobileApp() ? (e) => { e.preventDefault(); void openExternal(d.authorizationUrl!, { purpose: 'google-oauth' }).catch(() => d.setError(true)) } : undefined}>
              {t('drive.openGoogle')}
            </a>
          )}
          <Button size="sm" variant="ghost" className="ml-auto" disabled={d.busy} onClick={d.cancel} data-testid={`${testId}-cancel`}>{t('common.cancel')}</Button>
        </div>
      )}
      {flow?.state === 'ready' && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft/40 px-3 py-2 text-sm" data-testid={`${testId}-confirm-step`}>
          <span role="status" className="min-w-0 flex-[1_1_14rem]">{t('drive.confirmAccount')} <span className="font-medium break-all" data-testid={`${testId}-account`}>{[flow.account?.name, flow.account?.email].filter(Boolean).join(' · ')}</span></span>
          <Button size="sm" variant="primary" busy={d.busy} onClick={() => void d.complete()} data-testid={`${testId}-confirm`}>{t('drive.confirm')}</Button>
          <Button size="sm" variant="ghost" disabled={d.busy} onClick={d.cancel} data-testid={`${testId}-cancel`}>{t('common.cancel')}</Button>
        </div>
      )}
      {d.error && !flow && <p className="text-sm text-danger" role="alert" data-testid={`${testId}-error`}>{failed}</p>}
    </>
  )
}

/** "Try in chat" and the example prompts: a new chat with the text in its box (pages/Connectors.tsx). */
export type StartChat = (text: string) => void

/** A Google app's page. */
export function GoogleAppDetail({ v, g, onChat }: { v: GoogleAppView; g: GoogleAppsState; onChat: StartChat }) {
  const t = useT()
  const admin = isAdmin(useMe())
  const [settings, setSettings] = useState(false)
  const d = g.flows[v.id]
  const name = builtInName(v.id)
  const flow = d.inProgress ? d.flow : null
  const examples = exampleKeys(v.id).map((k) => t(k))
  const why = !v.available ? unavailableKeys(v.reason, admin) : null
  const busy = g.busy === v.id || d.busy
  const linked = v.status !== 'disconnected'
  const menu = (
    <CardMenu label={t('appConnectors.more', { name })} testId="gapp-menu" items={[
      ...(v.available && v.status === 'connected' ? [{ label: t('drive.reconnect'), onSelect: () => void d.start(), disabled: busy, testId: 'gapp-menu-reconnect' }] : []),
      { label: t('drive.disconnect'), onSelect: () => void g.disconnect(v.id), danger: true, disabled: busy, testId: 'gapp-menu-disconnect' },
    ]} />
  )
  const actions = flow ? null
    : v.status === 'connected' ? (
      <>
        <Button variant="primary" onClick={() => onChat(examples[0]!)} data-testid="gapp-try">{t('gapps.tryInChat')}</Button>
        <Button onClick={() => setSettings(true)} data-testid="gapp-settings"><Settings2 size={15} aria-hidden /> {t('gapps.settings')}</Button>
        {menu}
      </>
    ) : v.status === 'needs_reconnect' ? (
      <>
        {v.available && <Button variant="primary" busy={d.busy} onClick={() => void d.start()} data-testid="gapp-reconnect">{t('drive.reconnect')}</Button>}
        {menu}
      </>
    ) : (
      <Button variant="primary" busy={d.busy} disabled={!v.available} onClick={() => void d.start()} data-testid="gapp-connect">{t('aiApps.connect')}</Button>
    )
  const state = flow ? `flow-${flow.state}` : !v.available && !linked ? 'unavailable' : v.status
  return (
    <>
      <AppDetail testId="gapp-detail" state={state} logo={builtInLogo(v.id)} name={name} byLine={t('gapps.byLine', { line: t(lineKey(v.id)) })}
        actions={actions}
        status={<>
          {linked && v.account && !flow && (
            <p className="text-sm text-muted" data-testid="gapp-account-line">
              {t(v.status === 'connected' ? 'gapps.connectedAs' : 'gapps.signedInAs', { account: v.account.email ?? v.account.name ?? '' })}
            </p>
          )}
          {v.status === 'needs_reconnect' && !flow && <Note tone="warn" testId="gapp-needs-reconnect">{t('gapps.needsReconnect', { name })}</Note>}
          {v.status === 'connected' && v.serviceDown && <Note testId="gapp-service-down">{t('gapps.serviceDown', { name })}</Note>}
          {why && (
            <Note testId="gapp-unavailable" reason={v.reason ?? undefined}>
              {t(why.long, { name })}
              {admin && v.reason === 'not_set_up' && <> <Link to={`/admin/connectors?app=${v.id}`} className="font-medium text-accent-text underline underline-offset-2" data-testid="gapp-admin-link">{t('gapps.setUpLink', { name })}</Link></>}
            </Note>
          )}
          <SignInSteps d={d} testId="gapp" failed={t('drive.failed')} />
        </>}
        examples={examples} onExample={onChat}
        about={t(aboutKey(v.id))}
        canChange={canChange(v.tools)} asks={v.writePolicy}
        developer={t(developerKey(v.id))} category={t(categoryKey(v.id))}
        links={{ privacy: GOOGLE_PRIVACY, terms: GOOGLE_TERMS }}
        tools={v.tools} />
      {settings && <GoogleAppSettings v={v} busy={g.busy === v.id} onPolicy={(p) => void g.setPolicy(v.id, p)} onClose={() => setSettings(false)} />}
    </>
  )
}

/** A calm line under a page's header: why something is not possible now, or what to do about it. */
export function Note({ children, tone, testId, reason }: { children: React.ReactNode; tone?: 'warn'; testId: string; reason?: string }) {
  return (
    <p className={`border-l-2 py-1 pl-3 text-sm ${tone === 'warn' ? 'border-warn text-ink' : 'border-line text-muted'}`} data-testid={testId} data-reason={reason}>
      {children}
    </p>
  )
}

/** Settings of one connected app: whether the AI asks before it changes or sends something there. Saved at once. */
function GoogleAppSettings({ v, busy, onPolicy, onClose }: { v: GoogleAppView; busy: boolean; onPolicy: (p: 'ask' | 'allow') => void; onClose: () => void }) {
  const t = useT()
  const name = builtInName(v.id)
  const opts = [
    { id: 'ask' as const, label: t('gapps.policy.ask'), line: t('gapps.policy.askLine') },
    { id: 'allow' as const, label: t('gapps.policy.allow'), line: t('gapps.policy.allowLine', { name }) },
  ]
  return (
    <Modal open title={t('gapps.settingsTitle', { name })} onClose={onClose} width={440}
      footer={<Button variant="primary" onClick={onClose} data-testid="gapp-settings-done">{t('common.done')}</Button>}>
      <fieldset className="space-y-2" data-testid="gapp-settings-dialog" disabled={busy}>
        <legend className="mb-2 text-sm text-muted">{t('gapps.policy.question')}</legend>
        {opts.map((o) => (
          <label key={o.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${v.writePolicy === o.id ? 'border-accent bg-accent-soft/40' : 'border-line hover:bg-hover'}`}>
            <input type="radio" name="gapp-policy" className="mt-1 accent-[var(--c-accent)]" checked={v.writePolicy === o.id} onChange={() => onPolicy(o.id)} data-testid={`gapp-policy-${o.id}`} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="mt-0.5 block text-xs text-muted">{o.line}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </Modal>
  )
}
