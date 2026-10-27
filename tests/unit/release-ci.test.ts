// The release workflow's rules (scripts/release/release-ci.ts, sign.ts; .github/workflows/release.yml,
// docs/RELEASE-CI.md): which tag releases what, the signing key must be this product's, SHA256SUMS and its signature,
// and the feed's Worker (scripts/release/worker.js) serving the Linux servers' server/ paths.
import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import { VERSION_RE } from '../../server/src/office/release'
import { verifySignature } from '../../server/src/system/update'
import { main, packageVersion, parseReleaseTag, RELEASE_VERSION_RE, sha256sums, verifySums, writeSums } from '../../scripts/release/release-ci'
import { checkSigningKey, keyIdOfRaw, publicKeyOfPem, readKeyFile, signDetached, verifyDetached } from '../../scripts/release/sign'
import { workerCode } from '../../scripts/release/worker-code'

const ROOT = path.resolve(import.meta.dir, '../..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ci-'))
afterAll(() => fs.rmSync(T, { recursive: true, force: true }))

const newPem = () => crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

describe('release tag', () => {
  test('v<version> of server/package.json; a "-" makes it beta', () => {
    expect(parseReleaseTag('v0.3.0', '0.3.0')).toEqual({ tag: 'v0.3.0', version: '0.3.0', channel: 'stable', prerelease: false })
    expect(parseReleaseTag('refs/tags/v0.3.0-beta.1', '0.3.0-beta.1')).toEqual({ tag: 'v0.3.0-beta.1', version: '0.3.0-beta.1', channel: 'beta', prerelease: true })
    expect(parseReleaseTag('v1.0.0-rc.2', '1.0.0-rc.2').channel).toBe('beta')
  })

  test('anything else is refused before anything is built', () => {
    expect(() => parseReleaseTag('v0.3.1', '0.3.0')).toThrow(/not the version in server\/package.json \(0\.3\.0\)/)
    expect(() => parseReleaseTag('v0.3.0-beta.1', '0.3.0')).toThrow(/not the version/)
    for (const bad of ['0.3.0', 'release-0.3.0', 'v0.3', 'v0.3.0.1', 'v1.2.3+build.5', 'v0.3.0-', 'v0.3.0-a..b', 'v0.3.0/../x', 'v 0.3.0', 'vv0.3.0', 'v0.3.0-beta.1.2.3.4']) {
      expect(() => parseReleaseTag(bad, bad.replace(/^v/, '')), bad).toThrow()
    }
  })

  test('a release version is exactly what the office feed accepts as a folder name', () => {
    expect(RELEASE_VERSION_RE.source).toBe(VERSION_RE.source)
  })

  test('the CLI prints the lines the workflow appends to $GITHUB_OUTPUT', async () => {
    const out: string[] = []
    const v = packageVersion()
    await main(['tag', `v${v}`], (s) => out.push(s))
    expect(out.join('')).toBe(`tag=v${v}\nversion=${v}\nchannel=${v.includes('-') ? 'beta' : 'stable'}\nprerelease=${v.includes('-')}\n`)
    await expect(main(['tag', 'v99.0.0'])).rejects.toThrow(/not the version/)
  })

  test('the workflow checks the same tag shape before it checks anything out', () => {
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')
    const re = /\[\[ "\$tag" =~ (\S+) \]\]/.exec(wf)?.[1]
    expect(re).toBeDefined()
    const bash = new RegExp(re!)
    for (const t of ['v0.3.0', 'v0.3.0-beta.1', 'v10.20.300-rc.1']) expect(bash.test(t), t).toBe(RELEASE_VERSION_RE.test(t.slice(1)))
    for (const t of ['v0.3', '0.3.0', 'v0.3.0;rm', 'v0.3.0-a..b']) expect(bash.test(t), t).toBe(false)
  })
})

