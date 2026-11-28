import { useEffect, useRef, useState } from 'react'
import type { DriveConnection as Connection, DriveFlow } from '@mycel/shared/api'
import { api, API, ApiError } from '../../lib/api'
import { mobileApp, openExternal } from '../../lib/mobile'
import { desktopOpenUrl, driveSignInUrl, googleStartBody, openSignInWindow, reserveSignInWindow, signInPlace } from '../../lib/driveSignIn'
import { useT } from '../../i18n'
import { SIGN_IN_WAIT_MINUTES, useWaitLimit } from '../../lib/signInWait'
import { peekCached, rememberCached } from '../../store/listCache'
import { Button, LinkButton, WaitLine, confirmDialog } from '../ui'
import { GoogleAccountBlock } from '../integrations/GoogleAccount'
import { CopySignInLink } from '../integrations/CopySignInLink'

/** What a sign-in flow calls on the server: Google Drive's (useDriveFlow) and each Google app's (Gmail, Calendar, Docs,
 * Sheets: integrations/GoogleAppConnector.tsx) are the same steps on their own addresses. `current`: the connection once
 * a flow says it was completed elsewhere (another window confirmed it). */
export interface SignInOps<C> {
  authorize: () => Promise<{ flowId: string; authorizationUrl: string; connectUrl?: string; openPath?: string; expiresAt: string }>
  poll: (id: string) => Promise<DriveFlow>
  complete: (id: string) => Promise<C>
  cancel: (id: string) => Promise<unknown>
  current: () => Promise<C>
}

/**
 * Connecting the person's own Google account (Drive, or one Google app): authorize in a window reserved during the
 * click (the phone app: its browser; the desktop app: the system browser, once the server answered), poll the flow, then the person confirms the account they signed in with.
 * `onConnected`: the connection once it is complete (here or in another window). `generation` is shared with the
 * caller's own requests: starting over makes older answers stale. `reason`: why the last start or flow failed, as the
 * server says it ("drive_broker_unavailable", a flow's "consent_denied"), for a caller that words it (the welcome steps'
 * 도구 연결); `resume`: a flow this session started before a reload.
 */
