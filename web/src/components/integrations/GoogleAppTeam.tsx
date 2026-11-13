// Admin › Connectors › Gmail, Google Calendar, Google Docs or Google Sheets: one Google account shared with the team
// (shared/src/api/google-apps.ts GoogleAppTeam; docs/GOOGLE-APPS.md "Shared with the team"). Owners and admins only.
//  - One row in the page's Team settings, "Shared Google account": Connect for the team on its right while there is
//    none; once connected the account, who uses it and how many, who connected it, and ⋯ with Change people, Reconnect
//    and Remove.
//  - The dialog is Drive share's (DriveShares.tsx): Google sign-in, one line to confirm the account, then who may use it
//    (the same people picker as team connections), Save. A new one is used by nobody until Save; closing before the
//    first Save removes it again, so a half-made one never stays.
// Members' own connections are not touched by any of this. The server decides everything that matters.
import { useMemo, useState } from 'react'
import { API, type GoogleAppAdminStatus, type GoogleAppId, type GoogleAppTeam, type IntegrationAccess } from '@mycel/shared/api'
import { api } from '../../lib/api'
import { builtInLogo, builtInName } from '../../lib/googleApps'
import { isEmptyAccess } from '../../lib/integrations'
import { useT } from '../../i18n'
import { useMeStrict } from '../../store/session'
import { toast } from '../../store/ui'
import { Badge, Button, confirmDialog, Modal } from '../ui'
import { SettingRow, useLoad } from '../../pages/admin/common'
import { useSignInFlow, type SignInOps } from '../settings/DriveConnection'
import { CardMenu } from './AppConnectorCard'
import { AccessPicker } from './IntegrationDialog'
import { SignInSteps } from './GoogleAppConnector'

const NOBODY: IntegrationAccess = { everyone: false, groups: [], users: [] }
const accountLine = (a: GoogleAppTeam['account']) => a.email ?? a.name ?? ''

/** The shared account's row in Team settings, and its dialog. */
export function GoogleAppTeamRow({ status, onStatus }: { status: GoogleAppAdminStatus; onStatus: (s: GoogleAppAdminStatus) => void }) {
  const t = useT()
  const app = status.id
  const name = builtInName(app)
  const team = status.team ?? null
  const [dialog, setDialog] = useState<{ step: 'connect' | 'people'; isNew: boolean } | null>(null)
  const remove = async () => {
    if (!await confirmDialog({ title: t('gapps.team.removeTitle', { name }), body: t('gapps.team.removeBody', { name }), confirm: t('gapps.team.remove'), danger: true })) return
    try {
      await api.call(API.removeGoogleAppTeam, { params: { app } })
      toast({ level: 'success', text: t('gapps.team.removed', { name }) })
    } catch { toast({ level: 'error', text: t('gapps.saveFailed') }) }
    await refresh()
  }
  const refresh = async () => {
    try { const st = (await api.call(API.googleAppsAdminStatus)).apps.find((x) => x.id === app); if (st) onStatus(st) } catch {}
  }
  const audience = (x: GoogleAppTeam) => (isEmptyAccess(x.access) ? t('driveShare.nobody') : t('driveShare.usedBy', { count: x.usedBy }))
  return (
    <div data-testid="gapp-team">
      <SettingRow heading title={t('gapps.team.title')} desc={t('gapps.team.desc')} testId="gapp-team-row"
        control={!team ? <Button variant="primary" onClick={() => setDialog({ step: 'connect', isNew: true })} data-testid="gapp-team-connect">{t('gapps.team.connect')}</Button> : undefined}
        below={team ? (
          <div className="mt-2 flex items-start gap-3 border-t border-line py-3" data-testid="gapp-team-account" data-state={team.status}>
            <img src={builtInLogo(app)} alt="" className="size-9 shrink-0 rounded-lg border border-line p-1.5" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                <span className="break-all" data-testid="gapp-team-email">{accountLine(team.account)}</span>
                {team.status !== 'connected' && <Badge tone="warn">{t('driveShare.needsReconnect')}</Badge>}
              </p>
              <p className="mt-0.5 text-xs break-words text-muted" data-testid="gapp-team-detail">
                {audience(team)}{team.connectedBy ? ` · ${t('gapps.team.connectedBy', { name: team.connectedBy.name })}` : ''}
              </p>
            </div>
            <CardMenu label={t('driveShare.more', { name })} testId="gapp-team-menu" items={[
              { label: t('gapps.team.edit'), onSelect: () => setDialog({ step: 'people', isNew: false }), testId: 'gapp-team-edit' },
              { label: t('drive.reconnect'), onSelect: () => setDialog({ step: 'connect', isNew: false }), testId: 'gapp-team-reconnect' },
              { label: t('gapps.team.remove'), onSelect: () => void remove(), danger: true, testId: 'gapp-team-remove' },
            ]} />
          </div>
        ) : undefined} />
      {dialog && (
        <TeamDialog app={app} team={team} step={dialog.step} isNew={dialog.isNew}
          onStatus={onStatus} onClose={() => { setDialog(null); void refresh() }} />
      )}
    </div>
  )
}

