# Feature map

Which features the tests reach, without a hand-kept list. Two levels:

- **Units**, read from the code: every API endpoint of the contract (`shared/src/api`) and every web screen (the routes
  in `web/src/App.tsx`, one screen per Settings section and Admin page). See `scripts/features/units.ts`.
- **Features**, kept by hand in [`docs/features.ts`](features.ts): about 120 named groups with a stable ID
  (`rooms.threads`, `admin.members`), a plain name, an area, and the endpoints and screens they claim. Features of the
  desktop and phone apps, installs and releases have no endpoint or screen: they are `manual: true` and judged by QA rows.

## When `features:check` fails

`bun run features:check` (CI's static job) fails when an endpoint or a screen belongs to no feature, or a pattern of
`docs/features.ts` matches nothing. The message names the unit. Add it to the feature it is part of:

```ts
{ id: 'rooms.hide-pin', name: 'Hide and pin conversations', area: 'Rooms', endpoints: ['setRoomHidden', 'pinRoom', 'unpinRoom'] },
```

- A pattern is an exact endpoint name / screen path, or uses `*` for any run of characters (`'*IntegrationTemplate*'`,
  `'/slack/*'`). An endpoint may belong to more than one feature.
- A new feature gets a new ID `area.name` in lower case. **Never rename or reuse an ID**: QA rows name them.
- A removed endpoint: drop it from its pattern; the check says which pattern now matches nothing.

`bun run features:build` also writes `docs/features.generated.json` (not committed): every feature with its endpoints
and screens, and every unit with its features.

## e2e coverage

The mock team server (`web/test/mock/server.ts`) counts every API request of the e2e run by its contract endpoint,
over every `/__test/reset`. At the end of the run (`web/test/e2e/feature-coverage.ts`, Playwright's global teardown) it
is written to `web/test-results/feature-coverage.json`. Nothing is tagged by hand.

What "covered" means: the screen and the contract are exercised against the mock server, not the real server's logic
(QA rows and server unit tests cover that). Endpoints that every page polls (`me`, `listChats` …) count as reached by
any test. Screens visited are not recorded yet.

## The Features tab of the QA sheet

`scripts/features/sync-sheet.ts` rewrites a **Features** tab: a summary line on top, then one row per feature, Untested
first, with its e2e endpoints reached, its QA rows by result and its status. Never edit the tab: the next run replaces
it. In the QA tab it only writes the **Feature ID** column's header (once) and its dropdown; a QA row names the
feature(s) it tests there, comma-separated.

| Status | When |
|---|---|
| Untested | e2e reaches none of its endpoints and no QA row passed |
| Stale | a QA row passed, but the feature's contract file changed after the last Pass (coarse: any change in the file) |
| Partly | e2e reaches under half of its endpoints, no QA Pass yet, or a QA row failed or is blocked |
| Green | the rest |

Run it:

```bash
# on a computer with the gws CLI signed in to the sheet's account
cd web && bun run build && bunx playwright test -c playwright.config.ts; cd ..
FEATURES_SHEET_ID=<sheet id> bun scripts/features/sync-sheet.ts --gws
# shards side by side: MOCK_PORT=1925N FEATURE_COVERAGE_FILE=cov-N.json bunx playwright test --shard=N/4 --output=test-results-sN,
# then pass each file:  … --coverage cov-1.json --coverage cov-2.json …
# print the status without writing:  … --dry-run
```

### Sheet sync in CI

The `Feature map` workflow (`.github/workflows/feature-map.yml`) runs the e2e suite in four shards on every push to dev,
keeps each shard's coverage file as an artifact and, when all four finished, rewrites the tab. One-time setup by the
sheet's owner:

1. Google Cloud console → a project → **IAM & Admin › Service accounts** → create one (no roles needed) → **Keys › Add
   key › JSON**. Enable the **Google Sheets API** for the project.
2. Share the QA sheet with the service account's e-mail (`…@….iam.gserviceaccount.com`) as **Editor**.
3. GitHub → the repository's **Settings › Secrets and variables › Actions** → the secrets `GOOGLE_SHEETS_SA_JSON` (the
   whole key file) and `FEATURES_SHEET_ID` (the id in the sheet's address; a secret, so public logs never show it).

Without them the workflow still runs the suite and uploads the coverage; the sheet step says it was skipped.
