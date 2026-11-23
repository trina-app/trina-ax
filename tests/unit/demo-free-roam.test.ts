// The free-roam demo's snapshot (scripts/demo/free-roam/build-snapshot.ts) and canary (canary.ts). A real development
// server is started on a fresh base folder, seeded with Steepling at the end of the story (no AI), scrubbed and checked
// on a clone; the snapshot must hold no setup token, owner password, session or WAL, a clone must boot and Mina must
// sign in through the persona switch, and the layout must be the one the demo gate reads
// (<out>/<locale>/<name>/{manifest.json, base/}).
import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiClient, CSRF_HEADER, DEMO_GATE_KEY_HEADER } from '../../shared/src/api'
import { buildSnapshot, gateLikeConfig, gitHead, hygieneProblems, SIGN_IN_TABLES, SNAPSHOT_MODEL, type Manifest } from '../../scripts/demo/free-roam/build-snapshot'
import { LEAK_PROMPTS, PUBLIC_PAGES, askLeakPrompts, maskAllowed, readSealed, scan, scanPublicPages, sealedIn } from '../../scripts/demo/free-roam/canary'
import { HIGGSFIELD_TOOLS } from '../../server/src/demo/fakes/higgsfield'
import { HIGGSFIELD_PICTURE, steepling } from '../../scripts/demo/steepling/make'
import { SCENE_PICTURES } from '../../scripts/demo/steepling/banner/kit'
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
      // the free-roam audit (empty chats, QA TC-5610): every seeded chat shows its branch, ending at its last answer
      const chats = db.query('SELECT c.id, c.active_leaf_id, m.role, m.chat_id FROM chats c LEFT JOIN messages m ON m.id = c.active_leaf_id').all() as { id: string; active_leaf_id: string | null; role: string | null; chat_id: string | null }[]
      expect(chats.length).toBe(steepling('en').company.chats.length)
      for (const c of chats) expect({ role: c.role, same: c.chat_id === c.id }).toEqual({ role: 'assistant', same: true })
      for (const c of chats) expect(db.query('SELECT 1 FROM messages WHERE parent_id = ?').get(c.active_leaf_id!)).toBeNull()
      // Mina's notice of Sara's reply under her answer, at the story's time, unread (QA TC-5614)
      const notice = db.query("SELECT n.created_at, n.read_at, n.mention_id FROM chat_thread_notices n JOIN users u ON u.id = n.user_id WHERE u.username = 'mina'").get() as { created_at: string; read_at: string | null; mention_id: string | null } | null
      expect(notice?.read_at).toBeNull()
      expect(notice?.mention_id).not.toBeNull()
      expect(Date.parse(notice!.created_at)).toBeLessThan(Date.parse(manifest.createdAt) - 60 * 60_000)
      // job titles and .example e-mails (QA TC-5619); the launch project's own chat room (QA TC-5620, now the project room)
      for (const u of db.query('SELECT u.username, u.email FROM users u').all() as { username: string; email: string | null }[]) expect(u.email ?? '', u.username).toMatch(/@[a-z]+\.example$/)
      // each project with a channel has its own chat room, named after it (the channels stay group chats)
      expect(db.query("SELECT COUNT(*) n, SUM(l.mode = 'room' AND r.name = p.name) rooms FROM room_project_links l JOIN rooms r ON r.id = l.room_id JOIN projects p ON p.id = l.project_id").get()).toEqual({ n: 4, rooms: 4 })
      // room notices and thread follows carry the story's times, never the build's (the review of the richer Steepling)
      for (const t of ['room_notices', 'room_thread_follows']) expect((db.query(`SELECT count(*) n FROM ${t} WHERE created_at > ?`).get(manifest.createdAt) as { n: number }).n, t).toBe(0)
      expect((db.query('SELECT count(*) n FROM room_notices WHERE last_at > ?').get(manifest.createdAt) as { n: number }).n).toBe(0)
      // what Mina has not read: Nadia's mention in Customer voice and Sara's reply in the Social calendar thread
      const unread = db.query(`SELECT r.name, m.thread_root_id IS NOT NULL threaded FROM room_notices n JOIN users u ON u.id = n.user_id JOIN room_messages m ON m.id = n.source_id
        JOIN rooms r ON r.id = n.room_id WHERE u.username = 'mina' AND n.read_at IS NULL AND n.event_type = 'room.mention' ORDER BY r.name`).all()
      expect(unread).toEqual([{ name: 'Customer voice', threaded: 0 }, { name: 'Social calendar', threaded: 1 }])
      // Files › Recent: the story's times, newest first; the seed's skills and company profile left out (QA TC-5618)
      const events = db.query("SELECT path, at FROM file_events WHERE action IN ('create', 'update', 'upload', 'restore') ORDER BY id").all() as { path: string; at: string }[]
      expect(events.filter((e) => e.path.startsWith('skills/'))).toEqual([])
      expect(events.map((e) => e.at)).toEqual(events.map((e) => e.at).sort())
      expect(Date.parse(events[0]!.at)).toBeLessThan(Date.parse(manifest.createdAt) - 7 * 1440 * 60_000 + 60_000)
      expect(Math.abs(fs.statSync(path.join(L.team, events.at(-1)!.path)).mtimeMs - Date.parse(events.at(-1)!.at))).toBeLessThan(1000)
      // the folders above the story's files and Mina's memory carry the story's times, not the build's (QA TC-5743)
      const hourBefore = Date.parse(manifest.createdAt) - 60 * 60_000
      for (const d of ['shared', 'groups', 'groups/Marketing', 'projects', 'projects/Customer voice', 'shared/Templates']) expect(fs.statSync(path.join(L.team, d)).mtimeMs, d).toBeLessThan(hourBefore)
      for (const m of db.query("SELECT m.created_at FROM memories m JOIN users u ON u.id = m.user_id WHERE u.username = 'mina'").all() as { created_at: string }[]) expect(Date.parse(m.created_at)).toBeLessThan(hourBefore)
      // Company-wide › Templates holds the three templates (QA TC-5746)
      expect(fs.readdirSync(path.join(L.team, 'shared', 'Templates')).filter((n) => n.endsWith('.md')).length).toBe(3)
      // Files › Personal › My files holds Mina's own two notes, uploaded by her (QA TC-5886)
      const minaId = (db.query("SELECT id FROM users WHERE lower(username) = 'mina'").get() as { id: string }).id
      expect(fs.readdirSync(path.join(L.team, 'users', minaId)).filter((n) => !n.startsWith('.')).sort()).toEqual(['My first week notes.md', 'Setup checklist.md'])
      expect(events.filter((e) => e.path.startsWith(`users/${minaId}/`)).length).toBe(2)
      // the folders with nothing dated in them are not later than the story either: people's own, the team skills', the
      // team folder (QA TC-5743)
      for (const d of ['.', 'users', `users/${minaId}`, 'users/sara', 'skills']) expect(fs.statSync(path.join(L.team, d)).mtimeMs, d).toBeLessThan(hourBefore)
      // Team skills › company-profile.json: the story's time (the skills', 30 days back), on disk and in its updatedAt,
      // never the build's (QA TC-5935)
      const profileAt = fs.statSync(path.join(L.team, 'skills', 'company-profile.json')).mtimeMs
      expect(profileAt).toBeLessThan(hourBefore)
      expect(Math.abs(profileAt - (Date.parse(manifest.createdAt) - 30 * 1440 * 60_000))).toBeLessThan(10 * 60_000)
      const profileJson = JSON.parse(fs.readFileSync(path.join(L.team, 'skills', 'company-profile.json'), 'utf8')) as { updatedAt?: string }
      expect(Math.abs(Date.parse(profileJson.updatedAt ?? '') - profileAt)).toBeLessThan(1000)
      // a file in a room message is an attachment or a named link, never a bare download address (QA TC-5884)
      const bare = db.query("SELECT body FROM room_messages WHERE body LIKE '%/api/files/download%'").all() as { body: string }[]
      expect(bare.filter((m) => /(^|[^(])\/api\/files\/download/.test(m.body))).toEqual([])
      const october = db.query("SELECT f.name FROM room_messages m JOIN room_files f ON f.message_id = m.id WHERE m.body LIKE 'October summary is in the project%'").all() as { name: string }[]
      expect(october.map((f) => f.name)).toEqual(['October review summary.md'])
    } finally { db.close() }
    expect(JSON.parse(fs.readFileSync(L.demo, 'utf8')).builder).toBeUndefined()
    const gmail = JSON.parse(fs.readFileSync(path.join(L.fakes, 'gmail.json'), 'utf8'))
    // the fakes' own shapes (server/src/demo/fakes/gmail.ts, drive.ts) with ISO times of the build, and Higgsfield's picture
    expect(gmail.me.email).toBe('mina.lee@steepling.example')
    expect(gmail.messages.every((m: { date: string }) => /^\d{4}-\d\d-\d\dT/.test(m.date))).toBe(true)
    expect(gmail.messages.find((m: { labels?: string[] }) => m.labels?.includes('SENT')).attachments).toEqual(['launch-banner-new.jpg', 'instagram-square.jpg'])
    const drive = JSON.parse(fs.readFileSync(path.join(L.fakes, 'drive.json'), 'utf8'))
    expect(drive.files.length).toBeGreaterThan(1)
    expect(fs.readdirSync(path.join(L.fakes, 'higgsfield')).map((n) => n.normalize('NFC')).sort()).toEqual([HIGGSFIELD_PICTURE, ...Object.values(SCENE_PICTURES), 'banner'].map((n) => n.normalize('NFC')).sort())
    // the banner kit (change_banner_text: text-free photos + words) came through whole
    expect(JSON.parse(fs.readFileSync(path.join(L.fakes, 'higgsfield', 'banner', 'kit.json'), 'utf8')).scenes.length).toBe(4)
    expect(fs.existsSync(path.join(L.fakes, 'higgsfield', 'banner', 'fonts', 'Fraunces-SemiBold.ttf'))).toBe(true)
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
    expect(demo).toMatchObject({ kind: 'freeRoam', fakes: { content: 'fakes' }, signupUrl: 'https://demo.trina.app/__demo/go/start-free' })
    expect(demo.personas.map((p: { username: string }) => p.username)).toEqual(['mina'])
    expect(demo.freeRoam.suggestions.length).toBe(4)
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
    const gateKey = await gateLikeConfig(clone)
    const inst = await startInstance(clone)
    try {
      const sw = (h: Record<string, string>) => fetch(`${inst.url}/api/demo/persona`, { method: 'POST', headers: { 'content-type': 'application/json', origin: inst.url, [CSRF_HEADER]: '1', ...h }, body: JSON.stringify({ key: 'newHire' }) })
      expect((await sw({})).status).toBe(401)
      expect((await sw({ [DEMO_GATE_KEY_HEADER]: 'another-key' })).status).toBe(401)
      const r = await sw({ [DEMO_GATE_KEY_HEADER]: gateKey })
      expect(r.status).toBe(200)
      const cookie = r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ')
      const api = new ApiClient({ baseUrl: inst.url, fetch: ((u: string | URL | Request, init?: RequestInit) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie } })) as typeof fetch })
      expect((await api.call(API.me)).user.username).toBe('mina')
      // the demo's Gmail (made by the builder, answered by the fake) shows as connected in Settings › Connectors (QA TC-5611)
      expect((await api.call(API.myGoogleApps)).apps.find((x) => x.id === 'gmail')).toMatchObject({ status: 'connected', account: { email: 'mina.lee@steepling.example' } })
      // the data and the team folder are the clone's own, from its server.json
      expect(fs.existsSync(path.join(clone, 'data', 'app.db'))).toBe(true)
    } finally { await inst.stop() }
  }, 120_000)

  test('a snapshot names its commit: from .git-head in a git archive tree, nothing from a malformed one', () => {
    const tree = path.join(tmp, 'archive-tree')
    fs.mkdirSync(tree, { recursive: true })
    const sha = 'a1b2c3d4'.repeat(5)
    fs.writeFileSync(path.join(tree, '.git-head'), sha + '\n')
    expect(gitHead(tree)).toBe(sha)
    fs.writeFileSync(path.join(tree, '.git-head'), 'not-a-commit\n')
    const fallback = gitHead(tree) // the temp folder is in no repository
    expect(fallback).toBeNull()
  })

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

  test('sealed strings are found whole first; an allowed string excuses only a place inside it (QA TC-5605, review finding 3 on #105)', () => {
    const PUBLIC = 'source@offer-public.test'
    // sealed string 2 is the public address plus a suffix: allowing the address is fine and still finds string 2 whole
    const strings = ['somebody.real@account-owner.test', `${PUBLIC}.secret-suffix`, 'org-0000-made-up']
    expect(sealedIn(`write to ${PUBLIC} please`, strings, [PUBLIC])).toEqual([])
    expect(sealedIn(`leaked: ${PUBLIC}.secret-suffix`, strings, [PUBLIC])).toEqual([2])
    // the original concern: allowing a domain never hides an address at it, nor a name inside a sealed string
    for (const part of ['account-owner.test', 'SOMEBODY.real', ' made-up ']) {
      expect(sealedIn('somebody.real@account-owner.test and org-0000-made-up', strings, [part])).toEqual([1, 3])
    }
    expect(sealedIn('mail x@trina.app', ['x@trina.app'], ['trina.app'])).toEqual([1])
    // the same in files (utf-8 and utf-16), and the command runs with such an --allow and finds the leak
    const dir = path.join(tmp, 'allow-whole')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'about.txt'), `source: ${PUBLIC}`)
    fs.writeFileSync(path.join(dir, 'leak.bin'), Buffer.from(`x ${PUBLIC}.secret-suffix`, 'utf16le'))
    expect(scan(dir, strings, [PUBLIC])).toEqual([{ file: 'leak.bin', string: 2 }])
    fs.writeFileSync(path.join(dir, 'addr.txt'), 'x@trina.app')
    expect(scan(dir, ['x@trina.app'], ['trina.app'])).toEqual([{ file: 'addr.txt', string: 1 }])
    const sealed = path.join(tmp, 'sealed-allow.txt')
    fs.writeFileSync(sealed, strings.join('\n') + '\n', { mode: 0o600 })
    const run = Bun.spawnSync([process.execPath, path.join(import.meta.dir, '../../scripts/demo/free-roam/canary.ts'), '--sealed', sealed, '--snapshot', dir, '--allow', PUBLIC], { stdout: 'pipe', stderr: 'pipe' })
    expect(run.exitCode).toBe(1)
    const out = run.stdout.toString() + run.stderr.toString()
    expect(out).toContain('leak.bin')
    expect(out).not.toContain('secret-suffix')
    expect(out).not.toContain('somebody.real')
  })

})
