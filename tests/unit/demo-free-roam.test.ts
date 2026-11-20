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
import { buildSnapshot, gateLikeConfig, hygieneProblems, SIGN_IN_TABLES, SNAPSHOT_MODEL, type Manifest } from '../../scripts/demo/free-roam/build-snapshot'
import { LEAK_PROMPTS, PUBLIC_PAGES, askLeakPrompts, checkAllow, maskAllowed, readSealed, scan, scanPublicPages, sealedIn } from '../../scripts/demo/free-roam/canary'
import { HIGGSFIELD_TOOLS } from '../../server/src/demo/fakes/higgsfield'
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
      // the team's default model is pinned to Sonnet (a subscription turn would otherwise start on Opus)
      const setting = (k: string) => JSON.parse((db.query('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | null)?.value ?? 'null')
      expect(setting('defaultModel')).toBe(SNAPSHOT_MODEL)
      expect(SNAPSHOT_MODEL).toBe('sonnet')
      // the screens show Steepling and Mina (never a fixture's names)
      expect(setting('teamName')).toBe('Steepling')
      expect((db.query("SELECT name FROM users WHERE lower(username) = 'mina'").get() as { name: string }).name).toMatch(/^Mina\b/)
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
    // the team's Higgsfield keeps the fake's tool list, so the AI has its image tool (QA TC-5559)
    const hf = new Database(path.join(L.data, 'app.db'), { readonly: true })
    try {
      const row = hf.query("SELECT tools_json FROM integrations WHERE slug = 'higgsfield' AND scope = 'team'").get() as { tools_json: string } | null
      const saved = JSON.parse(row?.tools_json ?? '[]') as { name: string; inputSchema: unknown }[]
      expect(saved.length).toBeGreaterThan(0)
      expect(saved.map((t) => t.name)).toEqual(HIGGSFIELD_TOOLS.map((t) => t.name))
      expect(saved.every((t) => typeof t.inputSchema === 'object')).toBe(true)
    } finally { hf.close() }
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

describe('the canary\'s leak prompts (a stand-in instance; the real one needs the AI and is a hosting step)', () => {
  test('each prompt in a new chat; a sealed string in the streamed text or a tool step is found; nothing else is', async () => {
    const strings = ['somebody.real@account-owner.test', 'org-0000-made-up']
    let socket: import('bun').ServerWebSocket<unknown> | null = null
    const asked: string[] = []
    let n = 0
    const id = () => `0190a000-0000-7000-8000-${String(++n).padStart(12, '0')}`
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(req, srv) {
        const u = new URL(req.url)
        if (req.headers.get('cookie') !== 'mycel-dev-sid=visitor' || req.headers.get('origin') !== 'https://demo.trina.app') return new Response('{}', { status: 401 })
        if (u.pathname === '/api/ws') return srv.upgrade(req, { headers: { 'sec-websocket-protocol': 'mycel.v1' } }) ? undefined : new Response('no', { status: 400 })
        if (req.method === 'POST' && u.pathname === '/api/chats') return Response.json({ id: id() }, { status: 201 })
        const m = /^\/api\/chats\/([0-9a-f-]+)\/messages$/.exec(u.pathname)
        if (m && req.method === 'GET') return Response.json({ items: [] })
        if (m && req.method === 'POST') {
          if (req.headers.get(CSRF_HEADER) !== '1') return new Response('{}', { status: 403 })
          const { content } = await req.json() as { content: string }
          asked.push(content)
          const messageId = id()
          const k = asked.length
          setTimeout(() => {
            const send = (type: string, data: object) => socket?.send(JSON.stringify({ type, seq: 0, data: { chatId: m[1], messageId, ...data } }))
            // prompt 5 leaks in the answer text (another case), prompt 3 inside a tool step; the rest are clean
            send('message.delta', { offset: 0, text: k === 5 ? 'The org is ORG-0000-MADE-UP.' : 'I cannot tell you that.' })
            if (k === 3) send('message.step', { step: { id: 's1', tool: 'read', output: 'token for somebody.real@account-owner.test' } })
            send('message.done', { status: 'done', message: { id: messageId, content: 'done' } })
          }, 20)
          return Response.json({ userMessage: null, assistantMessage: { id: messageId } }, { status: 202 })
        }
        return new Response('{}', { status: 404 })
      },
      websocket: { open(ws) { socket = ws }, message() {} },
    })
    try {
      const lines: string[] = []
      const r = await askLeakPrompts({ url: `http://127.0.0.1:${server.port}`, cookie: 'mycel-dev-sid=visitor', origin: 'https://demo.trina.app', strings, timeoutMs: 5000, log: (s) => lines.push(s) })
      expect(asked).toEqual([...LEAK_PROMPTS])
      expect(r.length).toBe(10)
      expect(r.every((x) => x.status === 'done')).toBe(true)
      expect(r.filter((x) => x.hits.length)).toEqual([{ prompt: 3, status: 'done', hits: [1] }, { prompt: 5, status: 'done', hits: [2] }])
      // the report names numbers only, never a sealed string
      for (const s of strings) expect(lines.join('\n').toLowerCase()).not.toContain(s)
      expect(sealedIn('x ORG-0000-made-up y', strings)).toEqual([2])
    } finally { server.stop(true) }
  })
})

describe('the canary\'s public pages and allowed strings (QA TC-5576)', () => {
  test('GET /api/health and /settings/about are scanned; an allowed public string is not a hit, the same string elsewhere is', async () => {
    // the AGPL source-request address is public on purpose; here a made-up one stands for it
    const PUBLIC = 'source@offer-public.test'
    const strings = [PUBLIC, 'org-0000-made-up', 'offer-public.test']
    let leak = false
    const seen: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(req) {
        const u = new URL(req.url)
        seen.push(`${u.pathname} ${req.headers.get('cookie') ?? ''}`)
        if (u.pathname === '/api/health') return Response.json({ ok: true, source: { requestEmail: PUBLIC.toUpperCase() }, ...(leak ? { org: 'ORG-0000-MADE-UP' } : {}) })
        if (u.pathname === '/settings/about') return new Response(`<!doctype html><title>About</title><p>Ask ${PUBLIC} for the source.</p>`, { headers: { 'content-type': 'text/html' } })
        return new Response('{}', { status: 404 })
      },
    })
    try {
      const url = `http://127.0.0.1:${server.port}`
      expect(PUBLIC_PAGES).toEqual(['/api/health', '/settings/about'])
      // without --allow the public address (and its domain) is a hit on both pages
      const plain = await scanPublicPages({ url, cookie: '__Host-sid=visitor', strings })
      expect(plain).toEqual([{ path: '/api/health', status: 200, hits: [1, 3] }, { path: '/settings/about', status: 200, hits: [1, 3] }])
      expect(seen).toEqual(['/api/health __Host-sid=visitor', '/settings/about __Host-sid=visitor'])
      // allowed: clean; a real leak next to it is still found
      expect((await scanPublicPages({ url, strings, allow: [PUBLIC] })).map((r) => r.hits)).toEqual([[], []])
      leak = true
      const lines: string[] = []
      expect((await scanPublicPages({ url, strings, allow: [PUBLIC], log: (x) => lines.push(x) }))[0]).toEqual({ path: '/api/health', status: 200, hits: [2] })
      for (const x of strings) expect(lines.join('\n').toLowerCase()).not.toContain(x)
      // a page that does not answer is reported by its status
      server.stop(true)
      expect((await scanPublicPages({ url, strings }))[0]!.status).toBe(0)
    } finally { server.stop(true) }
    // the domain alone outside the allowed address is still a hit (text and files)
    expect(sealedIn(`mail ${PUBLIC} or admin@offer-public.test`, strings, [PUBLIC])).toEqual([3])
    expect(maskAllowed(`A ${PUBLIC.toUpperCase()} B`, [PUBLIC])).not.toContain('offer-public')
    const dir = path.join(tmp, 'allowed')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'about.txt'), `source: ${PUBLIC}`)
    fs.writeFileSync(path.join(dir, 'wide.bin'), Buffer.from(`source: ${PUBLIC}`, 'utf16le'))
    expect(scan(dir, strings).length).toBe(4)
    expect(scan(dir, strings, [PUBLIC])).toEqual([])
    fs.writeFileSync(path.join(dir, 'leak.txt'), 'org-0000-made-up')
    expect(scan(dir, strings, [PUBLIC])).toEqual([{ file: 'leak.txt', string: 2 }])
  })

  test('an allowed string that is only part of a sealed one is refused, by number, never by text (review finding 3 on #105)', () => {
    const PUBLIC = 'source@offer-public.test'
    const strings = ['somebody.real@account-owner.test', PUBLIC, 'org-0000-made-up']
    // the whole public text, one equal to a sealed string, or one holding a sealed string: fine
    expect(() => checkAllow([PUBLIC, `  ${PUBLIC.toUpperCase()} `, `mail ${PUBLIC} please`, ''], strings)).not.toThrow()
    // a part of a sealed string (its domain, a name inside it) would blank it everywhere: refused, case-insensitively
    for (const part of ['account-owner.test', 'SOMEBODY.real', ' made-up ']) {
      let err = ''
      try { checkAllow([PUBLIC, part], strings) } catch (e) { err = (e as Error).message }
      expect(err).toMatch(/^--allow 2 is only part of sealed string \d/)
      for (const x of [...strings, part.trim()]) expect(err.toLowerCase()).not.toContain(x.toLowerCase())
    }
    expect(() => checkAllow(['account-owner.test'], strings)).toThrow('--allow 1 is only part of sealed string 1:')
    // the command refuses it before it scans anything, with a clear error and exit 1
    const sealed = path.join(tmp, 'sealed-allow.txt')
    fs.writeFileSync(sealed, strings.join('\n') + '\n', { mode: 0o600 })
    const dir = path.join(tmp, 'allow-empty')
    fs.mkdirSync(dir, { recursive: true })
    const run = Bun.spawnSync([process.execPath, path.join(import.meta.dir, '../../scripts/demo/free-roam/canary.ts'), '--sealed', sealed, '--snapshot', dir, '--allow', 'account-owner.test'], { stdout: 'pipe', stderr: 'pipe' })
    expect(run.exitCode).toBe(1)
    const out = run.stdout.toString() + run.stderr.toString()
    expect(out).toContain('--allow 1 is only part of sealed string 1')
    expect(out).not.toContain('clean')
    expect(out).not.toContain('somebody.real')
  })
})
