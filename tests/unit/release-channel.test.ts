// The release channel (shared/src/release-channel.ts): one place for where updates come from and which keys sign them.
// An edition changes it with scripts/edition-release.ts and nothing else (docs/EDITION-RELEASE.md).
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import { keyIdOf, main, parseReleaseChannel, renderChannelTs, renderGoKeys, TARGETS } from '../../scripts/edition-release'
import { workerCode } from '../../scripts/release/worker-code'
import { DEFAULT_FEED, fileUrl, manifestUrl, OFFICE_PRODUCT, OFFICE_RELEASE_KEYS } from '../../server/src/office/release'
import { RELEASE_KEYS } from '../../server/src/system/release-keys'
import { RELEASE_PUBLIC_KEYS } from '../../server/src/system/update'

const ROOT = path.resolve(import.meta.dir, '../..')
const channel = () => JSON.parse(JSON.stringify(RELEASE_CHANNEL)) as ReturnType<typeof parseReleaseChannel>
const newKey = () => (crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12).toString('base64')

describe('release channel', () => {
  test('both source files are exactly what scripts/edition-release.ts writes for it', () => {
    expect(parseReleaseChannel(channel())).toEqual(channel())
    expect(fs.readFileSync(path.join(ROOT, TARGETS.ts), 'utf8')).toBe(renderChannelTs(channel()))
    expect(fs.readFileSync(path.join(ROOT, TARGETS.go), 'utf8')).toBe(renderGoKeys(channel()))
  })

  test('the office updater, the server updater and the release scripts all read it', () => {
    const c = RELEASE_CHANNEL
    expect(DEFAULT_FEED).toBe(c.feed)
    expect(OFFICE_PRODUCT).toBe(c.officeProduct)
    expect([...OFFICE_RELEASE_KEYS]).toEqual([...c.keys])
    expect([...RELEASE_KEYS]).toEqual([...c.keys])
    expect([...RELEASE_PUBLIC_KEYS]).toEqual([...c.keys])
    expect(manifestUrl(c.feed, 'stable')).toBe(`${c.feed}/${c.officeDir}/stable.json`)
    expect(fileUrl(c.feed, '1.2.3', 'a.zip')).toBe(`${c.feed}/${c.officeDir}/1.2.3/a.zip`)
    expect(workerCode(fs.readFileSync(path.join(ROOT, 'scripts/release/worker.js'), 'utf8'))).toContain(`const DIR = '${c.officeDir}'`)
  })

  test("an edition's channel file, when the repository has one, is the one applied", () => {
    const editions = path.join(ROOT, 'editions')
    const files = fs.existsSync(editions)
      ? fs.readdirSync(editions).map((e) => path.join(editions, e, 'branding', 'release-channel.json')).filter((f) => fs.existsSync(f))
      : []
    expect(files.length).toBeLessThanOrEqual(1)
    for (const f of files) expect(parseReleaseChannel(JSON.parse(fs.readFileSync(f, 'utf8')))).toEqual(channel())
  })

  test('no other source names the feed, the bucket or a key (so an edition changes only the channel)', () => {
    const host = new URL(RELEASE_CHANNEL.feed).hostname
    const needles = [host, RELEASE_CHANNEL.hosting.bucket, ...RELEASE_CHANNEL.keys]
    const skip = new Set(['node_modules', 'dist', 'build', 'release', '.work', 'test-results', 'playwright-report', '.expo', 'ios', 'android', 'vendor'])
    const own = new Set<string>([TARGETS.ts, TARGETS.go])
    const hits: string[] = []
    const walk = (rel: string) => {
      for (const d of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const r = path.join(rel, d.name)
        if (d.isDirectory()) { if (!skip.has(d.name) && !d.name.startsWith('.')) walk(r); continue }
        if (!/\.(ts|tsx|js|mjs|cjs|go|sh|swift)$/.test(d.name) || own.has(r)) continue
        const text = fs.readFileSync(path.join(ROOT, r), 'utf8')
        for (const n of needles) if (text.includes(n)) hits.push(`${r}: ${n.length > 20 ? 'a release key' : n}`)
      }
    }
    for (const top of ['server', 'shared', 'scripts', 'native', 'desktop', 'web/src', 'menubar', 'relay', 'mobile/src', 'ee']) if (fs.existsSync(path.join(ROOT, top))) walk(top)
    expect(hits).toEqual([])
  })

  test('the tool refuses a channel that is not one', () => {
    const bad: [string, (c: Record<string, unknown> & ReturnType<typeof channel>) => void][] = [
      ['extra field', (c) => { c.extra = 1 }],
      ['http feed', (c) => { c.feed = 'http://' + new URL(c.feed).hostname }],
      ['feed with a path', (c) => { c.feed = c.feed + '/x' }],
      ['feed with a trailing slash', (c) => { c.feed = c.feed + '/' }],
      ['feed with a port', (c) => { c.feed = c.feed + ':8443' }],
      ['feed outside the zone', (c) => { c.feed = 'https://updates.example.org' }],
      ['no key', (c) => { c.keys = [] }],
      ['short key', (c) => { c.keys = [Buffer.alloc(31).toString('base64')] }],
      ['same key twice', (c) => { c.keys = [c.keys[0], c.keys[0]] }],
      ['five keys', (c) => { c.keys = [newKey(), newKey(), newKey(), newKey(), newKey()] }],
      ['product without -office', (c) => { c.officeProduct = 'teamax' }],
      ['product with a quote', (c) => { c.officeProduct = "a'-office" }],
      ['office folder named server', (c) => { c.officeDir = 'server' }],
      ['office folder with a slash', (c) => { c.officeDir = 'a/b' }],
      ['key folder ..', (c) => { c.keyDir = '..' }],
      ['key folder with a slash', (c) => { c.keyDir = 'a/b' }],
      ['bucket with capitals', (c) => { c.hosting = { ...c.hosting, bucket: 'Teamax' } }],
      ['hosting with an extra field', (c) => { c.hosting = { ...c.hosting, account: 'x' } as typeof c.hosting }],
    ]
    for (const [what, change] of bad) {
      const c = channel() as Record<string, unknown> & ReturnType<typeof channel>
      change(c)
      expect(() => parseReleaseChannel(c), what).toThrow()
    }
  })

  test('--apply writes both files from an edition file; a second run changes nothing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-channel-'))
    try {
      for (const t of Object.values(TARGETS)) fs.mkdirSync(path.join(tmp, path.dirname(t)), { recursive: true })
      const k = newKey()
      const edition = { feed: 'https://updates.example.com', keys: [k], officeProduct: 'example-office', officeDir: 'office', keyDir: 'example-release', hosting: { zone: 'example.com', bucket: 'example-updates', worker: 'example-updates' } }
      const json = path.join(tmp, 'release-channel.json')
      fs.writeFileSync(json, JSON.stringify(edition))
      const out: string[] = []
      const write = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((s: string) => { out.push(s); return true }) as typeof process.stdout.write
      try {
        main([json], tmp)
        expect(fs.existsSync(path.join(tmp, TARGETS.ts))).toBe(false) // a check writes nothing
        main([json, '--apply'], tmp)
        main([json, '--apply'], tmp)
      } finally { process.stdout.write = write }
      expect(out.map((s) => JSON.parse(s).changed.length)).toEqual([2, 2, 0])
      const ts = fs.readFileSync(path.join(tmp, TARGETS.ts), 'utf8'), go = fs.readFileSync(path.join(tmp, TARGETS.go), 'utf8')
      expect(ts).toBe(renderChannelTs(edition))
      expect(go).toBe(renderGoKeys(edition))
      expect(ts).toContain(`"${k}", // key id ${keyIdOf(k)}`)
      expect(go).toContain(`\t"${k}", // key id ${keyIdOf(k)}`)
      expect(ts).not.toContain('treesoop')
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  test('the deployed Worker serves only the channel folder', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/release/worker.js'), 'utf8')
    expect(workerCode(src, 'medical-office')).toContain("const DIR = 'medical-office'")
    expect(() => workerCode(src, "x'; evil()")).toThrow()
    expect(() => workerCode(src.replace("const DIR = 'office'", ''), 'office')).toThrow()
  })
})
