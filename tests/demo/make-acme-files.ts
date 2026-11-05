// Regenerates the spreadsheets of the open demo company Acme (scripts/demo/acme/files/<team path>), which
// `bun run demo:company` uploads. The outputs are committed, so this only runs when the samples change:
//
//   bun tests/demo/make-acme-files.ts
//
// Only the .xlsx files come from here (SheetJS); the Markdown next to them is written by hand. The company, its people,
// customers and numbers are all made up. The budgets are built from one table, so the company sheet is always the sum
// of the team sheets, and the Marketing sheet's November campaign line is the campaign plan's $12,000; the script
// refuses to write if a total drifts.
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'

const OUT = path.resolve(import.meta.dir, '..', '..', 'scripts', 'demo', 'acme', 'files')

type Cell = string | number | null

function write(rel: string, wb: XLSX.WorkBook) {
  const data = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }))
  const p = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
  console.log(`wrote ${rel} (${data.byteLength} bytes)`)
}

/** A sheet from rows; numbers in the `money` columns get a dollar format. */
function sheet(rows: Cell[][], widths: number[], money: number[] = []): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  for (let r = 1; r < rows.length; r++) {
    for (const c of money) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (cell?.t === 'n') cell.z = '$#,##0'
    }
  }
  ws['!cols'] = widths.map((wch) => ({ wch }))
  return ws
}

function book(name: string, ws: XLSX.WorkSheet): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, name)
  return wb
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

// ---- Q4 2026 operating budget (salaries not included) ----

type Line = { item: string; months: [number, number, number]; spent: number; memo: string }
type Team = { team: string; total: number; lines: Line[] }

const TEAMS: Team[] = [
  { team: 'Marketing', total: 45_000, lines: [
    { item: 'Ads (always on)', months: [5_000, 5_000, 5_000], spent: 4_600, memo: 'Search and LinkedIn' },
    { item: 'November campaign', months: [0, 8_000, 4_000], spent: 0, memo: 'Ads $9,000 + content $3,000 (Nov 16 to Dec 13)' },
    { item: 'Content and design', months: [3_000, 4_000, 3_000], spent: 2_700, memo: 'Videos, customer stories, illustrations' },
    { item: 'Events', months: [0, 5_000, 3_000], spent: 0, memo: 'Two office-manager meetups' },
  ] },
  { team: 'Sales', total: 30_000, lines: [
    { item: 'Trials and demos', months: [4_000, 4_000, 4_000], spent: 3_800, memo: 'Demo hardware, trial gifts' },
    { item: 'Travel', months: [3_000, 4_000, 3_000], spent: 2_950, memo: 'Customer visits' },
    { item: 'CRM and tools', months: [3_000, 2_500, 2_500], spent: 3_000, memo: 'CRM seats, e-signature' },
  ] },
]
const COMPANY_WIDE: Line[] = [
  { item: 'Software', months: [3_500, 3_000, 3_500], spent: 3_400, memo: 'Shared tools for everyone' },
  { item: 'Office', months: [3_000, 3_000, 3_000], spent: 2_900, memo: 'Rent share, coffee, supplies' },
  { item: 'Training', months: [1_000, 2_000, 3_000], spent: 800, memo: 'Learning budget ($600 a person)' },
]
const TOTAL = 100_000

const lineTotal = (l: Line) => sum(l.months)
for (const t of TEAMS) {
  if (sum(t.lines.map(lineTotal)) !== t.total) throw new Error(`${t.team}: the lines do not add up to ${t.total}`)
}
const campaign = TEAMS[0]!.lines.find((l) => l.item === 'November campaign')!
if (lineTotal(campaign) !== 12_000) throw new Error('the November campaign line must be the plan\'s $12,000')
if (sum(TEAMS.map((t) => t.total)) + sum(COMPANY_WIDE.map(lineTotal)) !== TOTAL) throw new Error(`the company budget must be ${TOTAL}`)

const HEAD = ['Item', 'October', 'November', 'December', 'Q4 total', 'Spent in October', 'Note']
const rowsOf = (lines: Line[]): Cell[][] => lines.map((l) => [l.item, ...l.months, lineTotal(l), l.spent, l.memo])

for (const t of TEAMS) {
  const rows: Cell[][] = [HEAD, ...rowsOf(t.lines), ['Total', ...[0, 1, 2].map((m) => sum(t.lines.map((l) => l.months[m]!))), t.total, sum(t.lines.map((l) => l.spent)), '']]
  write(`shared/budget/teams/${t.team}/2026-Q4-${t.team.toLowerCase()}-budget.xlsx`, book(`${t.team} Q4`, sheet(rows, [22, 11, 11, 11, 11, 16, 44], [1, 2, 3, 4, 5])))
}

{
  const rows: Cell[][] = [
    ['Team or item', 'Q4 budget', 'Spent in October', 'Note'],
    ...TEAMS.map((t) => [t.team, t.total, sum(t.lines.map((l) => l.spent)), `Details: shared/budget/teams/${t.team}/`] as Cell[]),
    ...COMPANY_WIDE.map((l) => [`Company-wide: ${l.item}`, lineTotal(l), l.spent, l.memo] as Cell[]),
    ['Total', TOTAL, sum([...TEAMS.flatMap((t) => t.lines), ...COMPANY_WIDE].map((l) => l.spent)), 'Salaries are not in this budget'],
  ]
  write('shared/budget/2026-Q4-company-budget.xlsx', book('Company Q4', sheet(rows, [28, 12, 16, 40], [1, 2])))
}

// ---- Sales pipeline (November 4, 2026) ----

const DEALS: Cell[][] = [
  ['Customer', 'Stage', 'Plan', 'Desks', 'Monthly value', 'Owner', 'Next step', 'Expected close'],
  ['Bluepeak Design', 'Won', 'Pro', 40, 280, 'Priya Nair', 'Kick-off call Nov 9', '2026-10-28'],
  ['Cedar & Co', 'Proposal', 'Pro', 85, 595, 'Priya Nair', 'Answer on the price by Nov 12', '2026-11-20'],
  ['Harbor Labs', 'Won', 'Pro', 120, 840, 'Leo Martin', 'Customer story approved', '2026-09-15'],
  ['Kite Logistics', 'Trial', 'Starter', 30, 120, 'Leo Martin', 'Trial ends Nov 18', '2026-11-25'],
  ['Orchard Media', 'Trial', 'Pro', 55, 385, 'Priya Nair', 'Floor map set-up Nov 10', '2026-12-01'],
  ['Pine Street Studio', 'Lead', 'Starter', 15, 60, 'Leo Martin', 'First call Nov 6', '2026-12-15'],
  ['Quill Partners', 'Proposal', 'Starter', 25, 100, 'Leo Martin', 'Send the proposal Nov 9', '2026-11-30'],
  ['Redwood Analytics', 'Lost', 'Pro', 70, 490, 'Priya Nair', 'Chose to keep spreadsheets', '2026-10-20'],
]
for (const d of DEALS.slice(1)) {
  const perDesk = d[2] === 'Pro' ? 7 : 4
  if ((d[3] as number) * perDesk !== d[4]) throw new Error(`${d[0]}: the monthly value is desks x the plan's price`)
}
write('groups/Sales/pipeline.xlsx', book('Pipeline', sheet(DEALS, [20, 10, 9, 7, 14, 12, 30, 15], [4])))
