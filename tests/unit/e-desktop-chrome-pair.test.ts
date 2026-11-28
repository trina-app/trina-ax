// App-led linking of the <app> in Chrome extension, the running app's socket (desktop/src/common/chrome-pair.ts) and
// the native helper (desktop/native/chrome-host, when built: bash desktop/native/chrome-host/build.sh). Security cases
// of the review: a wrong origin, a replayed or expired nonce, malformed and oversize lines, the app not running, a
// nonce for profile A shown from profile B (what the app can and cannot tell), and the socket closed to other OS users.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { CHROME_EXTENSION_IDS, CHROME_NATIVE_MAX_BYTES, CHROME_PAIR_NONCE_TTL_MS, type ChromeNativeReply } from '@mycel/shared/chrome-native'
import { chromePairSocketPath, handlePairMessage, listenForPairs, NonceStore, type PairBinding, type PairServerDeps } from '../../desktop/src/common/chrome-pair'
import { ChromeProfilesHost, type PageLike } from '../../desktop/src/main/chrome-profiles'

const ORIGIN = `chrome-extension://${CHROME_EXTENSION_IDS.dev}/`
const secret = () => crypto.randomBytes(32).toString('base64url')
const A: PairBinding = { browser: 'chrome', dir: 'Default', label: 'Work', email: 'mina@acme.test', browserLabel: 'Chrome on Mac', teamOrigin: 'https://acme.trina.test' }
const B: PairBinding = { browser: 'chrome', dir: 'Profile 2', label: 'Home', browserLabel: 'Chrome on Mac', teamOrigin: 'https://acme.trina.test' }
const HELPER = path.join(import.meta.dir, '../../desktop/native-build/chrome-host')

