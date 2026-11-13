// The gap status of each feature (docs/FEATURES.md "Status"), from the feature map, the e2e run's coverage file and
// the QA sheet's rows. Pure: sync-sheet.ts reads and writes, the unit tests call this.
import type { FeatureMap } from './map'

export type GapStatus = 'Untested' | 'Stale' | 'Partly' | 'Green'

export interface QaRow {
  id: string
  /** the QA tab's Result column: Pass, Fail, Blocked, Not run, empty … */
  result: string
  /** YYYY-MM-DD or empty */
  testDate: string
  features: string[]
}

export interface FeatureRow {
  id: string
  name: string
  area: string
  manual: boolean
  status: GapStatus
  endpoints: number
  endpointsHit: number
  /** null: nothing the e2e run can reach (a manual feature or one with screens only) */
  e2ePct: number | null
  screens: number
  qaPass: number
  qaFail: number
  qaBlocked: number
  qaOpen: number
  lastPass: string
  lastChange: string
  endpointList: string[]
  screenList: string[]
}

const ORDER: Record<GapStatus, number> = { Untested: 0, Stale: 1, Partly: 2, Green: 3 }

/** "Pass" / "Fail" / "Blocked" in any case, else open (Not run, In progress, empty). */
function kind(result: string): 'pass' | 'fail' | 'blocked' | 'open' {
  const r = result.trim().toLowerCase()
  if (r.startsWith('pass')) return 'pass'
  if (r.startsWith('fail')) return 'fail'
  if (r.startsWith('blocked')) return 'blocked'
  return 'open'
}

/**
 * - Untested: no endpoint reached by e2e and no QA Pass.
 * - Stale: a QA Pass, but the feature's files changed after the last one (lastChange > lastPass).
 * - Partly: e2e reaches under half of its endpoints, or no QA Pass, or a QA row failed / is blocked.
 * - Green: the rest (e2e reaches most endpoints, or it has none, and QA passed after the last change).
 */
export function featureRows(map: Pick<FeatureMap, 'features'>, hits: Record<string, number>, qa: readonly QaRow[], lastChange: (featureId: string) => string = () => ''): FeatureRow[] {
  const rows = map.features.map((f): FeatureRow => {
    const mine = qa.filter((r) => r.features.includes(f.id))
    const n = { pass: 0, fail: 0, blocked: 0, open: 0 }
    let lastPass = ''
    for (const r of mine) {
      const k = kind(r.result)
      n[k]++
      if (k === 'pass' && r.testDate > lastPass) lastPass = r.testDate
    }
    const hit = f.endpoints.filter((e) => (hits[e] ?? 0) > 0).length
    const pct = f.endpoints.length ? Math.round((hit / f.endpoints.length) * 100) : null
    const changed = lastChange(f.id)
    let status: GapStatus
    if (hit === 0 && n.pass === 0) status = 'Untested'
    else if (n.pass > 0 && changed && lastPass && changed > lastPass) status = 'Stale'
    else if ((pct !== null && pct < 50) || n.pass === 0 || n.fail > 0 || n.blocked > 0) status = 'Partly'
    else status = 'Green'
    return {
      id: f.id, name: f.name, area: f.area, manual: !!f.manual, status, endpoints: f.endpoints.length, endpointsHit: hit, e2ePct: pct,
      screens: f.screens.length, qaPass: n.pass, qaFail: n.fail, qaBlocked: n.blocked, qaOpen: n.open, lastPass, lastChange: changed,
      endpointList: f.endpoints, screenList: f.screens,
    }
  })
  return rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.qaPass - b.qaPass || (a.e2ePct ?? -1) - (b.e2ePct ?? -1) || a.id.localeCompare(b.id))
}

/** The one line on top of the Features tab: "124 features · 40 green · 18 stale · 30 partly · 36 untested · e2e reaches
 * 210 of 407 endpoints (52%)". */
export function summaryLine(rows: readonly FeatureRow[], hits: Record<string, number>, allEndpoints: readonly string[]): string {
  const c = (s: GapStatus) => rows.filter((r) => r.status === s).length
  const reached = allEndpoints.filter((e) => (hits[e] ?? 0) > 0).length
  const pct = allEndpoints.length ? Math.round((reached / allEndpoints.length) * 100) : 0
  return `${rows.length} features · ${c('Green')} green · ${c('Stale')} stale · ${c('Partly')} partly · ${c('Untested')} untested · e2e reaches ${reached} of ${allEndpoints.length} endpoints (${pct}%)`
}

/** The QA tab's Feature ID cell: "rooms.threads, rooms.ai" → ids (unknown words are kept; the check is the dropdown). */
export const parseFeatureCell = (cell: string) => cell.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
