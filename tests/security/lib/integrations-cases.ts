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
  // turning one tool off: the manager of the connection only (owner / admin rules are in tests/unit/c-integrations-tools.test.ts)
  setIntegrationTool: { build: c => c.post(`/api/integrations/${NONE}/tools`, { name: 'search', enabled: false }), scope: 'nobody' },
  authorizeIntegration: { build: c => c.post(`/api/integrations/${NONE}/authorize`, {}), scope: 'nobody' },
  integrationFlow: { build: c => c.get(`/api/integrations/flows/${NONE}`), scope: 'nobody' },
  listTeamIntegrations: { build: c => c.get('/api/admin/integrations'), scope: 'byLevel' },
  createTeamIntegration: { build: c => c.post('/api/admin/integrations', { kind: 'http', name: 'Team matrix', url: 'https://integration-matrix.invalid/api', auth: 'none', writePolicy: 'ask', access: { everyone: false, groups: [], users: [] } }), scope: 'byLevel' },
  // an admin's request to a member to connect a service as their own (tests/unit/c-integration-requests.test.ts: only the
  // member asked sees, answers or declines it; admins and the owner of the team get 404 too)
  listIntegrationRequests: { build: c => c.get('/api/integration-requests'), scope: 'self' },
  getIntegrationRequest: { build: c => c.get(`/api/integration-requests/${NONE}`), scope: 'nobody' },
  completeIntegrationRequest: { build: c => c.post(`/api/integration-requests/${NONE}/complete`, { secret: 'matrix-key-value' }), scope: 'nobody' },
  declineIntegrationRequest: { build: c => c.post(`/api/integration-requests/${NONE}/decline`, {}), scope: 'nobody' },
  listTeamIntegrationRequests: { build: c => c.get('/api/admin/integration-requests'), scope: 'byLevel' },
  // asks the caller themselves (any active member may be asked), at an address of its own each time (one waiting request
  // per member and address)
  createIntegrationRequest: { build: async c => { const me = await c.get('/api/me'); return c.post('/api/admin/integration-requests', { userId: me.json?.user?.id ?? 'nobody', kind: 'http', name: 'Matrix', url: `https://integration-matrix.invalid/api/${crypto.randomUUID()}`, auth: 'bearer' }) }, scope: 'byLevel' },
  withdrawIntegrationRequest: { build: c => c.post(`/api/admin/integration-requests/${NONE}/withdraw`, {}), scope: 'nobody' },
  // an admin's template, each member connects their own key (tests/unit/c-integration-templates.test.ts: only members it
  // is for see or connect it, admins included; the key never reaches an admin; changes drop the members' keys)
  listIntegrationTemplates: { build: c => c.get('/api/integration-templates'), scope: 'self' },
  connectIntegrationTemplate: { build: c => c.post(`/api/integration-templates/${NONE}/connect`, { secret: 'matrix-key-value' }), scope: 'nobody' },
  listTeamIntegrationTemplates: { build: c => c.get('/api/admin/integration-templates'), scope: 'byLevel' },
  createIntegrationTemplate: { build: c => c.post('/api/admin/integration-templates', { kind: 'http', name: 'Matrix', url: `https://integration-matrix.invalid/api/${crypto.randomUUID()}`, auth: 'bearer', access: { everyone: false, groups: [], users: [] } }), scope: 'byLevel' },
  updateIntegrationTemplate: { build: c => c.patch(`/api/admin/integration-templates/${NONE}`, { name: 'x' }), scope: 'nobody' },
  deleteIntegrationTemplate: { build: c => c.del(`/api/admin/integration-templates/${NONE}`), scope: 'nobody' },
}
// GET /api/integrations/oauth/callback: state, session and person binding are tested in tests/unit/c-integrations-oauth.test.ts
export const INTEGRATION_RAW_COVERED = ['RAW GET INTEGRATION_CALLBACK']
