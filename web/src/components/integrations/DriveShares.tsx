// Admin › Connectors › Google Drive: Drives shared with the team (server/src/integrations/google-drive/shares.ts).
//  - "Share a Google Drive with the team" opens a small dialog: Google sign-in (the server's own client, read only),
//    one inline line confirms the account, then the share's name, its folders (top-level folders and shared drives,
//    with search; the whole Drive only with a warning) and who may use it (the same picker as team connections).
//    Cancelling before the first Save stops the share again, so a half-made one never stays.
//  - Each share is a row: the account, its folders, who may use it and how many people that is, and ⋯ with Change
//    folders or people, Reconnect and Stop sharing. A share that stopped (its admin left, Google signed it out) says
//    why and asks for a new sign-in.
// The server decides everything that matters (the folders, the rule, the tokens); this page only asks it.
import { Search, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { API, type DriveAdminStatus, type DriveFlow, type DriveShare, type DriveShareFolder, type IntegrationAccess } from '@mycel/shared/api'
import { api, ApiError } from '../../lib/api'
import { mobileApp, openExternal } from '../../lib/mobile'
import { driveSignInUrl } from '../../lib/driveSignIn'
import { isEmptyAccess } from '../../lib/integrations'
import { useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { toast } from '../../store/ui'
import { Badge, Button, confirmDialog, Field, inputCls, Modal, Spinner } from '../ui'
import { useLoad } from '../../pages/admin/common'
import { AppConnectorCard, CardMenu } from './AppConnectorCard'
import { AccessPicker } from './IntegrationDialog'
import { DriveLogo } from './DriveConnector'

const NOBODY: IntegrationAccess = { everyone: false, groups: [], users: [] }

/** A Google sign-in for a share: a window reserved during the click, polled until Google sent the account back. */
function useShareFlow() {
  const [flow, setFlow] = useState<DriveFlow | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(false)
  const generation = useRef(0), popup = useRef<Window | null>(null)
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
        if (['failed', 'expired'].includes(next.state)) setError(true)
      } catch { if (active && g === generation.current) setError(true) }
      if (active && g === generation.current) timer = setTimeout(poll, 1500)
    }
    timer = setTimeout(poll, 1000)
    return () => { active = false; clearTimeout(timer) }
  }, [flow?.flowId, flow?.state])
  const start = async (shareId?: string) => {
    const g = ++generation.current
    setBusy(true); setError(false); setFlow(null); setUrl(null)
    if (!mobileApp()) { popup.current = window.open('about:blank', '_blank'); if (popup.current) popup.current.opener = null }
    try {
      const r = await api.call(API.authorizeDriveShare, { body: shareId ? { shareId } : {} })
      if (g !== generation.current) return
      const href = driveSignInUrl(r, !!mobileApp())
      setUrl(href)
      setFlow({ flowId: r.flowId, state: 'pending', account: null, expiresAt: r.expiresAt, reason: null })
      if (mobileApp()) await openExternal(href, { purpose: 'google-oauth' })
      else if (popup.current) popup.current.location.replace(href)
    } catch { if (g === generation.current) { setError(true); popup.current?.close() } }
    finally { if (g === generation.current) setBusy(false) }
  }
  const cancel = async () => {
    if (!flow) return
    const id = flow.flowId
    generation.current++
    setFlow(null); setUrl(null); popup.current?.close()
    try { await api.call(API.cancelDriveFlow, { params: { id } }) } catch {}
  }
  const complete = async (name?: string): Promise<DriveShare | null> => {
    if (flow?.state !== 'ready') return null
    const g = ++generation.current
    setBusy(true); setError(false)
    try {
      const r = await api.call(API.completeDriveShareFlow, { params: { id: flow.flowId }, body: name ? { name } : {} })
      if (g === generation.current) { setFlow(null); setUrl(null) }
      return r
    } catch (e) {
      if (g === generation.current) setError(true)
      throw e
    } finally { if (g === generation.current) setBusy(false) }
  }
  return { flow, url, busy, error, start, cancel, complete, inProgress: !!flow && ['pending', 'exchanging', 'ready'].includes(flow.state) }
}

/** "Finance, Q3" or "Whole Drive" */
function foldersLine(t: ReturnType<typeof useT>, s: Pick<DriveShare, 'folders' | 'wholeDrive'>) {
  if (s.wholeDrive) return t('driveShare.wholeDrive')
  return s.folders.length ? s.folders.map((f) => f.name).join(', ') : t('driveShare.noFolders')
}

