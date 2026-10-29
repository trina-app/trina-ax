import type { Spec } from './cases'
/** Configured OAuth/MCP public-client and isolation behavior is exercised by remote-mcp-http/tools/oauth tests. */
export const REMOTE_MCP_SPECS: Record<string, Spec> = {
  getRemoteConnectorConsent: { build: c => c.get('/api/connectors/remote/requests/unknown-request'), scope: 'nobody' },
  decideRemoteConnectorConsent: { build: c => c.post('/api/connectors/remote/requests/unknown-request', { allow: true }), scope: 'nobody' },
  listRemoteConnectors: { build: c => c.get('/api/connectors/remote?userId=alice'), scope: 'self' },
  revokeRemoteConnector: { build: c => c.del('/api/connectors/remote/unknown-grant'), scope: 'nobody' },
}
export const REMOTE_MCP_RAW_COVERED = [
  "RAW GET '/.well-known/oauth-protected-resource'", "RAW GET '/.well-known/oauth-protected-resource/mcp'", "RAW GET '/.well-known/oauth-authorization-server'",
  "RAW POST '/oauth/register'", "RAW GET '/oauth/authorize'", "RAW POST '/oauth/token'", "RAW POST '/oauth/revoke'",
  "RAW POST '/mcp'", "RAW GET '/mcp'", "RAW DELETE '/mcp'", "RAW PUT '/connector-uploads/:token'",
]
