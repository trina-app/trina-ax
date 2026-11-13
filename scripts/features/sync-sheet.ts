// Writes the "Features" tab of the QA Google Sheet (docs/FEATURES.md): one row per feature of docs/features.ts with its
// e2e coverage (web/test-results/feature-coverage.json), its QA rows (the QA tab's "Feature ID" column) and its gap
// status, Untested first, and a summary line on top. The tab is made again on every run; never edit it by hand.
// In the QA tab it only ever writes the "Feature ID" header cell (once) and that column's dropdown; other sessions
// append QA rows at the same time, so it never rewrites a range of the QA tab.
//
//   FEATURES_SHEET_ID=<id> GOOGLE_SHEETS_SA_JSON='<service account key JSON>' bun scripts/features/sync-sheet.ts
//   FEATURES_SHEET_ID=<id> bun scripts/features/sync-sheet.ts --gws          (a Mac with the gws CLI signed in)
//   … --coverage <file>   a coverage file (repeat for shards);  --dry-run   print the rows, write nothing
//   … --backfill <tsv>    also fill empty Feature ID cells: lines "TC-ID<TAB>feature ids", by exact cell
import { execFileSync } from 'node:child_process'
import { createSign } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { FEATURES } from '../../docs/features'
import { buildMap } from './map'
import { featureRows, parseFeatureCell, summaryLine, type FeatureRow, type QaRow } from './status'
import { readEndpoints, readScreens, ROOT } from './units'

const QA = 'QA'
const TAB = 'Features'
const FEATURE_HEADER = 'Feature ID'
/** the Features tab: summary in row 1, the header in row 3, features from row 4 */
const FIRST_ROW = 4

interface Sheets {
  get(fields: string): Promise<any>
  values(range: string): Promise<string[][]>
  update(data: { range: string; values: (string | number)[][] }[]): Promise<void>
  clear(range: string): Promise<void>
  batch(requests: object[]): Promise<void>
}

// ---------------- transports ----------------

function gws(id: string): Sheets {
  const run = (args: string[]) => {
    const out = execFileSync('gws', ['sheets', 'spreadsheets', ...args], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] })
    const at = out.indexOf('{')
    return at < 0 ? {} : JSON.parse(out.slice(at))
  }
  const p = (x: object) => JSON.stringify({ spreadsheetId: id, ...x })
  return {
    get: async (fields) => run(['get', '--params', p({ fields })]),
    values: async (range) => run(['values', 'get', '--params', p({ range })]).values ?? [],
    update: async (data) => { run(['values', 'batchUpdate', '--params', p({}), '--json', JSON.stringify({ valueInputOption: 'RAW', data })]) },
    clear: async (range) => { run(['values', 'clear', '--params', p({ range })]) },
    batch: async (requests) => { run(['batchUpdate', '--params', p({}), '--json', JSON.stringify({ requests })]) },
  }
}

async function serviceAccount(id: string, keyJson: string): Promise<Sheets> {
  let key: { client_email: string; private_key: string; token_uri?: string }
  try { key = JSON.parse(keyJson) } catch { throw new Error('GOOGLE_SHEETS_SA_JSON is not a valid key JSON') }
  const b64 = (x: string | Buffer) => Buffer.from(x).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const aud = key.token_uri ?? 'https://oauth2.googleapis.com/token'
  const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud, iat: now, exp: now + 3600 }))}`
  const jwt = `${unsigned}.${b64(createSign('RSA-SHA256').update(unsigned).sign(key.private_key))}`
  const tok = await fetch(aud, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) })
  if (!tok.ok) throw new Error(`service account sign-in failed: ${tok.status} ${await tok.text()}`)
  const { access_token } = (await tok.json()) as { access_token: string }
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${id}`
  const call = async (method: string, suffix: string, body?: object) => {
    const res = await fetch(base + suffix, { method, headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    if (!res.ok) throw new Error(`Sheets ${method} ${suffix.split('?')[0]}: ${res.status} ${await res.text()}`)
    return res.json() as Promise<any>
  }
  const r = (range: string) => encodeURIComponent(range)
  return {
    get: (fields) => call('GET', `?fields=${encodeURIComponent(fields)}`),
    values: async (range) => (await call('GET', `/values/${r(range)}`)).values ?? [],
    update: async (data) => { await call('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data }) },
    clear: async (range) => { await call('POST', `/values/${r(range)}:clear`, {}) },
    batch: async (requests) => { await call('POST', ':batchUpdate', { requests }) },
  }
}

// ---------------- inputs ----------------

/** "A".."Z", "AA".. for a 0-based column */
export const col = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : col(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)))

/** The date of the last commit to each feature's contract files (shared/src/api/<file> of its endpoints' groups). Coarse:
 * a change anywhere in the file counts. Empty without git history. */
function lastChanges(map: ReturnType<typeof buildMap>): (id: string) => string {
  const dir = path.join(ROOT, 'shared', 'src', 'api')
  const fileOf = new Map<string, string>()
  for (const f of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, f), 'utf8')
    for (const m of text.matchAll(/export const ([A-Z_]+)\s*=\s*\{/g)) fileOf.set(m[1]!, f)
  }
  const dateOf = new Map<string, string>()
  const date = (f: string) => {
    if (!dateOf.has(f)) {
      let d = ''
      try { d = execFileSync('git', ['log', '-1', '--format=%cs', '--', `shared/src/api/${f}`], { cwd: ROOT, encoding: 'utf8' }).trim() } catch {}
      dateOf.set(f, d)
    }
    return dateOf.get(f)!
  }
  return (id) => {
    const f = map.features.find((x) => x.id === id)!
    return f.endpoints.map((e) => fileOf.get(map.endpoints[e]!.group)).filter((x): x is string => !!x).map(date).sort().at(-1) ?? ''
  }
}