/** The members' switch and the shares, under Google Drive's admin page once the server has a Google client. */
export function DriveAdminSettings({ status, onStatus }: { status: DriveAdminStatus; onStatus: (s: DriveAdminStatus) => void }) {
  const t = useT()
  const shares = useLoad(async () => (await api.call(API.listDriveShares)).items)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const [dialog, setDialog] = useState<{ share?: DriveShare; reconnect?: boolean } | null>(null)
  // the switch moves at once; it goes back if the server refuses
  const [switching, setSwitching] = useState<boolean | null>(null)
  const membersOn = switching ?? status.membersCanConnect !== false
  const refresh = async () => {
    void shares.reload()
    try { onStatus(await api.call(API.driveAdminStatus)) } catch {}
  }
  const toggle = async (on: boolean) => {
    setSwitching(on)
    try { onStatus(await api.call(API.setDriveMembers, { body: { on } })) }
    catch { toast({ level: 'error', text: t('driveShare.saveFailed') }) }
    finally { setSwitching(null) }
  }
  const stop = async (s: DriveShare) => {
    if (!await confirmDialog({ title: t('driveShare.stopTitle', { name: s.name }), body: t('driveShare.stopBody'), confirm: t('driveShare.stop'), danger: true })) return
    try { await api.call(API.stopDriveShare, { params: { id: s.id } }); toast({ level: 'success', text: t('driveShare.stopped', { name: s.name }) }) }
    catch { toast({ level: 'error', text: t('driveShare.saveFailed') }) }
    await refresh()
  }
  const audienceOf = (s: DriveShare) => {
    if (isEmptyAccess(s.access)) return t('driveShare.nobody')
    return t('driveShare.usedBy', { count: s.usedBy })
  }
  return (
    <div className="space-y-6" data-testid="drive-admin-settings">
      <section className="flex items-start gap-4 rounded-2xl border border-line p-4" data-testid="drive-members">
        <div className="min-w-0 flex-1">
          <h4 id="drive-members-title" className="text-sm font-semibold">{t('driveAdmin.members')}</h4>
          <p id="drive-members-desc" className="mt-0.5 text-xs text-muted">{t('driveAdmin.membersDesc')}</p>
          {membersOn && <p className="mt-1 text-xs text-faint">{t('appConnectors.connectedMembers', { count: status.connectedMembers })}</p>}
        </div>
        <Switch checked={membersOn} disabled={switching !== null} onChange={(v) => void toggle(v)} />
      </section>
      <section aria-labelledby="drive-shares-title" data-testid="drive-shares">
        <div className="mb-3 flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-[1_1_16rem]">
            <h4 id="drive-shares-title" className="text-sm font-semibold">{t('driveAdmin.shareTitle')}</h4>
            <p className="mt-0.5 text-xs text-muted">{t('driveAdmin.shareDesc')}</p>
          </div>
          <Button variant="primary" onClick={() => setDialog({})} data-testid="drive-share-add">{t('driveAdmin.shareAdd')}</Button>
        </div>
        {shares.error ? <p className="text-sm text-danger" role="alert">{t('driveAdmin.loadFailed')}</p>
          : !shares.data ? <Spinner />
          : !shares.data.length ? <p className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted" data-testid="drive-shares-empty">{t('driveAdmin.shareEmpty')}</p>
          : (
            <ul className="grid grid-cols-1 gap-3" data-testid="drive-share-list">
              {shares.data.map((s) => (
                <AppConnectorCard key={s.id} testId="drive-share-row" state={s.status} logo={<DriveLogo className="size-10" />} name={s.name}
                  line={s.account.email ?? s.account.name ?? ''}
                  lineTone={s.status === 'connected' ? 'muted' : 'warn'}
                  action={<>
                    {s.status !== 'connected' && <Badge tone="warn" className="hidden shrink-0 sm:inline-flex">{t('driveShare.needsReconnect')}</Badge>}
                    <CardMenu label={t('driveShare.more', { name: s.name })} testId="drive-share-menu" items={[
                      { label: t('driveShare.edit'), onSelect: () => setDialog({ share: s }), disabled: s.status !== 'connected', testId: 'drive-share-edit' },
                      { label: t('drive.reconnect'), onSelect: () => setDialog({ share: s, reconnect: true }), testId: 'drive-share-reconnect' },
                      { label: t('driveShare.stop'), onSelect: () => void stop(s), danger: true, testId: 'drive-share-stop' },
                    ]} />
                  </>}>
                  <p className="-mt-1 pl-[3.25rem] text-xs break-words text-muted" data-testid="drive-share-detail">{foldersLine(t, s)} · {audienceOf(s)}</p>
                  {s.status !== 'connected' && s.reason && <p className="pl-[3.25rem] text-xs text-warn" role="status" data-testid="drive-share-reason">{t(`driveShare.reason.${s.reason}`)}</p>}
                </AppConnectorCard>
              ))}
            </ul>
          )}
      </section>
      {dialog && (
        <DriveShareDialog share={dialog.share} reconnect={dialog.reconnect} groups={groups.data ?? []} users={users.data ?? []}
          onClose={() => { setDialog(null); void refresh() }} onSaved={() => { setDialog(null); void refresh() }} />
      )}
    </div>
  )
}

