// Global teardown of the e2e run (playwright.config.ts): asks the mock team server which contract endpoints the run's
// API requests reached (POST /__test/coverage without a body, kept over every /__test/reset) and writes them to
// test-results/feature-coverage.json (or $FEATURE_COVERAGE_FILE: one per shard run side by side) for the feature map
// (docs/FEATURES.md, scripts/features/sync-sheet.ts). It runs before Playwright stops the mock server. A failure here
// never fails the run.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export default async function featureCoverage() {
  const port = Number(process.env.MOCK_PORT ?? 19143)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__test/coverage`, { method: 'POST' })
    const endpoints = (await res.json()) as Record<string, number>
    const file = path.resolve(process.env.FEATURE_COVERAGE_FILE || path.join(import.meta.dirname, '..', '..', 'test-results', 'feature-coverage.json'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ finishedAt: new Date().toISOString(), commit: process.env.GITHUB_SHA ?? null, endpoints }, null, 2) + '\n')
    console.log(`feature coverage: ${Object.keys(endpoints).length} endpoints reached → ${path.relative(process.cwd(), file)}`)
  } catch (e) {
    console.warn(`feature coverage not written: ${(e as Error).message}`)
  }
}
