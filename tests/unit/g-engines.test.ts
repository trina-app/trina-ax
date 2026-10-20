// Diagnostics: engine login checks in local-login mode run the CLIs' own status commands with a minimal
// environment. Fake CLIs answer like the real ones; the Claude one only finds its keychain login with USER set.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkEngines, checkEnv } from '../../server/src/system/engines'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-engines-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function fake(name: string, body: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return p
}

const claude = fake('claude', `if [ -n "$USER" ]; then echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "someone@example.com"}'; else echo '{"loggedIn": false, "authMethod": "none"}'; fi`)
const codex = fake('codex', 'echo "Logged in using ChatGPT"')
const opts = { authMode: 'local-login' as const, roleAccount: false, claudeBin: claude, codexBin: codex, secretsDir: dir }

describe('engine login checks (local-login)', () => {
  test('the status commands get the account name (Claude Code looks its keychain login up by it)', async () => {
    expect(checkEnv().USER).toBe(os.userInfo().username)
    expect(checkEnv().LOGNAME).toBe(os.userInfo().username)
    const r = await checkEngines(opts)
    expect(r).toEqual([
      { engine: 'claude-code', installed: true, loggedIn: true, method: 'claude.ai', reason: null },
      { engine: 'codex', installed: true, loggedIn: true, method: 'ChatGPT', reason: null },
    ])
    // never an e-mail address or account name
    expect(JSON.stringify(r)).not.toContain('@')
  })
  test('not logged in, not installed, role-account mode', async () => {
    const out = fake('claude-out', `echo '{"loggedIn": false, "authMethod": "none"}'`)
    expect((await checkEngines({ ...opts, claudeBin: out }))[0]).toMatchObject({ loggedIn: false, reason: 'not_logged_in' })
    expect((await checkEngines({ ...opts, claudeBin: path.join(dir, 'missing') }))[0]).toMatchObject({ installed: false, reason: 'not_installed' })
    const role = await checkEngines({ ...opts, roleAccount: true })
    expect(role[0]).toMatchObject({ loggedIn: false, reason: 'setup_token_missing' })
    expect(role[1]).toMatchObject({ loggedIn: null, reason: 'engine_login_missing' })
  })
})
