// admin.js commands behind mycel-ctl's tenant commands (CT-1, server/src/system/cloud-tenant.ts): cloud-status is the
// app's part of the strict TenantStatus (no names, mail or free text), reset-link gives a one-time link at the team's
// public address, credentials-escrow-out age-armors the AI connections' key to the control plane's recipient (with
// the key file's name after a rekey), all through the real command line with JSON out.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { TenantStatus } from '@mycel/shared/cloud-protocol'
import { openDb } from '../../server/src/db'
import { ageUnarmorWith, newAgeIdentity } from '../../server/src/system/streams'
import { WORK } from '../lib/env'

setDefaultTimeout(60_000)
const W = path.join(WORK, `g-cloud-tenant-${process.pid}`)
fs.rmSync(W, { recursive: true, force: true })

function install(name: string, extra: object = {}) {
  const base = path.join(W, name)
  fs.mkdirSync(path.join(base, 'team'), { recursive: true })
  fs.mkdirSync(path.join(base, 'data'), { recursive: true })
  const cfgFile = path.join(base, 'server.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ mode: 'dev', dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team'), ...extra }))
  openDb(path.join(base, 'data', 'app.db')).close()
  const run = (...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, '../../server/src/system/cli.ts'), ...args], { env: { ...process.env, MYCEL_CONFIG: cfgFile, MYCEL_MODE: 'dev' } })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  return { base, run, db: () => openDb(path.join(base, 'data', 'app.db')) }
}

/** what mycel-ctl adds around admin.js cloud-status */
const rootPart = {
  at: '2026-10-22T00:00:00Z', kitVersion: '0.3.0', rootVersion: '0.3.0',
  app: { version: '0.3.0', health: 'ok' as const, schemaApplied: 1, readerLevel: 1, uptimeSec: 5 },
  resources: { memCurrent: 1, memMax: 2, oomKills: 0, cpuPressureSome10: 0, ioPressureSome10: 0, diskUsed: 1, diskTotal: 2 },
  update: { running: false, step: null },
}

describe('admin.js cloud-status', () => {
  test('a fresh team: setup needed, nothing connected; with the server\'s status file: queue, relay code, checks', () => {
    const t = install('status')
    const a = t.run('cloud-status')
    expect(a.code).toBe(0)
    const s = JSON.parse(a.out)
    expect(s).toEqual({
      setupNeeded: true, activeMembers: 0, queue: null, relay: null, lastLocalBackup: null, lastUploadedLocalId: null, overall: 'unknown', checks: [],
      ai: { claude: 'none', codex: 'none' }, credentialsKey: { present: false, version: null },
    })
    expect(TenantStatus.safeParse({ ...rootPart, ...s }).success).toBe(true)
    // the server's status file (written every 30 s): free-text relay details and problem lines never get through
    const db = t.db()
    db.query("INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga Kim', 'owner')").run()
    db.close()
    fs.mkdirSync(path.join(t.base, 'status'), { recursive: true })
    const status = {
      format: 1, writtenAt: new Date().toISOString(), version: '0.3.0', pid: 1, webUrl: 'https://acme.treesoop.com', localUrl: 'http://127.0.0.1:1',
      label: null, logsDir: null, connection: { mode: 'relay', state: 'connecting', address: 'https://acme.treesoop.com', detail: 'awaiting_operator' },
      queue: { running: 1, queued: 2 }, firewall: 'ok', sandbox: 'ok', lastBackupAt: null, overall: 'warn',
      problems: ['Relay: olga@acme.example could not …'], checks: [{ id: 'relay', status: 'warn' }, { id: 'disk.team', status: 'ok' }],
    }
    fs.writeFileSync(path.join(t.base, 'status', 'status.json'), JSON.stringify(status))
    const s2 = JSON.parse(t.run('cloud-status').out)
    expect(s2).toMatchObject({ setupNeeded: false, activeMembers: 1, queue: { running: 1, queued: 2 }, relay: { state: 'connecting', detail: 'awaiting_operator' }, overall: 'warn', checks: status.checks })
    expect(TenantStatus.safeParse({ ...rootPart, ...s2 }).success).toBe(true)
    expect(JSON.stringify(s2)).not.toContain('olga')
    fs.writeFileSync(path.join(t.base, 'status', 'status.json'), JSON.stringify({ ...status, connection: { ...status.connection, detail: 'the relay at 1.2.3.4 refused' } }))
    expect(JSON.parse(t.run('cloud-status').out).relay).toEqual({ state: 'connecting', detail: null })
    // a stale file (the server stopped writing it): no queue, no checks
    fs.writeFileSync(path.join(t.base, 'status', 'status.json'), JSON.stringify({ ...status, writtenAt: '2020-01-01T00:00:00Z' }))
    expect(JSON.parse(t.run('cloud-status').out)).toMatchObject({ queue: null, relay: null, overall: 'unknown', checks: [] })
  })
})

