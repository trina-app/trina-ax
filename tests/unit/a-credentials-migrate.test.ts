// Moving the older credentials into AI connections (docs/DECISIONS.md "AI 연결" 3.16): the owner's token file
// (claude-oauth-token, also the office's config/ copy), a token the upstream had refused, a new token in the file
// later, company keys of engine_accounts, the engine account's own Codex login through the launcher's codex-export
// (a fake launcher here), idempotent runs, an older launcher that does not know the request.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { fakeJwt, testCredCtx } from '../lib/credentials'
import { FILE_TOKEN_KEY, importCodexAuth, importEngineAccounts, importTokenFile, migrateCredentials, MIGRATED_KEY } from '../../server/src/credentials/migrate'
import { getRow, listRows, metaOf, secretOf, stateOf } from '../../server/src/credentials/store'
import { markTokenRejected, tokenFile } from '../../server/src/proxy/subscription'
import { getSetting } from '../../server/src/admin/settings'

const env = makeEnv('a-cred-migrate')
const secrets = path.join(env.fx.base, 'secrets')
const t = testCredCtx(env.db, secrets)
const TOK = 'sk-ant-oat01-' + 'F'.repeat(50)

describe('the owner\'s token file', () => {
  test('imported once as "Claude subscription" (issued = the file time, one year), the file stays; running again changes nothing', () => {
    fs.mkdirSync(secrets, { recursive: true, mode: 0o700 })
    fs.writeFileSync(tokenFile(secrets), TOK + '\n', { mode: 0o600 })
    const mtime = new Date(Date.now() - 30 * 86400_000)
    fs.utimesSync(tokenFile(secrets), mtime, mtime)
    expect(importTokenFile(t.cc, secrets)).toBe('imported')
    const rows = listRows(env.db)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ kind: 'anthropic-oauth', status: 'ok', priority: 100 })
    expect(stateOf(env.db, rows[0]!, new Date(), t.cc.allowedKinds)).toBe('sharing_off') // importing is not consent to share
    expect(Math.abs(Date.parse(rows[0]!.expires_at!) - (mtime.getTime() + 365 * 86400_000))).toBeLessThan(2000)
    expect(secretOf(t.cc, rows[0] as never)).toEqual({ token: TOK })
    expect(fs.existsSync(tokenFile(secrets))).toBe(true)
    expect(importTokenFile(t.cc, secrets)).toBe('same')
    expect(listRows(env.db).length).toBe(1)
    expect((env.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'credential.migrated'").get() as { n: number }).n).toBe(1)
  })
  test('a new token in the file replaces the imported connection\'s secret; a token the upstream refused comes in as refused', () => {
    const id = (getSetting<{ id: string }>(env.db, FILE_TOKEN_KEY))!.id
    const NEW = 'sk-ant-oat01-' + 'G'.repeat(50)
    markTokenRejected(env.db, NEW)
    fs.writeFileSync(tokenFile(secrets), NEW + '\n', { mode: 0o600 })
    expect(importTokenFile(t.cc, secrets)).toBe('updated')
    expect(listRows(env.db).length).toBe(1)
    expect(getRow(env.db, id)!.status).toBe('invalid')
    t.cc.cache.clear()
    expect(secretOf(t.cc, getRow(env.db, id)! as never)).toEqual({ token: NEW })
  })
  test('the owner removed the imported connection: the same file does not bring it back', () => {
    env.db.query('DELETE FROM engine_credentials').run()
    expect(importTokenFile(t.cc, secrets)).toBe('same')
    expect(listRows(env.db)).toEqual([])
  })
})

