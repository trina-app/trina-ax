// The REAL `claude setup-token` in the launcher's Claude sign-in (docs/DECISIONS.md "Claude 구독 연결: 브라우저에서"),
// on this machine, WITHOUT signing in: the real launcher (native/bin) runs the real CLI on its pseudo-terminal under the
// engine sandbox (macOS: scripts/macos/engine.sb, production settings: LOCAL_LOGIN=0, LOGIN_TTY, only the proxy
// port), with HTTPS_PROXY pointing at a recording proxy of this script. It goes up to the authorize address and the
// paste prompt, then cancels; it checks that the address is Anthropic's manual-code page, that nothing connected
// anywhere before it, that the folder is gone and that no process is left.
//
//   bun tests/engine/claude-login-real.ts [--claude <path>]            (default: versions.json's pin, else `claude`)
//   bun tests/engine/claude-login-real.ts --tls-handshake [--claude …]  also type a made-up code and let the CLI open
//       its token exchange tunnel to platform.claude.com:443: the proxy passes the TLS handshake through and cuts the
//       tunnel at the client's first encrypted record (TLS 1.3: its Finished; 1.2: the request), so no HTTP request
//       and no code ever reach Anthropic. It shows whether the CLI trusts the real certificate inside the sandbox
//       (it sends that record only after verifying it; a refused certificate is an alert instead).
//
// No browser can open: the sandbox lets the CLI start nothing but files in its own folder and bind no port (so
// setup-token has no callback listener and never tries to open a browser), and BROWSER is a no-op as well. Refuses to
// run on macOS without the sandbox profile. Prints no token (there is none: nobody approves).
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { claudeSignIn, startLauncher } from '../../server/src/native'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const argv = process.argv.slice(2)
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const tls = argv.includes('--tls-handshake')
// as configured (the launcher allows the file named claude; ~/.local/bin/claude is a link to versions/<v>)
const claude = path.resolve(opt('--claude') ?? Bun.which('claude') ?? 'claude')
const real = fs.realpathSync(claude)
const nativeBin = path.join(ROOT, 'native', 'bin', `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`)
const profile = path.join(ROOT, 'scripts', 'macos', 'engine.sb')
if (process.platform === 'darwin' && (!fs.existsSync(profile) || !fs.existsSync('/usr/bin/sandbox-exec'))) { console.error('needs the macOS engine sandbox'); process.exit(2) }
if (process.platform !== 'darwin') { console.error('macOS only (Linux: the bwrap path is the Linux job, tests/linux/driver.ts)'); process.exit(2) }

const version = (Bun.spawnSync([claude, '--version'], { env: { PATH: '/usr/bin:/bin', DISABLE_AUTOUPDATER: '1' } }).stdout.toString().trim())
console.log(`claude: ${claude}${real !== claude ? ` -> ${real}` : ''} (${version})`)

// ---------------- the recording proxy ----------------
const seen: string[] = []
type Handshake = 'none' | 'trusted' | 'alert' | 'closed'
let handshake = 'none' as Handshake
let firstLen = 0
const proxy = net.createServer((c) => {
  let head = Buffer.alloc(0)
  c.on('error', () => {})
  const onData = (d: Buffer) => {
    head = Buffer.concat([head, d])
    const end = head.indexOf('\r\n\r\n')
    if (end < 0) return
    c.off('data', onData)
    const target = head.subarray(0, end).toString('latin1').split('\r\n')[0]!.split(' ')[1] ?? '?'
    seen.push(target)
    if (!tls || target !== 'platform.claude.com:443') { c.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return }
    // the handshake only: server bytes flow back as they are; client records go up until its first encrypted one
    const up = net.connect(443, 'platform.claude.com')
    up.on('error', () => c.destroy())
    let buf = head.subarray(end + 4)
    up.on('connect', () => {
      c.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      up.pipe(c)
      const pump = () => {
        while (buf.length >= 5) {
          const type = buf[0]!, len = buf.readUInt16BE(3)
          if (buf.length < 5 + len) return
          // never forwarded. TLS 1.3 encrypts a client alert too (type 23, 19 bytes: alert 2 + type 1 + tag 16); its
          // Finished is 53 bytes or more (verify data 32/48 + header 4 + type 1 + tag 16)
          if (type === 23) { handshake = len <= 24 ? 'alert' : 'trusted'; firstLen = len; up.destroy(); c.destroy(); return }
          if (type === 21) handshake = 'alert'
          up.write(buf.subarray(0, 5 + len))
          buf = buf.subarray(5 + len)
        }
      }
      c.on('data', (x: Buffer) => { buf = Buffer.concat([buf, x]); pump() })
      c.on('close', () => { if (handshake === 'none') handshake = 'closed'; up.destroy() })
      pump()
    })
  }
  c.on('data', onData)
})
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
const proxyPort = (proxy.address() as net.AddressInfo).port

