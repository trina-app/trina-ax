// A new token or key on an AI connection drops the provider limit it was waiting out (QA 2026-11-25: the owner put a
// new Claude token in the token file after the old one hit its weekly limit). The limit belongs to the old secret's
// account, so the next turn must try the new one. The same token written again keeps the limit (same account).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { testCredCtx } from '../lib/credentials'
import { FILE_TOKEN_KEY } from '../../server/src/credentials/migrate'
import { tokenFileTick } from '../../server/src/credentials/maintenance'
import { resolveCredential } from '../../server/src/credentials/resolve'
import { replaceSecret } from '../../server/src/credentials/service'
import { getRow, unusable } from '../../server/src/credentials/store'
import { SHARED_SUBSCRIPTIONS_KEY } from '../../server/src/credentials/policy'
import { getSetting, setSetting } from '../../server/src/admin/settings'
import { tokenFile } from '../../server/src/proxy/subscription'

const env = makeEnv('a-cred-new-secret-limit')
const secrets = path.join(env.fx.base, 'secrets')
const t = testCredCtx(env.db, secrets, { upstreams: { anthropic: 'http://127.0.0.1:9' }, fetch: (async () => Response.json({ input_tokens: 1 })) as unknown as typeof fetch })
setSetting(env.db, SHARED_SUBSCRIPTIONS_KEY, true)
const TOK = (c: string) => 'sk-ant-oat01-' + c.repeat(50)
const until = () => new Date(Date.now() + 36 * 3600_000).toISOString()
/** what the proxy writes for a long 429 (credentials/broker.ts onLongLimit) */
const limit = (id: string) => env.db.query("UPDATE engine_credentials SET limited_until = ?, status_code = 'rate_limited' WHERE id = ?").run(until(), id)
const why = (id: string) => unusable(env.db, getRow(env.db, id)!, new Date(), t.cc.allowedKinds)?.why ?? null
const resolve = () => resolveCredential(env.db, { userId: 'alice', engine: 'claude-code', allowedKinds: t.cc.allowedKinds })

describe('the token file', () => {
  test('a new token in the file: the old token\'s limit goes and the next turn uses the connection', () => {
    fs.writeFileSync(tokenFile(secrets), TOK('A') + '\n', { mode: 0o600 })
    expect(tokenFileTick(t.cc, secrets)).toBe('imported')
    const id = getSetting<{ id: string }>(env.db, FILE_TOKEN_KEY)!.id
    limit(id)
    expect(why(id)).toBe('limited')
    expect(resolve()).toMatchObject({ ok: false, reason: 'all_unusable' })

    fs.writeFileSync(tokenFile(secrets), TOK('B') + '\n', { mode: 0o600 })
    expect(tokenFileTick(t.cc, secrets)).toBe('updated')
    expect(getRow(env.db, id)).toMatchObject({ limited_until: null, status_code: null, status: 'ok' })
    expect(why(id)).toBeNull()
    expect(resolve()).toMatchObject({ ok: true, credentialId: id })
  })

  test('the same token written again (a touch, a copy over itself): the limit stays, it is the same account', () => {
    const id = getSetting<{ id: string }>(env.db, FILE_TOKEN_KEY)!.id
    limit(id)
    fs.writeFileSync(tokenFile(secrets), TOK('B') + '\n', { mode: 0o600 })
    const later = new Date(Date.now() + 5_000)
    fs.utimesSync(tokenFile(secrets), later, later)
    expect(tokenFileTick(t.cc, secrets)).toBe('same')
    expect(why(id)).toBe('limited')
  })
})

describe('Admin › AI providers: a new token on the connection', () => {
  test('the limit goes with the old token', async () => {
    const id = getSetting<{ id: string }>(env.db, FILE_TOKEN_KEY)!.id
    expect(why(id)).toBe('limited')
    await replaceSecret(t.cc, id, TOK('C'), 'dana', 'en')
    expect(getRow(env.db, id)).toMatchObject({ limited_until: null, status_code: null, status: 'ok' })
    expect(resolve()).toMatchObject({ ok: true, credentialId: id })
  })
})
