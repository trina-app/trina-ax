// Admin › Connectors, a Google connector's page (/admin/connectors/<id>: Google Drive, Gmail, Google Calendar, Google
// Docs, Google Sheets): the member's page (AppDetail.tsx) with what only an admin does inside it. On the right of the
// name its state (On, Ready to set up, Off, Not set up) and Set up while it is not set up; once it is, Change setup in
// ⋯. Under the header one line: why it cannot be set up here (or, for Google Drive, that nothing is shared yet), and
// where its Google sign-in comes from. On a server whose Google sign-in comes from the hosting service (source
// "service", or blocked "hosted") that line says so, and there is nothing to set up. Under the details, Team settings in
// the layout of Admin › Team settings: who can use it (everyone in the team, each with their own account: there is no
// members' switch, docs/DECISIONS.md "No members' switch for connectors"), Google Drive's Drives shared with the team
// (DriveShares.tsx), a Google app's account shared with the team (GoogleAppTeam.tsx), and the Google APIs a card with its own Google app needs switched on. The setup dialogs stay where they were (DriveConnector.tsx DriveSetupDialog, GoogleAppAdmin.tsx).
// First in Team settings, for owners and admins where the company's own Google app can be set or is set: Google sign-in
// (GoogleSignInRow.tsx), the same row on all five pages. It says where sign-in comes from, so the hosting service's
// line above goes away there, and Team settings shows on a hosted page that is not set up yet, so the row is reachable.
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { DriveAdminStatus, GoogleAppAdminStatus, GoogleAppView, GoogleOwnAppStatus } from '@mycel/shared/api'
import { builtInLogo, builtInName, canChange, categoryKey, developerKey, DRIVE_TOOL_LIST, GOOGLE, GOOGLE_PRIVACY, GOOGLE_TERMS, lineKey, toolWords } from '../../lib/googleApps'
import { useT } from '../../i18n'
import { isAdmin, isOwner, useMe } from '../../store/session'
import { Button } from '../ui'
import { SettingRow, SettingsSection } from '../../pages/admin/common'
import { AppDetail } from './AppDetail'
import { CardMenu } from './AppConnectorCard'
import { driveAdminLine, driveAdminOn } from './DriveConnector'
import { DriveAdminSettings } from './DriveShares'
import { ApiList, googleAppAdminLine, googleAppAdminOn } from './GoogleAppAdmin'
import { GoogleAppTeamRow } from './GoogleAppTeam'
import { Note } from './GoogleAppConnector'
import { GoogleSignInRow, googleSignInShown } from './GoogleSignInRow'

/** Google sign-in comes from the hosting service: nothing to set up here (no Google client, no redirect address). */
export const byHostingService = (s: { source: string; blocked: string | null }) => s.source === 'service' || s.blocked === 'hosted'

const list = (t: ReturnType<typeof useT>) => ({ to: '/admin/connectors', name: t('admin.integrations') })

/** The company's own Google app for the five pages (GET /api/admin/google/own-app; null on an older server) and what
 * the page does after a change (reads the Google statuses again). */
export interface OwnAppProps { status: GoogleOwnAppStatus | null; onChange: (s: GoogleOwnAppStatus) => void }

/** The Google sign-in row's status when it shows on this page (owners and admins; it can be set here, or is set). */
function useSignIn(ownApp: OwnAppProps | undefined) {
  const admin = isAdmin(useMe())
  return googleSignInShown(admin, ownApp?.status) ? ownApp!.status! : null
}

/** On the right of the name: its state, Set up while it is not set up, ⋯ with Change setup once it is. */
function Actions({ name, state, label, on, canSetUp, configured, testId, setUpTestId, onSetUp }: {
  name: string; state: string; label: string; on: boolean; canSetUp: boolean; configured: boolean; testId: string; setUpTestId: string; onSetUp: () => void
}) {
  const t = useT()
  return (
    <>
      <span className={`flex items-center gap-1 text-xs ${on ? 'text-ok' : 'text-muted'}`} data-testid={testId} data-state={state}>
        {on && <Check size={14} aria-hidden />}{label}
      </span>
      {canSetUp && !configured && <Button variant="primary" onClick={onSetUp} data-testid={setUpTestId}>{t('gapps.admin.setUp')}</Button>}
      {canSetUp && configured && (
        <CardMenu label={t('appConnectors.more', { name })} testId={`${setUpTestId}-menu`} items={[
          { label: t('appConnectors.changeSetup'), onSelect: onSetUp, testId: setUpTestId },
        ]} />
      )}
    </>
  )
}

