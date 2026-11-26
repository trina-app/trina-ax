// The runner image's Microsoft apt source answered 403 on 2026-11-27 and failed `apt-get update` in the merge queue.
// Every package our jobs install is Ubuntu's, so each step that updates apt drops that source first.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.join(import.meta.dir, '../../.github/workflows')
const RM = 'sudo rm -f /etc/apt/sources.list.d/microsoft-prod.list'

describe('apt steps in the workflows', () => {
  test('every step that runs apt-get update (or playwright install-deps) removes the Microsoft source first', () => {
    const bad: string[] = []
    let seen = 0
    for (const f of fs.readdirSync(DIR).filter(n => n.endsWith('.yml'))) {
      const wf = Bun.YAML.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as { jobs?: Record<string, { steps?: { name?: string; run?: string }[] }> }
      for (const [id, job] of Object.entries(wf.jobs ?? {})) for (const st of job.steps ?? []) {
        const run = st.run ?? ''
        const m = /apt-get\b[^\n]*\bupdate\b|install-deps/.exec(run)
        if (!m) continue
        seen++
        const rm = run.indexOf(RM)
        if (rm < 0 || rm > m.index) bad.push(`${f}:${id}:${st.name ?? '(step)'}`)
      }
    }
    expect(seen).toBeGreaterThanOrEqual(9)
    expect(bad).toEqual([])
  })
})
