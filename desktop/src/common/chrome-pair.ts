// App-led linking, the running app's end (shared/src/chrome-native.ts): the nonces the app put in the pair pages it
// opened, and the socket the native helper (desktop/native/chrome-host) relays each extension message to.
//
// What protects it (docs/decisions/20261128-chrome-app-led-linking.md):
// - the socket is in a 0700 folder of this OS user's own (app data, or the per-user temp folder), and is 0600: another
//   OS user cannot connect;
// - Chrome starts the helper only for the extension ids in the manifest's allowed_origins and tells it the caller
//   (argv[1]); the app checks that origin against the same ids again;
// - a nonce is 32 random bytes, lives CHROME_PAIR_NONCE_TTL_MS, is good for one `pair` (and one `linked` after it) and
//   exists only in the address of the one profile the app opened (and the browser's command line: `ps` shows it to
//   this OS user for the moment the browser's second process runs);
// - the code comes from the team page on screen, signed in, and every link shows the page's notice with Undo.
// What it cannot do: tell which profile a message comes from (Chrome does not say), or check the peer's code signature
// (Node gives no peer pid; and a process of this user could start the signed helper itself, so it would prove nothing).
// It never sees a link token or a session, and never logs a nonce or a code.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { CHROME_NATIVE_MAX_BYTES, CHROME_PAIR_NONCE_TTL_MS, ChromeNativeRequest, type ChromeNativeReply } from '@mycel/shared/chrome-native'

/** what a nonce is bound to: the profile the app opened and the names the reply gives it */
export interface PairBinding {
  browser: string
  dir: string
  label: string
  email?: string
  /** "Chrome on Mac" */
  browserLabel: string
  /** the team on the app's screen when it opened the profile: the code must come from that same team */
  teamOrigin: string
}
interface Entry { b: PairBinding; at: number; paired: boolean; linked: boolean }

export class NonceStore {
  private m = new Map<string, Entry>()
  constructor(private now: () => number = Date.now, private ttl = CHROME_PAIR_NONCE_TTL_MS) {}
  /** a new nonce for a profile the app is opening (32 random bytes, base64url) */
  mint(b: PairBinding): string {
    this.purge()
    const n = crypto.randomBytes(32).toString('base64url')
    this.m.set(n, { b, at: this.now(), paired: false, linked: false })
    // at most a few dozen at once: one per profile opened in the last two minutes
    while (this.m.size > 64) this.m.delete(this.m.keys().next().value!)
    return n
  }
  private live(n: string): Entry | null {
    const e = this.m.get(n)
    if (!e) return null
    if (this.now() - e.at > this.ttl) { this.m.delete(n); return null }
    return e
  }
  /** `pair`: the binding, once; a used, unknown or expired nonce gives null */
  take(n: string): PairBinding | null {
    const e = this.live(n)
    if (!e || e.paired) return null
    e.paired = true
    return e.b
  }
  /** `linked`: once per nonce, after its `pair`, within the same lifetime */
  linked(n: string): PairBinding | null {
    const e = this.live(n)
    if (!e || !e.paired || e.linked) return null
    e.linked = true
    return e.b
  }
  /** a pair that got no code (no team, refused): its `linked` may never come */
  drop(n: string) { this.m.delete(n) }
  private purge() { for (const [n, e] of this.m) if (this.now() - e.at > this.ttl) this.m.delete(n) }
}

/** the longest Unix socket path macOS takes (sun_path is 104 bytes with its closing NUL) */
export const SOCKET_PATH_MAX = 103

/** This OS user's own temp folder: macOS's per-user DARWIN_USER_TEMP_DIR (0700, /var/folders/…/T/, short), never
 * $TMPDIR (a terminal or a tool may point it anywhere, long, or shared like /tmp); elsewhere the system's temp folder.
 * '' when macOS does not say (no shared folder is taken instead: no socket, and the app says so). */
export function userTempDir(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'darwin') return os.tmpdir()
  try {
    const d = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 2000 }).trim()
    return path.isAbsolute(d) ? d : ''
  } catch { return '' }
}

/**
 * Where the app listens for the native helper, short and independent of how long the user data path is:
 * - the app run from its default folder (~/Library/Application Support/<data folder>): `<it>/chrome/pair.sock`, the
 *   path the helper computes by itself (a release helper takes no other);
 * - any other user data folder (a development run, MYCEL_DESKTOP_USER_DATA, tests): `<this user's temp folder>/
 *   mycel-chrome/<12 hex of the folder's sha256>.sock`, which the host start script names (devHostScript).
 * `fixed`: the helper finds it without being told. null when even that is too long for a Unix socket.
 */
