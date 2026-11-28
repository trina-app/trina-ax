// The repo-wide guard tests (docs/decisions/20261118-guard-tests-in-quick-checks.md): unit tests that check the whole
// repository holds together (every route has a permission matrix case, every language has every text, every new
// access check is reviewed, the exact tool lists, ...) rather than one feature. One list, run in two places:
//   - `bun run check:prepush` (scripts/check-prepush.ts, step "test guards") before a push;
//   - CI's job "typecheck, docs, native, relay" on every pull request and queued entry (`bun scripts/ci/guard-tests.ts`),
//     so a miss shows on the pull request's quick checks, not a whole merge queue cycle later.
// Only fast files (each well under 5 s; about a minute together, most of it the tool-list tests): a new repo-wide guard goes here, once. The slow ones stay
// in the unit shards: the permanent permission matrix (tests/security/permission-matrix.test.ts boots a server and runs
// every persona on every route, minutes); security-route-coverage.test.ts below is its fast half.
import { spawnSync } from 'node:child_process'
import path from 'node:path'

export const GUARD_TESTS = [
  'tests/unit/i18n-completeness.test.ts', // every language has every text (and check:i18n's rules)
  'tests/unit/i18n-languages.test.ts', // no Korean outside the screen-text tables
  'tests/unit/product-name.test.ts', // no product name in code or comments: write <app>
  'tests/unit/product-brand.test.ts',
  'tests/unit/c-tools.test.ts', // exact tool lists: change them when a PR adds a tool
  'tests/unit/i-wiring.test.ts',
  'tests/unit/b-browser.test.ts',
  // guards that failed batch CIs on 2026-11-17 though check:prepush was green (about 30 s together)
  'tests/unit/c-reader-counters.test.ts', // every new access check or users/ shortcut is reviewed for folder shares
  'tests/unit/a-account-removal-coverage.test.ts', // every new user-id column goes with a deleted account or is kept on purpose
  'tests/unit/system-packages.test.ts', // no script pins a download of its own: scripts/system/packages.json
  'tests/unit/ai-scenarios-catalog.test.ts', // every feature has a feature-scope line and, if the AI reaches it, a case
  // added 2026-11-18 after a new route reached the merge queue without a matrix case (PR #1271)
  'tests/unit/security-route-coverage.test.ts', // every route has a permission matrix case (tests/security/lib/*cases.ts)
  'tests/security/p4-route-coverage.test.ts', // chat routes find the chat through chatFor and stay in the matrix
  'tests/security/plugin-route-coverage.test.ts', // Admin › Plugins routes stay in the matrix, owner/admin only
  'tests/security/remote-mcp-coverage.test.ts', // the remote MCP tools stay in the matrix
  'tests/unit/a-guests-endpoints.test.ts', // the guest endpoint allow-list against the whole API contract
  'tests/unit/a-guests-role-reads.test.ts', // no SQL reads users.role without the guest column
  'tests/unit/contracts.test.ts', // the API contract registry holds together
  'tests/unit/rule-set-construction.test.ts', // folder access is built only in server/src/policy/
  'tests/unit/p1-db-bindings.test.ts', // named SQL parameters as Bun 1.3.12's strict binding takes them
  'tests/unit/p1-migration-files.test.ts', // every migration file is one the runner applies
  'tests/unit/step-labels-tools.test.ts', // every built-in tool's step has words in every language
  'tests/unit/ai-app-map.test.ts', // the AI's map of the app names the web app's real labels
  'tests/unit/docs-site.test.ts', // every docs page in the navigation, links resolve, the API page matches the contract
  'tests/unit/chrome-ext-version.test.ts', // chrome-extension/shipped.json matches what the zip is built from (docs/RELEASE-CI.md 16)
  'tests/unit/docs-in-app-links.test.ts', // every link the apps open into the guide leads to a page and heading
  'tests/unit/onboarding-docs.test.ts',
  'tests/unit/edition-source.test.ts', // one source link per edition, no other repository name
  'tests/unit/release-channel.test.ts', // one place for where updates come from
  'tests/unit/ci-unit-shard.test.ts', // every test file runs in exactly one CI shard
  'tests/unit/brand-light-icons.test.ts', // every app icon (iOS dark/tinted, Android, web push, desktop) is the light tile
  // added 2026-11-19 after the v0.5.19 release run failed at start-up: ci.yml asked for more than release.yml grants it
  'tests/unit/workflow-permissions.test.ts', // a called workflow's jobs stay within the caller's permissions
  // added 2026-11-22 (docs/decisions/20261122-ask-registry.md)
  'tests/unit/ask-registry.test.ts', // every card, dialog and system prompt has an entry in docs/ASKS.md
]

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '..', '..')
  const r = spawnSync('bun', ['test', ...GUARD_TESTS.map((f) => `./${f}`)], { cwd: root, stdio: 'inherit', env: process.env })
  process.exit(r.status ?? 1)
}
