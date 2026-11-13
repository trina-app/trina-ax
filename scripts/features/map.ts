// Builds the feature map (docs/FEATURES.md): docs/features.ts applied to the units read from the code (units.ts).
import type { Feature } from '../../docs/features'
import { globRe, type EndpointUnit, type ScreenUnit } from './units'

export interface FeatureMap {
  features: (Feature & { endpoints: string[]; screens: string[] })[]
  endpoints: Record<string, Omit<EndpointUnit, 'name'> & { features: string[] }>
  screens: Record<string, { source: string; features: string[] }>
  problems: string[]
}

const ID_RE = /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/

export function buildMap(features: readonly Feature[], endpoints: readonly EndpointUnit[], screens: readonly ScreenUnit[]): FeatureMap {
  const problems: string[] = []
  const seen = new Set<string>()
  const epOut: FeatureMap['endpoints'] = Object.fromEntries(endpoints.map(({ name, ...rest }) => [name, { ...rest, features: [] as string[] }]))
  const scOut: FeatureMap['screens'] = Object.fromEntries(screens.map((s) => [s.path, { source: s.source, features: [] as string[] }]))
  const out: FeatureMap['features'] = []
  for (const f of features) {
    if (!ID_RE.test(f.id)) problems.push(`feature id "${f.id}" is not "area.name" in lower case`)
    if (seen.has(f.id)) problems.push(`feature id "${f.id}" is used twice`)
    seen.add(f.id)
    if (!f.name.trim()) problems.push(`feature "${f.id}" has no name`)
    const claim = (patterns: string[] | undefined, units: string[], kind: string) => {
      const got = new Set<string>()
      for (const p of patterns ?? []) {
        const re = globRe(p)
        const hit = units.filter((u) => re.test(u))
        if (!hit.length) problems.push(`feature "${f.id}": ${kind} pattern "${p}" matches nothing (renamed or removed? fix the pattern in docs/features.ts)`)
        for (const u of hit) got.add(u)
      }
      return [...got].sort()
    }
    const eps = claim(f.endpoints, Object.keys(epOut), 'endpoint')
    const scs = claim(f.screens, Object.keys(scOut), 'screen')
    if (f.manual && (eps.length || scs.length)) problems.push(`feature "${f.id}" is manual but claims endpoints or screens`)
    if (!f.manual && !eps.length && !scs.length) problems.push(`feature "${f.id}" claims no endpoint and no screen (mark it manual: true?)`)
    for (const e of eps) epOut[e]!.features.push(f.id)
    for (const s of scs) scOut[s]!.features.push(f.id)
    out.push({ ...f, endpoints: eps, screens: scs })
  }
  for (const [name, e] of Object.entries(epOut)) if (!e.features.length) problems.push(`endpoint ${name} (${e.method} ${e.path}, ${e.group}) belongs to no feature: add it to a feature in docs/features.ts`)
  for (const [p, s] of Object.entries(scOut)) if (!s.features.length) problems.push(`screen ${p} (${s.source}) belongs to no feature: add it to a feature in docs/features.ts`)
  return { features: out, endpoints: epOut, screens: scOut, problems }
}
