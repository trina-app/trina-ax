// The free-roam demo's snapshot (scripts/demo/free-roam/build-snapshot.ts) and canary (canary.ts). A real development
// server is started on a fresh base folder, seeded with Steepling at the end of the story (no AI), scrubbed and checked
// on a clone; the snapshot must hold no setup token, owner password, session or WAL, a clone must boot and Mina must
// sign in through the persona switch, and the layout must be the one the demo gate reads
// (<out>/<locale>/<name>/{manifest.json, base/}).
import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiClient, CSRF_HEADER } from '../../shared/src/api'
import { buildSnapshot, gateLikeConfig, hygieneProblems, SIGN_IN_TABLES, type Manifest } from '../../scripts/demo/free-roam/build-snapshot'
import { LEAK_PROMPTS, readSealed, scan } from '../../scripts/demo/free-roam/canary'
import { baseLayout, cloneBase, shortTemp, startInstance } from '../../scripts/demo/free-roam/instance'

const tmp = shortTemp('frt')
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('the snapshot of Steepling (en)', () => {
  let dir = ''
  let manifest: Manifest
  const base = () => path.join(dir, 'base')

  test('builds, verified on a clone, in the layout the gate reads', async () => {
    const r = await buildSnapshot({ content: 'steepling', locale: 'en', out: path.join(tmp, 'snaps'), name: 'test', log: () => {} })
    dir = r.dir
    manifest = r.manifest
    expect(dir).toBe(path.join(tmp, 'snaps', 'en', 'test'))
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))).toEqual(manifest)
    expect(manifest).toMatchObject({ locale: 'en', config: 'config/server.json', demoFile: 'demo.json', content: { id: 'steepling' } })
    expect(manifest.codeVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(Number.isNaN(Date.parse(manifest.createdAt))).toBe(false)
    expect(manifest.content.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.checks?.join('\n')).toContain('signs in through the persona switch')
    for (const p of [manifest.config, manifest.demoFile, 'data/app.db', 'team', 'fakes/gmail.json', 'fakes/drive.json']) expect(fs.existsSync(path.join(base(), p)), p).toBe(true)
  }, 300_000)

  test('hygiene: no setup token, owner password, sessions or WAL; the builder is off; the fakes have times and ids', () => {
    expect(hygieneProblems(base())).toEqual([])
    const L = baseLayout(base())
    expect(fs.existsSync(path.join(L.data, 'setup-token'))).toBe(false)
    expect(fs.readdirSync(base(), { recursive: true }).map(String).filter((f) => /owner-password/.test(f))).toEqual([])
    const db = new Database(path.join(L.data, 'app.db'), { readonly: true })
    try {
      for (const t of SIGN_IN_TABLES) {
        const there = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
        if (there) expect((db.query(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n, t).toBe(0)
      }
    } finally { db.close() }
    expect(JSON.parse(fs.readFileSync(L.demo, 'utf8')).builder).toBeUndefined()
    const gmail = JSON.parse(fs.readFileSync(path.join(L.fakes, 'gmail.json'), 'utf8'))
    // the fakes' own shapes (server/src/demo/fakes/gmail.ts, drive.ts) with ISO times of the build, and Higgsfield's picture
    expect(gmail.me.email).toBe('mina.lee@steepling.example')
    expect(gmail.messages.every((m: { date: string }) => /^\d{4}-\d\d-\d\dT/.test(m.date))).toBe(true)
    expect(gmail.messages.find((m: { labels?: string[] }) => m.labels?.includes('SENT')).attachments).toEqual(['launch-banner-new.jpg', 'instagram-square.jpg'])
    const drive = JSON.parse(fs.readFileSync(path.join(L.fakes, 'drive.json'), 'utf8'))
    expect(drive.files.length).toBeGreaterThan(1)
    expect(fs.readdirSync(path.join(L.fakes, 'higgsfield')).length).toBe(1)
    // a free-roam demo file: one person, the suggestions, the fakes' folder; the file list off, the AI through the gate
    const demo = JSON.parse(fs.readFileSync(L.demo, 'utf8'))
    expect(demo).toMatchObject({ kind: 'freeRoam', fakes: { content: 'fakes' }, signupUrl: 'https://ax.trina.app/pricing' })
    expect(demo.personas.map((p: { username: string }) => p.username)).toEqual(['mina'])
    expect(demo.freeRoam.suggestions.length).toBe(3)
    expect(JSON.parse(fs.readFileSync(L.config, 'utf8'))).toMatchObject({ engine: { authMode: 'managed' }, fileList: { enabled: false }, dataDir: '../data', teamRoot: '../team' })
    // a snapshot that was not scrubbed is told apart
    const dirty = path.join(tmp, 'dirty')
    cloneBase(base(), dirty)
    fs.writeFileSync(path.join(dirty, 'data', 'setup-token'), 'x')
    expect(hygieneProblems(dirty).join('\n')).toContain('setup-token')
  })

  test('a clone boots and Mina signs in (the gate\'s way: only MYCEL_CONFIG and MYCEL_DEMO point at it)', async () => {
    const clone = path.join(tmp, 'clone')
    cloneBase(base(), clone)
    await gateLikeConfig(clone)
    const inst = await startInstance(clone)
    try {
      const r = await fetch(`${inst.url}/api/demo/persona`, { method: 'POST', headers: { 'content-type': 'application/json', origin: inst.url, [CSRF_HEADER]: '1' }, body: JSON.stringify({ key: 'newHire' }) })
      expect(r.status).toBe(200)
      const cookie = r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ')
      const api = new ApiClient({ baseUrl: inst.url, fetch: ((u: string | URL | Request, init?: RequestInit) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie } })) as typeof fetch })
      expect((await api.call(API.me)).user.username).toBe('mina')
      // the data and the team folder are the clone's own, from its server.json
      expect(fs.existsSync(path.join(clone, 'data', 'app.db'))).toBe(true)
    } finally { await inst.stop() }
  }, 120_000)

  test('the canary: a sealed string planted in a copy is found, the snapshot has none of a made-up account', () => {
    const sealed = path.join(tmp, 'sealed.txt')
    fs.writeFileSync(sealed, '# made-up account\nsomebody.real@account-owner.test\norg-0000-made-up\n', { mode: 0o600 })
    const strings = readSealed(sealed)
    expect(strings).toEqual(['somebody.real@account-owner.test', 'org-0000-made-up'])
    expect(scan(base(), strings)).toEqual([])
    const copy = path.join(tmp, 'planted')
    cloneBase(base(), copy)
    fs.writeFileSync(path.join(copy, 'team', 'note.md'), 'mail SOMEBODY.real@account-owner.test')
    expect(scan(copy, strings)).toEqual([{ file: path.join('team', 'note.md'), string: 1 }])
    fs.chmodSync(sealed, 0o644)
    expect(() => readSealed(sealed)).toThrow(/chmod 600/)
    expect(LEAK_PROMPTS.length).toBe(10)
  })
})
