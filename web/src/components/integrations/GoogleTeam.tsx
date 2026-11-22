// Connect for the team, for Google: the team's shared Google accounts as Admin › Connected apps reads them, and the
// dialog it opens (DriveShares.tsx DriveShareDialog for Google Drive, GoogleAppTeam.tsx GoogleAppTeamDialog for Gmail,
// Calendar, Docs and Sheets). Used by the welcome tools step (onboarding/ToolsStep.tsx) and the chat's connect card
// (chat/ConnectCard.tsx, #253), so both open the very same dialog. Owners and admins only: every call here is an admin
// endpoint, which checks the role again.
import { useCallback, useEffect, useState } from 'react'
import { API, type DriveShare, type GoogleAppAdminStatus } from '@mycel/shared/api'
import { api } from '../../lib/api'
import { isEmptyAccess } from '../../lib/integrations'
import type { BuiltInId } from '../../lib/googleApps'
import { useT } from '../../i18n'
import { useAdminGroups, useAdminUsers } from '../../store/adminPeople'
import { DriveShareDialog } from './DriveShares'
import { GoogleAppTeamDialog } from './GoogleAppTeam'

/** The team's shared Google accounts, as Admin › Connected apps reads them (owners and admins): Google Drive's shares
 * (GET /api/admin/google-drive, then its shares once it is set up) and each Google app's team account
 * (GET /api/admin/google-apps). `of(id)`: null where the team way cannot be offered here (not set up, an older server,
 * a failed read); else the account shown (the first share that works, else the first) and who uses it. */
export function useGoogleTeam() {
  const t = useT()
  const [shares, setShares] = useState<DriveShare[] | null>(null)
  const [apps, setApps] = useState<GoogleAppAdminStatus[]>([])
  const reload = useCallback(() => {
    api.call(API.driveAdminStatus).then((d) => d.configured ? api.call(API.listDriveShares).then((r) => setShares(r.items)) : setShares(null))
      .catch(() => setShares(null))
    api.call(API.googleAppsAdminStatus).then((r) => setApps(r.apps), () => setApps([]))
  }, [])
  useEffect(reload, [reload])
  const share = shares?.find((x) => x.status === 'connected') ?? shares?.[0] ?? null
  const app = (id: string) => apps.find((a) => a.id === id)
  const who = (x: { access: DriveShare['access']; usedBy: number }) => (isEmptyAccess(x.access) ? t('driveShare.nobody') : t('driveShare.usedBy', { count: x.usedBy }))
  const email = (a: DriveShare['account']) => a.email ?? a.name ?? ''
  const of = (id: BuiltInId) => {
    if (id === 'google-drive') return shares === null ? null : { account: share ? email(share.account) : null, ok: share?.status === 'connected', who: share ? who(share) : '' }
    const a = app(id)
    if (!a?.configured || a.team === undefined) return null
    return { account: a.team ? email(a.team.account) : null, ok: a.team?.status === 'connected', who: a.team ? who(a.team) : '' }
  }
  const setApp = (st: GoogleAppAdminStatus) => setApps((xs) => xs.map((a) => (a.id === st.id ? st : a)))
  return { of, share, app, setApp, reload, anyOn: share?.status === 'connected' || apps.some((a) => a.team?.status === 'connected') }
}
export type GoogleTeamState = ReturnType<typeof useGoogleTeam>

/** Whether the team's shared account for this tool works now, read again (a dialog just closed): a Drive share that
 * works, or the app's team account connected. False on a failed read. */
export async function googleTeamOn(id: BuiltInId): Promise<boolean> {
  try {
    if (id === 'google-drive') return (await api.call(API.listDriveShares)).items.some((s) => s.status === 'connected')
    return (await api.call(API.googleAppsAdminStatus)).apps.find((a) => a.id === id)?.team?.status === 'connected'
  } catch {
    return false
  }
}

/** The dialog Admin › Connected apps opens for a shared Google account: Drive's share (sign in, folders, who), or a Google
 * app's team account (Gmail, Calendar, Docs, Sheets: sign in, who); a new sign-in for one that needs it. */
export function GoogleTeamDialog({ app, google, onClose }: { app: BuiltInId; google: GoogleTeamState; onClose: () => void }) {
  const groups = useAdminGroups()
  const users = useAdminUsers()
  // what there was when the dialog opened, kept while it is open (as Admin does): a sign-in made here sets the app's
  // team account at once (onStatus), and the dialog must still treat it as new, so its Cancel or ✕ removes it again
  const [share] = useState(() => google.share)
  const [isNew] = useState(() => !google.app(app)?.team)
  if (app === 'google-drive') {
    return <DriveShareDialog share={share ?? undefined} reconnect={!!share} groups={groups.data ?? []} users={users.data ?? []} onClose={onClose} onSaved={onClose} />
  }
  const st = google.app(app)
  if (!st) return null
  return <GoogleAppTeamDialog app={st.id} team={st.team ?? null} step="connect" isNew={isNew} onStatus={google.setApp} onClose={onClose} />
}