describe('admin.js cloud-status: the team\'s first days (onboarding)', () => {
  test('counts and yes/no only: day, pack, profile, invites, people, the best skill, the goal; never a name or path', () => {
    const t = install('onboarding')
    const day = 86_400_000, start = new Date(Date.now() - 2.5 * day).toISOString()
    const db = t.db()
    db.query("INSERT INTO users (id, username, name, role, created_at) VALUES ('olga', 'olga', 'Olga Kim', 'owner', ?), ('mina', 'mina', 'Mina Lee', 'member', ?), ('jun', 'jun', 'Jun Park', 'member', ?)").run(start, start, start)
    db.close()
    // just the owner's account: everything no or zero, day 2
    const t0 = install('onboarding-owner')
    const d0 = t0.db()
    d0.query("INSERT INTO users (id, username, name, role, created_at) VALUES ('olga', 'olga', 'Olga Kim', 'owner', ?)").run(start)
    d0.close()
    const s0 = JSON.parse(t0.run('cloud-status').out)
    expect(s0.onboarding).toEqual({ day: 2, packInstalled: false, profileSaved: false, inviteMade: false, membersJoined: 0, peopleAnswered: 0, membersWithFirstRun: 0, bestSkillRunners: 0, goalReached: false })
    expect(TenantStatus.safeParse({ ...rootPart, ...s0 }).success).toBe(true)

    const path1 = 'skills/marketing/ad-copy/SKILL.md'
    fs.mkdirSync(path.join(t.base, 'team', path.dirname(path1)), { recursive: true })
    fs.writeFileSync(path.join(t.base, 'team', path1), '---\nname: ad-copy\ndescription: 광고 문구 — x\n---\nWrite.\n')
    // an empty profile is not a saved one
    fs.writeFileSync(path.join(t.base, 'team', 'skills/company-profile.json'), JSON.stringify({ version: 1, website: '', oneLine: '', products: '', audience: '', tone: [], avoid: '', sources: [] }))
    const w = t.db()
    const turn = (id: string, user: string, status = 'done') => w.query("INSERT INTO turns (id, chat_id, user_id, engine, status, started_at) VALUES (?, 'c', ?, 'claude-code', ?, ?)").run(id, user, status, new Date(Date.parse(start) + 3600_000).toISOString())
    turn('t1', 'olga'); turn('t2', 'mina'); turn('t3', 'jun', 'error'); turn('t4', 'jun')
    w.query("INSERT INTO turn_skill_runs (turn_id, skill_path, skill_name, source) VALUES ('t1', ?, 'ad-copy', 'command'), ('t2', ?, 'ad-copy', 'tool'), ('t3', ?, 'ad-copy', 'command')").run(path1, path1, path1)
    w.close()
    const s = JSON.parse(t.run('cloud-status').out)
    expect(s.onboarding).toEqual({ day: 2, packInstalled: true, profileSaved: false, inviteMade: true, membersJoined: 2, peopleAnswered: 3, membersWithFirstRun: 2, bestSkillRunners: 2, goalReached: false })
    expect(TenantStatus.safeParse({ ...rootPart, ...s }).success).toBe(true)
    for (const word of ['Olga', 'Mina', 'olga', 'ad-copy', 'marketing', '광고']) expect(JSON.stringify(s)).not.toContain(word)

    // a saved profile, and jun's successful run: three people, the goal
    fs.writeFileSync(path.join(t.base, 'team', 'skills/company-profile.json'), JSON.stringify({ version: 1, website: 'https://acme.example', oneLine: 'Acme makes things', products: '', audience: '', tone: [], avoid: '', sources: [] }))
    const w2 = t.db()
    w2.query("INSERT INTO turn_skill_runs (turn_id, skill_path, skill_name, source) VALUES ('t4', ?, 'ad-copy', 'command')").run(path1)
    w2.close()
    expect(JSON.parse(t.run('cloud-status').out).onboarding).toMatchObject({ profileSaved: true, membersWithFirstRun: 3, bestSkillRunners: 3, goalReached: true })
  })
})

