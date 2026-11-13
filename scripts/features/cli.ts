// bun run features:check — fails when an endpoint or a screen belongs to no feature (docs/FEATURES.md).
// bun run features:build — also writes docs/features.generated.json (not committed: made again whenever it is needed).
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { FEATURES } from '../../docs/features'
import { buildMap } from './map'
import { readEndpoints, readScreens, ROOT } from './units'

export const GENERATED = path.join(ROOT, 'docs', 'features.generated.json')

if (import.meta.main) {
  const map = buildMap(FEATURES, readEndpoints(), readScreens())
  const counts = `${map.features.length} features, ${Object.keys(map.endpoints).length} endpoints, ${Object.keys(map.screens).length} screens`
  if (process.argv.includes('--write')) {
    const { problems: _, ...data } = map
    writeFileSync(GENERATED, JSON.stringify(data, null, 2) + '\n')
    console.log(`wrote ${path.relative(ROOT, GENERATED)}`)
  }
  if (map.problems.length) {
    console.error(`features:check: ${map.problems.length} problem(s) (${counts}); see docs/FEATURES.md\n` + map.problems.map((p) => `  - ${p}`).join('\n'))
    process.exit(1)
  }
  console.log(`features:check ok: ${counts}`)
}