/** The column of a QA header (case and spaces aside), -1 when missing. */
const headerCol = (values: string[][], name: string) => (values[0] ?? []).findIndex((h) => h.trim().toLowerCase() === name.toLowerCase())

/** A QA date cell as YYYY-MM-DD ("2026-11-10", "2026. 11. 10", "11/10/2026" read as month/day/year like the sheet's
 * US locale, a date and time), else ''. */
export function isoDate(cell: string): string {
  const t = cell.trim()
  let m = t.match(/^(\d{4})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})/)
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
  return ''
}

function qaRows(values: string[][], featureCol: number): QaRow[] {
  if (!values.length) return []
  const [idC, resC, dateC] = [headerCol(values, 'TC ID'), headerCol(values, 'Result'), headerCol(values, 'Test date')]
  // a renamed header would make every feature look untested: stop instead of writing that
  if (idC < 0 || resC < 0) throw new Error('the QA tab has no "TC ID" or "Result" header: nothing written')
  if (dateC < 0) console.warn('the QA tab has no "Test date" header: no Stale status')
  return values.slice(1).filter((r) => r[idC]?.trim()).map((r) => ({ id: r[idC]!.trim(), result: r[resC] ?? '', testDate: dateC < 0 ? '' : isoDate(r[dateC] ?? ''), features: featureCol < 0 ? [] : parseFeatureCell(r[featureCol] ?? '') }))
}

const HEADER = ['Feature ID', 'Name', 'Area', 'Status', 'e2e endpoints hit', 'e2e %', 'QA Pass', 'QA Fail', 'QA Blocked', 'QA open', 'Last QA Pass', 'Last contract change', 'Screens', 'Endpoints']

function tabValues(rows: FeatureRow[], summary: string, coverageNote: string): (string | number)[][] {
  return [
    [summary],
    [coverageNote],
    HEADER,
    ...rows.map((r) => [r.id, r.name, r.area, r.status, r.manual ? 'manual' : `${r.endpointsHit} / ${r.endpoints}`, r.e2ePct ?? '', r.qaPass, r.qaFail, r.qaBlocked, r.qaOpen, r.lastPass, r.lastChange,
      r.screenList.join(' '), r.endpointList.join(' ').slice(0, 2000)]),
  ]
}

// ---------------- main ----------------

