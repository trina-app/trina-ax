// Settings › Connectors' "Programs connected on this computer" (docs/decisions/20261123-ask-registry-findings.md,
// decision 9): the desktop app lists the connections confirmed for a team on this computer (ids only) and forgets one
// on Remove, so the next call asks again in the app's own window; a running program of it stops; the setting values
// stay. desktop/src/main/local-apps.ts LocalAppsHost, with Electron's dialog and keychain faked.
import { afterAll, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LocalAppSpec, LocalCall } from '@mycel/shared/api'

setDefaultTimeout(30_000)
const asked: string[] = []
let answer = 0
// every name another test file's electron mock exports is here too (bun keeps one module for the run): only the
// dialog and the keychain are used
mock.module('electron', () => ({
  app: {}, shell: {}, powerMonitor: {}, BaseWindow: {}, session: {}, autoUpdater: {},
  dialog: { showMessageBox: async (_w: unknown, o: { detail: string }) => { asked.push(o.detail); return { response: answer } } },
  safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'unknown', encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
const { LocalAppsHost } = await import('../../desktop/src/main/local-apps')
const { commandHash } = await import('../../desktop/src/common/local-apps')

const FAKE = path.join(import.meta.dir, '..', 'fixtures', 'local-apps', 'fake-mcp.ts')
const spec: LocalAppSpec = { adapter: 'mcp', command: process.execPath, args: [FAKE], env: [] }
const dirs: string[] = []
const hosts: InstanceType<typeof LocalAppsHost>[] = []
afterAll(() => {
  for (const h of hosts) h.apps.stopAll()
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})
beforeEach(() => { asked.length = 0; answer = 0 })

function host(saved: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-local-forget-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'local-apps.json'), JSON.stringify(saved))
  const h = new LocalAppsHost({ userData: dir, parent: () => ({}) as never, locale: () => 'en', teamLabel: () => 'Acme', onChange: () => {} })
  hosts.push(h)
  return { h, file: () => JSON.parse(fs.readFileSync(path.join(dir, 'local-apps.json'), 'utf8')) }
}
let n = 0
const init = (connectionId: string): LocalCall => ({ callId: `c-${++n}`, turnId: '019a0000-0000-7000-8000-000000000001', connectionId, name: 'Fake', spec, message: { jsonrpc: '2.0', id: `i-${n}`, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, deadline: Date.now() + 10_000 })

describe('programs connected on this computer', () => {
  test('connected(): the confirmed ids of that team only, never another team\'s or an unconfirmed one', () => {
    const { h } = host({ v: 1, teams: { t1: { a: { confirmed: 'h1' }, b: { settings: 'x' }, 'bad id!': { confirmed: 'h' } }, t2: { c: { confirmed: 'h2' } } } })
    expect(h.connected('t1')).toEqual(['a'])
    expect(h.connected('t2')).toEqual(['c'])
    expect(h.connected('t3')).toEqual([])
  })

  test('forget(): the confirm goes, the settings stay; malformed or never-confirmed ids answer false', () => {
    const { h, file } = host({ v: 1, teams: { t1: { a: { confirmed: 'h1', settings: 'sealed' } } } })
    expect(h.forget('t1', '../a')).toBe(false)
    expect(h.forget('t1', 42)).toBe(false)
    expect(h.forget('t1', 'zz')).toBe(false)
    expect(h.forget('t2', 'a')).toBe(false)
    expect(h.forget('t1', 'a')).toBe(true)
    expect(h.connected('t1')).toEqual([])
    expect(file().teams.t1.a).toEqual({ settings: 'sealed' })
  })

  test('after forget the next call asks again in the app\'s window, and a running program stops', async () => {
    const { h } = host({ v: 1, teams: { t1: { conn: { confirmed: commandHash(spec) } } } })
    const first = await h.apps.call('t1', init('conn'))
    expect(first.ok).toBe(true)
    expect(asked).toEqual([])
    expect(h.apps.runningIds('t1')).toEqual(['conn'])
    expect(h.forget('t1', 'conn')).toBe(true)
    await new Promise((r) => setTimeout(r, 200))
    expect(h.apps.runningIds('t1')).toEqual([])
    // Cancel in the window this time: nothing runs
    const again = await h.apps.call('t1', init('conn'))
    expect(asked.length).toBe(1)
    expect(again).toMatchObject({ ok: false, failure: 'declined' })
  })
})