function Switch({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="relative mt-0.5 inline-flex shrink-0 cursor-pointer items-center">
      <input type="checkbox" role="switch" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)}
        aria-labelledby="drive-members-title" aria-describedby="drive-members-desc" data-testid="drive-members-switch" />
      <span className="relative h-5 w-9 rounded-full bg-field-border transition peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:opacity-60 after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4 dark:peer-checked:after:bg-accent-ink" aria-hidden />
    </label>
  )
}

/** Connect (Google sign-in, confirm the account), then name, folders and who may use it; or change an existing share,
 * or sign in again for one (`reconnect`). */
function DriveShareDialog({ share, reconnect, groups, users, onClose, onSaved }: {
  share?: DriveShare; reconnect?: boolean; groups: Parameters<typeof AccessPicker>[0]['groups']; users: Parameters<typeof AccessPicker>[0]['users']
  onClose: () => void; onSaved: () => void
}) {
  const t = useT()
  const me = useMeStrict()
  const f = useShareFlow()
  const [made, setMade] = useState<DriveShare | null>(reconnect ? null : share ?? null)
  const [name, setName] = useState(share?.name ?? t('driveShare.defaultName'))
  const [chosen, setChosen] = useState<DriveShareFolder[]>(share?.folders ?? [])
  const [whole, setWhole] = useState(share?.wholeDrive ?? false)
  const [access, setAccess] = useState<IntegrationAccess>(share?.access ?? NOBODY)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const isNew = !share
  const step = made ? 'settings' : 'connect'

  const confirm = async () => {
    setError(null)
    try {
      const s = await f.complete(isNew ? name.trim() || t('driveShare.defaultName') : undefined)
      if (!s) return
      if (reconnect) { toast({ level: 'success', text: t('drive.status.connected') }); onSaved(); return }
      setMade(s); setName(s.name)
    } catch (e) { setError(t(e instanceof ApiError && e.message.includes('name_taken') ? 'driveShare.nameTaken' : 'drive.failed')) }
  }
  const close = async () => {
    await f.cancel()
    // a share made here but never saved: stop it again (its tokens go with it)
    if (isNew && made) { try { await api.call(API.stopDriveShare, { params: { id: made.id } }) } catch {} }
    onClose()
  }
  const save = async () => {
    if (!made) return
    if (!whole && !chosen.length) { setError(t('driveShare.pickFolder')); return }
    setBusy(true); setError(null)
    try {
      await api.call(API.updateDriveShare, { params: { id: made.id }, body: { name: name.trim(), folders: whole ? [] : chosen.map((x) => x.id), wholeDrive: whole, access } })
      if (isNew) toast({ level: 'success', text: t('driveShare.saved') })
      onSaved()
    } catch (e) {
      const m = e instanceof ApiError ? e.message : ''
      setError(t(m.includes('name_taken') ? 'driveShare.nameTaken' : 'driveShare.saveFailed'))
    } finally { setBusy(false) }
  }
  const title = share ? (reconnect ? t('drive.reconnect') : t('driveShare.editTitle', { name: share.name })) : t('driveShare.dialogTitle')
  return (
    <Modal open title={title} onClose={() => void close()} width={560}
      footer={step === 'settings' ? <>
        <Button onClick={() => void close()} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void save()} data-testid="drive-share-save">{t('common.save')}</Button>
      </> : <Button onClick={() => void close()}>{t('common.cancel')}</Button>}>
      <div className="space-y-4" data-testid="drive-share-dialog" data-step={step}>
        {step === 'connect' && <>
          <p className="text-sm text-muted">{t('driveShare.intro')}</p>
          {isNew && <Field label={t('driveShare.name')}><input className={inputCls} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="drive-share-name" /></Field>}
          {!f.inProgress && <Button variant="primary" busy={f.busy} onClick={() => void f.start(share?.id)} data-testid="drive-share-google">{t('drive.openGoogle')}</Button>}
          {f.flow && f.flow.state !== 'ready' && f.inProgress && (
            <div className="flex flex-wrap items-center gap-2 text-sm" role="status" data-testid="drive-share-waiting">
              <span className="text-muted">{t('drive.waitingShort')}</span>
              {f.url && <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline"
                onClick={mobileApp() ? (e) => { e.preventDefault(); void openExternal(f.url!, { purpose: 'google-oauth' }) } : undefined}>{t('drive.openGoogle')}</a>}
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void f.cancel()} data-testid="drive-share-cancel-flow">{t('common.cancel')}</Button>
            </div>
          )}
          {f.flow?.state === 'ready' && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm" data-testid="drive-share-confirm-step">
              <span role="status" className="min-w-0 flex-1">{t('drive.confirmAccount')} <span className="font-medium" data-testid="drive-share-account">{[f.flow.account?.name, f.flow.account?.email].filter(Boolean).join(' · ')}</span></span>
              <Button size="sm" variant="primary" busy={f.busy} onClick={() => void confirm()} data-testid="drive-share-confirm">{t('drive.confirm')}</Button>
            </div>
          )}
          {f.error && !f.inProgress && <p className="text-sm text-danger" role="alert">{t('drive.failed')}</p>}
        </>}
        {step === 'settings' && made && <>
          <p className="text-xs text-muted" data-testid="drive-share-signed-in">{t('driveShare.account', { email: made.account.email ?? made.account.name ?? '' })}</p>
          <Field label={t('driveShare.name')}><input className={inputCls} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="drive-share-name" /></Field>
          <FolderPicker shareId={made.id} chosen={chosen} onChosen={setChosen} whole={whole} onWhole={setWhole} />
          <AccessPicker value={access} onChange={setAccess} groups={groups} users={users} me={{ id: me.user.id, groupIds: me.groups.map((g) => g.id) }} template
            legend={t('driveShare.audience')} note={t('driveShare.audienceNote')} />
        </>}
        {error && <p className="text-sm text-danger" role="alert" data-testid="drive-share-error">{error}</p>}
      </div>
    </Modal>
  )
}

