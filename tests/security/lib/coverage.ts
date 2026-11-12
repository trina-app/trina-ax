// The permission matrix's coverage (tests/security/permission-matrix.test.ts "coverage"): every route the server registers
// has a matrix case, and no case targets a route that is not registered. Read from the code alone (no server), so the
// unit tests run it too (tests/unit/security-route-coverage.test.ts): tests/security is not part of CI, and a new route
// without a case went unnoticed while this failed.
import { enumerateRoutes } from './matrix'
import { SPECS } from './cases'
import { P4_RAW_COVERED } from './p4-cases'
import { REMOTE_MCP_RAW_COVERED } from './remote-mcp-cases'
import { INTEGRATION_RAW_COVERED } from './integrations-cases'
import { SLACK_RAW_COVERED } from './slack-cases'
import { APP_LINKS_RAW_COVERED } from './app-links-cases'

/** Routes in server/src/routes/*.ts with no matrix case (`missing`) and cases for routes the code does not register (`extra`). */
export function routeCoverage(repo: string): { missing: string[]; extra: string[] } {
  const routes = enumerateRoutes(repo)
  const covered = new Set(Object.keys(SPECS))
  // the two raw routes are exercised separately (ws subscriptions test, web app shell)
  const rawCovered = new Set(['RAW GET WS_PATH', 'RAW GET \'*\'', ...P4_RAW_COVERED, ...REMOTE_MCP_RAW_COVERED, ...INTEGRATION_RAW_COVERED, ...SLACK_RAW_COVERED, ...APP_LINKS_RAW_COVERED])
  const missing = routes.filter((r) => (r.startsWith('RAW') ? !rawCovered.has(r) : !covered.has(r)))
  const registered = new Set(routes)
  const extra = Object.keys(SPECS).filter((r) => !registered.has(r))
  return { missing, extra }
}