/** Team settings, under the page's details, laid out like Admin › Team settings (common.tsx SettingsSection and
 * SettingRow): a plain heading, one row per setting (its name and one line on the left, its control on the right), a
 * hairline between; no boxes. */
function TeamSettings({ children }: { children: ReactNode }) {
  const t = useT()
  return (
    <div className="border-t border-line" data-testid="team-settings">
      <SettingsSection title={t('connectors.teamSettings')}>
        <div className="divide-y divide-line">{children}</div>
      </SettingsSection>
    </div>
  )
}

/** Who can use it: everyone in the team, each with their own Google account (no members' switch: docs/DECISIONS.md "No
 * members' switch for connectors"), and how many have connected. */
function WhoRow({ count }: { count: number }) {
  const t = useT()
  return (
    <SettingRow heading title={t('connectors.whoCanUse')} testId="team-who"
      desc={`${t('connectors.everyoneOwnGoogle')} ${t('appConnectors.connectedMembers', { count })}`} />
  )
}

/** Google Drive's page in Admin › Connectors. */
export function DriveAdminPage({ status, onSetUp, onStatus, ownApp }: { status: DriveAdminStatus; onSetUp: () => void; onStatus: (s: DriveAdminStatus) => void; ownApp?: OwnAppProps }) {
  const t = useT()
  const owner = isOwner(useMe())
  const signIn = useSignIn(ownApp)
  const id = 'google-drive' as const
  const name = builtInName(id)
  const on = driveAdminOn(status)
  const hosted = byHostingService(status)
  const state = on ? 'on' : 'not_set_up'
  // why it is not on yet; once on, Team settings says who uses it. The hosting service's line says it all for a server
  // it serves
  const line = hosted || on ? null : driveAdminLine(t, status)
  return (
    <AppDetail embedded list={list(t)} testId="drive-admin-detail" state={state} logo={builtInLogo(id)} name={name} byLine={t('gapps.byLineDrive', { line: t(lineKey(id)) })}
      actions={<Actions name={name} state={state} on={on} label={t(on ? 'appConnectors.on' : 'appConnectors.notSetUp')}
        canSetUp={status.canSetUp} configured={status.configured} testId="drive-admin-state" setUpTestId="drive-setup" onSetUp={onSetUp} />}
      status={<>
        {line && <Note testId="drive-admin-line">{line}</Note>}
        {/* the Google sign-in row says where sign-in comes from, once */}
        {hosted && !signIn && <Note testId="drive-by-service">{t('appConnectors.byService')}</Note>}
        {status.configured && status.source === 'server' && !signIn?.active && <Note testId="drive-by-server">{t('appConnectors.byServer')}</Note>}
        {/* no public address: what to do next and who does it (QA TC-196). It is set on the server computer by whoever
            installed it, not in the app; the owner sees it in System › 연결 방식, and only the owner sees that page */}
        {!status.configured && status.blocked === 'public_host' && (
          <div className="space-y-1 border-l-2 border-line py-1 pl-3 text-sm text-muted" data-testid="drive-public-host">
            <p>{t('driveAdmin.publicHost.why')}</p>
            <p>{t(owner ? 'driveAdmin.publicHost.owner' : 'driveAdmin.publicHost.admin')}</p>
            {owner && <Link to="/admin/system/connection" className="inline-block text-accent-text underline-offset-2 hover:underline" data-testid="drive-public-host-system">{t('driveAdmin.publicHost.openSystem')}</Link>}
          </div>
        )}
      </>}
      about={t('gapps.admin.driveAbout')} canChange={false}
      developer={t(developerKey(id))} category={t(categoryKey(id))} signIn={GOOGLE} links={{ by: GOOGLE, privacy: GOOGLE_PRIVACY, terms: GOOGLE_TERMS }}
      tools={DRIVE_TOOL_LIST.map((x) => ({ name: x.name, title: t(`gapps.drive.tool.${x.name}`), changes: x.changes }))}>
      {/* once it is set up; before that only the Google sign-in row (a hosted server whose service does not answer yet) */}
      {(status.configured || signIn) && (
        <TeamSettings>
          {signIn && <GoogleSignInRow status={signIn} onChange={ownApp!.onChange} />}
          {status.configured && <WhoRow count={status.connectedMembers} />}
          {status.configured && <DriveAdminSettings onStatus={onStatus} />}
        </TeamSettings>
      )}
    </AppDetail>
  )
}

