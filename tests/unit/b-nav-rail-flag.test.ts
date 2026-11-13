// The new navigation's one switch (AppConfig.navRail; docs/AGENTS/plan/20261112-1839-nav-rail.md §5.1): off by
// default, so Me says nothing and every client keeps today's sidebar and tabs; the operator's `"navRail": true` in
// server.json puts `navRail: true` in Me.server for everyone, owner and member alike (one switch per server).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { loadAppConfig } from '../../server/src/app-config'
import { WORK } from '../lib/env'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('off (the default): Me has no navRail', async () => {
  h = await harness('b-nav-rail-off')
  const owner = await withOwner(h)
  expect((await owner.call('GET', '/api/me')).server.navRail).toBeUndefined()
})

test('on (the operator\'s switch): Me says so to the owner and to a member', async () => {
  h = await harness('b-nav-rail-on', { navRail: true })
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  expect((await owner.call('GET', '/api/me')).server.navRail).toBe(true)
  expect((await mia.client.call('GET', '/api/me')).server.navRail).toBe(true)
})

test('server.json: absent or false is off, true is on', () => {
  const dir = path.join(WORK, 'nav-rail-config')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const load = (extra: object, n: string) => {
    const f = path.join(dir, `server-${n}.json`)
    fs.writeFileSync(f, JSON.stringify({ mode: 'dev', ...extra }))
    return loadAppConfig({ argv: ['--config', f], env: {} }).navRail
  }
  expect(load({}, 'absent')).toBeUndefined()
  expect(load({ navRail: false }, 'off')).toBeUndefined()
  expect(load({ navRail: true }, 'on')).toBe(true)
})