/** Sign in (new or again), then who may use it; or only who may use it. */
function TeamDialog({ app, team, step: first, isNew, onStatus, onClose }: {
  app: GoogleAppId; team: GoogleAppTeam | null; step: 'connect' | 'people'; isNew: boolean
  onStatus: (s: GoogleAppAdminStatus) => void; onClose: () => void
}) {
  const t = useT()
  const me = useMeStrict()
  const name = builtInName(app)
  const groups = useLoad(async () => (await api.call(API.listGroups)).items)
  const users = useLoad(async () => (await api.call(API.listUsers)).items)
  const [step, setStep] = useState(first)
  const [made, setMade] = useState<GoogleAppTeam | null>(team)
  const [access, setAccess] = useState<IntegrationAccess>(team?.access ?? NOBODY)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const ops = useMemo<SignInOps<GoogleAppAdminStatus>>(() => ({
    authorize: () => api.call(API.authorizeGoogleAppTeam, { params: { app }, body: {} }),
    poll: (id) => api.call(API.googleAppTeamFlow, { params: { app, id } }),
    complete: (id) => api.call(API.completeGoogleAppTeamFlow, { params: { app, id }, body: {} }),
    cancel: (id) => api.call(API.cancelGoogleAppTeamFlow, { params: { app, id } }),
    current: async () => (await api.call(API.googleAppsAdminStatus)).apps.find((x) => x.id === app)!,
  }), [app])
  const f = useSignInFlow(ops, (st) => {
    onStatus(st)
    if (!isNew) { toast({ level: 'success', text: t('drive.status.connected') }); onClose(); return }
    if (st.team) { setMade(st.team); setAccess(st.team.access); setStep('people') }
  })
  const close = async () => {
    if (f.inProgress) await f.cancel()
    // made here but never saved: removed again (used by nobody so far)
    if (isNew && made) { try { await api.call(API.removeGoogleAppTeam, { params: { app } }) } catch {} }
    onClose()
  }
  const save = async () => {
    setBusy(true); setError(null)
    try {
      onStatus(await api.call(API.setGoogleAppTeam, { params: { app }, body: { access } }))
      toast({ level: 'success', text: t('gapps.team.saved') })
      onClose()
    } catch { setError(t('gapps.saveFailed')) } finally { setBusy(false) }
  }
  const title = step === 'people' && !isNew ? t('gapps.team.edit') : !isNew ? t('drive.reconnect') : t('gapps.team.dialogTitle', { name })
  return (
    <Modal open title={title} onClose={() => void close()} width={560}
      footer={step === 'people' ? <>
        <Button onClick={() => void close()} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={busy} onClick={() => void save()} data-testid="gapp-team-save">{t('common.save')}</Button>
      </> : <Button onClick={() => void close()}>{t('common.cancel')}</Button>}>
      <div className="space-y-4" data-testid="gapp-team-dialog" data-step={step}>
        {step === 'connect' && <>
          <p className="text-sm text-muted">{t('gapps.team.intro')}</p>
          {!f.inProgress && <Button variant="primary" busy={f.busy} onClick={() => void f.start()} data-testid="gapp-team-google">{t('drive.openGoogle')}</Button>}
          <SignInSteps d={f} testId="gapp-team" failed={t(f.reason === 'scope_denied' ? 'gapps.scopeDenied' : 'drive.failed')} />
        </>}
        {step === 'people' && made && <>
          <p className="text-xs text-muted" data-testid="gapp-team-signed-in">{t('driveShare.account', { email: accountLine(made.account) })}</p>
          <AccessPicker value={access} onChange={setAccess} groups={groups.data ?? []} users={users.data ?? []} me={{ id: me.user.id, groupIds: me.groups.map((g) => g.id) }}
            legend={t('connectors.whoCanUse')} note={t('gapps.team.audienceNote')} />
        </>}
        {error && <p className="text-sm text-danger" role="alert" data-testid="gapp-team-error">{error}</p>}
      </div>
    </Modal>
  )
}
