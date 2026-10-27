import path from 'node:path'
import { expect, test } from 'bun:test'
import { REMOTE_MCP } from '@mycel/shared/api'
import { enumerateRoutes } from './lib/matrix'
import { SPECS } from './lib/cases'
import { REMOTE_MCP_RAW_COVERED } from './lib/remote-mcp-cases'
test('remote connector browser endpoints and every public OAuth/MCP route have coverage', () => {
  const routes = enumerateRoutes(path.resolve(import.meta.dir, '../..'))
  for (const [key, spec] of Object.entries(REMOTE_MCP)) { expect(routes).toContain(key); expect(SPECS[key]).toBeDefined(); expect(spec.auth).toBe('user') }
  for (const raw of REMOTE_MCP_RAW_COVERED) expect(routes).toContain(raw)
})