const cleanup: (() => void)[] = []
afterEach(() => { for (const f of cleanup.splice(0)) f() })
const tmp = () => {
  // short: a Unix socket path is at most 104 bytes on macOS
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chp-'))
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function deps(o: Partial<PairServerDeps> & { now?: () => number } = {}) {
  const linked: unknown[] = []
  const asked: string[] = []
  const d: PairServerDeps = {
    nonces: o.nonces ?? new NonceStore(o.now),
    ids: () => [CHROME_EXTENSION_IDS.dev],
    team: () => ({ origin: 'https://acme.trina.test', name: 'Acme' }),
    askCode: async (c) => { asked.push(c); return { code: secret() } },
    linked: (l) => linked.push(l),
    ...o,
  }
  return { d, linked, asked }
}

describe('nonces', () => {
  test('single use, bound, expire; linked once and only after pair', () => {
    let now = 1000
    const s = new NonceStore(() => now)
    const n = s.mint(A)
    expect(n).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(s.linked(n)).toBeNull()
    expect(s.take(n)).toEqual(A)
    expect(s.take(n)).toBeNull()
    expect(s.linked(n)).toEqual(A)
    expect(s.linked(n)).toBeNull()
    const late = s.mint(B)
    now += CHROME_PAIR_NONCE_TTL_MS + 1
    expect(s.take(late)).toBeNull()
    expect(s.take(secret())).toBeNull()
    expect(s.mint(A)).not.toBe(n)
  })
})

describe('messages', () => {
  const pair = (nonce: string, origin = ORIGIN) => ({ origin, request: { type: 'pair', nonce, challenge: secret() } })

  test('pair: a code for the team on screen, named from the nonce\'s profile; then linked once', async () => {
    const { d, linked, asked } = deps()
    const n = d.nonces.mint(A)
    const msg = pair(n)
    const r = await handlePairMessage(d, msg)
    expect(r).toMatchObject({ type: 'code', origin: 'https://acme.trina.test', team: 'Acme', label: 'Work', email: 'mina@acme.test', browser: 'Chrome on Mac' })
    expect(asked).toEqual([msg.request.challenge])
    expect(await handlePairMessage(d, { origin: ORIGIN, request: { type: 'linked', nonce: n, linkId: 'cl_1' } })).toEqual({ type: 'ok' })
    expect(linked).toEqual([{ linkId: 'cl_1', label: 'Work', browser: 'Chrome on Mac' }])
    expect(await handlePairMessage(d, { origin: ORIGIN, request: { type: 'linked', nonce: n, linkId: 'cl_2' } })).toEqual({ type: 'error', reason: 'bad_nonce' })
  })

  test('replayed, expired, unknown nonce: bad_nonce, and the page is never asked', async () => {
    let now = 0
    const { d, asked } = deps({ now: () => now })
    const n = d.nonces.mint(A)
    await handlePairMessage(d, pair(n))
    expect(await handlePairMessage(d, pair(n))).toEqual({ type: 'error', reason: 'bad_nonce' })
    const old = d.nonces.mint(A)
    now += CHROME_PAIR_NONCE_TTL_MS + 1
    expect(await handlePairMessage(d, pair(old))).toEqual({ type: 'error', reason: 'bad_nonce' })
    expect(await handlePairMessage(d, pair(secret()))).toEqual({ type: 'error', reason: 'bad_nonce' })
    expect(asked.length).toBe(1)
  })

  test('wrong origin (another extension, a prefix, a web page, none): refused before the nonce is looked at', async () => {
    const { d, asked } = deps()
    const n = d.nonces.mint(A)
    for (const o of [`chrome-extension://${'a'.repeat(32)}/`, `chrome-extension://${CHROME_EXTENSION_IDS.dev}`, `chrome-extension://${CHROME_EXTENSION_IDS.dev}/x`, 'https://evil.test/', '', undefined]) {
      expect(await handlePairMessage(d, { origin: o, request: { type: 'pair', nonce: n, challenge: secret() } })).toEqual({ type: 'error', reason: 'refused' })
    }
    expect(asked).toEqual([])
    // the nonce is still good for the real extension
    expect((await handlePairMessage(d, pair(n))).type).toBe('code')
  })

  test('the dev id is not let in when the app allows store ids only', async () => {
    const { d } = deps({ ids: () => [] })
    expect(await handlePairMessage(d, pair(d.nonces.mint(A)))).toEqual({ type: 'error', reason: 'refused' })
  })

  test('malformed requests are refused', async () => {
    const { d } = deps()
    const n = d.nonces.mint(A)
    for (const m of [null, 'x', {}, { origin: ORIGIN }, { origin: ORIGIN, request: { type: 'pair', nonce: n } }, { origin: ORIGIN, request: { type: 'pair', nonce: 'short', challenge: secret() } }, { origin: ORIGIN, request: { type: 'pair', nonce: n, challenge: secret(), extra: 1 } }, { origin: ORIGIN, request: { type: 'token' } }]) {
      expect(await handlePairMessage(d, m)).toEqual({ type: 'error', reason: 'refused' })
    }
  })

  test('no team page signed in: no_team; the page says no: refused; neither leaves the nonce usable', async () => {
    const t = deps({ team: () => null })
    const n1 = t.d.nonces.mint(A)
    expect(await handlePairMessage(t.d, pair(n1))).toEqual({ type: 'error', reason: 'no_team' })
    expect(t.asked).toEqual([])
    expect(await handlePairMessage(t.d, { origin: ORIGIN, request: { type: 'linked', nonce: n1, linkId: 'x' } })).toEqual({ type: 'error', reason: 'bad_nonce' })
    const r = deps({ askCode: async () => null })
    expect(await handlePairMessage(r.d, pair(r.d.nonces.mint(A)))).toEqual({ type: 'error', reason: 'refused' })
    const bad = deps({ askCode: async () => ({ code: 'not a code' }) })
    expect(await handlePairMessage(bad.d, pair(bad.d.nonces.mint(A)))).toEqual({ type: 'error', reason: 'refused' })
    const thrown = deps({ askCode: async () => { throw new Error('x') } })
    expect(await handlePairMessage(thrown.d, pair(thrown.d.nonces.mint(A)))).toEqual({ type: 'error', reason: 'refused' })
  })

  test('profile A\'s nonce shown from profile B: the app cannot tell (Chrome does not name the profile), but the link is named A\'s and the nonce is spent', async () => {
    // The nonce exists only in the address of the page the app opened in profile A (and, briefly, the browser's command
    // line). Profile B learns it only if something reads A's tab or this user's process list; that something could also
    // read this user's files. What the app guarantees: one link per nonce, named as profile A, shown with Undo.
    const { d } = deps()
    const n = d.nonces.mint(A)
    d.nonces.mint(B)
    const r = await handlePairMessage(d, pair(n)) as Extract<ChromeNativeReply, { type: 'code' }>
    expect(r.label).toBe('Work')
    expect(await handlePairMessage(d, pair(n))).toEqual({ type: 'error', reason: 'bad_nonce' })
  })
})

async function line(socket: string, data: string | Buffer, wait = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    const s = net.createConnection(socket)
    let got = ''
    const t = setTimeout(() => { s.destroy(); resolve(got || null) }, wait)
    s.on('data', (c) => { got += c.toString() })
    s.on('close', () => { clearTimeout(t); resolve(got || null) })
    s.on('error', () => {})
    s.on('connect', () => s.write(data))
  })
}