export function useSignInFlow<C>(ops: SignInOps<C>, onConnected: (c: C) => void) {
  const [flow, setFlow] = useState<DriveFlow | null>(null)
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null)
  // the address the desktop app opened in the system browser ("Copy link" beside the wait: CopySignInLink)
  const [openedUrl, setOpenedUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [reason, setReason] = useState<string | null>(null)
  // the browser refused the window reserved during the click: the page shows Google's address as a link instead
  const [popupBlocked, setPopupBlocked] = useState(false)
  const generation = useRef(0)
  const popup = useRef<Window | null>(null)
  const connected = useRef(onConnected)
  connected.current = onConnected
  const calls = useRef(ops)
  calls.current = ops
  useEffect(() => () => { generation.current++; popup.current?.close() }, [])
  useEffect(() => {
    if (!flow || !['pending', 'exchanging'].includes(flow.state)) return
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const g = generation.current, id = flow.flowId
    const poll = async () => {
      try {
        const next = await calls.current.poll(id)
        if (!active || g !== generation.current) return
        setFlow(next)
        if (next.state === 'ready') popup.current?.close()
        if (next.state === 'completed') {
          const r = await calls.current.current()
          if (active && g === generation.current) { setFlow(null); setAuthorizationUrl(null); setOpenedUrl(null); connected.current(r) }
        }
        if (['failed', 'expired'].includes(next.state)) { setError(true); setReason(next.reason ?? next.state) }
      } catch { if (active && g === generation.current) setError(true) }
      if (active && g === generation.current) timer = setTimeout(poll, 1500)
    }
    timer = setTimeout(poll, 1000)
    return () => { active = false; clearTimeout(timer) }
  }, [flow?.flowId, flow?.state])
  const start = async () => {
    const g = ++generation.current
    setBusy(true); setError(false); setReason(null); setFlow(null); setAuthorizationUrl(null); setOpenedUrl(null)
    // A browser reserves its window during the click; if it was blocked, the page shows the same checked URL as a
    // normal link. The desktop app reserves none and opens the address once it is known (lib/driveSignIn.ts).
    const place = signInPlace()
    popup.current = reserveSignInWindow(place)
    setPopupBlocked(place === 'browser' && !popup.current)
    try {
      const result = await calls.current.authorize()
      if (g !== generation.current) return
      const url = driveSignInUrl(result, place === 'phone')
      setAuthorizationUrl(url)
      setFlow({ flowId: result.flowId, state: 'pending', account: null, expiresAt: result.expiresAt, reason: null })
      if (place === 'phone') await openExternal(url, { purpose: 'google-oauth' })
      // the desktop app: the server's one-time address first, so the system browser can finish without a sign-in
      // (Drive only; the link beside the wait stays the sign-in page)
      else {
        const opened = (place === 'desktop' && desktopOpenUrl(result, globalThis.location?.origin)) || url
        if (place === 'desktop') setOpenedUrl(opened)
        openSignInWindow(place, popup.current, opened)
      }
    } catch (e) { if (g === generation.current) { setError(true); setReason(e instanceof ApiError ? e.message : null); popup.current?.close() } }
    finally { if (g === generation.current) setBusy(false) }
  }
  /** A flow of this session still under way (the page was reloaded): shown again, polled on, confirmed as before. */
  const resume = async (id: string) => {
    const g = generation.current
    try {
      const f = await calls.current.poll(id)
      if (g === generation.current && ['pending', 'exchanging', 'ready'].includes(f.state)) setFlow(f)
    } catch { /* gone: nothing to resume */ }
  }
  const cancel = async () => {
    if (!flow) return
    const id = flow.flowId, g = ++generation.current
    setBusy(true); setFlow(null); setAuthorizationUrl(null); setOpenedUrl(null); popup.current?.close()
    try { await calls.current.cancel(id) }
    catch { if (g === generation.current) setError(true) }
    finally { if (g === generation.current) setBusy(false) }
  }
  const complete = async () => {
    if (flow?.state !== 'ready') return
    const g = ++generation.current
    setBusy(true); setError(false); setReason(null)
    try {
      const r = await calls.current.complete(flow.flowId)
      if (g !== generation.current) return
      setFlow(null); setAuthorizationUrl(null); setOpenedUrl(null); popup.current?.close(); connected.current(r)
    } catch (e) { if (g === generation.current) { setError(true); setReason(e instanceof ApiError ? e.message : null) } }
    finally { if (g === generation.current) setBusy(false) }
  }
  // the window was closed (or left) before Google answered: after a while the wait ends, the flow is cancelled on the
  // server, and Connect is back with a line that says so (reason "timeout"; QA TC-1417)
  useWaitLimit(!!flow && ['pending', 'exchanging'].includes(flow.state), flow?.flowId, () => {
    if (!flow) return
    const id = flow.flowId
    generation.current++
    setFlow(null); setAuthorizationUrl(null); setOpenedUrl(null); popup.current?.close()
    setError(true); setReason('timeout')
    void calls.current.cancel(id).catch(() => { /* it expires there by itself */ })
  })
  const inProgress = !!flow && ['pending', 'exchanging', 'ready'].includes(flow.state)
  return { flow, authorizationUrl, openedUrl, busy, setBusy, error, setError, reason, popupBlocked, generation, start, resume, cancel, complete, inProgress }
}
export type SignInFlowState = ReturnType<typeof useSignInFlow>

const DRIVE_OPS: SignInOps<Connection> = {
  authorize: () => api.call(API.authorizeDrive, { body: googleStartBody() }),
  poll: (id) => api.call(API.driveFlow, { params: { id } }),
  complete: (id) => api.call(API.completeDriveFlow, { params: { id }, body: {} }),
  cancel: (id) => api.call(API.cancelDriveFlow, { params: { id } }),
  current: () => api.call(API.myDriveConnection),
}

/** Connecting the person's own Google Drive (Connectors, and a chat's connect_service card): useSignInFlow on Drive's
 * addresses. */
export function useDriveFlow(onConnected: (c: Connection) => void) {
  return useSignInFlow(DRIVE_OPS, onConnected)
}
export type DriveFlowState = ReturnType<typeof useDriveFlow>

