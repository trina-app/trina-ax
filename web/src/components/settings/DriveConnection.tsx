import { useEffect, useRef, useState } from 'react'
import type { DriveConnection as Connection, DriveFlow } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { mobileApp, openExternal } from '../../lib/mobile'
import { useT } from '../../i18n'
import { Button, ErrorNote, Skeleton, confirmDialog } from '../ui'

function googleAuthorization(value: string): string {
  const u = new URL(value)
  if (u.origin !== 'https://accounts.google.com' || u.pathname !== '/o/oauth2/v2/auth' || u.username || u.password) throw new Error('invalid authorization URL')
  return u.href
}

/**
 * Connecting the person's own Google account to Drive (Settings > Google Drive, and a chat's connect_service card):
 * authorize in a window reserved during the click (the phone app: the browser), poll the flow, then the person
 * confirms the account they signed in with. `onConnected`: the connection once it is complete (here or in another
 * window). `generation` is shared with the caller's own requests: starting over makes older answers stale.
 */
export function useDriveFlow(onConnected: (c: Connection) => void) {
  const [flow, setFlow] = useState<DriveFlow | null>(null)
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
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
        if (['failed', 'expired'].includes(next.state)) setError(true)
      } catch { if (active && g === generation.current) setError(true) }
      if (active && g === generation.current) timer = setTimeout(poll, 1500)
    }
    timer = setTimeout(poll, 1000)
    return () => { active = false; clearTimeout(timer) }
  }, [flow?.flowId, flow?.state])
  const start = async () => {
    const g = ++generation.current
    setBusy(true); setError(false); setFlow(null); setAuthorizationUrl(null)
    // Reserve the web popup during the click. If blocked, show the same checked URL as a normal link.
    if (!mobileApp()) { popup.current = window.open('about:blank', '_blank'); if (popup.current) popup.current.opener = null }
    try {
      const result = await api.call(API.authorizeDrive, { body: {} })
      if (g !== generation.current) return
      const url = googleAuthorization(result.authorizationUrl)
      setAuthorizationUrl(url)
      setFlow({ flowId: result.flowId, state: 'pending', account: null, expiresAt: result.expiresAt, reason: null })
      if (mobileApp()) await openExternal(url, { purpose: 'google-oauth' })
      else if (popup.current) popup.current.location.replace(url)
    } catch { if (g === generation.current) { setError(true); popup.current?.close() } }
    finally { if (g === generation.current) setBusy(false) }
  }
  const cancel = async () => {
    if (!flow) return
    const id = flow.flowId, g = ++generation.current
    setBusy(true); setFlow(null); setAuthorizationUrl(null); popup.current?.close()
    try { await api.call(API.cancelDriveFlow, { params: { id } }) }
    catch { if (g === generation.current) setError(true) }
    finally { if (g === generation.current) setBusy(false) }
  }
  const complete = async () => {
    if (flow?.state !== 'ready') return
    const g = ++generation.current
    setBusy(true); setError(false)
    try {
      const r = await api.call(API.completeDriveFlow, { params: { id: flow.flowId }, body: {} })
      if (g !== generation.current) return
      setFlow(null); setAuthorizationUrl(null); popup.current?.close(); connected.current(r)
    } catch { if (g === generation.current) setError(true) }
    finally { if (g === generation.current) setBusy(false) }
  }
  const inProgress = !!flow && ['pending', 'exchanging', 'ready'].includes(flow.state)
  return { flow, authorizationUrl, busy, setBusy, error, setError, generation, start, cancel, complete, inProgress }
}
export type DriveFlowState = ReturnType<typeof useDriveFlow>

/** A Drive connection under way: waiting for Google, then "connect this account?" with the account to confirm. */
export function DriveFlowPanel({ d, flow }: { d: DriveFlowState; flow: DriveFlow }) {
  const t = useT()
  return <div className="space-y-3 rounded-xl border border-line p-4">
    <p role="status">{t(flow.state === 'ready' ? 'drive.confirmAccount' : 'drive.waiting')}</p>
    {flow.state === 'ready' && <>
      <p data-testid="drive-account">{flow.account?.name} {flow.account?.email}</p>
      <Button variant="primary" busy={d.busy} onClick={d.complete} data-testid="drive-confirm">{t('drive.confirm')}</Button>
    </>}
    {flow.state !== 'ready' && d.authorizationUrl && <a href={d.authorizationUrl} target="_blank" rel="noopener noreferrer" className="block text-sm text-accent-text hover:underline" onClick={mobileApp() ? (e) => { e.preventDefault(); void openExternal(d.authorizationUrl!, { purpose: 'google-oauth' }).catch(() => d.setError(true)) } : undefined}>{t('drive.openGoogle')}</a>}
    <Button disabled={d.busy} onClick={d.cancel}>{t('common.cancel')}</Button>
  </div>
}

export function DriveConnection() {
  const t = useT()
  const [connection, setConnection] = useState<Connection | null>(null)
  const [revokeWarning, setRevokeWarning] = useState(false)
  const d = useDriveFlow(setConnection)
  const { busy, error, setBusy, setError, generation, flow } = d
  useEffect(() => {
    const g = ++generation.current
    api.call(API.myDriveConnection).then(r => { if (g === generation.current) setConnection(r) }, () => { if (g === generation.current) setError(true) })
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
  return <section className="space-y-4" data-testid="drive-connection">
    <div><h2 className="text-base font-semibold">{t('drive.title')}</h2><p className="mt-1 text-sm text-muted">{t('drive.description')}</p></div>
    <p className="rounded-xl bg-subtle p-3 text-xs text-muted">{t('drive.privacy')}</p>
    {mobileApp() && <p className="text-xs text-muted">{t('drive.mobileBrowserLogin')}</p>}
    {error && <ErrorNote>{t('drive.failed')}</ErrorNote>}
    {revokeWarning && <p role="status" className="text-sm text-muted">{t('drive.revokeWarning')}</p>}
    {!connection && !error && <Skeleton lines={3} />}
    {connection && !connection.configured && <p>{t('drive.notConfigured')}</p>}
    {connection?.configured && <>
      <p data-testid="drive-status">{t(`drive.status.${connection.status}`)}</p>
      {connection.account && <p className="text-sm">{connection.account.name} {connection.account.email}</p>}
      {d.inProgress && flow ? <DriveFlowPanel d={d} flow={flow} /> : <div className="flex gap-2">
        <Button variant="primary" busy={busy} onClick={start}>{t(connection.status === 'connected' || connection.status === 'needs_reconnect' ? 'drive.reconnect' : 'drive.connect')}</Button>
        {connection.status !== 'disconnected' && <Button disabled={busy} onClick={disconnect}>{t('drive.disconnect')}</Button>}
      </div>}
    </>}
  </section>
}
