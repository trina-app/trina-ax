// The AI scenario catalog (tests/ai-scenarios) holds together without a server or a model: every feature of the
// feature map has a line in feature-scope.ts, every case names known features, a fixture person and fixture files it
// restores, and the first pass reaches every feature the AI can reach.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { FEATURES } from '../../docs/features'
import { FEATURE_SCOPE } from '../ai-scenarios/feature-scope'
import { coverage, firstPass, loadCatalog, problems } from '../ai-scenarios/lib/catalog'
import { COMPANY, FIXTURE_FILES, GUEST } from '../ai-scenarios/fixture/seed'
import { CaseInput } from '../ai-scenarios/lib/types'
import { loadFlows } from '../ai-scenarios/cli'

const cases = loadCatalog()

describe('AI scenario catalog', () => {
  test('no problems against the feature map', () => {
    expect(problems(cases)).toEqual([])
  })

  // TC-4549: the runner of another branch dropped the Jakarta cases' `timeZone` without a word, sent no zone and the
  // rerun reported Seoul times as a product regression
  test('a case or variant field the runner does not know is refused, not dropped', () => {
    const base = { id: 'ROOM-99', title: 't', features: ['rooms.messages'], lang: 'en', context: 'personal', as: 'daniel', prompt: 'p', expect: { outcome: 'do', good: 'g' } }
    expect(CaseInput.safeParse({ ...base, variants: [{ key: 'zone', timeZone: 'Asia/Jakarta' }] }).success).toBe(true)
    expect(CaseInput.safeParse({ ...base, variants: [{ key: 'zone', deviceZone: 'Asia/Jakarta' }] }).success).toBe(false)
    expect(CaseInput.safeParse({ ...base, deviceZone: 'Asia/Jakarta' }).success).toBe(false)
  })

  test('every case is asked by a fixture person and restores fixture files only', () => {
    const people = new Set([...COMPANY.people.map((p) => p.username), GUEST.username])
    for (const c of cases) {
      expect(people.has(c.as)).toBe(true)
      if (c.context === 'guest') expect(c.as).toBe(GUEST.username)
      for (const r of c.restores) expect(fs.existsSync(path.join(FIXTURE_FILES, r))).toBe(true)
    }
  })

  test('every feature the AI reaches has a case, and the first pass runs each at least once', () => {
    const reach = FEATURES.filter((f) => FEATURE_SCOPE[f.id]?.reach !== 'none').map((f) => f.id)
    expect(coverage(cases).filter((c) => c.level === 'none').map((c) => c.id)).toEqual([])
    const first = cases.filter((c) => firstPass(cases).has(c.id))
    expect(reach.filter((f) => !first.some((c) => c.features.includes(f)))).toEqual([])
  })

  test('the flows parse and name known features and people', () => {
    const known = new Set(FEATURES.map((f) => f.id))
    const people = new Set([...COMPANY.people.map((p) => p.username), GUEST.username, 'buyer2'])
    for (const f of loadFlows()) {
      for (const x of f.features) expect(known.has(x)).toBe(true)
      for (const s of f.steps) if (s.ask) expect(people.has(s.ask.as)).toBe(true)
    }
  })
})
