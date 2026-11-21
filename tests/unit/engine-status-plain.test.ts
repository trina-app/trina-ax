// Admin › AI providers (QA TC-4837): a failed status check says in plain words what happened, with the provider's name.
// The engine's raw output (stream JSON, a long stderr) never reaches the card's line; it is errorDetail, cleaned of
// keys, tokens and home folders and cut short, for support. A known reason (timeout, no network, signed out) has its
// own line.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EngineStatus } from '@mycel/shared/api'
import { writeApiEngine } from '../../server/src/engine/api-agent'
import { checkEngine, classifyFailure, failedCheck, supportDetail, SUPPORT_DETAIL_MAX, T, type EngineEnv } from '../../server/src/admin/engines'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-plain-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
const bin = (name: string, script: string) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return p
}
const env = (claudeBin: string, codexBin = ''): EngineEnv => ({
  mode: 'dev', authMode: 'local-login', claudeBin, codexBin, dataDir: dir, secretsDir: dir, versionsFile: null, codexCatalogs: [],
})
// what the QA copy's engine printed for `auth status --json` (TC-4836): stream events, not the status JSON
const STREAM = '{"type":"system","subtype":"init","session_id":"cd44f44b-1111-2222-3333-444455556666","model":"","tools":[]}{"type":"stream_event","event":{"type":"content_block_start","index":0}}'
const raw = (stdout: string, o: { stderr?: string; timedOut?: boolean; error?: string } = {}) => ({ code: 1, stdout, stderr: o.stderr ?? '', timedOut: o.timedOut ?? false, ...(o.error ? { error: o.error } : {}) })

