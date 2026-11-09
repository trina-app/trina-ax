// The staleness check of the pinned chrome-headless-shell against Chrome for Testing Stable
// (scripts/system/browser-staleness.ts): the policy on fixed versions, no network.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { compareChrome, staleness } from '../../scripts/system/browser-staleness'

const REPO = path.join(import.meta.dir, '../..')

describe('pinned browser against Chrome for Testing Stable', () => {
  test('versions compare part by part, as numbers', () => {
    expect(compareChrome('157.0.8103.38', '157.0.8103.38')).toBe(0)
    expect(compareChrome('157.0.8103.9', '157.0.8103.38')).toBe(-1)
    expect(compareChrome('158.0.1.0', '157.0.9999.99')).toBe(1)
  })

  test('the policy: ok at Stable; warn behind in the same major, one major behind, newer; fail two majors behind', () => {
    expect(staleness('157.0.8103.38', '157.0.8103.38').level).toBe('ok')
    expect(staleness('157.0.8103.38', '157.0.8103.70')).toMatchObject({ level: 'warn' })
    expect(staleness('157.0.8103.38', '157.0.8103.70').message).toContain('within 7 days')
    expect(staleness('157.0.8103.38', '158.0.8127.40').message).toContain('one major behind')
    expect(staleness('157.0.8103.38', '158.0.8127.40').level).toBe('warn')
    expect(staleness('158.0.8127.18', '157.0.8103.38').level).toBe('warn')
    expect(staleness('157.0.8103.38', '159.0.8150.20')).toMatchObject({ level: 'fail' })
    expect(staleness('157.0.8103.38', '161.0.1.1').message).toContain('4 majors behind')
    // a bad answer from Chrome for Testing only warns; a bad pin fails
    expect(staleness('157.0.8103.38', 'garbage').level).toBe('warn')
    expect(staleness('latest', '157.0.8103.38').level).toBe('fail')
  })

  test('CI runs it in the main job with a time limit (not in dev-build.yml), and a network error never fails', () => {
    const ci = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toMatch(/- name: Pinned browser against Chrome for Testing Stable\n\s+timeout-minutes: 2\n\s+run: bun scripts\/system\/browser-staleness\.ts\n/)
    expect(fs.readFileSync(path.join(REPO, '.github/workflows/dev-build.yml'), 'utf8')).not.toContain('browser-staleness')
    const src = fs.readFileSync(path.join(REPO, 'scripts/system/browser-staleness.ts'), 'utf8')
    expect(src).toContain('if (stable === null) {')
    expect(src).toMatch(/if \(stable === null\) \{[\s\S]*?process\.exit\(0\)/)
  })
})
