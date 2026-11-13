// The new navigation's one switch (AppConfig.navRail; docs/DECISIONS.md "navRail"): on by default since P6, so Me says
// `navRail: true` to everyone, owner and member alike (one switch per server); the operator's `"navRail": false` in
// server.json is the kill switch for one release: Me says nothing and every client keeps the old sidebar and tabs.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { loadAppConfig } from '../../server/src/app-config'
import { WORK } from '../lib/env'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('on (the default): Me says so to the owner and to a member', async () => {
  h = await harness('b-nav-rail-on')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  expect((await owner.call('GET', '/api/me')).server.navRail).toBe(true)
  expect((await mia.client.call('GET', '/api/me')).server.navRail).toBe(true)
})

test('off (the operator\'s kill switch): Me has no navRail', async () => {
  h = await harness('b-nav-rail-off', { navRail: false })
  const owner = await withOwner(h)
  expect((await owner.call('GET', '/api/me')).server.navRail).toBeUndefined()
})

test('server.json: absent or true is on, false is off', () => {
  const dir = path.join(WORK, 'nav-rail-config')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const load = (extra: object, n: string) => {
    const f = path.join(dir, `server-${n}.json`)
    fs.writeFileSync(f, JSON.stringify({ mode: 'dev', ...extra }))
    return loadAppConfig({ argv: ['--config', f], env: {} }).navRail
  }
  expect(load({}, 'absent')).toBeUndefined()
  expect(load({ navRail: true }, 'on')).toBeUndefined()
  expect(load({ navRail: false }, 'off')).toBe(false)
})