describe('a failed engine check shows a plain line', () => {
  test('stream JSON from `auth status`: the plain line names Claude Code; the JSON is only in errorDetail', async () => {
    const claude = bin('claude-stream', `case "$1" in --version) echo "2.1.305 (Claude Code)";; auth) printf '%s' '${STREAM}';; esac`)
    for (const locale of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      const s = await checkEngine('claude-code', env(claude), true, locale)
      expect(s.status).toBe('error')
      expect(s.detail).toBe(T.checkFailed![locale].replace('{name}', 'Claude Code'))
      expect(s.detail).not.toMatch(/[{}"]|stream_event|session_id/)
      expect(s.errorDetail).toContain('stream_event')
      expect(s.errorDetail).not.toContain('cd44f44b-1111-2222-3333-444455556666')
      expect(EngineStatus.safeParse(s).success).toBe(true)
    }
    expect((await checkEngine('claude-code', env(claude), true, 'en')).detail).toBe("Couldn't check Claude Code right now. Try Check again in a moment.")
  })

  test('a long stderr from `--version` never reaches the line; the detail is cut short', async () => {
    const codex = bin('codex-broken', `echo "panic: ${'x'.repeat(3000)}" >&2; exit 3`)
    const s = await checkEngine('codex', env('', codex), true, 'en')
    expect(s).toMatchObject({ status: 'error', detail: "Couldn't check Codex right now. Try Check again in a moment." })
    expect(s.detail).not.toContain('panic')
    expect(s.errorDetail!.length).toBeLessThanOrEqual(SUPPORT_DETAIL_MAX + 1)
    expect(EngineStatus.safeParse(s).success).toBe(true)
  })

  test('a known reason has its plain line: signed out, no network, timeout', async () => {
    const out = await checkEngine('claude-code', env(bin('claude-signedout', `case "$1" in --version) echo "2.1.305 (Claude Code)";; auth) echo "Invalid API key · Please run /login" >&2; exit 1;; esac`)), true, 'en')
    expect(out).toMatchObject({ status: 'not_logged_in', detail: T.claudeLogin!.en })
    const net = await checkEngine('claude-code', env(bin('claude-offline', `case "$1" in --version) echo "2.1.305 (Claude Code)";; auth) echo "Error: getaddrinfo ENOTFOUND api.anthropic.com" >&2; exit 1;; esac`)), true, 'ko')
    expect(net).toMatchObject({ status: 'error', detail: T.checkNetwork!.ko.replace('{name}', 'Claude Code') })
    expect(failedCheck('Codex', raw('', { timedOut: true }), 'en')).toEqual({ status: 'error', detail: 'Checking Codex took too long. Try Check again in a moment.' })
    expect(classifyFailure(raw(STREAM))).toBe('unknown')
  })

  test('supportDetail takes out keys, tokens, secret fields and home folders', () => {
    const home = os.homedir()
    const d = supportDetail(`failed at ${home}/.claude/settings.json and /Users/someone/x and C:\\Users\\someone\\y: Bearer abcdefgh12345678 sk-ant-oat01-${'a'.repeat(40)} "access_token":"zzzzzzzz" password=hunter22 key sk-test-12345678`, 'sk-test-12345678')!
    expect(d).not.toContain(home)
    expect(d).not.toContain('someone')
    expect(d).not.toContain('abcdefgh12345678')
    expect(d).not.toContain('a'.repeat(40))
    expect(d).not.toContain('zzzzzzzz')
    expect(d).not.toContain('hunter22')
    expect(d).not.toContain('sk-test-12345678')
    expect(d).toContain('~/.claude')
    expect(supportDetail('   ')).toBeUndefined()
  })

  describe('supportDetail masks each kind of secret (review of #1255)', () => {
    const d = (x: string) => supportDetail(x)!
    test('1. credentials in an address', () => {
      const out = d('fetch https://user:p4ss@proxy.example.com/v1 and http://tok@host.example/x')
      expect(out).toContain('https://[hidden]@proxy.example.com/v1')
      expect(out).toContain('http://[hidden]@host.example/x')
      expect(out).not.toMatch(/p4ss|user:|tok@/)
    })
    test('2. secret fields with any prefix: camelCase, kebab-case, upper snake, quoted values', () => {
      const out = d('{"refreshToken":"r1 secret value","accessToken":"abc"} x-api-key: kkkkk OPENAI_API_KEY=oooo client_secret=ssss "password": "a b c"')
      for (const leak of ['r1 secret value', 'abc', 'kkkkk', 'oooo', 'ssss', 'a b c']) expect(out).not.toContain(leak)
      expect(out).toContain('refreshToken')
      expect(out).toContain('OPENAI_API_KEY=[hidden]')
      // usage counts are not secrets: a name must END in the secret word
      expect(d('"input_tokens":100,"output_tokens":20')).toBe('"input_tokens":100,"output_tokens":20')
    })
    test('3. Authorization Basic / Bearer: the credential itself goes', () => {
      expect(d('Authorization: Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz')
      expect(d('sent Basic dXNlcjpwYXNz to it')).toBe('sent Basic [hidden] to it')
      expect(d('header Bearer abc.def')).toBe('header Bearer [hidden]')
      expect(d('authorization=Bearer abcdefgh12345678')).not.toContain('abcdefgh12345678')
    })
    test('4. Cookie / Set-Cookie to the end of the line', () => {
      const out = d('Set-Cookie: sid=abc; Path=/; HttpOnly\nCookie: a=1; b=2\nnext line')
      expect(out).not.toMatch(/sid=abc|HttpOnly|a=1|b=2/)
      expect(out).toContain('next line')
    })
    test('5. home folders on every system, names with spaces', () => {
      const out = d('C:/Users/name/a D:\\Users\\jo smith\\x "E:\\Users\\Kim Lee" /root/.claude /var/root/y /private/var/root/z /home/someone/w /Users/someone/v')
      for (const leak of ['name/a', 'jo smith', 'Kim Lee', '/root', '/var/root', 'someone']) expect(out).not.toContain(leak)
      expect(out).toContain('~\\x')
      expect(out.startsWith('~/a ')).toBe(true)
      expect(out).toContain('~/.claude')
    })
    test('6. email addresses', () => {
      const out = d('{"loggedIn":true,"email":"kim.lee+ai@acme-corp.example.com"} owner jo@acme.io')
      expect(out).not.toMatch(/kim\.lee|acme-corp|jo@acme/)
      expect(out).toContain('[email]')
    })
    test('7. token-like runs go; snake_case words stay readable', () => {
      const out = d('{"type":"content_block_start","event":"message_delta_stream_event"} id cd44f44b-1111-2222-3333-444455556666 tok AbCdEfGhIjKlMnOpQrStUvWx b64 QWxhZGRpbjpvcGVuIHNlc2FtZQ+/AbCdEfGh==')
      expect(out).toContain('content_block_start')
      expect(out).toContain('message_delta_stream_event')
      for (const leak of ['cd44f44b', 'AbCdEfGhIjKlMnOpQrStUvWx', 'QWxhZGRpbjpvcGVu']) expect(out).not.toContain(leak)
    })
  })

  describe('supportDetail, second review of #1255', () => {
    const d = (x: string) => supportDetail(x)!
    test('1. a quoted value with escaped quotes goes whole', () => {
      const out = d(String.raw`{"password":"ab\"cd\"tail-secret","next":"ok"} token='x\'y\'z-tail' after`)
      expect(out).not.toMatch(/tail-secret|cd|z-tail/)
      expect(out).toContain('"next":"ok"')
      expect(out).toContain('after')
    })
    test('2. a PEM private key block, whole, and one cut off before its end', () => {
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc\nline2xyz\n-----END RSA PRIVATE KEY-----'
      const out = d(`before\n${pem}\nafter`)
      expect(out).toBe('before\n[private key hidden]\nafter')
      expect(d('x -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\npartial')).toBe('x [private key hidden]')
    })
    test('3. (proxy-)authorization of any scheme to the end of the line', () => {
      const out = d('Authorization: Digest username="u", realm="r", response="6629fae49393a05397450978507c4ef1"\nProxy-Authorization: Negotiate YIIabc\nnext')
      expect(out).not.toMatch(/Digest|6629fae4|realm|Negotiate|YIIabc/)
      expect(out).toBe('Authorization: [hidden]\nProxy-Authorization: [hidden]\nnext')
    })
    test('4. known short token prefixes without a field name; plain words stay', () => {
      const toks = ['xoxb-1234-abcd', 'ghp_abcDEF123', 'gho_x1', 'github_pat_11ABC_def', 'glpat-abc123', 'AIzaSyA1b2C3d4E5f6G7h8I9j0', 'AKIAIOSFODNN7EXAMPLE']
      const out = d(`saw ${toks.join(' ')} in the ghost log`)
      for (const t of toks) expect(out).not.toContain(t)
      expect(out).toContain('ghost log')
    })
    test('5. a query string: only the secret value goes, the other parameters stay', () => {
      expect(d('GET /v1/models?api_key=abc123&model=m-1&token=t0;lang=en')).toBe('GET /v1/models?api_key=[hidden]&model=m-1&token=[hidden];lang=en')
    })
  })

  describe('the API engine: a timeout and an address that does not answer have different lines', () => {
    const real = globalThis.fetch
    afterAll(() => { globalThis.fetch = real })
    const api = async (thrown: Error, baseUrl = 'https://api.example.com/v1') => {
      globalThis.fetch = (async () => { throw thrown }) as unknown as typeof fetch
      const d = fs.mkdtempSync(path.join(dir, 'api-'))
      writeApiEngine(d, { baseUrl, model: 'm', label: 'QA API', key: 'sk-test-12345678' })
      try { return await checkEngine('api', { dataDir: d } as EngineEnv, true, 'en') } finally { globalThis.fetch = real }
    }
    test('a timeout says it took too long, with the engine name', async () => {
      const s = await api(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))
      expect(s).toMatchObject({ status: 'error', detail: 'Checking QA API took too long. Try Check again in a moment.' })
      expect(EngineStatus.safeParse(s).success).toBe(true)
    })
    test('no answer says the address could not be reached; the provider error is only in errorDetail, without the key', async () => {
      const s = await api(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9 key sk-test-12345678') }))
      expect(s).toMatchObject({ status: 'error', detail: T.apiUnreachable!.en })
      expect(s.detail).not.toContain('ECONNREFUSED')
      expect(s.errorDetail).toContain('ECONNREFUSED')
      expect(s.errorDetail).not.toContain('sk-test-12345678')
    })
    test('QA TC-4827: a refused connection on this computer says nothing runs there; for Ollama, to open it', async () => {
      const refused = () => new TypeError('fetch failed', { cause: new Error('Unable to connect. Is the computer able to access the url? ECONNREFUSED') })
      const ollama = await api(refused(), 'http://127.0.0.1:11434/v1')
      expect(ollama).toMatchObject({ status: 'error', detail: T.apiOllamaNotRunning!.en })
      expect(ollama.errorDetail).toContain('ECONNREFUSED')
      const lmstudio = await api(refused(), 'http://192.168.1.20:1234/v1')
      expect(lmstudio).toMatchObject({ status: 'error', detail: T.apiLocalNotRunning!.en })
      // a public address that refuses: the usual line (check the address)
      expect((await api(refused(), 'https://api.example.com/v1')).detail).toBe(T.apiUnreachable!.en)
      // an unknown host on a local name is not "not running"
      expect((await api(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') }), 'http://127.0.0.1:11434/v1')).detail).toBe(T.apiUnreachable!.en)
    })
  })

  test('every plain line has all six languages and no raw placeholder left', () => {
    for (const k of ['checkFailed', 'checkTimeout', 'checkNetwork', 'apiUnreachable', 'apiOllamaNotRunning', 'apiLocalNotRunning'] as const) {
      for (const l of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
        expect(T[k]![l]).toBeTruthy()
        expect(T[k]![l]).not.toContain('{e}')
      }
    }
  })
})