/** A Drive connection under way: waiting for Google, then "connect this account?" with the account to confirm. */
export function DriveFlowPanel({ d, flow }: { d: DriveFlowState; flow: DriveFlow }) {
  const t = useT()
  return <div className="space-y-3 rounded-xl border border-line p-4">
    {flow.state === 'ready' ? <p role="status">{t('drive.confirmAccount')}</p>
      : <WaitLine text={t('drive.waiting')} hint={<>{t('connect.wait.google', { n: SIGN_IN_WAIT_MINUTES })}<CopySignInLink url={d.openedUrl} testId="drive-flow-wait-copy-link" /></>} testId="drive-flow-wait" />}
    {flow.state === 'ready' && <>
      <GoogleAccountBlock account={flow.account} testId="drive-account" />
      <Button variant="primary" busy={d.busy} onClick={() => void d.complete()} data-testid="drive-confirm">{t('drive.confirm')}</Button>
    </>}
    {/* waiting: Continue with Google (the window again), Try again (a new window, the server replaces the flow) beside Cancel, always (QA TC-1417) */}
    <div className="flex flex-wrap gap-2">
      {flow.state !== 'ready' && d.authorizationUrl && <LinkButton variant="primary" href={d.authorizationUrl} onClick={mobileApp() ? (e) => { e.preventDefault(); void openExternal(d.authorizationUrl!, { purpose: 'google-oauth' }).catch(() => d.setError(true)) } : undefined}>{t('drive.openGoogle')}</LinkButton>}
      {flow.state !== 'ready' && <Button disabled={d.busy} onClick={() => void d.start()} data-testid="drive-flow-retry">{t('common.retry')}</Button>}
      <Button disabled={d.busy} onClick={d.cancel}>{t('common.cancel')}</Button>
    </div>
  </div>
}

/**
 * The person's own Google Drive connection, for Settings › Connectors (components/integrations/DriveConnector.tsx: the
 * "Built in" card in Discover, its page and its row among the connections): the status, a connect that ends in
 * `onConnected`, and disconnect (with Google's revocation reported when it could not be done).
 */
const DRIVE_KEY = 'connectors:drive'
export function useDriveConnection(onConnected?: (c: Connection) => void) {
  const t = useT()
  // as this window last read it (store/listCache.ts): Connectors shows it at once on a visit after the first
  const [connection, setConnection] = useState<Connection | null>(() => peekCached<Connection>(DRIVE_KEY) ?? null)
  useEffect(() => { if (connection) rememberCached(DRIVE_KEY, connection) }, [connection])
  // after a disconnect: Google could not be told ('unavailable'), or the hosting service's shared app keeps the grant for
  // the person's other Trina servers ('kept': the line offers Google's own page to remove it everywhere)
  const [revokeWarning, setRevokeWarning] = useState<'unavailable' | 'kept' | null>(null)
  // The first load of the status failed: this is not a failed connection, so it has its own message and a Retry.
  const [loadFailed, setLoadFailed] = useState(false)
  const connected = useRef(onConnected)
  connected.current = onConnected
  const d = useDriveFlow((c) => { setConnection(c); connected.current?.(c) })
  const { setBusy, setError, generation } = d
  const load = () => {
    const g = ++generation.current
    setLoadFailed(false)
    api.call(API.myDriveConnection).then(r => { if (g === generation.current) setConnection(r) }, () => { if (g === generation.current) { setConnection(null); setLoadFailed(true) } })
  }
  useEffect(() => {
    load()
    return () => { generation.current++ }
  }, [])
  const start = () => { setRevokeWarning(null); void d.start() }
  const disconnect = async () => {
    const intent = generation.current
    if (!await confirmDialog({ title: t('drive.disconnect'), body: t('drive.disconnectHint'), confirm: t('drive.disconnect'), danger: true })) return
    if (intent !== generation.current) return
    const g = ++generation.current
    setBusy(true); setError(false)
    try {
      const r = await api.call(API.disconnectDrive)
      if (g !== generation.current) return
      setConnection({ configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null })
      setRevokeWarning(r.revocation === 'unavailable' || r.revocation === 'kept' ? r.revocation : null)
    } catch { if (g === generation.current) setError(true) }
    finally { if (g === generation.current) setBusy(false) }
  }
  return { connection, loadFailed, load, revokeWarning, start, disconnect, d }
}
export type DriveConnectionState = ReturnType<typeof useDriveConnection>
