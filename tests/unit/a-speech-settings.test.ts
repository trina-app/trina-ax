// Voice input settings (docs/DECISIONS.md "Voice input through OpenRouter"): the speech provider is 'off' by default
// and Me.team.voiceInput says so; the team's OpenRouter key arrives sealed in the browser, asks for the password again
// (owner and admins), is stored encrypted, never comes back (only set + last 4) and is never in an audit entry or a log
// line; credentials-rekey keeps it readable.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { SealingKey } from '@mycel/shared/api'
import { createLogger } from '../../server/src/log'
import { credentialsOf } from '../../server/src/credentials/store'
import { readSpeechKey, SPEECH_KEY_SETTING } from '../../server/src/credentials/speech-key'
import { rekeyCredentials } from '../../server/src/credentials/rekey'
import { sealSecret } from '../../web/src/lib/seal'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'

const KEY = 'sk-or-v1-SPEECH-CANARY-' + 'f'.repeat(40) + 'WXYZ'
const KEY2 = 'sk-or-v1-SPEECH-CANARY-TWO-' + 'e'.repeat(40) + 'ABCD'
const lines: string[] = []
let h: Harness
let owner: Client
let admin: { client: Client; password: string }
let member: { client: Client; password: string }
let seal: SealingKey
beforeAll(async () => {
  h = await harness('speech', {}, { log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) })
  owner = await withOwner(h)
  admin = await addMember(h, owner, { username: 'adam', role: 'admin' })
  member = await addMember(h, owner, { username: 'mia', role: 'member' })
  seal = await owner.call('GET', '/api/credentials/sealing-key')
})
afterAll(async () => { await h?.close() })

describe('speech provider setting', () => {
  test("default 'off' with the default model; voice input is off for everyone", async () => {
    const s = await owner.call('GET', '/api/admin/settings')
    expect(s.speechProvider).toBe('off')
    expect(s.speechModel).toBe('openai/whisper-large-v3-turbo')
    expect((await owner.call('GET', '/api/me')).team.voiceInput).toBe(false)
    expect((await member.client.call('GET', '/api/me')).team.voiceInput).toBe(false)
    expect(await owner.call('GET', '/api/admin/speech-key')).toEqual({ set: false, hint: null, updatedAt: null })
  })
  test("an admin picks 'local': audited as settings.update, everyone is told, voice input on", async () => {
    h.hub.events.length = 0
    const s = await admin.client.call('PATCH', '/api/admin/settings', { speechProvider: 'local' })
    expect(s.speechProvider).toBe('local')
    expect((await member.client.call('GET', '/api/me')).team.voiceInput).toBe(true)
    expect(h.hub.events.some((e) => (e.data as any)?.data?.code === 'speech_changed')).toBe(true)
    const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'settings.update' ORDER BY rowid DESC LIMIT 1").get() as { detail: string }
    expect(JSON.parse(audit.detail)).toEqual({ speechProvider: 'local' })
  })
  test('a member cannot change it; a bad provider or model id is refused', async () => {
    expect((await member.client.try('PATCH', '/api/admin/settings', { speechProvider: 'openrouter' })).status).toBe(403)
    expect((await owner.try('PATCH', '/api/admin/settings', { speechProvider: 'google' })).status).toBe(400)
    expect((await owner.try('PATCH', '/api/admin/settings', { speechModel: 'https://evil.example/x' })).status).toBe(400)
  })
  test("'openrouter' without a key: voice input stays off", async () => {
    await owner.call('PATCH', '/api/admin/settings', { speechProvider: 'openrouter' })
    expect((await member.client.call('GET', '/api/me')).team.voiceInput).toBe(false)
  })
})

