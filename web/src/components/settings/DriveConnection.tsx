import { useEffect, useRef, useState } from 'react'
import type { DriveConnection as Connection, DriveFlow } from '@mycel/shared/api'
import { api, API, ApiError } from '../../lib/api'
import { mobileApp, openExternal } from '../../lib/mobile'
import { driveSignInUrl } from '../../lib/driveSignIn'
import { useT } from '../../i18n'
import { Button, confirmDialog } from '../ui'

/**
 * Connecting the person's own Google account to Drive (Settings > MCP, and a chat's connect_service card):
 * authorize in a window reserved during the click (the phone app: the browser), poll the flow, then the person
 * confirms the account they signed in with. `onConnected`: the connection once it is complete (here or in another
 * window). `generation` is shared with the caller's own requests: starting over makes older answers stale. `reason`:
 * why the last start or flow failed, as the server says it ("drive_broker_unavailable", a flow's "consent_denied"), for
 * a caller that words it (the welcome steps' 도구 연결); `resume`: a flow this session started before a reload.
 */
export function useDriveFlow(onConnected: (c: Connection) => void) {
  const [flow, setFlow] = useState<DriveFlow | null>(null)
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [reason, setReason] = useState<string | null>(null)
  // the browser refused the window reserved during the click: the page shows Google's address as a link instead
  const [popupBlocked, setPopupBlocked] = useState(false)
  const generation = useRef(0)
  const popup = useRef<Window | null>(null)
  const connected = useRef(onConnected)
  connected.current = onConnected
  useEffect(() => () => { generation.current++; popup.current?.close() }, [])
  useEffect(() => {
    if (!flow || !['pending', 'exchanging'].includes(flow.state)) return
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const g = generation.current, id = flow.flowId
    const poll = async () => {
      try {
        const next = await api.call(API.driveFlow, { params: { id } })
        if (!active || g !== generation.current) return
        setFlow(next)
        if (next.state === 'ready') popup.current?.close()
        if (next.state === 'completed') {
          const r = await api.call(API.myDriveConnection)
          if (active && g === generation.current) { setFlow(null); setAuthorizationUrl(null); connected.current(r) }
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
    setBusy(true); setError(false); setReason(null); setFlow(null); setAuthorizationUrl(null)
    // Reserve the web popup during the click. If blocked, show the same checked URL as a normal link.
    if (!mobileApp()) { popup.current = window.open('about:blank', '_blank'); if (popup.current) popup.current.opener = null; setPopupBlocked(!popup.current) }
    try {
      const result = await api.call(API.authorizeDrive, { body: {} })
      if (g !== generation.current) return
      const url = driveSignInUrl(result, !!mobileApp())
      setAuthorizationUrl(url)
      setFlow({ flowId: result.flowId, state: 'pending', account: null, expiresAt: result.expiresAt, reason: null })
      if (mobileApp()) await openExternal(url, { purpose: 'google-oauth' })
      else if (popup.current) popup.current.location.replace(url)
    } catch (e) { if (g === generation.current) { setError(true); setReason(e instanceof ApiError ? e.message : null); popup.current?.close() } }
    finally { if (g === generation.current) setBusy(false) }
  }
  /** A flow of this session still under way (the page was reloaded): shown again, polled on, confirmed as before. */
  const resume = async (id: string) => {
    const g = generation.current
    try {
      const f = await api.call(API.driveFlow, { params: { id } })
      if (g === generation.current && ['pending', 'exchanging', 'ready'].includes(f.state)) setFlow(f)
    } catch { /* gone: nothing to resume */ }
  }
  const cancel = async () => {
    if (!flow) return
    const id = flow.flowId, g = ++generation.current
    setBusy(true); setFlow(null); setAuthorizationUrl(null); popup.current?.close()
    try { await api.call(API.cancelDriveFlow, { params: { id } }) }
    catch { if (g === generation.current) setError(true) }
    finally { if (g === generation.current) setBusy(false) }
  }
  /** `membersOn`: the members' switch is off and the owner or admin confirming turns it on with the connection (the
   * press named that) */
  const complete = async (opts: { membersOn?: true } = {}) => {
    if (flow?.state !== 'ready') return
    const g = ++generation.current
    setBusy(true); setError(false); setReason(null)
    try {
      const r = await api.call(API.completeDriveFlow, { params: { id: flow.flowId }, body: opts.membersOn ? { membersOn: true } : {} })
      if (g !== generation.current) return
      setFlow(null); setAuthorizationUrl(null); popup.current?.close(); connected.current(r)
    } catch (e) { if (g === generation.current) { setError(true); setReason(e instanceof ApiError ? e.message : null) } }
    finally { if (g === generation.current) setBusy(false) }
  }
  const inProgress = !!flow && ['pending', 'exchanging', 'ready'].includes(flow.state)
  return { flow, authorizationUrl, busy, setBusy, error, setError, reason, popupBlocked, generation, start, resume, cancel, complete, inProgress }
}
export type DriveFlowState = ReturnType<typeof useDriveFlow>

/** A Drive connection under way: waiting for Google, then "connect this account?" with the account to confirm. */
export function DriveFlowPanel({ d, flow }: { d: DriveFlowState; flow: DriveFlow }) {
  const t = useT()
  return <div className="space-y-3 rounded-xl border border-line p-4">
    <p role="status">{t(flow.state === 'ready' ? 'drive.confirmAccount' : 'drive.waiting')}</p>
    {flow.state === 'ready' && <>
      <p data-testid="drive-account">{flow.account?.name} {flow.account?.email}</p>
      <Button variant="primary" busy={d.busy} onClick={() => void d.complete()} data-testid="drive-confirm">{t('drive.confirm')}</Button>
    </>}
    {flow.state !== 'ready' && d.authorizationUrl && <a href={d.authorizationUrl} target="_blank" rel="noopener noreferrer" className="block text-sm text-accent-text hover:underline" onClick={mobileApp() ? (e) => { e.preventDefault(); void openExternal(d.authorizationUrl!, { purpose: 'google-oauth' }).catch(() => d.setError(true)) } : undefined}>{t('drive.openGoogle')}</a>}
    <Button disabled={d.busy} onClick={d.cancel}>{t('common.cancel')}</Button>
  </div>
}

/**
 * The person's own Google Drive connection, for Settings > MCP (components/integrations/DriveConnector.tsx: the
 * "Built in" card in Discover, its dialog and the row under Connected): the status, a connect that ends in
 * `onConnected`, and disconnect (with Google's revocation reported when it could not be done).
 */
export function useDriveConnection(onConnected?: (c: Connection) => void) {
  const t = useT()
  const [connection, setConnection] = useState<Connection | null>(null)
  const [revokeWarning, setRevokeWarning] = useState(false)
  // The first load of the status failed: this is not a failed connection, so it has its own message and a Retry.
  const [loadFailed, setLoadFailed] = useState(false)
  const connected = useRef(onConnected)
  connected.current = onConnected
  const d = useDriveFlow((c) => { setConnection(c); connected.current?.(c) })
  const { setBusy, setError, generation } = d
  const load = () => {
    const g = ++generation.current
    setLoadFailed(false)
    api.call(API.myDriveConnection).then(r => { if (g === generation.current) setConnection(r) }, () => { if (g === generation.current) setLoadFailed(true) })
  }
  useEffect(() => {
    load()
    return () => { generation.current++ }
  }, [])
  const start = () => { setRevokeWarning(false); void d.start() }
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
      setRevokeWarning(r.revocation === 'unavailable')
    } catch { if (g === generation.current) setError(true) }
    finally { if (g === generation.current) setBusy(false) }
  }
  return { connection, loadFailed, load, revokeWarning, start, disconnect, d }
}
export type DriveConnectionState = ReturnType<typeof useDriveConnection>
