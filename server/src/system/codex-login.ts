// The engine account's Codex login on an installed server (design tab 2 "Codex 네트워크", tab 3 codex_login /
// codex_status / codex_logout). Run by the owner once, as the server account, through the admin CLI:
//
//   sudo -u _axserver env MYCEL_MODE=prod HOME="/Library/Application Support/mycel/data" \
//     "/Library/Application Support/mycel/app/current/bin/bun" \
//     "/Library/Application Support/mycel/app/current/server/src/admin.js" codex-login
//
// codex-login asks the launcher (LaunchDaemon, engine account) to run `codex login --device-auth` with
// CODEX_HOME = <agent root>/codex-auth, under the engine sandbox, through the running server's model proxy (pf lets
// the engine account reach nothing else). The proxy accepts the tunnel only with the one-time proxy token issued
// here and only from the login process (the token is bound to its pid as soon as the launcher reports it). The CLI
// prints the URL and the one-time code; the owner opens the URL, signs in with the ChatGPT account meant for the
// team (a separate one: design tab 2) and enters the code. No token is ever printed.
import crypto from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import type { AppConfig } from '../app-config'
import { PROD_PROXY_PORT } from '../app-config'
import { openDb } from '../db'
import { codexDeviceLogin, codexLoginState, codexLogout } from '../native'
import { issueProxyToken, revokeProxyTokens } from '../proxy/model-proxy'
import { CODEX_LOGIN_BOUND, CODEX_LOGIN_PENDING } from '../proxy/connect'
import { codexProxyUrl } from '../engine/codex'
import { audit } from '../admin/audit'

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** URL and one-time code from `codex login --device-auth` output (0.163: a https URL, then "XXXX-XXXXX"). */
export function parseDeviceLogin(text: string): { url: string | null; code: string | null } {
  const t = text.replace(ANSI, '')
  const url = /https:\/\/[^\s'")]+/.exec(t)?.[0] ?? null
  const after = t.slice(t.search(/one-time code/i) >= 0 ? t.search(/one-time code/i) : 0)
  const code = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/.exec(after)?.[1] ?? null
  return { url, code }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const c = net.connect(port, '127.0.0.1')
    c.once('connect', () => { c.destroy(); res(true) })
    c.once('error', () => res(false))
    setTimeout(() => { c.destroy(); res(false) }, 2000)
  })
}

export interface CodexCliIo { out(line: string): void; err(line: string): void }

export async function codexCommand(cmd: 'codex-status' | 'codex-login' | 'codex-logout', cfg: AppConfig, io: CodexCliIo = { out: (l) => console.log(l), err: (l) => console.error(l) }): Promise<number> {
  const sock = cfg.engine.launcherSock
  if (cfg.mode !== 'prod' || !sock) {
    io.err('codex-login / codex-status / codex-logout are for an installed server (role accounts). In dev mode the engine uses your own `codex login`.')
    return 2
  }
  if (cmd === 'codex-status') {
    const s = await codexLoginState(sock)
    if (!s) { io.err(`the launcher did not answer (${sock}); is the launcher daemon running?`); return 1 }
    io.out(JSON.stringify({ loggedIn: s.loggedIn, ...(s.accountId ? { accountId: s.accountId } : {}), ...(s.lastRefresh ? { lastRefresh: s.lastRefresh } : {}), ...(s.problem ? { problem: s.problem } : {}) }))
    return s.loggedIn ? 0 : 3
  }
  if (cmd === 'codex-logout') {
    const r = await codexLogout(sock)
    io.out(JSON.stringify(r))
    if (r.ok) withDb(cfg, (db) => audit(db, { actor: null, action: 'engine.codex_logout', target: null, detail: { via: 'cli' } }))
    return r.ok ? 0 : 1
  }
  // codex-login
  const bin = cfg.engine.codexBin
  if (!bin) { io.err('no engine.codexBin in server.json: install Codex with `install-macos.sh --engine codex=<file>`'); return 2 }
  const port = cfg.engine.proxyPort ?? PROD_PROXY_PORT
  if (!(await portOpen(port))) { io.err(`the model proxy (127.0.0.1:${port}) is not answering: the server must be running (it opens the proxy on its first engine use; open the web app once or check Admin > System > Diagnostics)`); return 1 }
  const pending = CODEX_LOGIN_PENDING + crypto.randomBytes(8).toString('hex')
  const db = openDb(path.join(cfg.dataDir, 'app.db'))
  let bound: string | null = null
  try {
    const token = issueProxyToken(db, pending, 'codex-login-cli', { ttlMs: 20 * 60_000 })
    let shown = false
    let buf = ''
    io.out('Starting the Codex sign-in for the engine account (this can take a few seconds)...')
    const r = await codexDeviceLogin(sock, { cmd: bin, proxy: codexProxyUrl(port, token) }, {
      // bind the token to the login process: the proxy accepts the tunnel only from this pid's session
      started: (pid) => { bound = CODEX_LOGIN_BOUND + pid; db.query('UPDATE proxy_tokens SET turn_id = ? WHERE turn_id = ?').run(bound, pending) },
      output: (text) => {
        buf += text
        const d = parseDeviceLogin(buf)
        if (!shown && d.url && d.code) {
          shown = true
          io.out('')
          io.out(`1. Open ${d.url} in a browser and sign in with the ChatGPT account for the team's AI (not your personal one).`)
          io.out(`2. Enter this one-time code: ${d.code}   (it expires in 15 minutes)`)
          io.out('')
          io.out('Waiting for the sign-in to finish...')
        }
      },
    })
    if (r.code === 0) {
      const s = await codexLoginState(sock)
      audit(db, { actor: null, action: 'engine.codex_login', target: null, detail: { ok: true, via: 'cli' } })
      io.out(s?.loggedIn ? 'Codex is signed in for the engine account.' : 'codex exited without error, but no login was found.')
      return s?.loggedIn ? 0 : 1
    }
    const tail = buf.replace(ANSI, '').trim().split('\n').slice(-3).join(' | ')
    audit(db, { actor: null, action: 'engine.codex_login', target: null, detail: { ok: false, via: 'cli', code: r.code, message: r.message ?? null } })
    io.err(`the Codex sign-in did not finish (${r.message ?? `exit ${r.code}`})${tail ? `: ${tail}` : ''}`)
    return 1
  } finally {
    revokeProxyTokens(db, pending)
    if (bound) revokeProxyTokens(db, bound)
    db.close()
  }
}

function withDb(cfg: AppConfig, fn: (db: ReturnType<typeof openDb>) => void) {
  const db = openDb(path.join(cfg.dataDir, 'app.db'))
  try { fn(db) } finally { db.close() }
}
