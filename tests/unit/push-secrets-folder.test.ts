// QA TC-6929: a data folder left open (0755) stopped every phone and browser from registering for notifications, and
// the member's phone said only "The team server is temporarily unavailable" (503, reason push_key). The member still
// hears only that; the cause, with the command that fixes it, goes to the server log once and to Admin › System ›
// Diagnostics.
import { afterEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PUSH_KEY_REASON } from '@mycel/shared/api'
import { harness, withOwner, type Harness } from './a-lib'
import { PushService } from '../../server/src/notifications/push-service'
import { padPrivateKey } from '../../server/src/notifications/push-config'
import { PUSH_SECRETS_TEXT, pushSecretsLogLine, pushSecretsProblem } from '../../server/src/notifications/push-secrets'
import { HttpError } from '../../server/src/http/errors'
import { OpsService } from '../../server/src/system/ops'
import type { Logger } from '../../server/src/log'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-push-secrets-'))

test('the folders: closed ones pass, an open one says which and its mode, the data folder inside the team folder is refused', () => {
  const base = tmp()
  const data = path.join(base, 'data'), team = path.join(base, 'team')
  fs.mkdirSync(data, { mode: 0o700 })
  fs.mkdirSync(team, { mode: 0o755 })
  fs.chmodSync(data, 0o700)
  const secrets = path.join(data, 'secrets', 'push')
  // not made yet: no problem; made on a registration, closed
  expect(pushSecretsProblem({ dataDir: data, teamRoot: team, secrets })).toBeNull()
  expect(pushSecretsProblem({ dataDir: data, teamRoot: team, secrets, create: true })).toBeNull()
  expect((fs.statSync(secrets).mode & 0o777).toString(8)).toBe('700')
  fs.chmodSync(data, 0o755)
  expect(pushSecretsProblem({ dataDir: data, teamRoot: team, secrets })).toEqual({ dir: data, why: 'open', mode: '755' })
  fs.chmodSync(data, 0o700)
  fs.chmodSync(path.join(data, 'secrets'), 0o750)
  expect(pushSecretsProblem({ dataDir: data, teamRoot: team, secrets })).toMatchObject({ dir: path.join(data, 'secrets'), why: 'open', mode: '750' })
  const inside = path.join(team, 'data')
  fs.mkdirSync(inside, { mode: 0o700 })
  expect(pushSecretsProblem({ dataDir: inside, teamRoot: team, secrets: path.join(inside, 'secrets', 'push') })).toMatchObject({ why: 'in_team_folder' })
})

test('the words: the log line and every language name the folder and the fix, and carry no secret', () => {
  const p = { dir: '/srv/trina/data', why: 'open' as const, mode: '755' }
  expect(pushSecretsLogLine(p)).toContain('chmod 700')
  expect(pushSecretsLogLine(p)).toContain('/srv/trina/data')
  const words = PUSH_SECRETS_TEXT.problem(p)
  for (const l of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
    expect(words[l]).toContain('chmod 700 /srv/trina/data')
    expect(PUSH_SECRETS_TEXT.label[l].length).toBeGreaterThan(0)
    // a hosted team's admin has no shell: no folder, no command
    expect(PUSH_SECRETS_TEXT.problem(p, true)[l]).not.toContain('/srv/trina/data')
    expect(PUSH_SECRETS_TEXT.problem(p, true)[l]).not.toContain('chmod')
    for (const why of ['owner', 'link', 'not_folder', 'in_team_folder', 'unreadable'] as const) expect(PUSH_SECRETS_TEXT.problem({ dir: '/x', why })[l]).toContain('/x')
  }
})

let h: Harness | undefined, p: PushService | undefined
afterEach(async () => { await p?.stop(); await h?.close(); p = undefined; h = undefined })

test('a registration with the data folder open: 503 push_key for the member, the cause in the log once, and a Diagnostics line', async () => {
  const warned: { msg: string; fields?: Record<string, unknown> }[] = []
  const quiet = () => {}
  const log: Logger = { debug: quiet, info: quiet, error: quiet, warn: (msg, fields) => void warned.push({ msg, fields }), child: () => log }
  h = await harness('push-secrets-folder', {}, { log })
  await withOwner(h)
  const sid = (h.ctx.db.query("SELECT id FROM sessions WHERE user_id='olga'").get() as { id: string }).id
  const e = crypto.createECDH('prime256v1'); e.generateKeys()
  const keys = { publicKey: e.getPublicKey().toString('base64url'), privateKey: padPrivateKey(e.getPrivateKey().toString('base64url')) }
  p = new PushService(h.ctx, { config: () => ({ enabled: true, subject: 'mailto:push@example.test', ...keys }), transport: async () => ({ statusCode: 201 }) })
  const k = crypto.createECDH('prime256v1'); k.generateKeys()
  const input = () => ({ consent: true as const, endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-folder', keys: { p256dh: k.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } })
  const dataDir = h.ctx.config.dataDir
  fs.chmodSync(dataDir, 0o755)
  try {
    for (let i = 0; i < 2; i++) {
      let error: unknown
      try { p.subscribe('olga', sid, input()) } catch (x) { error = x }
      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).code).toBe('unavailable')
      // the member's answer: the reason code only, no folder or mode
      const body = (error as HttpError).body('en')
      expect(body.params).toEqual({ reason: PUSH_KEY_REASON })
      expect(JSON.stringify(body)).not.toContain(dataDir)
    }
    const lines = warned.filter((w) => w.msg.includes('push secrets folder'))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.msg).toContain(`${dataDir} is open to other accounts (mode 755)`)
    expect(lines[0]!.msg).toContain('chmod 700')
    // Admin › System › Diagnostics (admins only) says it and what to run
    const ops = new OpsService(h.ctx, { engines: async () => [], launcherStatus: async () => null })
    const line = (await ops.diagnostics('en')).checks.find((c) => c.id === 'push_secrets')
    expect(line).toMatchObject({ status: 'warn', group: 'server', label: 'Notification secrets folder' })
    expect(line?.detail).toContain(`chmod 700 ${dataDir}`)
    // fixed: it registers, and the Diagnostics line is gone
    fs.chmodSync(dataDir, 0o700)
    expect(p.subscribe('olga', sid, input()).id).toBeTruthy()
    expect((await ops.diagnostics('en')).checks.find((c) => c.id === 'push_secrets')).toBeUndefined()
  } finally {
    fs.chmodSync(dataDir, 0o700)
  }
})
