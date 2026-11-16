// The catalog (cases.yaml) read, expanded (variants become cases of their own) and checked against the feature map
// (docs/features.ts) and the AI's reach per feature (feature-scope.ts); coverage per feature.
import fs from 'node:fs'
import path from 'node:path'
import { FEATURES } from '../../../docs/features'
import { FEATURE_SCOPE } from '../feature-scope'
import { Case, Catalog, type Kind } from './types'

export const CATALOG_FILE = path.join(import.meta.dir, '..', 'cases.yaml')

export function expand(raw: unknown): Case[] {
  const cat = Catalog.parse(raw)
  const out: Case[] = []
  for (const { variants, ...base } of cat.cases) {
    out.push(Case.parse(base))
    for (const { key, ...v } of variants) {
      const set = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined))
      // pass1 is the variant's own: a base in the first pass does not take all its variants with it
      const merged = { ...base, ...set, id: `${base.id}.${key}`, pass1: v.pass1 ?? false } as Record<string, unknown>
      if (!('kind' in set)) {
        const m = merged as { expect: { outcome: string }; install: string }
        merged.kind = m.expect.outcome === 'refuse' && base.expect.outcome !== 'refuse' ? 'refuse' : m.install !== base.install ? 'install' : 'context'
      }
      out.push(Case.parse(merged))
    }
  }
  return out
}

/** the catalog's problems: duplicate ids, unknown features, features the scope map misses or calls 'none' */
export function problems(cases: Case[]): string[] {
  const p: string[] = []
  const known = new Set(FEATURES.map((f) => f.id))
  const ids = new Set<string>()
  for (const c of cases) {
    if (ids.has(c.id)) p.push(`duplicate case id ${c.id}`)
    ids.add(c.id)
    for (const f of c.features) {
      if (!known.has(f)) p.push(`${c.id}: no feature ${f} in docs/features.ts`)
      else if (FEATURE_SCOPE[f]?.reach === 'none') p.push(`${c.id}: ${f} is marked "none" in feature-scope.ts`)
    }
  }
  for (const f of FEATURES) if (!FEATURE_SCOPE[f.id]) p.push(`feature ${f.id} has no line in tests/ai-scenarios/feature-scope.ts`)
  for (const id of Object.keys(FEATURE_SCOPE)) if (!known.has(id)) p.push(`feature-scope.ts names ${id}, which docs/features.ts does not have`)
  return p
}

export function loadCatalog(): Case[] {
  const cases = expand(Bun.YAML.parse(fs.readFileSync(CATALOG_FILE, 'utf8')))
  const p = problems(cases)
  if (p.length) throw new Error(`the catalog does not hold together:\n- ${p.join('\n- ')}`)
  return cases
}

/** The first, representative pass: the cases marked pass1, plus for every feature still without one the first case
 * of it, so every feature in the AI's reach is run at least once. */
export function firstPass(cases: Case[]): Set<string> {
  const out = new Set(cases.filter((c) => c.pass1).map((c) => c.id))
  for (const f of FEATURES) {
    if (FEATURE_SCOPE[f.id]?.reach === 'none') continue
    if (cases.some((c) => out.has(c.id) && c.features.includes(f.id))) continue
    const first = cases.find((c) => c.features.includes(f.id))
    if (first) out.add(first.id)
  }
  return out
}

export interface FeatureCoverage {
  id: string
  name: string
  area: string
  reach: string
  cases: string[]
  kinds: Kind[]
  contexts: string[]
  /** none: no case; happy-only: only happy-path cases; covered: the happy path plus another place, install or refusal */
  level: 'none' | 'happy-only' | 'covered' | 'out of scope'
}

export function coverage(cases: Case[]): FeatureCoverage[] {
  return FEATURES.map((f) => {
    const scope = FEATURE_SCOPE[f.id]
    const mine = cases.filter((c) => c.features.includes(f.id))
    const kinds = [...new Set(mine.map((c) => c.kind))]
    const contexts = [...new Set(mine.map((c) => (c.context === 'personal' && ['jiwoo', 'minho'].includes(c.as) ? 'personal (admin)' : c.context)))]
    const level: FeatureCoverage['level'] = scope?.reach === 'none' ? 'out of scope' : !mine.length ? 'none'
      : kinds.some((k) => k !== 'happy' && k !== 'flow') || contexts.length > 1 ? 'covered' : 'happy-only'
    return { id: f.id, name: f.name, area: f.area, reach: scope?.reach ?? '?', cases: mine.map((c) => c.id), kinds, contexts, level }
  })
}

export function coverageMarkdown(cases: Case[]): string {
  const cov = coverage(cases)
  const n = (l: FeatureCoverage['level']) => cov.filter((c) => c.level === l).length
  const lines = [
    `## Coverage per feature`, '',
    `${cov.length} features in docs/features.ts: ${n('covered')} covered (happy path plus another place, install or refusal), ${n('happy-only')} happy path only, ${n('none')} with no case, ${n('out of scope')} out of the AI's reach (feature-scope.ts says why). ${cases.length} cases.`, '',
    '| Feature | Reach | Level | Kinds | Places | Cases |', '|---|---|---|---|---|---|',
    ...cov.map((c) => `| ${c.id} ${c.name.replace(/\|/g, '/')} | ${c.reach} | ${c.level} | ${c.kinds.join(', ')} | ${c.contexts.join(', ')} | ${c.cases.join(', ')} |`),
  ]
  return lines.join('\n') + '\n'
}
