// Component C's part of a deleted account (auth/account-removal.ts; registered by routes/files.ts init): their Google
// Drive sign-in (revoked at Google unless the same grant serves something else, as Disconnect does), their open sign-in
// flows, and their Slack link. A Slack user token is revoked at Slack by the retire step at each start.
import type { AppContext } from '../context'
import { registerAccountCleanup } from '../auth/account-removal'
import { googleDriveOf } from './google-drive/oauth'

export function registerConnectionsAccountCleanup(ctx: AppContext): void {
  registerAccountCleanup(ctx, {
    name: 'connections',
    rows: [
      'google_app_flows.user_id', 'integration_oauth_flows.user_id',
      'slack_email_changes.user_id', 'slack_install_flows.user_id', 'slack_links.user_id', 'slack_requests.user_id', 'slack_signin_flows.user_id', 'slack_threads.user_id',
    ],
    covers: ['drive_connections.user_id', 'drive_oauth_flows.user_id'],
    after: async (c, userId) => { await googleDriveOf(c).forgetAccount(userId) },
  })
}
