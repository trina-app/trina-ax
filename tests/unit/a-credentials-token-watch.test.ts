// The token file is taken without a restart (QA 2026-11-16: after `sudo …/root/set-claude-token`, which said "from the
// next message", Claude answered only after `systemctl restart`). The server watches the secrets folder
// (credentials/maintenance.ts watchTokenFile), imports the file and drops every copy of the connections' state
// (tokenFileTick); the 5-minute check stays for a watch that misses it.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { testCredCtx } from '../lib/credentials'
import { tokenFileTick, watchTokenFile } from '../../server/src/credentials/maintenance'
import { listRows } from '../../server/src/credentials/store'
import { tokenFile } from '../../server/src/proxy/subscription'

const env = makeEnv('a-cred-token-watch')
const secrets = path.join(env.fx.base, 'secrets')
fs.mkdirSync(secrets, { recursive: true, mode: 0o700 })
const t = testCredCtx(env.db, secrets)
const REPO = path.resolve(import.meta.dir, '../..')
const waitFor = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await Bun.sleep(20); return f() }
/** as root/set-claude-token does: a file written elsewhere, renamed into place */
const put = (token: string) => { const tmp = path.join(env.fx.base, 'token.tmp'); fs.writeFileSync(tmp, token + '\n', { mode: 0o600 }); fs.renameSync(tmp, tokenFile(secrets)) }

describe('the token file without a restart', () => {
  test('a new file: the watch fires once the file is renamed into place; another file in the folder does not fire it', async () => {
    let fired = 0
    const stop = watchTokenFile(secrets, () => { fired++ }, 50)
    try {
      fs.writeFileSync(path.join(secrets, 'other.key'), 'x', { mode: 0o600 })
      await Bun.sleep(300)
      expect(fired).toBe(0)
      put('sk-ant-oat01-' + 'W'.repeat(90))
      expect(await waitFor(() => fired > 0)).toBe(true)
    } finally { stop() }
    const after = fired
    put('sk-ant-oat01-' + 'V'.repeat(90))
    await Bun.sleep(300)
    expect(fired).toBe(after) // stopped
  })

  test('a tick imports the file and drops the copies of the connections\' state; the same file again changes nothing', () => {
    let dropped = 0
    t.cc.changeListeners.add(() => { dropped++ })
    put('sk-ant-oat01-' + 'U'.repeat(90))
    expect(tokenFileTick(t.cc, secrets)).toBe('imported')
    expect(dropped).toBe(1)
    expect(listRows(env.db).filter((r) => r.kind === 'anthropic-oauth').length).toBe(1)
    expect(tokenFileTick(t.cc, secrets)).toBe('same')
    expect(dropped).toBe(1)
    put('sk-ant-oat01-' + 'T'.repeat(90))
    expect(tokenFileTick(t.cc, secrets)).toBe('updated')
    expect(dropped).toBe(2)
  })

  test('a folder that cannot be watched: no error, a no-op stop', () => {
    expect(() => watchTokenFile(path.join(env.fx.base, 'no-such-folder'), () => {})()).not.toThrow()
  })

  test('set-claude-token says what is true: within a few seconds, no restart', () => {
    for (const f of ['scripts/linux/set-claude-token.sh', 'scripts/macos/set-claude-token.sh']) {
      const s = fs.readFileSync(path.join(REPO, f), 'utf8')
      expect(s).toContain('the server takes it within a few seconds (at most 5 minutes, no restart)')
      expect(s).not.toContain('from the next message')
      expect(s).not.toContain('reads it on every model request')
    }
  })
})
