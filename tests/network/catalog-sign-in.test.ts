// Network check of the app's list of services (shared/src/service-catalog.ts): every official address, asked the way
// a Connect asks it (server/src/integrations/connections/service.ts authorize): an MCP initialize without a sign-in
// must answer 401, then the protected-resource and authorization-server metadata must give https sign-in and token
// addresses with PKCE S256 (oauth.ts discover, which refuses anything else). Nothing is registered at any service.
// It talks to the real services, so it never runs with the unit tests: `bun run check:connectors`
// (CONNECTOR_NETWORK=1). A failure means a listed address moved or its sign-in changed: check the service's docs.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { officialUrls, SERVICE_CATALOG } from '../../shared/src/service-catalog'
import { McpClient, McpError } from '../../server/src/integrations/connections/mcp'
import { discover } from '../../server/src/integrations/connections/oauth'

setDefaultTimeout(60_000)
const ON = process.env.CONNECTOR_NETWORK === '1'
const rows: string[] = []

describe.skipIf(!ON)('listed services answer like a sign-in MCP server', () => {
  for (const c of SERVICE_CATALOG) {
    for (const url of officialUrls(c)) {
      test(`${c.id} ${url}`, async () => {
        let status = 0, header = ''
        try { await new McpClient(url, async () => [], {}).start() } catch (e) {
          if (e instanceof McpError) { status = e.status; if (e.code === 'unauthorized') header = e.detail } else throw e
        }
        expect(status, 'an initialize without a sign-in answers 401').toBe(401)
        const found = await discover(url, {}, header)
        expect(found.server.authorizationEndpoint).toStartWith('https://')
        expect(found.server.tokenEndpoint).toStartWith('https://')
        rows.push([c.id.padEnd(12), String(status), (header ? 'header' : 'well-known').padEnd(10), new URL(found.server.authorizationEndpoint).host.padEnd(36),
          `registration ${found.server.registrationEndpoint ? 'yes' : 'no '}`, `metadata-document ${found.metadataClients ? 'yes' : 'no'}`, url].join('  '))
      })
    }
  }
  test('summary', () => { console.log('\n' + rows.join('\n')) })
})

test.skipIf(ON)('skipped: set CONNECTOR_NETWORK=1 (bun run check:connectors) to ask the real services', () => {})
