// Voice input settings (docs/DECISIONS.md "Voice input through OpenRouter"): the speech provider is 'off' by default
// and Me.team.voiceInput says so; the team's OpenRouter key arrives sealed in the browser, asks for the password again
// (owner and admins), is stored encrypted, never comes back (only set + last 4) and is never in an audit entry or a log
// line; credentials-rekey keeps it readable. With no provider chosen, a saved team key turns voice input on (OpenRouter)
// and removing it turns it off; 'local' without whisper-cli or ffmpeg keeps the mic hidden and says which is missing
// (docs/DECISIONS.md "Voice input on a team's own server: the key turns it on"). The tools are set here
// (ctx.files.speech), so the tests do not depend on what the machine has installed.
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
    expect(await owner.call('GET', '/api/admin/speech-key')).toEqual({ set: false, hint: null, updatedAt: null, hosted: null })
  })
  test("an admin picks 'local': audited as settings.update, everyone is told, voice input on", async () => {
    // this server has whisper-cli and ffmpeg (the CI runner has neither)
    Object.assign(h.ctx.files.speech, { whisperBin: '/usr/bin/true', ffmpegBin: '/usr/bin/true' })
    h.hub.events.length = 0
    const s = await admin.client.call('PATCH', '/api/admin/settings', { speechProvider: 'local' })
    expect(s.speechProvider).toBe('local')
    expect((await member.client.call('GET', '/api/me')).team.voiceInput).toBe(true)
    // on this server nothing goes out: a confidential chat's composer keeps the mic
    expect((await member.client.call('GET', '/api/me')).team.voiceInputOutside).toBeUndefined()
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
    expect((await member.client.call('GET', '/api/me')).team.voiceInputOutside).toBeUndefined()
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
    // voice input now goes to OpenRouter: a confidential chat's composer says it is not used there
    expect((await member.client.call('GET', '/api/me')).team.voiceInputOutside).toBe(true)
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
    expect(r).toEqual({ set: false, hint: null, updatedAt: null, hosted: null })
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

describe('not chosen: the team key turns voice input on', () => {
  const stored = () => h.ctx.db.query("SELECT value FROM settings WHERE key = 'speechProvider'").get()
  const voice = async () => (await member.client.call('GET', '/api/me')).team as { voiceInput: boolean; voiceInputOutside?: true }
  const putKey = async (k: string | null) => owner.call('PUT', '/api/admin/speech-key', { sealed: k === null ? null : await sealSecret(seal, k, 'speech.key'), password: OWNER_PW })

  test('no choice and no key: off, the mic hidden', async () => {
    h.ctx.db.query("DELETE FROM settings WHERE key = 'speechProvider'").run()
    expect((await owner.call('GET', '/api/admin/speech-key')).set).toBe(false)
    expect((await owner.call('GET', '/api/admin/settings')).speechProvider).toBe('off')
    expect((await voice()).voiceInput).toBe(false)
  })
  test('the key saved: OpenRouter, voice input on, nothing stored for the provider', async () => {
    h.hub.events.length = 0
    await putKey(KEY)
    expect((await owner.call('GET', '/api/admin/settings')).speechProvider).toBe('openrouter')
    expect(await voice()).toMatchObject({ voiceInput: true, voiceInputOutside: true })
    expect(h.hub.events.some((e) => (e.data as any)?.data?.code === 'speech_changed')).toBe(true)
    expect(stored()).toBeNull()
    // saving another setting does not store it either; "Turn video sound into text" keeps its rule (off with the team's key)
    const s = await owner.call('PATCH', '/api/admin/settings', { auditRetentionDays: 120 })
    expect(s.speechProvider).toBe('openrouter')
    expect(s.aiMediaTranscripts).toBeNull()
    expect(stored()).toBeNull()
  })
  test("an admin's 'off' wins over the key; without the choice the key counts again", async () => {
    await admin.client.call('PATCH', '/api/admin/settings', { speechProvider: 'off' })
    expect((await owner.call('GET', '/api/admin/settings')).speechProvider).toBe('off')
    expect((await voice()).voiceInput).toBe(false)
    h.ctx.db.query("DELETE FROM settings WHERE key = 'speechProvider'").run()
    expect((await owner.call('GET', '/api/admin/settings')).speechProvider).toBe('openrouter')
    expect((await voice()).voiceInput).toBe(true)
  })
  test('the key removed with no choice: off again', async () => {
    await putKey(null)
    expect((await owner.call('GET', '/api/admin/settings')).speechProvider).toBe('off')
    expect((await voice()).voiceInput).toBe(false)
    expect((await voice()).voiceInputOutside).toBeUndefined()
    expect(stored()).toBeNull()
  })
  test("an admin's 'local' wins over the key", async () => {
    await putKey(KEY)
    await owner.call('PATCH', '/api/admin/settings', { speechProvider: 'local' })
    expect((await owner.call('GET', '/api/admin/settings')).speechProvider).toBe('local')
    expect((await voice()).voiceInputOutside).toBeUndefined()
    await putKey(null)
  })
})

describe("'local' needs whisper-cli and ffmpeg on this server", () => {
  const voice = async () => (await member.client.call('GET', '/api/me')).team.voiceInput
  const tools = (whisperBin: string | null, ffmpegBin: string | null) => Object.assign(h.ctx.files.speech, { whisperBin, ffmpegBin })

  test('without either the mic stays hidden (it used to show and fail every recording), and the settings screen names what is missing', async () => {
    await owner.call('PATCH', '/api/admin/settings', { speechProvider: 'local' })
    tools(null, '/usr/bin/true')
    expect(await voice()).toBe(false)
    expect((await owner.call('GET', '/api/admin/speech-host')).localMissing).toEqual(['whisper.cpp'])
    tools('/usr/bin/true', null)
    expect(await voice()).toBe(false)
    expect((await owner.call('GET', '/api/admin/speech-host')).localMissing).toEqual(['ffmpeg'])
    tools(null, null)
    expect(await voice()).toBe(false)
    expect((await owner.call('GET', '/api/admin/speech-host')).localMissing).toEqual(['whisper.cpp', 'ffmpeg'])
    tools('/usr/bin/true', '/usr/bin/true')
    expect(await voice()).toBe(true)
    expect((await owner.call('GET', '/api/admin/speech-host')).localMissing).toEqual([])
  })
  test('the tools do not matter for OpenRouter', async () => {
    tools(null, null)
    await owner.call('PATCH', '/api/admin/settings', { speechProvider: 'openrouter' })
    await owner.call('PUT', '/api/admin/speech-key', { sealed: await sealSecret(seal, KEY, 'speech.key'), password: OWNER_PW })
    expect(await voice()).toBe(true)
  })
})