/** A Google app's page in Admin › Connectors (Gmail, Google Calendar, Google Docs, Google Sheets). `view`: the admin's
 * own view of it (Connectors'), for its tools; none on an older server. */
export function GoogleAppAdminPage({ status, view, onSetUp, onStatus, ownApp }: { status: GoogleAppAdminStatus; view?: GoogleAppView; onSetUp: () => void; onStatus: (s: GoogleAppAdminStatus) => void; ownApp?: OwnAppProps }) {
  const t = useT()
  const signIn = useSignIn(ownApp)
  const id = status.id
  const name = builtInName(id)
  const on = googleAppAdminOn(status)
  const hosted = byHostingService(status)
  const state = on ? 'on' : 'not_set_up'
  // why it cannot be connected now (not set up, or set up elsewhere); once set up Team settings has the switch and how
  // many use it
  const line = hosted || status.configured ? null : googleAppAdminLine(t, status)
  const tools = toolWords(t, view?.tools ?? [])
  // every source but the hosting service's (an operator's own client too, as before)
  const showApis = status.source !== 'service' && !hosted && status.apis.length > 0
  return (
    <AppDetail embedded list={list(t)} testId="gapp-admin-detail" state={state} logo={builtInLogo(id)} name={name} byLine={t('gapps.byLine', { line: t(lineKey(id)) })}
      actions={<Actions name={name} state={state} on={on} label={t(on ? 'appConnectors.on' : 'appConnectors.notSetUp')}
        canSetUp={status.canSetUp} configured={status.configured} testId="gapp-admin-state" setUpTestId="gapp-admin-setup" onSetUp={onSetUp} />}
      status={<>
        {line && <Note testId="gapp-admin-line">{line}</Note>}
        {/* the Google sign-in row says where sign-in comes from, once */}
        {hosted && !signIn && <Note testId="gapp-by-service">{t('appConnectors.byService')}</Note>}
        {status.configured && status.source === 'drive' && !signIn?.active && <Note testId="gapp-admin-same">{t('gapps.admin.sameAsDriveOn')}</Note>}
        {status.configured && status.source === 'server' && <Note testId="gapp-by-server">{t('appConnectors.byServer')}</Note>}
      </>}
      about={t('gapps.admin.about', { name })} canChange={canChange(tools)}
      developer={t(developerKey(id))} category={t(categoryKey(id))} signIn={GOOGLE} links={{ by: GOOGLE, privacy: GOOGLE_PRIVACY, terms: GOOGLE_TERMS }}
      tools={tools}>
      {(status.configured || showApis || signIn) && (
        <TeamSettings>
          {signIn && <GoogleSignInRow status={signIn} onChange={ownApp!.onChange} />}
          {status.configured && <WhoRow count={status.connectedMembers} />}
          {/* one account for the people an admin picks (an older server sends no team: nothing to show) */}
          {status.configured && status.team !== undefined && <GoogleAppTeamRow status={status} onStatus={onStatus} />}
          {showApis && (
            <SettingRow heading title={t('gapps.admin.apisTitle')} desc={t('gapps.admin.apis')} testId="gapp-admin-apis-row"
              below={<div className="mt-2"><ApiList apis={status.apis} bare /></div>} />
          )}
        </TeamSettings>
      )}
    </AppDetail>
  )
}
