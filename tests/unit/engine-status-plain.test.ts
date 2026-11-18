// Admin › AI providers (QA TC-4837): a failed status check says in plain words what happened, with the provider's name.
// The engine's raw output (stream JSON, a long stderr) never reaches the card's line; it is errorDetail, cleaned of
// keys, tokens and home folders and cut short, for support. A known reason (timeout, no network, signed out) has its
// own line.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EngineStatus } from '@mycel/shared/api'
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

  test('every plain line has all six languages and no raw placeholder left', () => {
    for (const k of ['checkFailed', 'checkTimeout', 'checkNetwork', 'apiUnreachable'] as const) {
      for (const l of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
        expect(T[k]![l]).toBeTruthy()
        expect(T[k]![l]).not.toContain('{e}')
      }
    }
  })
})