describe('the OpenRouter key', () => {
  test('members 403; a wrong password 403; a value sealed for another request 400', async () => {
    expect((await member.client.try('PUT', '/api/admin/speech-key', { sealed: await sealSecret(seal, KEY, 'speech.key'), password: member.password })).status).toBe(403)
    expect((await member.client.try('GET', '/api/admin/speech-key')).status).toBe(403)
    expect((await owner.try('PUT', '/api/admin/speech-key', { sealed: await sealSecret(seal, KEY, 'speech.key'), password: 'wrong' })).status).toBe(403)
    expect((await owner.try('PUT', '/api/admin/speech-key', { sealed: await sealSecret(seal, KEY, 'credential.create'), password: OWNER_PW })).status).toBe(400)
    expect((await owner.try('PUT', '/api/admin/speech-key', { key: KEY, password: OWNER_PW })).status).toBe(400)
    expect((await owner.call('GET', '/api/admin/speech-key')).set).toBe(false)
  })
  test('the owner sets it (password again): only set + last 4 come back; stored encrypted; voice input on', async () => {
    h.hub.events.length = 0
    const r = await owner.call('PUT', '/api/admin/speech-key', { sealed: await sealSecret(seal, KEY, 'speech.key'), password: OWNER_PW })
    expect(r.set).toBe(true)
    expect(r.hint).toBe('WXYZ')
    expect(JSON.stringify(r)).not.toContain(KEY)
    expect((await member.client.call('GET', '/api/me')).team.voiceInput).toBe(true)
    expect(h.hub.events.some((e) => (e.data as any)?.data?.code === 'speech_changed')).toBe(true)
    const raw = (h.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(SPEECH_KEY_SETTING) as { value: string }).value
    expect(raw).not.toContain(KEY)
    expect(raw).not.toContain('SPEECH-CANARY')
    expect(readSpeechKey(credentialsOf(h.ctx))).toBe(KEY)
  })
  test('an admin replaces it with their own password', async () => {
    const r = await admin.client.call('PUT', '/api/admin/speech-key', { sealed: await sealSecret(seal, KEY2, 'speech.key'), password: admin.password })
    expect(r.hint).toBe('ABCD')
    expect(readSpeechKey(credentialsOf(h.ctx))).toBe(KEY2)
  })
  test('credentials-rekey encrypts it again and it still opens', () => {
    const cc = credentialsOf(h.ctx)
    const before = (h.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(SPEECH_KEY_SETTING) as { value: string }).value
    rekeyCredentials(cc)
    const after = (h.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(SPEECH_KEY_SETTING) as { value: string }).value
    expect(JSON.parse(after).keyVersion).toBeGreaterThan(JSON.parse(before).keyVersion)
    expect(readSpeechKey(cc)).toBe(KEY2)
  })
  test('remove (null, password again): voice input off again', async () => {
    const r = await owner.call('PUT', '/api/admin/speech-key', { sealed: null, password: OWNER_PW })
    expect(r).toEqual({ set: false, hint: null, updatedAt: null })
    expect(readSpeechKey(credentialsOf(h.ctx))).toBeNull()
    expect((await member.client.call('GET', '/api/me')).team.voiceInput).toBe(false)
  })
  test('the key is in no response, audit entry or log line', async () => {
    const dump = JSON.stringify(await owner.call('GET', '/api/admin/settings')) + JSON.stringify(await owner.call('GET', '/api/admin/speech-key'))
      + JSON.stringify(await owner.call('GET', '/api/me')) + JSON.stringify(h.ctx.db.query('SELECT action, target, detail FROM audit_log').all())
      + JSON.stringify(await owner.call('GET', '/api/admin/audit?limit=200')) + lines.join('\n')
    for (const k of [KEY, KEY2, 'SPEECH-CANARY']) expect(dump).not.toContain(k)
    const details = (h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'speech.key' ORDER BY rowid").all() as { detail: string }[]).map((r) => JSON.parse(r.detail))
    expect(details).toEqual([{ key: 'set', hint: 'WXYZ' }, { key: 'set', hint: 'ABCD' }, { key: 'removed' }])
  })
})
