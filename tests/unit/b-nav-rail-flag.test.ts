// The new navigation's switch is retired (docs/DECISIONS.md "navRail: retired, the old navigation removed"): the rail and
// the phone tabs 트리나 · 대화 · 파일 · 나 are the only navigation, so Me says nothing about it, and a server.json that
// still has `"navRail"` (true or false) loads; the key is ignored and listed as obsolete (the start logs it once).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { loadAppConfig } from '../../server/src/app-config'
import { WORK } from '../lib/env'
import { harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('Me has no navRail', async () => {
  h = await harness('b-nav-rail-retired')
  const owner = await withOwner(h)
  expect((await owner.call('GET', '/api/me')).server).not.toHaveProperty('navRail')
})

test('server.json: an old "navRail" key loads and is reported as obsolete', () => {
  const dir = path.join(WORK, 'nav-rail-config')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const load = (extra: object, n: string) => {
    const f = path.join(dir, `server-${n}.json`)
    fs.writeFileSync(f, JSON.stringify({ mode: 'dev', ...extra }))
    return loadAppConfig({ argv: ['--config', f], env: {} })
  }
  expect(load({}, 'absent').obsoleteKeys).toBeUndefined()
  for (const v of [true, false]) {
    const cfg = load({ navRail: v }, String(v))
    expect(cfg.obsoleteKeys).toEqual(['navRail'])
    expect(cfg).not.toHaveProperty('navRail')
  }
})
