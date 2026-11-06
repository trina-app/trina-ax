// Admin › App connectors: the apps members can connect with their own account (lib/connectors.ts APP_CONNECTORS), as
// cards: for now Google Drive, with whether it is on, how many members are connected, and Set up (or Replace) when this
// page may set up the Google client (GET/PUT /api/admin/google-drive, integrations/google-drive/admin-setup.ts). A client
// the operator set, a hosted server or one without a public address shows why in one line instead. Outside AI apps that
// use this server (Claude, Claude Code) are Admin › AI apps (pages/admin/AiApps.tsx).
import { useState } from 'react'
import { API, type DriveAdminStatus } from '@mycel/shared/api'
import { api } from '../../lib/api'
import { APP_CONNECTORS } from '../../lib/connectors'
import { useT } from '../../i18n'
import { DriveAdminCard, DriveSetupDialog } from '../../components/integrations/DriveConnector'
import { AdminPageHeader, Loadable, useLoad } from './common'

export default function AppConnectors() {
  const t = useT()
  const [setup, setSetup] = useState(false)
  const state = useLoad(() => api.call(API.driveAdminStatus))
  return (
    <>
      <AdminPageHeader title={t('connectors.title')} desc={t('appConnectors.adminDesc')} testId="app-connectors-header" />
      <Loadable state={state} lines={2}>
        {(drive: DriveAdminStatus) => (
          <>
            <ul className="grid gap-3 sm:grid-cols-2" data-testid="admin-app-connectors">
              {APP_CONNECTORS.map((a) => (a.id === 'google-drive' ? <DriveAdminCard key={a.id} status={drive} onSetUp={() => setSetup(true)} /> : null))}
            </ul>
            {setup && <DriveSetupDialog status={drive} onClose={() => setSetup(false)} onSaved={(s) => { state.setData(s); setSetup(false) }} />}
          </>
        )}
      </Loadable>
    </>
  )
}
