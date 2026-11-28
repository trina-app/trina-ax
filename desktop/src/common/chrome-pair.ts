// App-led linking, the running app's end (shared/src/chrome-native.ts): the nonces the app put in the pair pages it
// opened, and the socket the native helper (desktop/native/chrome-host) relays each extension message to.
//
// What protects it (docs/decisions/20261128-chrome-app-led-linking.md):
// - the socket is in a 0700 folder of this OS user's own app data, and is 0600: another OS user cannot connect;
// - Chrome starts the helper only for the extension ids in the manifest's allowed_origins and tells it the caller
//   (argv[1]); the app checks that origin against the same ids again;
// - a nonce is 32 random bytes, lives CHROME_PAIR_NONCE_TTL_MS, is good for one `pair` (and one `linked` after it) and
//   exists only in the address of the one profile the app opened (and the browser's command line: `ps` shows it to
//   this OS user for the moment the browser's second process runs);
// - the code comes from the team page on screen, signed in, and every link shows the page's notice with Undo.
// What it cannot do: tell which profile a message comes from (Chrome does not say), or check the peer's code signature
// (Node gives no peer pid; and a process of this user could start the signed helper itself, so it would prove nothing).
// It never sees a link token or a session, and never logs a nonce or a code.
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
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

/** `<userData>/chrome/pair.sock` (the folder is 0700); null when the path is too long for a Unix socket. The helper
 * computes the same path from the app's data folder name, or takes MYCEL_CHROME_PAIR_SOCKET. */
export function chromePairSocketPath(userData: string): string | null {
  const p = path.join(userData, 'chrome', 'pair.sock')
  return Buffer.byteLength(p) <= 100 ? p : null
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
  if (!team) { d.nonces.drop(r.data.nonce); return refuse('no_team') }
  let got: { code: string } | null = null
  try { got = await d.askCode(r.data.challenge) } catch { got = null }
  if (!got || !/^[A-Za-z0-9_-]{43}$/.test(got.code)) { d.nonces.drop(r.data.nonce); return refuse('refused') }
  return { type: 'code', origin: team.origin, code: got.code, team: team.name.slice(0, 200), label: b.label, ...(b.email ? { email: b.email } : {}), browser: b.browserLabel }
}

/** how long the helper has to send its line; the reply may take longer (the page asks the team server) */
const READ_MS = 2000

/** Listen for the helper: one line in, one line out, per connection. */
export function listenForPairs(socket: string, d: PairServerDeps): net.Server {
  const dir = path.dirname(socket)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
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
  server.on('error', () => { /* no app-led linking this run: the in-profile Connect still works */ })
  server.listen(socket, () => { try { fs.chmodSync(socket, 0o600) } catch { /* the folder is 0700 anyway */ } })
  return server
}