export function chromePairSocketPath(o: { home: string; dataDirName: string; userData: string; tempDir?: () => string }): { path: string; fixed: boolean } | null {
  const own = path.join(o.home, 'Library', 'Application Support', o.dataDirName)
  const fixed = path.join(own, 'chrome', 'pair.sock')
  if (path.resolve(o.userData) === own && Buffer.byteLength(fixed) <= SOCKET_PATH_MAX) return { path: fixed, fixed: true }
  const temp = (o.tempDir ?? userTempDir)()
  if (!temp) return null
  const short = path.join(temp, 'mycel-chrome', `${crypto.createHash('sha256').update(path.resolve(o.userData)).digest('hex').slice(0, 12)}.sock`)
  return Buffer.byteLength(short) <= SOCKET_PATH_MAX ? { path: short, fixed: false } : null
}

export interface PairServerDeps {
  nonces: NonceStore
  /** the extension ids the app lets in (chromeExtensionIds(dev)) */
  ids: () => string[]
  /** the team page on screen, signed in: its team address and name; null when there is none */
  team: () => { origin: string; name: string } | null
  /** ask that page for a code bound to the challenge (POST /api/chrome/pair as itself); null: it said no */
  askCode: (challenge: string) => Promise<{ code: string } | null>
  /** a profile linked: the page's notice with Undo */
  linked: (l: { linkId: string; label: string; browser: string }) => void
}

/** one message from the helper: `{origin, request}`; the reply to send back */
export async function handlePairMessage(d: PairServerDeps, msg: unknown): Promise<ChromeNativeReply> {
  const refuse = (reason: 'bad_nonce' | 'no_team' | 'refused'): ChromeNativeReply => ({ type: 'error', reason })
  if (!msg || typeof msg !== 'object') return refuse('refused')
  const { origin, request } = msg as { origin?: unknown; request?: unknown }
  if (typeof origin !== 'string' || !d.ids().some((id) => origin === `chrome-extension://${id}/`)) return refuse('refused')
  const r = ChromeNativeRequest.safeParse(request)
  if (!r.success) return refuse('refused')
  if (r.data.type === 'linked') {
    const b = d.nonces.linked(r.data.nonce)
    if (!b) return refuse('bad_nonce')
    d.linked({ linkId: r.data.linkId, label: b.label, browser: b.browserLabel })
    return { type: 'ok' }
  }
  const b = d.nonces.take(r.data.nonce)
  if (!b) return refuse('bad_nonce')
  const team = d.team()
  // the team on screen now must be the one the profile was opened for (a team switch in between: Connect again)
  if (!team || team.origin !== b.teamOrigin) { d.nonces.drop(r.data.nonce); return refuse('no_team') }
  let got: { code: string } | null = null
  try { got = await d.askCode(r.data.challenge) } catch { got = null }
  if (!got || !/^[A-Za-z0-9_-]{43}$/.test(got.code)) { d.nonces.drop(r.data.nonce); return refuse('refused') }
  return { type: 'code', origin: team.origin, code: got.code, team: team.name.slice(0, 200), label: b.label, ...(b.email ? { email: b.email } : {}), browser: b.browserLabel }
}

/** how long the helper has to send its line; the reply may take longer (the page asks the team server) */
const READ_MS = 2000

/** Listen for the helper: one line in, one line out, per connection. `state`: told 'listening', or 'failed' with why
 * (the app says so instead of a pair page that waits for nobody). */
export function listenForPairs(socket: string, d: PairServerDeps, state: (s: 'listening' | 'failed', err?: unknown) => void = () => {}): net.Server {
  const dir = path.dirname(socket)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // a real folder of this OS user (not a link, not someone else's), then 0700; else throw: no socket this run
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw new Error(`not this user's folder: ${dir}`)
  fs.chmodSync(dir, 0o700)
  try { fs.rmSync(socket, { force: true }) } catch { /* a socket a crashed run left: replaced below */ }
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0)
    let done = false
    const timer = setTimeout(() => sock.destroy(), READ_MS)
    sock.on('error', () => sock.destroy())
    sock.on('close', () => clearTimeout(timer))
    sock.on('data', (chunk: Buffer) => {
      if (done) return
      buf = Buffer.concat([buf, chunk])
      const i = buf.indexOf(0x0a)
      if (i < 0 && buf.length <= CHROME_NATIVE_MAX_BYTES) return
      done = true
      clearTimeout(timer)
      sock.removeAllListeners('data')
      if (i < 0 || i > CHROME_NATIVE_MAX_BYTES) return void sock.destroy()
      let msg: unknown = null
      try { msg = JSON.parse(buf.subarray(0, i).toString('utf8')) } catch { msg = null }
      void handlePairMessage(d, msg).then((reply) => { if (!sock.destroyed) sock.end(JSON.stringify(reply) + '\n') }, () => sock.destroy())
    })
  })
  // no app-led linking this run (the in-profile Connect still works): the host says why when someone presses Connect
  server.on('error', (e) => state('failed', e))
  server.listen(socket, () => {
    try { fs.chmodSync(socket, 0o600) } catch { /* the folder is 0700 anyway */ }
    state('listening')
  })
  return server
}
