// 팀장 넘기기 (docs/DECISIONS.md "W6"; server/src/admin/handover.ts, admin/users.ts transferOwnership): the race that
// made two owners, the lead flag (owner only on the server, a member in the team group for 3 days, one open, cleared by
// a transfer), a forwarded link, the card and its ✕, the confirm's own connections ended after the commit, the
// password limit and its lockout notice, 409s, the notices to both people and the other admins, the realtime role
// refresh, the audit rows, and the hosted gating with its reset-link lock.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LIMITS } from '../../server/src/auth/rate-limit'
import { openDb } from '../../server/src/db'
import { leadPushWanted } from '../../server/src/admin/handover-notices'
import { setupWelcomeTeam } from '../../server/src/onboarding/welcome'
import { WORK } from '../lib/env'
import { OWNER_PW, addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
const PW = 'river stone lamp 7'

type H = { h: Harness; owner: Client }
async function team(name: string, over: Parameters<typeof harness>[1] = {}): Promise<H> {
  const h = await harness(name, over)
  return { h, owner: await withOwner(h) }
}
const roleOf = (h: Harness, id: string) => (h.ctx.db.query('SELECT role FROM users WHERE id = ?').get(id) as { role: string }).role
const owners = (h: Harness) => (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner' AND deleted_at IS NULL").all() as { id: string }[]).map((r) => r.id)
const audits = (h: Harness, action: string) => h.ctx.db.query('SELECT actor_id, target, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { actor_id: string | null; target: string | null; detail: string | null }[]
const inbox = async (c: Client) => (await c.call('GET', '/api/notifications')).items as any[]
const handoverItems = async (c: Client) => (await inbox(c)).filter((i) => i.handover)
async function join(h: Harness, token: string, username: string, name = username.toUpperCase()) {
  const c = h.client()
  const r = await c.call('POST', `/api/invites/${token}/accept`, { username, name, password: PW })
  return { client: c, id: r.me.user.id as string }
}

describe('the transfer race (security review S1)', () => {
  let t: H
  beforeAll(async () => { t = await team('handover-race') })
  afterAll(() => t.h.close())

  test('two transfers at once to different people: one wins, the other is 409, and there is exactly one owner', async () => {
    const a = await addMember(t.h, t.owner, { username: 'ana' })
    const b = await addMember(t.h, t.owner, { username: 'ben' })
    const [r1, r2] = await Promise.all([
      t.owner.try('POST', '/api/admin/transfer-ownership', { userId: a.id, password: OWNER_PW }),
      t.owner.try('POST', '/api/admin/transfer-ownership', { userId: b.id, password: OWNER_PW }),
    ])
    expect([r1.status, r2.status].sort()).toEqual([200, 409])
    const lost = r1.status === 409 ? r1 : r2
    expect(lost.body.error.params.reason).toBe('owner_changed')
    expect(lost.body.error.message).toBe('이미 팀장이 바뀌었어요. 화면을 새로 고쳐 주세요.')
    expect(owners(t.h)).toHaveLength(1)
    expect(roleOf(t.h, 'olga')).toBe('admin')
    expect(audits(t.h, 'owner.transfer')).toHaveLength(1)
    // the winner hands it back (ten at once now: still one owner)
    const winner = r1.status === 200 ? a : b
    const back = await Promise.all(Array.from({ length: 10 }, () => winner.client.try('POST', '/api/admin/transfer-ownership', { userId: 'olga', password: PW })))
    // (the password check holds at most 5 at a time per person: the rest wait, 429)
    expect(back.filter((r) => r.status === 200)).toHaveLength(1)
    expect(back.every((r) => [200, 403, 409, 429].includes(r.status))).toBe(true)
    expect(owners(t.h)).toEqual(['olga'])
  })

  test('targets: not me, active, past the temporary password, signed in once', async () => {
    expect((await t.owner.try('POST', '/api/admin/transfer-ownership', { userId: 'olga', password: OWNER_PW })).status).toBe(403)
    // added with a temporary password, never changed it
    const fresh = await t.owner.call('POST', '/api/admin/users', { username: 'temp.tom', name: 'Tom', role: 'member' })
    const r = await t.owner.try('POST', '/api/admin/transfer-ownership', { userId: fresh.user.id, password: OWNER_PW })
    expect(r.status).toBe(409)
    expect(r.body.error.params.reason).toBe('target_not_ready')
    // never signed in (made directly, e.g. an import)
    t.h.ctx.db.query("INSERT INTO users (id, username, name, role, password_hash) VALUES ('ghost', 'ghost', 'Ghost', 'member', 'x')").run()
    expect((await t.owner.try('POST', '/api/admin/transfer-ownership', { userId: 'ghost', password: OWNER_PW })).body.error.params.reason).toBe('target_not_ready')
    const off = await addMember(t.h, t.owner, { username: 'off.ona' })
    await t.owner.call('PATCH', `/api/admin/users/${off.id}`, { status: 'disabled' })
    expect((await t.owner.try('POST', '/api/admin/transfer-ownership', { userId: off.id, password: OWNER_PW })).status).toBe(409)
    expect(owners(t.h)).toEqual(['olga'])
  })
})

describe('the lead flag', () => {
  let t: H
  let admin: Awaited<ReturnType<typeof addMember>>
  let groupId: string
  beforeAll(async () => {
    t = await team('handover-flag')
    admin = await addMember(t.h, t.owner, { username: 'adam', role: 'admin' })
    groupId = setupWelcomeTeam(t.h.ctx, 'olga', 'ko').progress.teamGroup!.id
  })
  afterAll(() => t.h.close())

  test('only the owner sets it, on the server: an admin and a member are refused', async () => {
    const byAdmin = await admin.client.try('POST', '/api/admin/invites', { leadFor: '김팀장 대표님' })
    expect(byAdmin.status).toBe(403)
    expect(byAdmin.body.error.message).toBe('팀장 링크는 팀장만 만들 수 있어요.')
    const m = await addMember(t.h, t.owner, { username: 'mia' })
    expect((await m.client.try('POST', '/api/admin/invites', { leadFor: 'x' })).status).toBe(403)
    expect(t.h.ctx.db.query('SELECT COUNT(*) n FROM invites WHERE lead_hint = 1').get()).toEqual({ n: 0 })
    // the state is the owner's only
    expect((await admin.client.try('GET', '/api/admin/handover')).status).toBe(403)
  })

  test('a member in the team group for 3 days, whatever the request says; admin with the flag is refused', async () => {
    expect((await t.owner.try('POST', '/api/admin/invites', { leadFor: 'x', role: 'admin' })).status).toBe(400)
    expect((await t.owner.try('POST', '/api/admin/invites', { leadFor: '   ' })).status).toBe(400)
    expect((await t.owner.try('POST', '/api/admin/invites', { leadFor: 'x'.repeat(61) })).status).toBe(400)
    const r = await t.owner.call('POST', '/api/admin/invites', { leadFor: ' 김팀장\u202e 대표님\n', groupIds: [], expiresInHours: 24 * 30 })
    expect(r.invite).toMatchObject({ role: 'member', groupIds: [groupId], leadFor: '김팀장 대표님' })
    expect(Date.parse(r.invite.expiresAt) - Date.parse(r.invite.createdAt)).toBe(72 * 3600_000)
    expect(r.replacedLead).toBe(false)
    const a = audits(t.h, 'invite.create').at(-1)!
    expect(JSON.parse(a.detail!)).toMatchObject({ role: 'member', leadHint: true })
    const s = await t.owner.call('GET', '/api/admin/handover')
    expect(s).toMatchObject({ flag: true, openLead: { inviteId: r.invite.id, leadFor: '김팀장 대표님' }, card: null })
  })

  test('one open lead invite: a new one stops the old link in the same write', async () => {
    const first = await t.owner.call('POST', '/api/admin/invites', { leadFor: '첫 번째' })
    const second = await t.owner.call('POST', '/api/admin/invites', { leadFor: '두 번째' })
    expect(second.replacedLead).toBe(true)
    expect((await t.h.client().try('POST', `/api/invites/${first.token}/accept`, { username: 'late', name: 'Late', password: PW })).status).toBe(410)
    // many at once: still one open
    await Promise.all(Array.from({ length: 6 }, (_, i) => t.owner.call('POST', '/api/admin/invites', { leadFor: `동시 ${i}` })))
    expect(t.h.ctx.db.query('SELECT COUNT(*) n FROM invites WHERE lead_hint = 1 AND used_at IS NULL AND revoked_at IS NULL').get()).toEqual({ n: 1 })
    // the database holds it too
    expect(() => t.h.ctx.db.query("INSERT INTO invites (id, role, token_hash, created_by, created_at, expires_at, lead_hint) VALUES ('dup', 'member', 'h-dup', 'olga', '2026-01-01', '2099-01-01', 1)").run()).toThrow(/UNIQUE/)
  })

  test('it expires after 3 days', async () => {
    const r = await t.owner.call('POST', '/api/admin/invites', { leadFor: '늦게 올 사람' })
    t.h.advance(72 * 3600_000 + 1000)
    try {
      expect((await t.h.client().try('POST', `/api/invites/${r.token}/accept`, { username: 'too.late', name: 'Late', password: PW })).status).toBe(410)
      expect((await t.owner.call('GET', '/api/admin/handover')).openLead).toBeNull()
    } finally { t.h.advance(-(72 * 3600_000 + 1000)) }
  })
})

describe('a join with the lead link: the card, the notice, a forwarded link', () => {
  let t: H
  let admin: Awaited<ReturnType<typeof addMember>>
  beforeAll(async () => {
    t = await team('handover-card')
    admin = await addMember(t.h, t.owner, { username: 'adam', role: 'admin' })
    setupWelcomeTeam(t.h.ctx, 'olga', 'ko')
  })
  afterAll(() => t.h.close())

  test('a forwarded link: whoever joins is a member and nothing moves; the card shows the owner\'s words beside their own account', async () => {
    const inv = await t.owner.call('POST', '/api/admin/invites', { leadFor: '박민준 대표님' })
    const stranger = await join(t.h, inv.token, 'not.minjun', '박민준')
    expect(roleOf(t.h, stranger.id)).toBe('member')
    expect(roleOf(t.h, 'olga')).toBe('owner')
    const me = await stranger.client.call('GET', '/api/me')
    expect(me.user.role).toBe('member')
    // a member cannot take it themselves
    expect((await stranger.client.try('POST', '/api/admin/transfer-ownership', { userId: stranger.id, password: PW })).status).toBe(403)
    const s = await t.owner.call('GET', '/api/admin/handover')
    expect(s.card).toMatchObject({ leadFor: '박민준 대표님', user: { id: stranger.id, name: '박민준', username: 'not.minjun' }, dismissed: false })
    expect(Date.parse(s.card.joinedAt)).toBeGreaterThan(0)
    // the owner's Inbox (also pushed: the delivery source is handover_notices), and a desktop notification in their windows
    const items = await handoverItems(t.owner)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ code: 'owner.lead_joined', handover: { kind: 'lead_joined', leadFor: '박민준 대표님', user: { username: 'not.minjun' }, open: true } })
    expect(leadPushWanted(t.h.ctx.db, items[0].id)).toBe(true)
    expect(t.h.hub.events.some((e) => e.target === 'olga' && (e.data as any)?.data?.code === 'owner_lead_joined')).toBe(true)
    // the admin hears nothing of it
    expect(await handoverItems(admin.client)).toHaveLength(0)
    const acc = audits(t.h, 'invite.accept').at(-1)!
    expect(JSON.parse(acc.detail!)).toMatchObject({ role: 'member', leadHint: true })
  })

  test('✕ hides the card only; the Inbox entry and its [넘기기] stay; an admin cannot dismiss', async () => {
    const s = await t.owner.call('GET', '/api/admin/handover')
    expect((await admin.client.try('POST', '/api/admin/handover/dismiss', { inviteId: s.card.inviteId })).status).toBe(403)
    await t.owner.call('POST', '/api/admin/handover/dismiss', { inviteId: s.card.inviteId })
    expect((await t.owner.call('GET', '/api/admin/handover')).card.dismissed).toBe(true)
    expect((await handoverItems(t.owner))[0].handover.open).toBe(true)
    expect(audits(t.h, 'lead_hint.dismiss')).toHaveLength(1)
  })

  test('the joiner disabled: the card goes and the notice no longer offers [넘기기]', async () => {
    const s = await t.owner.call('GET', '/api/admin/handover')
    await t.owner.call('PATCH', `/api/admin/users/${s.card.user.id}`, { status: 'disabled' })
    expect((await t.owner.call('GET', '/api/admin/handover')).card).toBeNull()
    const n = (await handoverItems(t.owner))[0]
    expect(n.handover.open).toBe(false)
    expect(leadPushWanted(t.h.ctx.db, n.id)).toBe(false)
  })
})

describe('the transfer itself: connections, notices, realtime, audit', () => {
  let t: H
  let admin: Awaited<ReturnType<typeof addMember>>
  let lead: { client: Client; id: string }
  beforeAll(async () => {
    t = await team('handover-transfer')
    admin = await addMember(t.h, t.owner, { username: 'adam', role: 'admin' })
    setupWelcomeTeam(t.h.ctx, 'olga', 'ko')
    const inv = await t.owner.call('POST', '/api/admin/invites', { leadFor: '박민준 대표님' })
    lead = await join(t.h, inv.token, 'minjun.park', '박민준')
    // the owner's own connections: a team Claude sign-in and a team API key (the team's, never listed), a Drive share
    const db = t.h.ctx.db
    const now = new Date().toISOString()
    const cred = db.query("INSERT INTO engine_credentials (id, kind, label, owner_user_id, secret_enc, key_version, fingerprint, meta, created_by, created_at, updated_at) VALUES (?, ?, ?, NULL, 'x', 1, ?, '{}', 'olga', ?, ?)")
    cred.run('cred-claude', 'anthropic-oauth', '지수 Claude', 'fp1', now, now)
    cred.run('cred-key', 'anthropic-api-key', '팀 API 키', 'fp2', now, now)
    cred.run('cred-admin', 'chatgpt', '아담 ChatGPT', 'fp3', now, now)
    db.query("UPDATE engine_credentials SET created_by = 'adam' WHERE id = 'cred-admin'").run()
    db.query("INSERT INTO drive_team_shares (id, name, owner_user_id, config_key, account, scopes, secret_enc, key_version, folders, status, version, expires_at, created_at, updated_at) VALUES ('share-1', '영업 자료', 'olga', 'k', ?, 'drive.readonly', 'sealed', 1, '[]', 'connected', 1, '2099-01-01', ?, ?)")
      .run(JSON.stringify({ name: 'Jisu', email: 'jisu@acme.example' }), now, now)
  })
  afterAll(() => t.h.close())

  test('the confirm lists only the owner\'s own subscriptions and Drive shares, never the team\'s API keys', async () => {
    const s = await t.owner.call('GET', '/api/admin/handover')
    expect(s.connections.map((c: any) => `${c.kind}:${c.id}`).sort()).toEqual(['drive_share:share-1', 'team_ai:cred-claude'])
    expect(s.connections.find((c: any) => c.kind === 'drive_share').account).not.toContain('jisu@')
  })

  test('a wrong password, then the transfer: one owner, connections ended after the commit, everyone told', async () => {
    const wrong = await t.owner.try('POST', '/api/admin/transfer-ownership', { userId: lead.id, password: 'nope', end: [] })
    expect(wrong.status).toBe(403)
    t.h.hub.events = []
    const r = await t.owner.call('POST', '/api/admin/transfer-ownership', { userId: lead.id, password: OWNER_PW, end: [{ kind: 'team_ai', id: 'cred-claude' }, { kind: 'drive_share', id: 'share-1' }, { kind: 'team_ai', id: 'cred-admin' }, { kind: 'team_ai', id: 'cred-key' }] })
    expect(r.ok).toBe(true)
    expect(Object.fromEntries(r.ended.map((e: any) => [e.id, e.result]))).toEqual({ 'cred-claude': 'ended', 'share-1': 'ended', 'cred-admin': 'gone', 'cred-key': 'gone' })
    const db = t.h.ctx.db
    expect(owners(t.h)).toEqual([lead.id])
    expect(roleOf(t.h, 'olga')).toBe('admin')
    expect(db.query("SELECT id FROM engine_credentials ORDER BY id").all()).toEqual([{ id: 'cred-admin' }, { id: 'cred-key' }])
    expect(db.query("SELECT secret_enc, status FROM drive_team_shares WHERE id = 'share-1'").get()).toEqual({ secret_enc: null, status: 'needs_reconnect' })
    // audit: the transfer (via the card, decided on the server), each disconnect
    const tr = JSON.parse(audits(t.h, 'owner.transfer').at(-1)!.detail!)
    expect(tr).toMatchObject({ from: 'olga', to: lead.id, via: 'lead_card', leadHintsCleared: 1 })
    expect(audits(t.h, 'owner.transfer.disconnect').map((a) => [a.target, JSON.parse(a.detail!).result])).toEqual([['cred-claude', 'ended'], ['share-1', 'ended'], ['cred-admin', 'gone'], ['cred-key', 'gone']])
    // every flag is gone: no card for anyone
    expect(db.query('SELECT COUNT(*) n FROM invites WHERE lead_hint = 1').get()).toEqual({ n: 0 })
    // realtime: both people's open windows refresh their role
    const changed = t.h.hub.events.filter((e) => (e.data as any)?.data?.code === 'owner_changed')
    expect(changed.map((e) => e.target).sort()).toEqual(['olga', lead.id].sort())
    expect((changed.find((e) => e.target === 'olga')!.data as any).data.message).toBe('팀장이 바뀌었어요 · 이제 박민준님이 이어서 해요')
    // the notices
    const toNew = (await handoverItems(lead.client)).find((i) => i.code === 'owner.transferred')
    expect(toNew.handover).toMatchObject({ kind: 'transferred', me: 'to', from: { id: 'olga' }, to: { id: lead.id }, removable: true, setupUnfinished: true, recovery: null, ended: { teamAi: 1, driveShares: 1, failed: 0 } })
    const toOld = (await handoverItems(t.owner)).filter((i) => i.code === 'owner.transferred')
    expect(toOld).toHaveLength(1)
    expect(toOld[0].handover).toMatchObject({ me: 'from', removable: false, setupUnfinished: false })
    // the old owner's lead notice is settled
    const leadNotice = (await handoverItems(t.owner)).find((i) => i.code === 'owner.lead_joined')
    expect(leadNotice.readAt).not.toBeNull()
    expect(leadNotice.handover.open).toBe(false)
    const toAdmin = (await handoverItems(admin.client)).find((i) => i.code === 'owner.transferred')
    expect(toAdmin.handover).toMatchObject({ me: 'other', to: { id: lead.id }, removable: false })
  })

  test('the new owner removes the helper with the existing disable; [내보내기] goes once they are not an active admin', async () => {
    expect((await t.owner.try('PATCH', `/api/admin/users/${lead.id}`, { status: 'disabled' })).status).toBe(403) // the old owner cannot act on the owner
    await lead.client.call('PATCH', '/api/admin/users/olga', { status: 'disabled' })
    const n = (await handoverItems(lead.client)).find((i) => i.code === 'owner.transferred')
    expect(n.handover.removable).toBe(false)
    expect((await t.owner.try('GET', '/api/me')).status).toBe(401)
  })
})

describe('the password limit and its lockout notice', () => {
  let t: H
  beforeAll(async () => { t = await team('handover-reauth') })
  afterAll(() => t.h.close())

  test('5 wrong tries in 15 minutes lock the check, and the owner gets one Inbox note', async () => {
    const m = await addMember(t.h, t.owner, { username: 'mo' })
    const rs = []
    for (let i = 0; i < DEFAULT_LIMITS.perReauth + 2; i++) rs.push((await t.owner.try('POST', '/api/admin/transfer-ownership', { userId: m.id, password: 'wrong ' + i })).status)
    expect(rs).toEqual([403, 403, 403, 403, 403, 429, 429])
    const right = await t.owner.try('POST', '/api/admin/transfer-ownership', { userId: m.id, password: OWNER_PW })
    expect(right.status).toBe(429)
    const locked = (await handoverItems(t.owner)).filter((i) => i.code === 'owner.reauth_locked')
    expect(locked).toHaveLength(1)
    expect(locked[0].handover).toEqual({ kind: 'reauth_locked' })
    expect(audits(t.h, 'auth.reauth_failed')).toHaveLength(DEFAULT_LIMITS.perReauth)
    expect(owners(t.h)).toEqual(['olga'])
    t.h.advance(15 * 60_000 + 1000)
    try { expect((await t.owner.call('POST', '/api/admin/transfer-ownership', { userId: m.id, password: OWNER_PW })).ok).toBe(true) }
    finally { t.h.advance(-(15 * 60_000 + 1000)) }
  })
})

describe('a hosted team', () => {
  test('without handoverSafe: no flag and no card, only the menu transfer, and both people hear who can still reset', async () => {
    const t = await team('handover-hosted', { deployment: 'hosted' })
    try {
      const s = await t.owner.call('GET', '/api/admin/handover')
      expect(s).toMatchObject({ flag: false, recovery: 'hosted', openLead: null, card: null })
      const r = await t.owner.try('POST', '/api/admin/invites', { leadFor: '김팀장' })
      expect(r.status).toBe(409)
      expect(r.body.error.params.reason).toBe('lead_not_offered')
      const m = await addMember(t.h, t.owner, { username: 'mina' })
      await t.owner.call('POST', '/api/admin/transfer-ownership', { userId: m.id, password: OWNER_PW })
      expect((await handoverItems(m.client)).find((i) => i.code === 'owner.transferred').handover.recovery).toBe('hosted')
      expect((await handoverItems(t.owner)).find((i) => i.code === 'owner.transferred').handover.recovery).toBe('hosted')
      expect(t.h.ctx.db.query("SELECT 1 FROM settings WHERE key = 'handover.recoveryLock'").get()).toBeNull()
    } finally { await t.h.close() }
  })

  test('with handoverSafe: the flag is offered, and a transfer sets the recovery lock', async () => {
    const t = await team('handover-hosted-safe', { deployment: 'hosted', handoverSafe: true })
    try {
      const s = await t.owner.call('GET', '/api/admin/handover')
      expect(s).toMatchObject({ flag: true, recovery: null })
      const m = await addMember(t.h, t.owner, { username: 'mina' })
      await t.owner.call('POST', '/api/admin/transfer-ownership', { userId: m.id, password: OWNER_PW })
      expect(t.h.ctx.db.query("SELECT 1 AS x FROM settings WHERE key = 'handover.recoveryLock'").get()).toEqual({ x: 1 })
      expect(JSON.parse(audits(t.h, 'owner.transfer').at(-1)!.detail!).recoveryLocked).toBe(true)
    } finally { await t.h.close() }
  })

  test('the tenant\'s reset-link refuses owners and admins in both forms while the lock is set; members stay reachable', () => {
    const base = path.join(WORK, `handover-cli-${process.pid}`)
    fs.rmSync(base, { recursive: true, force: true })
    fs.mkdirSync(path.join(base, 'team'), { recursive: true })
    fs.mkdirSync(path.join(base, 'data'), { recursive: true })
    const cfgFile = path.join(base, 'server.json')
    fs.writeFileSync(cfgFile, JSON.stringify({ mode: 'dev', dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team'), publicOrigins: ['https://acme.example.com'] }))
    const db = openDb(path.join(base, 'data', 'app.db'))
    db.query("INSERT INTO users (id, username, name, role) VALUES ('mina', 'mina', 'Mina', 'owner'), ('olga', 'olga', 'Olga', 'admin'), ('kim', 'kim', 'Kim', 'member')").run()
    db.query("INSERT INTO settings (key, value) VALUES ('handover.recoveryLock', ?)").run(JSON.stringify({ since: new Date().toISOString(), transferId: 't1' }))
    db.close()
    const run = (...args: string[]) => {
      const p = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, '../../server/src/system/cli.ts'), ...args], { env: { ...process.env, MYCEL_CONFIG: cfgFile, MYCEL_MODE: 'dev' } })
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
    }
    const owner = run('reset-link')
    expect(owner.code).toBe(3)
    expect(owner.err).toContain('owner_recovery_locked')
    expect(run('reset-link', '--username', 'mina').code).toBe(3)
    expect(run('reset-link', '--username', 'olga').code).toBe(3)
    expect(run('reset-link', '--username', 'kim').code).toBe(0)
    const claimed = run('owner-recovery-claimed')
    expect(JSON.parse(claimed.out)).toEqual({ ok: true, cleared: true })
    expect(run('reset-link').code).toBe(0)
    const db2 = openDb(path.join(base, 'data', 'app.db'))
    try {
      expect(db2.query("SELECT COUNT(*) n FROM password_resets WHERE created_by IS NULL").get()).toEqual({ n: 2 })
      expect(db2.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'owner.recovery_claimed'").get()).toEqual({ n: 1 })
    } finally { db2.close() }
  })
})

describe('the lead join is pushed to the owner\'s devices, only while the card holds', () => {
  test('a Web Push with the event code only; none once the joiner is disabled', async () => {
    const crypto = await import('node:crypto')
    const { PushService } = await import('../../server/src/notifications/push-service')
    const t = await team('handover-push')
    const sent: any[] = []
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys()
    const p = new PushService(t.h.ctx, { config: () => ({ enabled: true, subject: 'mailto:push@example.test', publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') }), transport: async (i) => { sent.push(i.payload); return { statusCode: 201 } } })
    try {
      const sid = (t.h.ctx.db.query("SELECT id FROM sessions WHERE user_id = 'olga'").get() as { id: string }).id
      const k = crypto.createECDH('prime256v1'); k.generateKeys()
      p.subscribe('olga', sid, { consent: true, endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-owner', keys: { p256dh: k.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } })
      await Bun.sleep(5)
      const inv = await t.owner.call('POST', '/api/admin/invites', { leadFor: '박민준 대표님' })
      const j = await join(t.h, inv.token, 'minjun')
      await p.tick()
      expect(sent).toHaveLength(1)
      expect(sent[0].code).toBe('owner.lead_joined')
      expect(Object.keys(sent[0]).sort()).toEqual(['code', 'notificationId', 'subscriptionId'])
      // a second lead join after the joiner is disabled: no push (the card does not hold)
      const inv2 = await t.owner.call('POST', '/api/admin/invites', { leadFor: '다른 사람' })
      const j2 = await join(t.h, inv2.token, 'other.one')
      await t.owner.call('PATCH', `/api/admin/users/${j2.id}`, { status: 'disabled' })
      await p.tick()
      expect(sent).toHaveLength(1)
      expect(j.id).not.toBe(j2.id)
    } finally { await p.stop(); await t.h.close() }
  })
})
