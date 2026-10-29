import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildCodexLaunch, prepareCodexTurn, type CodexConf } from '../../server/src/engine/codex'
import { nativeBinDir } from '../../server/src/config'
import { SocketLauncher, startLauncher } from '../../server/src/native'

// Real launcher, synthetic login only. The server-prepared home must survive until exec,
// while switching to another engine must still clear any leftover Codex login.
test('local-login Codex keeps its prepared home; the next other-engine turn clears it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-local-'))
  const bin = path.join(dir, 'engine'), sock = path.join(dir, 'l.sock')
  const agent = path.join(dir, 'agent'), chat = path.join(agent, 'chat')
  const auth = path.join(dir, 'synthetic-auth.json'), catalog = path.join(dir, 'catalog.json')
  fs.writeFileSync(auth, '{}')
  fs.writeFileSync(catalog, '{"models":[]}')
  fs.writeFileSync(bin, '#!/bin/sh\nif [ -n "$CODEX_HOME" ]; then test -L "$CODEX_HOME/auth.json" && test -f "$CODEX_HOME/catalog.json" || exit 9; else test ! -e .codex || exit 10; fi\nprintf "HOME-OK\\n"\n', { mode: 0o700 })
  const conf: CodexConf = { bin, codexHome: '', agentHome: '', catalog, model: 'fake', auth: 'dev-owner-symlink' }
  const p = await startLauncher(nativeBinDir(), { listen: sock, agentRoot: agent, toolsSock: path.join(dir, 't.sock'), allowCmds: [bin], sandbox: { profile: '', localLogin: true, localCodex: true } })
  try {
    const launcher = new SocketLauncher(sock)
    prepareCodexTurn(conf, chat, auth)
    const req = buildCodexLaunch({ turnId: 'local', chatDir: chat, token: 'test', systemPrompt: '', message: 'hello', timeoutMs: 5000 }, conf)
    for (const lr of [req, { ...req, turnId: 'other', env: { PATH: '/usr/bin:/bin' }, args: [] }]) {
      const events = []
      for await (const e of launcher.launch(lr).events) events.push(e)
      expect(events.find(e => e.ev === 'exit')).toMatchObject({ code: 0 })
      expect(events.some(e => e.ev === 'error')).toBe(false)
    }
    expect(fs.existsSync(path.join(chat, '.codex'))).toBe(false)
    expect(fs.readFileSync(auth, 'utf8')).toBe('{}')
  } finally { p.kill(); await p.exited; fs.rmSync(dir, { recursive: true, force: true }) }
}, 15000)