describe('review fixes', () => {
  test('the team switched between opening the profile and its pair: no_team, the nonce is spent, the page is never asked', async () => {
    const t = deps({ team: () => ({ origin: 'https://other.trina.test', name: 'Other' }) })
    const n = t.d.nonces.mint(A)
    expect(await handlePairMessage(t.d, { origin: ORIGIN, request: { type: 'pair', nonce: n, challenge: secret() } })).toEqual({ type: 'error', reason: 'no_team' })
    expect(t.asked).toEqual([])
    expect(t.d.nonces.take(n)).toBeNull()
  })
  test('names: the browser\'s own profile name (never the email), cut to 60 UTF-16 units without breaking an emoji, no control characters', async () => {
    const { chromeProfileLabel, cutLabel, ChromeNativeReply } = await import('@mycel/shared/chrome-native')
    expect(chromeProfileLabel('Person 1', 'Chrome on Mac')).toBe('Person 1')
    expect(chromeProfileLabel('', 'Chrome on Mac')).toBe('Chrome on Mac')
    expect(chromeProfileLabel('Work\u2028mail\n', 'Chrome on Mac')).toBe('Work mail')
    const emoji = '😀'.repeat(40)
    const cut = cutLabel(emoji)
    expect(cut.length).toBe(60)
    expect(cut).toBe('😀'.repeat(30))
    expect(ChromeNativeReply.safeParse({ type: 'code', origin: 'https://a.test', code: secret(), team: 'A', label: chromeProfileLabel(emoji, 'Chrome on Mac'), browser: 'Chrome on Mac' }).success).toBe(true)
  })
})