describe('release key', () => {
  const pem = newPem()
  const pub = publicKeyOfPem(pem)

  test("a key of this product passes and prints only its key id", () => {
    const id = checkSigningKey(pem, [pub])
    expect(id).toBe(keyIdOfRaw(Buffer.from(pub, 'base64')))
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  test("another product's key (or a fresh one) is refused: the message names key ids, never the key", () => {
    let msg = ''
    try { checkSigningKey(pem) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain("is not one of this product's release keys")
    expect(msg).toContain(keyIdOfRaw(Buffer.from(pub, 'base64')))
    for (const k of RELEASE_CHANNEL.keys) expect(msg).toContain(keyIdOfRaw(Buffer.from(k, 'base64')))
    expect(msg).not.toContain('PRIVATE KEY')
    expect(msg).not.toContain(pem.split('\n')[1]!)
    expect(() => checkSigningKey(pem, [publicKeyOfPem(newPem())])).toThrow(/not one of this product's release keys/)
  })

  test('not an Ed25519 private key, or not a key at all: refused without echoing it', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    expect(() => checkSigningKey(rsa, [pub])).toThrow(/rsa, not Ed25519/)
    const junk = 'super-secret-token-value'
    let msg = ''
    try { checkSigningKey(junk, [pub]) } catch (e) { msg = (e as Error).message }
    expect(msg).toBe('the release key is not a private key in PEM form')
    // the public half pasted instead of the private key
    const pubPem = crypto.createPublicKey(pem).export({ format: 'pem', type: 'spki' }).toString()
    expect(() => checkSigningKey(pubPem, [pub])).toThrow()
  })

  test('the key file must be readable only by its owner (the workflow writes it with umask 077)', () => {
    const f = path.join(T, 'k.pem')
    fs.writeFileSync(f, pem, { mode: 0o644 })
    fs.chmodSync(f, 0o644)
    expect(() => readKeyFile(f)).toThrow(/readable only by you/)
    fs.chmodSync(f, 0o600)
    expect(readKeyFile(f)).toBe(pem)
  })

  test('check-key from the command line: exit 1 for a key that is not this product\'s, nothing secret in the output', () => {
    const f = path.join(T, 'other.pem')
    fs.writeFileSync(f, pem, { mode: 0o600 })
    const p = Bun.spawnSync(['bun', path.join(ROOT, 'scripts/release/release-ci.ts'), 'check-key', f], { stdout: 'pipe', stderr: 'pipe' })
    expect(p.exitCode).toBe(1)
    const all = p.stdout.toString() + p.stderr.toString()
    expect(all).toContain("not one of this product's release keys")
    expect(all).not.toContain('PRIVATE KEY')
    expect(all).not.toContain(pem.split('\n')[1]!)
  })

  test('a detached signature is the one installed servers check (update.ts verifySignature)', () => {
    const data = Buffer.from('{"version":"0.3.0"}\n')
    const sig = signDetached(data, pem)
    expect(sig).toBe(signDetached(data, pem)) // deterministic: a second run writes the same file
    expect(verifySignature(data, sig, [pub])).toBe(true)
    expect(verifyDetached(data, sig, [pub])).toBe(true)
    expect(verifyDetached(Buffer.from('{"version":"0.3.1"}\n'), sig, [pub])).toBe(false)
    expect(verifyDetached(data, sig, [publicKeyOfPem(newPem())])).toBe(false)
    expect(verifyDetached(data, 'not json', [pub])).toBe(false)
  })
})

describe('SHA256SUMS', () => {
  test('sorted by name like sha256sum, signed; a changed file or another key is caught', () => {
    const pem = newPem(), pub = publicKeyOfPem(pem)
    const d = path.join(T, 'sums')
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'b.tar.gz'), 'bbb')
    fs.writeFileSync(path.join(d, 'a-mac.zip'), 'aaa')
    const files = ['b.tar.gz', 'a-mac.zip'].map((f) => path.join(d, f))
    const text = sha256sums(files)
    expect(text).toBe(`${crypto.createHash('sha256').update('aaa').digest('hex')}  a-mac.zip\n${crypto.createHash('sha256').update('bbb').digest('hex')}  b.tar.gz\n`)
    expect(() => writeSums(d, pem, files)).toThrow(/not one of this product's release keys/) // the real channel keys
    writeSums(d, pem, files, [pub])
    expect(verifySums(path.join(d, 'SHA256SUMS'), [pub])).toEqual(['a-mac.zip', 'b.tar.gz'])
    expect(() => verifySums(path.join(d, 'SHA256SUMS'), [publicKeyOfPem(newPem())])).toThrow(/does not verify/)
    fs.writeFileSync(path.join(d, 'b.tar.gz'), 'bbX')
    expect(() => verifySums(path.join(d, 'SHA256SUMS'), [pub])).toThrow(/b\.tar\.gz does not match/)
    fs.mkdirSync(path.join(d, 'x'))
    fs.writeFileSync(path.join(d, 'x', 'a-mac.zip'), 'zzz')
    expect(() => sha256sums([...files, path.join(d, 'x', 'a-mac.zip')])).toThrow(/same name/)
  })
})

// ---------------- the feed's Worker ----------------

/** an R2 bucket binding with the parts worker.js uses */
function fakeBucket(objects: Record<string, string>) {
  return {
    async get(key: string, o: { range: Headers }) {
      if (!(key in objects)) return null
      const body = Buffer.from(objects[key]!)
      const m = /^bytes=(\d+)-(\d*)$/.exec(o.range.get('range') ?? '')
      const range = m ? { offset: Number(m[1]), length: (m[2] ? Number(m[2]) + 1 : body.length) - Number(m[1]) } : undefined
      return {
        size: body.length, httpEtag: '"e"', range,
        body: range ? body.subarray(range.offset, range.offset + range.length) : body,
        writeHttpMetadata(h: Headers) { h.set('content-type', key.endsWith('.json') || key.endsWith('.sig') ? 'application/json' : 'application/octet-stream') },
      }
    },
  }
}

async function loadWorker(dir?: string): Promise<{ fetch(req: Request, env: unknown): Promise<Response> }> {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/release/worker.js'), 'utf8')
  const f = path.join(T, `worker-${dir ?? 'office'}-${Date.now()}.mjs`)
  fs.writeFileSync(f, dir ? workerCode(src, dir) : src)
  return (await import(f)).default
}

describe('the feed Worker (scripts/release/worker.js)', () => {
  const v = '0.3.0'
  const objects: Record<string, string> = {
    'office/stable.json': '{}', [`office/${v}/TeamAX-office-${v}-mac.zip`]: 'zip', [`office/${v}/latest.yml`]: 'yml',
    'server/stable.json': '{"version":"0.3.0"}', 'server/stable.json.sig': '{}', 'server/beta.json': '{}', 'server/beta.json.sig': '{}',
    [`server/${v}/release.json`]: '{}', [`server/${v}/release.json.sig`]: '{}',
    [`server/${v}/manifest-linux-amd64.json`]: '{}', [`server/${v}/manifest-linux-amd64.json.sig`]: '{}',
    [`server/${v}/${v}-linux-amd64.tar.zst`]: '0123456789', [`server/${v}/TeamAX-server-${v}-linux-arm64.tar.gz`]: 'kit',
    'server/x.json': 'stray', 'secret/key.pem': 'nope', 'server/0.3.0/sub/file': 'deep',
  }
  const env = { BUCKET: fakeBucket(objects) }
  const get = async (w: Awaited<ReturnType<typeof loadWorker>>, p: string, init: RequestInit = {}) => w.fetch(new Request(`https://feed.example${p}`, init), env)

  test('the root says it serves server/ (publish-server.ts checks this before uploading)', async () => {
    const w = await loadWorker()
    const r = await get(w, '/')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('Updates: office/, server/\n')
  })

  test('server/: the head and every .json / .sig are never cached, update archives and kits are immutable', async () => {
    const w = await loadWorker()
    for (const p of ['server/stable.json', 'server/stable.json.sig', 'server/beta.json', 'server/beta.json.sig', `server/${v}/release.json`, `server/${v}/release.json.sig`, `server/${v}/manifest-linux-amd64.json`, `server/${v}/manifest-linux-amd64.json.sig`]) {
      const r = await get(w, '/' + p)
      expect(r.status, p).toBe(200)
      expect(r.headers.get('cache-control'), p).toBe('no-cache, no-store')
      expect(await r.text()).toBe(objects[p]!)
    }
    for (const p of [`server/${v}/${v}-linux-amd64.tar.zst`, `server/${v}/TeamAX-server-${v}-linux-arm64.tar.gz`]) {
      const r = await get(w, '/' + p)
      expect(r.status, p).toBe(200)
      expect(r.headers.get('cache-control'), p).toBe('public, max-age=31536000, immutable')
      expect(r.headers.get('content-length')).toBe(String(objects[p]!.length))
    }
    const part = await get(w, `/server/${v}/${v}-linux-amd64.tar.zst`, { headers: { range: 'bytes=2-5' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await part.text()).toBe('2345')
    const head = await get(w, '/server/stable.json', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  test('the office folder works as before', async () => {
    const w = await loadWorker()
    expect((await get(w, '/office/stable.json')).headers.get('cache-control')).toBe('no-cache, no-store')
    expect((await get(w, `/office/${v}/latest.yml`)).headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect((await get(w, `/office/${v}/TeamAX-office-${v}-mac.zip`)).status).toBe(200)
  })

  test('every other path is 404, writes are 405', async () => {
    const w = await loadWorker()
    for (const p of ['/server', '/server/', '/server/x.json', '/server/candidate.json', '/server/stable.json.bak', `/server/${v}`, `/server/${v}/`, '/server/0.3.0/sub/file',
      `/server/${v}/..%2Fstable.json`, `/server/${v}/%2e%2e/%2e%2e/secret/key.pem`, `/server/${v}/.hidden`, '/server/latest/release.json', '/server/0.3/release.json',
      '/secret/key.pem', `/other/${v}/x`, '/office/server.json', '/%E0%A4%A', '/server/stable.json/']) {
      expect((await get(w, p)).status, p).toBe(404)
    }
    for (const m of ['PUT', 'POST', 'DELETE']) expect((await get(w, '/server/stable.json', { method: m })).status, m).toBe(405)
    // dot segments are resolved by the URL itself before the Worker sees the path: they only reach paths it serves anyway
    expect(new URL(`https://feed.example/server/${v}/%2e%2e/stable.json`).pathname).toBe('/server/stable.json')
  })

  test("an edition's office folder: its own folder and server/, not office/", async () => {
    const w = await loadWorker('medical-office')
    expect(await (await get(w, '/')).text()).toBe('Updates: medical-office/, server/\n')
    expect((await get(w, '/office/stable.json')).status).toBe(404)
    expect((await get(w, '/server/stable.json')).status).toBe(200)
  })
})