describe('company keys (engine_accounts + <data>/secrets/<id>.key)', () => {
  test('API key connections with the same id and hint, after the subscription (priority 200); idempotent', () => {
    const dir = path.join(env.fx.data, 'secrets'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const key = 'sk-ant-api03-' + 'C'.repeat(40) + 'WXYZ'
    fs.writeFileSync(path.join(dir, 'acct1.key'), key, { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'acct2.key'), 'sk-' + 'o'.repeat(40), { mode: 0o600 })
    env.db.query("INSERT INTO engine_accounts (id, engine, secret_ref, label, status, hint) VALUES ('01900000-0000-7000-8000-000000000001', 'anthropic', 'acct1.key', 'main', 'ok', 'WXYZ'), ('01900000-0000-7000-8000-000000000002', 'openai', 'acct2.key', NULL, 'invalid', 'oooo'), ('x3', 'anthropic', '../../etc/passwd', 'evil', 'ok', NULL)").run()
    expect(importEngineAccounts(t.cc, env.fx.data).sort()).toEqual(['01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002'])
    const a = getRow(env.db, '01900000-0000-7000-8000-000000000001')!
    expect(a).toMatchObject({ kind: 'anthropic-api-key', label: 'main', priority: 200, hint: 'WXYZ', status: 'ok' })
    expect(getRow(env.db, '01900000-0000-7000-8000-000000000002')).toMatchObject({ kind: 'openai-api-key', status: 'invalid' })
    expect(importEngineAccounts(t.cc, env.fx.data)).toEqual([])
  })
})

/** a launcher socket that answers codex-export / codex-logout like the real one (or not at all: an older launcher) */
function fakeLauncher(sock: string, o: { auth: string | null; known: boolean }) {
  const ops: string[] = []
  const srv = net.createServer((c) => {
    c.on('data', (d) => {
      const req = JSON.parse(d.toString().split('\n')[0]!)
      ops.push(req.op)
      if (!o.known) { c.end(JSON.stringify({ ev: 'error', message: 'bad request' }) + '\n'); return }
      if (req.op === 'codex-export') c.end(JSON.stringify(o.auth === null ? { ev: 'codex_export', none: true } : { ev: 'codex_export', b64: Buffer.from(o.auth).toString('base64') }) + '\n')
      else if (req.op === 'codex-logout') c.end(JSON.stringify({ ev: 'logout_done', ok: true }) + '\n')
    })
  })
  return { srv: srv.listen(sock), ops }
}

describe('the engine account\'s Codex login', () => {
  const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: fakeJwt({ email: 'e@x.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-old', chatgpt_plan_type: 'team' } }), access_token: 'at-old', refresh_token: 'rt-old', account_id: 'acc-old' }, last_refresh: '2026-10-01T00:00:00Z' })
  test('exported once, stored as "ChatGPT (existing)", then the old login is removed; recorded so it never runs again', async () => {
    const R = fs.mkdtempSync('/tmp/mycel-mg-')
    const f = fakeLauncher(path.join(R, 'l.sock'), { auth, known: true })
    try {
      const m = await migrateCredentials(t.cc, { secretsDir: secrets, dataDir: env.fx.data, launcherSock: path.join(R, 'l.sock') })
      expect(m.codexAuth).toBe('done')
      expect(f.ops).toEqual(['codex-export', 'codex-logout'])
      const row = listRows(env.db).find((r) => r.kind === 'chatgpt')!
      expect(metaOf(row)).toMatchObject({ planType: 'team', from: 'codex-auth' })
      expect(stateOf(env.db, row, new Date(), t.cc.allowedKinds)).toBe('sharing_off')
      expect(secretOf(t.cc, row as never)).toMatchObject({ refreshToken: 'rt-old', accountId: 'acc-old' })
      f.ops.length = 0
      await migrateCredentials(t.cc, { secretsDir: secrets, dataDir: env.fx.data, launcherSock: path.join(R, 'l.sock') })
      expect(f.ops).toEqual([])
      expect(getSetting<{ codexAuth: string }>(env.db, MIGRATED_KEY)!.codexAuth).toBe('done')
    } finally { f.srv.close(); fs.rmSync(R, { recursive: true, force: true }) }
  })
  test('an older launcher (does not know codex-export): pending, nothing removed; no login there: none', async () => {
    const R = fs.mkdtempSync('/tmp/mycel-mg-')
    const old = fakeLauncher(path.join(R, 'l.sock'), { auth, known: false })
    try {
      expect(await importCodexAuth(t.cc, path.join(R, 'l.sock'))).toBe('pending')
      expect(old.ops).toEqual(['codex-export'])
    } finally { old.srv.close() }
    const none = fakeLauncher(path.join(R, 'n.sock'), { auth: null, known: true })
    try { expect(await importCodexAuth(t.cc, path.join(R, 'n.sock'))).toBe('none') } finally { none.srv.close(); fs.rmSync(R, { recursive: true, force: true }) }
  })
})
