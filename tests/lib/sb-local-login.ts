// engine.sb with the office profile parameters (LOCAL_LOGIN=1) on a fake home, driven by the probe (g-sbprobe.c): the
// security round 4b tests share it. The real ~/.claude.json, keychain and ~/.codex are never opened.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const sbAvailable = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec') && !!Bun.which('cc')
export const ENGINE_PROFILE = path.resolve(import.meta.dir, '..', '..', 'scripts', 'macos', 'engine.sb')

export interface LocalLoginBox {
  /** base folder (removed by close) */
  base: string
  /** the fake home (USER_HOME) */
  home: string
  agent: string
  /** run the probe as chat <chat>'s engine turn; proxyPort 0 = dev (no proxy), else office (proxy only). Exit code. */
  run(chat: string, o: { proxyPort?: number; codex?: boolean }, ...args: string[]): number | null
  close(): void
}

export function localLoginBox(prefix: string): LocalLoginBox {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const eng = path.join(base, 'engine'), probe = path.join(eng, 'probe'), agent = path.join(base, 'agent'), home = path.join(base, 'home')
  for (const d of [eng, path.join(agent, 'c_me'), path.join(agent, 'c_other'), path.join(home, 'Library', 'Keychains'), path.join(home, '.claude', 'projects'), path.join(home, '.claude', 'backups')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), '{}')
  if (sbAvailable) {
    const cc = Bun.spawnSync(['cc', '-O2', '-o', probe, path.resolve(import.meta.dir, 'g-sbprobe.c')])
    if (cc.exitCode !== 0) throw new Error(cc.stderr.toString())
  }
  return {
    base, home, agent,
    run(chat, o, ...args) {
      const chatDir = path.join(agent, chat)
      const sess = path.join(home, '.claude', 'projects', `-agent-${chat}`)
      fs.mkdirSync(sess, { recursive: true })
      return Bun.spawnSync(['/usr/bin/sandbox-exec', '-f', ENGINE_PROFILE,
        '-D', `CHAT_DIR=${chatDir}`, '-D', `AGENT_ROOT=${agent}`, '-D', `ENGINE_DIR=${eng}`, '-D', `BRIDGE=${path.join(eng, 'bridge')}`,
        '-D', `TOOLS_SOCK=${path.join(base, 'tools.sock')}`, '-D', `PROXY_PORT=${o.proxyPort ?? 0}`, '-D', 'LOCAL_LOGIN=1', '-D', `LOCAL_CODEX=${o.codex ? 1 : 0}`,
        '-D', `USER_HOME=${home}`, '-D', `SESSION_DIR=${sess}`, probe, ...args], { cwd: chatDir, stdout: 'ignore', stderr: 'ignore' }).exitCode
    },
    close() { fs.rmSync(base, { recursive: true, force: true }) },
  }
}