/** The share account's top-level folders and shared drives, or the folders whose name has the search; the whole Drive
 * only with its warning. */
function FolderPicker({ shareId, chosen, onChosen, whole, onWhole }: { shareId: string; chosen: DriveShareFolder[]; onChosen: (f: DriveShareFolder[]) => void; whole: boolean; onWhole: (v: boolean) => void }) {
  const t = useT()
  const [q, setQ] = useState('')
  const [items, setItems] = useState<DriveShareFolder[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setItems(null); setFailed(false)
    const timer = setTimeout(() => {
      api.call(API.driveShareFolders, { params: { id: shareId }, query: q.trim() ? { q: q.trim() } : {} })
        .then((r) => { if (live) setItems(r.items) }, () => { if (live) setFailed(true) })
    }, q ? 300 : 0)
    return () => { live = false; clearTimeout(timer) }
  }, [shareId, q])
  const has = (id: string) => chosen.some((x) => x.id === id)
  const toggle = (f: DriveShareFolder) => onChosen(has(f.id) ? chosen.filter((x) => x.id !== f.id) : [...chosen, f])
  // chosen folders stay listed even when the search does not show them
  const shown = [...chosen.filter((c) => !(items ?? []).some((x) => x.id === c.id)), ...(items ?? [])]
  return (
    <fieldset className="space-y-2" data-testid="drive-share-folders">
      <legend className="mb-1 text-label font-medium text-ink">{t('driveShare.folders')}</legend>
      <p className="text-xs text-muted">{t('driveShare.foldersHint')}</p>
      {!whole && <>
        <label className="relative block">
          <span className="sr-only">{t('driveShare.search')}</span>
          <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
          <input className={`${inputCls} pl-8`} type="search" value={q} placeholder={t('driveShare.search')} onChange={(e) => setQ(e.target.value)} data-testid="drive-share-folder-search" />
        </label>
        <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-line p-1.5" aria-busy={!items && !failed}>
          {failed ? <p className="px-1.5 py-1 text-xs text-danger" role="alert">{t('driveShare.foldersFailed')}</p>
            : !items && !chosen.length ? <p className="px-1.5 py-1 text-xs text-faint">{t('driveShare.loadingFolders')}</p>
            : !shown.length ? <p className="px-1.5 py-1 text-xs text-faint">{t('driveShare.noFolderMatch')}</p>
            : shown.map((f) => (
              <label key={f.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-hover">
                <input type="checkbox" checked={has(f.id)} onChange={() => toggle(f)} data-testid="drive-share-folder" data-id={f.id} />
                <span className="min-w-0 flex-1 break-words">{f.name}</span>
                {f.kind === 'drive' && <span className="shrink-0 text-xs text-faint">{t('driveShare.sharedDrive')}</span>}
              </label>
            ))}
        </div>
        {chosen.length > 0 && <p className="text-xs text-muted" data-testid="drive-share-chosen">{t('driveShare.chosen', { count: chosen.length })}: {chosen.map((c) => c.name).join(', ')}</p>}
      </>}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={whole} onChange={(e) => onWhole(e.target.checked)} data-testid="drive-share-whole" /> {t('driveShare.wholeDrive')}
      </label>
      {whole && (
        <p role="note" className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn" data-testid="drive-share-whole-warning">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden /><span>{t('driveShare.wholeWarn')}</span>
        </p>
      )}
    </fieldset>
  )
}