// ---------------- the launcher, as production starts it (sandbox, proxy port) ----------------
const work = fs.mkdtempSync(path.join(os.homedir(), '.mycel-cl-real-'))
const agentRoot = path.join(work, 'agent')
const launcher = await startLauncher(nativeBin, { listen: path.join(work, 'l.sock'), agentRoot, toolsSock: path.join(work, 't.sock'), allowCmds: [claude],
  sandbox: { profile, localLogin: false, proxyPort } })
const loginId = crypto.randomBytes(18).toString('base64url')
const checks: [string, boolean, string?][] = []
const check = (name: string, ok: boolean, detail?: string) => { checks.push([name, ok, detail]); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }
let url = null as string | null, failed = null as string | null, gotToken = false as boolean
const t0 = Date.now()
const urlSeen = Promise.withResolvers<void>()
const failedSeen = Promise.withResolvers<void>()
const run = claudeSignIn(path.join(work, 'l.sock'), { cmd: claude, proxy: `http://turn:${crypto.randomBytes(24).toString('base64url')}@127.0.0.1:${proxyPort}`, loginId, timeoutMs: 180_000 }, {
  url: (u) => { url = u; urlSeen.resolve() },
  failed: (r) => { failed = r; failedSeen.resolve() },
  token: () => { gotToken = true },
})
const folder = path.join(agentRoot, '.claude-login', loginId)
try {
  await Promise.race([urlSeen.promise, run.done, Bun.sleep(90_000)])
  check('the authorize address and the paste prompt came up', !!url, url ? `${((Date.now() - t0) / 1000).toFixed(1)} s` : failed ?? 'nothing')
  if (url) {
    const u = new URL(url)
    check('Anthropic\'s manual-code page', `${u.host}${u.pathname}` === 'claude.com/cai/oauth/authorize' && u.searchParams.get('redirect_uri') === 'https://platform.claude.com/oauth/code/callback' && u.searchParams.get('scope') === 'user:inference',
      `${u.host}${u.pathname} redirect_uri=${u.searchParams.get('redirect_uri')} scope=${u.searchParams.get('scope')}`)
  }
  check('the sign-in folder exists while it runs', fs.existsSync(folder))
  check('no connection at all before the address (no telemetry, updates, flags)', seen.length === 0, seen.join(', '))
  if (tls && url) {
    run.sendCode('probe-code#probe-state')
    await Promise.race([failedSeen.promise, run.done, Bun.sleep(60_000)])
    check('the typed code reached the CLI: it opened the exchange tunnel to platform.claude.com:443 only', seen.length > 0 && seen.every((s) => s === 'platform.claude.com:443'), seen.join(', '))
    check('TLS inside the sandbox: the CLI verified the real certificate (cut before any request)', handshake === 'trusted', `${handshake}, first encrypted client record ${firstLen} bytes`)
    check('the cut exchange ends the sign-in as failed (no token)', failed === 'exchange_failed' && !gotToken, String(failed))
  } else run.cancel()
  const r = await run.done
  check('the program ended', true, JSON.stringify(r))
  check('no token', !gotToken)
  // a cancel closes the connection at once; the launcher then stops the program (SIGTERM, SIGKILL after 5 s) and removes
  // the folder
  const left = () => Bun.spawnSync(['ps', '-ax', '-o', 'pid=,command=']).stdout.toString().split('\n').filter((l) => [claude, real].some((c) => l.trim().replace(/^\d+\s+/, '') === `${c} setup-token`))
  const until = Date.now() + 10_000
  while ((fs.existsSync(folder) || left().length) && Date.now() < until) await Bun.sleep(200)
  check('the sign-in folder is gone', !fs.existsSync(folder), `${((Date.now() - t0) / 1000).toFixed(1)} s after start`)
  check('no setup-token process left', left().length === 0, left().join(' | '))
} finally {
  launcher.kill()
  proxy.close()
  fs.rmSync(work, { recursive: true, force: true })
}
const failedChecks = checks.filter((c) => !c[1])
console.log(failedChecks.length ? `${failedChecks.length} check(s) failed` : 'all checks passed')
process.exit(failedChecks.length ? 1 : 0)
