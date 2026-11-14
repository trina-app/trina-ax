// The Claude login refresh of office mode, read instead of tunnelled (TC-359). Office Claude turns use the Mac user's
// own Claude login, and Claude Code refreshes it itself at https://platform.claude.com/v1/oauth/token (the TOKEN_URL in
// the CLI; CLAUDE_CODE_CUSTOM_OAUTH_URL takes only Anthropic's approved addresses). A plain CONNECT tunnel to that host
// stayed TLS end to end, and the same host also answers the Messages API (POST /v1/messages there is the API), so a
// taken-over engine could send mcp_servers, code execution or a fetching server tool through it, past the body check
// of the proxy's HTTP path. Here the tunnel ends at a local TLS listener that holds a certificate for the refresh host,
// signed by a CA made on this Mac (only the engine trusts it: NODE_EXTRA_CA_CERTS of the turn); it answers exactly
// POST /v1/oauth/token with grant_type refresh_token by sending it on to the real host, and refuses everything else.
// The CA and the certificate live in the server's data folder (0600), which the engine sandbox cannot read.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { Database } from 'bun:sqlite'
import { audit } from '../admin/audit'

/** the refresh host whose tunnel ends here (connect.ts CLAUDE_CONNECT_HOSTS) */
export const REFRESH_HOST = 'platform.claude.com'
export const REFRESH_PATH = '/v1/oauth/token'
/** the file the turn's engine trusts (NODE_EXTRA_CA_CERTS), written into its .turn folder by the launcher */
export const REFRESH_CA_FILE = '.turn/refresh-ca.pem'
/** certificates are made again after this (they are valid for 825 days) */
const RENEW_MS = 365 * 24 * 3600_000

export interface RefreshTerminator {
  /** the CA certificate (PEM) the engine trusts */
  caPem: string
  /** open a connection to the listener for a tunnel the CONNECT handler accepted */
  dial(): net.Socket
  stop(): void
}

function openssl(args: string[], cwd: string) {
  const r = spawnSync(fs.existsSync('/usr/bin/openssl') ? '/usr/bin/openssl' : 'openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${String(r.stderr ?? '').slice(0, 200)}`)
}

/** The CA and the refresh host's certificate in `dir` (made once, again when older than a year). */
export function refreshCertificates(dir: string, now = Date.now()): { caPem: string; key: string; cert: string } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const f = (n: string) => path.join(dir, n)
  const fresh = ['ca.pem', 'leaf.key', 'leaf.pem'].every((n) => { try { const st = fs.lstatSync(f(n)); return st.isFile() && now - st.mtimeMs < RENEW_MS } catch { return false } })
  if (!fresh) {
    for (const n of fs.readdirSync(dir)) fs.rmSync(f(n), { force: true })
    const old = process.umask(0o077)
    try {
      fs.writeFileSync(f('leaf.ext'), `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${REFRESH_HOST}\nauthorityKeyIdentifier=keyid\n`)
      openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key'], dir)
      fs.writeFileSync(f('ca.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\n[dn]\n[v3_ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n')
      openssl(['req', '-x509', '-new', '-config', 'ca.cnf', '-key', 'ca.key', '-sha256', '-days', '825', '-subj', '/CN=Team server login refresh (this Mac only)', '-out', 'ca.pem'], dir)
      openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key'], dir)
      openssl(['req', '-new', '-key', 'leaf.key', '-subj', `/CN=${REFRESH_HOST}`, '-out', 'leaf.csr'], dir)
      openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '825', '-sha256', '-extfile', 'leaf.ext', '-out', 'leaf.pem'], dir)
    } finally { process.umask(old) }
    // the CA key is not needed again (a new pair is made at renewal): it does not stay on disk
    for (const n of ['ca.key', 'ca.cnf', 'leaf.csr', 'leaf.ext', 'ca.srl']) fs.rmSync(f(n), { force: true })
  }
  return { caPem: fs.readFileSync(f('ca.pem'), 'utf8'), key: fs.readFileSync(f('leaf.key'), 'utf8'), cert: fs.readFileSync(f('leaf.pem'), 'utf8') }
}

/** what a refresh request may be: grant_type refresh_token, as JSON (Claude Code) or a form */
function isRefresh(contentType: string, body: string): boolean {
  try {
    if (contentType.includes('application/json')) return (JSON.parse(body) as { grant_type?: unknown }).grant_type === 'refresh_token'
    if (contentType.includes('application/x-www-form-urlencoded')) return new URLSearchParams(body).get('grant_type') === 'refresh_token'
  } catch {}
  return false
}

export function startRefreshTerminator(o: {
  db: Database
  /** where the CA and certificate are kept (the server's secrets folder) */
  dir: string
  /** where the refresh goes (tests); default https://platform.claude.com */
  upstream?: string
  log?: { warn(msg: string, f?: Record<string, unknown>): void }
}): RefreshTerminator {
  const { caPem, key, cert } = refreshCertificates(o.dir)
  const upstream = (o.upstream ?? `https://${REFRESH_HOST}`).replace(/\/$/, '')
  // only connections dial() opened (the CONNECT handler, after its token, turn and peer checks) are answered
  const ours = new Set<number>()
  const refuse = (reason: string, status = 403) => {
    audit(o.db, { actor: null, action: 'proxy.refused', target: null, detail: { reason: `login refresh tunnel: ${reason}` } })
    o.log?.warn('model proxy: login refresh tunnel refused a request', { reason })
    return new Response(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: `refused by the team server: ${reason}` } }), { status, headers: { 'content-type': 'application/json' } })
  }
  const srv = Bun.serve({
    hostname: '127.0.0.1', port: 0, reusePort: false, tls: { key, cert },
    maxRequestBodySize: 64 * 1024,
    async fetch(req, s) {
      const ip = s.requestIP(req)
      if (!ip || !ours.has(ip.port)) return new Response('', { status: 403 })
      const url = new URL(req.url)
      if (req.method !== 'POST' || url.pathname !== REFRESH_PATH || url.search) return refuse(`${req.method} ${url.pathname.slice(0, 80)} is not the login refresh`)
      const ct = req.headers.get('content-type') ?? ''
      const body = await req.text()
      if (!isRefresh(ct, body)) return refuse('not a refresh_token grant')
      let up: Response
      try {
        up = await fetch(upstream + REFRESH_PATH, { method: 'POST', body, redirect: 'manual',
          headers: { 'content-type': ct, accept: req.headers.get('accept') ?? 'application/json', ...(req.headers.get('user-agent') ? { 'user-agent': req.headers.get('user-agent')! } : {}) } })
      } catch { return new Response(JSON.stringify({ error: 'unreachable' }), { status: 502, headers: { 'content-type': 'application/json' } }) }
      if (up.status >= 300 && up.status < 400) { await up.body?.cancel().catch(() => {}); return new Response('', { status: 502 }) }
      return new Response(await up.arrayBuffer(), { status: up.status, headers: { 'content-type': up.headers.get('content-type') ?? 'application/json' } })
    },
  })
  return {
    caPem,
    dial() {
      const c = net.connect(srv.port!, '127.0.0.1')
      c.once('connect', () => { const p = c.localPort; if (p) { ours.add(p); c.once('close', () => ours.delete(p)) } })
      return c
    },
    stop() { srv.stop(true) },
  }
}