async function main() {
  const args = process.argv.slice(2)
  const opt = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  const dry = args.includes('--dry-run')
  const id = process.env.FEATURES_SHEET_ID
  const map = buildMap(FEATURES, readEndpoints(), readScreens())
  if (map.problems.length) throw new Error(`the feature map has problems; run bun run features:check`)
  // one file per e2e run or shard (--coverage may repeat): the counts add up
  const files = args.flatMap((a, i) => (a === '--coverage' && args[i + 1] ? [args[i + 1]!] : []))
  if (!files.length) files.push(path.join(ROOT, 'web', 'test-results', 'feature-coverage.json'))
  const runs = files.filter((f) => existsSync(f)).map((f) => JSON.parse(readFileSync(f, 'utf8')) as { finishedAt?: string; commit?: string | null; endpoints: Record<string, number> })
  const hits: Record<string, number> = {}
  // GET /api/health is Playwright's own check that the mock server is up, before any test: not a test's
  for (const r of runs) for (const [e, n] of Object.entries(r.endpoints)) if (e !== 'health') hits[e] = (hits[e] ?? 0) + n
  const last = runs.map((r) => r.finishedAt ?? '').sort().at(-1)
  const commit = runs.find((r) => r.commit)?.commit
  const coverageNote = runs.length ? `e2e coverage from ${runs.length} run file(s), last finished ${last || '?'}${commit ? ` (${commit.slice(0, 9)})` : ''}; made by scripts/features/sync-sheet.ts, do not edit this tab` : 'no e2e coverage file: every e2e column is 0'

  if (!id && !dry) throw new Error('FEATURES_SHEET_ID is not set')
  const sheets = dry && !id ? null : args.includes('--gws') ? gws(id!) : await serviceAccount(id!, process.env.GOOGLE_SHEETS_SA_JSON ?? (() => { throw new Error('GOOGLE_SHEETS_SA_JSON is not set (or pass --gws)') })())

  // the QA tab: its header row, then the Feature ID column (added at the first free header cell, by that one cell)
  const meta = sheets ? await sheets.get('sheets.properties') : { sheets: [] }
  const tabs: { title: string; sheetId: number; gridProperties: { rowCount: number; columnCount: number } }[] = meta.sheets.map((s: any) => s.properties)
  const qaTab = tabs.find((t) => t.title === QA)
  if (sheets && !qaTab) throw new Error(`the sheet has no "${QA}" tab`)
  let values: string[][] = sheets ? await sheets.values(`${QA}!A1:ZZ`) : []
  let featureCol = headerCol(values, FEATURE_HEADER)
  if (sheets && featureCol < 0) {
    // the first column with nothing in any row (a column with data but no header is never taken), by its header cell
    featureCol = Math.max(0, ...values.map((r) => r.length))
    if (dry) console.log(`QA tab: would add the "${FEATURE_HEADER}" header in column ${col(featureCol)}`)
    else {
      if (featureCol >= qaTab!.gridProperties.columnCount) await sheets.batch([{ appendDimension: { sheetId: qaTab!.sheetId, dimension: 'COLUMNS', length: 1 } }])
      // read the header row again just before: another run may have added it meanwhile
      const again = await sheets.values(`${QA}!A1:ZZ1`)
      const there = headerCol(again, FEATURE_HEADER)
      if (there >= 0) featureCol = there
      else await sheets.update([{ range: `${QA}!${col(featureCol)}1`, values: [[FEATURE_HEADER]] }])
      console.log(`QA tab: "${FEATURE_HEADER}" header in column ${col(featureCol)}`)
    }
  }

  // the backfill: only empty cells, each by its own address, rows found by TC ID just now
  const backfill = opt('--backfill')
  if (sheets && backfill) {
    const known = new Set(map.features.map((f) => f.id))
    const want = new Map(readFileSync(backfill, 'utf8').split('\n').map((l) => l.split('\t')).filter((x) => x[0]?.trim() && x[1]?.trim()).map((x) => [x[0]!.trim(), parseFeatureCell(x[1]!).filter((f) => known.has(f)).join(', ')]))
    values = await sheets.values(`${QA}!A1:ZZ`)
    const idC = headerCol(values, 'TC ID')
    if (idC < 0) throw new Error('the QA tab has no "TC ID" header')
    const data: { range: string; values: string[][] }[] = []
    values.forEach((r, i) => {
      const ids = want.get((r[idC] ?? '').trim())
      if (i > 0 && ids && !(r[featureCol] ?? '').trim()) data.push({ range: `${QA}!${col(featureCol)}${i + 1}`, values: [[ids]] })
    })
    if (!dry && data.length) await sheets.update(data)
    console.log(`QA tab: ${data.length} empty Feature ID cells filled`)
    values = await sheets.values(`${QA}!A1:ZZ`)
  }

  const rows = featureRows(map, hits, qaRows(values, featureCol), lastChanges(map))
  const summary = `${summaryLine(rows, hits, Object.keys(map.endpoints))} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const out = tabValues(rows, summary, coverageNote)
  console.log(summary)
  if (dry || !sheets) {
    for (const r of rows.filter((x) => x.status === 'Untested' || x.status === 'Stale').slice(0, 20)) console.log(`  ${r.status.padEnd(8)} ${r.id.padEnd(30)} ${r.name}`)
    return
  }

  // the Features tab: made if missing, emptied and written again
  if (!tabs.some((t) => t.title === TAB)) await sheets.batch([{ addSheet: { properties: { title: TAB, gridProperties: { frozenRowCount: FIRST_ROW - 1, frozenColumnCount: 1 } } } }])
  await sheets.clear(`${TAB}!A1:Z`)
  await sheets.update([{ range: `${TAB}!A1`, values: out }])
  // the dropdown of the QA tab's Feature ID column: the Features tab's IDs (a warning, not a refusal: a cell may name two)
  if (qaTab) {
    await sheets.batch([{
      setDataValidation: {
        range: { sheetId: qaTab.sheetId, startRowIndex: 1, endRowIndex: qaTab.gridProperties.rowCount, startColumnIndex: featureCol, endColumnIndex: featureCol + 1 },
        rule: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: `='${TAB}'!$A$${FIRST_ROW}:$A$${FIRST_ROW + 300}` }] }, strict: false, showCustomUi: true },
      },
    }])
  }
  console.log(`Features tab: ${rows.length} features written`)
}

if (import.meta.main) await main()