describe('socket', () => {
  function serve(o: Partial<PairServerDeps> = {}) {
    const dir = tmp()
    const socket = chromePairSocketPath(dir)!
    const t = deps(o)
    const server = listenForPairs(socket, t.d)
    cleanup.unshift(() => server.close())
    return { ...t, socket, dir, ready: new Promise<void>((r) => server.once('listening', () => r())) }
  }

  test('a 0700 folder and a 0600 socket of this OS user: another OS user cannot connect', async () => {
    const s = serve()
    await s.ready
    const dir = fs.statSync(path.dirname(s.socket))
    const sock = fs.statSync(s.socket)
    expect(dir.mode & 0o777).toBe(0o700)
    expect(sock.mode & 0o777).toBe(0o600)
    expect(dir.uid).toBe(os.userInfo().uid)
    expect(sock.uid).toBe(os.userInfo().uid)
    expect(sock.isSocket()).toBe(true)
  })

  test('one line in, one reply out; malformed and oversize lines get nothing useful', async () => {
    const s = serve()
    await s.ready
    const n = s.d.nonces.mint(A)
    const r = JSON.parse((await line(s.socket, JSON.stringify({ origin: ORIGIN, request: { type: 'pair', nonce: n, challenge: secret() } }) + '\n'))!)
    expect(r).toMatchObject({ type: 'code', label: 'Work' })
    expect(JSON.parse((await line(s.socket, 'not json\n'))!)).toEqual({ type: 'error', reason: 'refused' })
    // larger than a native message may be: the connection is closed without a reply
    expect(await line(s.socket, 'x'.repeat(CHROME_NATIVE_MAX_BYTES + 10))).toBeNull()
    expect(await line(s.socket, JSON.stringify({ origin: ORIGIN, pad: 'x'.repeat(CHROME_NATIVE_MAX_BYTES) }) + '\n')).toBeNull()
    // no line at all: closed after the read timeout
    const t0 = Date.now()
    expect(await line(s.socket, '{"origin":', 5000)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(4000)
  })
})

describe('the host and the page', () => {
  test('the page on screen is asked, only its own answer counts, and a page that does not answer is refused in time', async () => {
    const sent: { channel: string; payload: any }[] = []
    const page: PageLike = { send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false }
    const other: PageLike = { send: () => {}, isDestroyed: () => false }
    const host = new ChromeProfilesHost({ userData: tmp(), dataDirName: 'X', dev: true, execPath: '/x', team: () => ({ origin: 'https://acme.trina.test', name: 'Acme', page }), askMs: 300 })
    host.start()
    cleanup.unshift(() => host.stop())
    await Bun.sleep(50)
    const n = host.nonces.mint(A)
    const challenge = secret()
    const reply = line(host.socket!, JSON.stringify({ origin: ORIGIN, request: { type: 'pair', nonce: n, challenge } }) + '\n')
    while (!sent.length) await Bun.sleep(5)
    expect(sent[0]).toMatchObject({ channel: 'bridge:chrome-pair-request', payload: { challenge } })
    const code = secret()
    host.answer(other, sent[0]!.payload.id, { code: secret() })
    host.answer(page, sent[0]!.payload.id, { code })
    host.answer(page, sent[0]!.payload.id, { code: secret() })
    expect(JSON.parse((await reply)!)).toMatchObject({ type: 'code', code, team: 'Acme', origin: 'https://acme.trina.test' })
    expect(JSON.parse((await line(host.socket!, JSON.stringify({ origin: ORIGIN, request: { type: 'linked', nonce: n, linkId: 'cl_9' } }) + '\n'))!)).toEqual({ type: 'ok' })
    expect(sent[1]).toEqual({ channel: 'bridge:chrome-linked', payload: { linkId: 'cl_9', label: 'Work', browser: 'Chrome on Mac' } })
    // nobody answers: refused after askMs
    const n2 = host.nonces.mint(A)
    expect(JSON.parse((await line(host.socket!, JSON.stringify({ origin: ORIGIN, request: { type: 'pair', nonce: n2, challenge } }) + '\n'))!)).toEqual({ type: 'error', reason: 'refused' })
  })
})

// the real helper (built on a Mac with bash desktop/native/chrome-host/build.sh)
const helperBuilt = process.platform === 'darwin' && fs.existsSync(HELPER)
describe.skipIf(!helperBuilt)('the native helper', () => {
  function frame(o: unknown) {
    const b = Buffer.from(JSON.stringify(o))
    const h = Buffer.alloc(4)
    h.writeUInt32LE(b.length)
    return Buffer.concat([h, b])
  }
  /** run the helper as Chrome does: the origin as argv[1], framed messages on stdin; its framed replies */
  function run(socket: string, origin: string, input: Buffer, count: number): Promise<unknown[]> {
    return new Promise((resolve) => {
      const child = spawn(HELPER, [origin], { env: { ...process.env, MYCEL_CHROME_PAIR_SOCKET: socket }, stdio: ['pipe', 'pipe', 'ignore'] })
      let out = Buffer.alloc(0)
      const replies: unknown[] = []
      child.stdout.on('data', (c: Buffer) => {
        out = Buffer.concat([out, c])
        while (out.length >= 4 && out.length >= 4 + out.readUInt32LE(0)) {
          const n = out.readUInt32LE(0)
          replies.push(JSON.parse(out.subarray(4, 4 + n).toString()))
          out = out.subarray(4 + n)
          if (replies.length === count) child.stdin.end()
        }
      })
      child.on('close', () => resolve(replies))
      child.stdin.write(input)
      if (count === 0) child.stdin.end()
    })
  }

  test('pair and linked through the helper and the app\'s socket, one message each, as Chrome sends them', async () => {
    const dir = tmp()
    const socket = chromePairSocketPath(dir)!
    const t = deps()
    const server = listenForPairs(socket, t.d)
    cleanup.unshift(() => server.close())
    await new Promise((r) => server.once('listening', r))
    const n = t.d.nonces.mint(A)
    const [r1] = await run(socket, ORIGIN, frame({ type: 'pair', nonce: n, challenge: secret() }), 1)
    expect(r1).toMatchObject({ type: 'code', team: 'Acme', label: 'Work', email: 'mina@acme.test', browser: 'Chrome on Mac' })
    // the helper passes Chrome's origin as it got it: the app refuses another extension
    const [r2] = await run(socket, `chrome-extension://${'b'.repeat(32)}/`, frame({ type: 'linked', nonce: n, linkId: 'cl_1' }), 1)
    expect(r2).toEqual({ type: 'error', reason: 'refused' })
    const [r3] = await run(socket, ORIGIN, frame({ type: 'linked', nonce: n, linkId: 'cl_1' }), 1)
    expect(r3).toEqual({ type: 'ok' })
    expect(t.linked).toEqual([{ linkId: 'cl_1', label: 'Work', browser: 'Chrome on Mac' }])
    // two messages on one stdin: both answered (a replay is bad_nonce)
    const two = await run(socket, ORIGIN, Buffer.concat([frame({ type: 'pair', nonce: n, challenge: secret() }), frame({ type: 'pair', nonce: n, challenge: secret() })]), 2)
    expect(two).toEqual([{ type: 'error', reason: 'bad_nonce' }, { type: 'error', reason: 'bad_nonce' }])
  })

  test('the app is not running: app_not_running', async () => {
    const socket = path.join(tmp(), 'none.sock')
    expect(await run(socket, ORIGIN, frame({ type: 'pair', nonce: secret(), challenge: secret() }), 1)).toEqual([{ type: 'error', reason: 'app_not_running' }])
  })

  test('a message larger than the limit ends the helper without a reply; not JSON is refused', async () => {
    const socket = path.join(tmp(), 'none.sock')
    const h = Buffer.alloc(4)
    h.writeUInt32LE(CHROME_NATIVE_MAX_BYTES + 1)
    expect(await run(socket, ORIGIN, h, 0)).toEqual([])
    const junk = Buffer.from('{nope')
    const jh = Buffer.alloc(4)
    jh.writeUInt32LE(junk.length)
    expect(await run(socket, ORIGIN, Buffer.concat([jh, junk]), 1)).toEqual([{ type: 'error', reason: 'refused' }])
  })
})
