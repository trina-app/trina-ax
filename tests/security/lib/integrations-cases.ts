import type { Spec } from './cases'

// External-service connections (docs/INTEGRATIONS.md). Ownership (another member's personal connection, team access
// rules, admins not implied) and the sign-in callback's session binding are tested in tests/unit/c-integrations-*.ts;
// this permanent matrix checks the auth level of every route and that unknown ids are refused for everyone.
const NONE = '00000000-0000-7000-8000-000000000000'
export const INTEGRATION_SPECS: Record<string, Spec> = {
  listIntegrations: { build: c => c.get('/api/integrations?userId=alice'), scope: 'self' },
  // a personal connection to an address that cannot resolve: created for the caller, its check fails
  createIntegration: { build: c => c.post('/api/integrations', { kind: 'http', name: 'Matrix', url: 'https://integration-matrix.invalid/api', auth: 'none', writePolicy: 'ask' }), scope: 'self' },
  updateIntegration: { build: c => c.patch(`/api/integrations/${NONE}`, { name: 'x' }), scope: 'nobody' },
  deleteIntegration: { build: c => c.del(`/api/integrations/${NONE}`), scope: 'nobody' },
  refreshIntegration: { build: c => c.post(`/api/integrations/${NONE}/refresh`, {}), scope: 'nobody' },
  authorizeIntegration: { build: c => c.post(`/api/integrations/${NONE}/authorize`, {}), scope: 'nobody' },
  integrationFlow: { build: c => c.get(`/api/integrations/flows/${NONE}`), scope: 'nobody' },
  listTeamIntegrations: { build: c => c.get('/api/admin/integrations'), scope: 'byLevel' },
  createTeamIntegration: { build: c => c.post('/api/admin/integrations', { kind: 'http', name: 'Team matrix', url: 'https://integration-matrix.invalid/api', auth: 'none', writePolicy: 'ask', access: { everyone: false, groups: [], users: [] } }), scope: 'byLevel' },
}
// GET /api/integrations/oauth/callback: state, session and person binding are tested in tests/unit/c-integrations-oauth.test.ts
export const INTEGRATION_RAW_COVERED = ['RAW GET INTEGRATION_CALLBACK']