describe('admin.js reset-link', () => {
  test('the owner by default, a member by username, at publicOrigins[0]; refused without a public address or account', () => {
    const t = install('reset', { publicOrigins: ['https://acme.treesoop.com'] })
    expect(t.run('reset-link').code).toBe(1) // no owner yet
    const db = t.db()
    db.query("INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga', 'owner'), ('kim', 'kim.lee', 'Kim', 'member')").run()
    db.close()
    const o = t.run('reset-link')
    expect(o.code).toBe(0)
    const r = JSON.parse(o.out)
    expect(r.url).toMatch(/^https:\/\/acme\.treesoop\.com\/reset-password\/[A-Za-z0-9_-]+$/)
    expect(Date.parse(r.expiresAt)).toBeGreaterThan(Date.now())
    expect(JSON.parse(t.run('reset-link', '--username', 'kim.lee').out).url).not.toBe(r.url)
    expect(t.run('reset-link', '--username', 'nobody').code).toBe(1)
    const db2 = t.db()
    const n = (db2.query("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = 'kim' AND created_by IS NULL").get() as { n: number }).n
    db2.close()
    expect(n).toBe(1)
    expect(install('reset2').run('reset-link').code).toBe(1) // no publicOrigins
  })
})

describe('admin.js credentials-escrow-out', () => {
  test('absent without a key; version 1 = the key line; after a rekey the line names its file', async () => {
    const t = install('escrow')
    const id = await newAgeIdentity()
    expect(JSON.parse(t.run('credentials-escrow-out', '--recipient', id.recipient).out)).toEqual({ absent: true })
    expect(t.run('credentials-escrow-out', '--recipient', 'age1nope').code).toBe(1)
    const secrets = path.join(t.base, 'secrets')
    fs.mkdirSync(secrets, { recursive: true, mode: 0o700 })
    const k1 = Buffer.alloc(32, 1).toString('base64')
    fs.writeFileSync(path.join(secrets, 'credentials.key'), k1 + '\n', { mode: 0o600 })
    const e1 = JSON.parse(t.run('credentials-escrow-out', '--recipient', id.recipient).out)
    expect(e1.keyVersion).toBe(1)
    expect(e1.keyAge).toStartWith('-----BEGIN AGE ENCRYPTED FILE-----')
    expect(Buffer.from(await ageUnarmorWith(e1.keyAge, [id.identity])).toString().trim()).toBe(k1)
    const k3 = Buffer.alloc(32, 3).toString('base64')
    fs.writeFileSync(path.join(secrets, 'credentials.key.3'), k3 + '\n', { mode: 0o600 })
    const e3 = JSON.parse(t.run('credentials-escrow-out', '--recipient', id.recipient).out)
    expect(e3.keyVersion).toBe(3)
    expect(Buffer.from(await ageUnarmorWith(e3.keyAge, [id.identity])).toString().trim()).toBe(`credentials.key.3 ${k3}`)
  })
})
