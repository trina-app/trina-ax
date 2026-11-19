// The free-roam demo's snapshot (docs/AGENTS/plan/20261119-1538-demo-free-roam-c.md): a whole base folder of a seeded
// development server, the END of the scripted story, that the demo gate clones once per visitor (demo-gate/src/pool.ts).
//
//   bun scripts/demo/free-roam/build-snapshot.ts --content steepling|<content dir> --locale en|ko --out <snapshots dir>
//       [--name <name>] [--no-verify]
//
// It writes <snapshots dir>/<locale>/<name>/ (name: the UTC time, YYYYMMDD-HHMMSS) with
//   manifest.json   { codeVersion, locale, createdAt, config, demoFile, content: { id, hash }, git, checks }
//   base/           config/server.json, demo.json, data/, secrets/, team/, fakes/ (the gate's clone source)
//
// Steps: a fresh server on the base folder (127.0.0.1, a free port, no relay; its demo file says `builder: true`, so the
// builder's routes answer for the owner); seedDemo and seedStoryState (no AI: past chats are plain finished messages);
// the fake Gmail and Drive with times and account ids; the server stops; the setup token, an owner password and every
// session and sign-in token are deleted, the database's WAL is checkpointed into it, the demo file is written again
// without `builder`; the manifest. Then the snapshot is checked on a clone: it boots, Mina signs in through the persona
// switch, her files, skills, rooms and chats are there, the builder's routes are gone; the clone is deleted. Only a
// snapshot that passed is moved into place.
import { Database } from 'bun:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiClient, ApiError, CSRF_HEADER } from '../../../shared/src/api'
import { writeFakesAt } from '../company/fakes'
import { seedDemo } from '../seed'
import { loadContent, type DemoContent } from '../company/content'
import { roomMembers, seedStoryState } from '../company/story-state'
import { STEEPLING_LOCALES, writeSteepling, type SteeplingLocale } from '../steepling/make'
import { baseConfig, baseLayout, cloneBase, freePort, shortTemp, SNAPSHOT_CONFIG, SNAPSHOT_DEMO_FILE, startInstance } from './instance'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')
export const USAGE = 'Usage: bun scripts/demo/free-roam/build-snapshot.ts --content steepling|<dir> --locale en|ko --out <snapshots dir> [--name <name>] [--no-verify]'

export interface Manifest {
  codeVersion: string
  locale: string
  createdAt: string
  /** inside base/ */
  config: string
  demoFile: string
  content: { id: string; hash: string }
  git: string | null
  /** what the verification checked on a clone (null: --no-verify) */
  checks: string[] | null
}

/** the server's version, as the instance will report it (server/src/context.ts SERVER_VERSION) */
export function codeVersion(): string {
  return process.env.MYCEL_BUILD_VERSION || (JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'package.json'), 'utf8')) as { version: string }).version
}
function gitHead(): string | null {
  const r = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT })
  if (r.exitCode !== 0) return null
  const dirty = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: ROOT }).stdout.toString().trim() ? '-dirty' : ''
  return r.stdout.toString().trim() + dirty
}

/** sha256 over a content folder: every file's path and bytes, in order */
export function contentHash(dir: string): string {
  const h = crypto.createHash('sha256')
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(abs, e.name), r)
      else if (e.isFile()) { h.update(r.normalize('NFC')).update('\0').update(fs.readFileSync(path.join(abs, e.name))).update('\0') }
    }
  }
  walk(dir, '')
  return h.digest('hex')
}

const anon = (url: string) => new ApiClient({ baseUrl: url })
async function ownerClient(url: string, username: string, password: string) {
  const r = await anon(url).call(API.login, { body: { username, password, client: 'web', tokenMode: 'bearer' } })
  return new ApiClient({ baseUrl: url, token: r.token! })
}

/** The demo's own Google client for Drive (docs/decisions/20261119-demo-fakes.md): a Drive connection belongs to the
 * client set up when it was made, so the server must read one at its start. Made up: the demo's fake answers every
 * Google address and no sign-in starts in the demo, so nothing ever uses it. In the server's own place for it
 * (<secrets>/integrations/google-drive/client.json, 0600 in 0700 folders, google-drive/config.ts readDriveConfig). */
export function writeDemoDriveClient(base: string): void {
  const dir = path.join(baseLayout(base).secrets, 'integrations', 'google-drive')
  for (const d of [baseLayout(base).secrets, path.dirname(dir), dir]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(d, 0o700) }
  const client = { clientId: 'demo-fake-client.apps.example', clientSecret: `demo-fake-${crypto.randomBytes(12).toString('base64url')}`, redirectUri: 'https://steepling.example/api/integrations/google-drive/callback' }
  fs.writeFileSync(path.join(dir, 'client.json'), JSON.stringify(client) + '\n', { mode: 0o600 })
}

/** where the snapshot keeps the fakes, inside base/: the demo file names it relative to the instance's folder (the gate
 * starts each instance in its clone: demo-gate/src/pool.ts) */
export const SNAPSHOT_FAKES = 'fakes'

/** Tables of sign-ins and tokens: none may be in a snapshot (every clone would share them). */
export const SIGN_IN_TABLES = ['sessions', 'proxy_tokens', 'remote_mcp_tokens', 'upload_sessions', 'slack_link_tokens', 'slack_user_tokens']

/** What no snapshot keeps: the setup token, an owner password, sign-ins; the WAL is folded into the database. */
export function scrub(base: string): void {
  const L = baseLayout(base)
  for (const f of [path.join(L.data, 'setup-token'), path.join(base, 'owner-password'), path.join(L.data, 'owner-password')]) fs.rmSync(f, { force: true })
  for (const name of fs.readdirSync(L.data).filter((n) => n.endsWith('.db') && fs.statSync(path.join(L.data, n)).isFile())) {
    const file = path.join(L.data, name)
    const db = new Database(file)
    try {
      db.exec('PRAGMA foreign_keys = ON')
      const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name))
      for (const t of SIGN_IN_TABLES) if (tables.has(t)) db.exec(`DELETE FROM ${t}`)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      // one self-contained file (the server turns WAL on again when it opens it)
      db.exec('PRAGMA journal_mode = DELETE')
    } finally { db.close() }
    for (const x of ['-wal', '-shm']) fs.rmSync(file + x, { force: true })
  }
}

/** Problems of a snapshot's base folder as it lies on disk (no server running): what scrub removes is gone. */
export function hygieneProblems(base: string): string[] {
  const L = baseLayout(base)
  const problems: string[] = []
  for (const f of [path.join(L.data, 'setup-token'), path.join(base, 'owner-password'), path.join(L.data, 'owner-password')]) if (fs.existsSync(f)) problems.push(`${path.relative(base, f)} is there`)
  const dbFile = path.join(L.data, 'app.db')
  if (!fs.existsSync(dbFile)) return [...problems, 'data/app.db is missing']
  for (const x of ['-wal', '-shm']) if (fs.existsSync(dbFile + x) && fs.statSync(dbFile + x).size > 0) problems.push(`data/app.db${x} is not empty (no checkpoint)`)
  const db = new Database(dbFile, { readonly: true })
  try {
    for (const t of SIGN_IN_TABLES) {
      const n = (db.query(`SELECT count(*) n FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) as { n: number }).n
      if (n && (db.query(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n > 0) problems.push(`${t} has rows`)
    }
    // the demo limit counts every turn the model proxy recorded on the instance: a snapshot starts at zero
    const proxied = db.query("SELECT count(*) n, COALESCE(SUM(input_tokens + output_tokens), 0) t FROM turns WHERE usage_source = 'proxy' OR input_tokens > 0 OR output_tokens > 0").get() as { n: number; t: number }
    if (proxied.n) problems.push(`${proxied.n} turns with recorded AI use (${proxied.t} tokens)`)
  } finally { db.close() }
  const demo = JSON.parse(fs.readFileSync(L.demo, 'utf8')) as { builder?: boolean; kind?: string; personas?: unknown[] }
  if (demo.builder) problems.push('demo.json still turns the builder on')
  if (demo.kind !== 'freeRoam' || demo.personas?.length !== 1) problems.push('demo.json is not a free-roam demo with one person')
  const cfg = JSON.parse(fs.readFileSync(L.config, 'utf8')) as { fileList?: { enabled?: boolean }; engine?: { authMode?: string } }
  if (cfg.fileList?.enabled !== false) problems.push('server.json does not turn the file list off (it runs the AI outside turns)')
  if (cfg.engine?.authMode !== 'managed') problems.push('server.json: engine.authMode is not "managed"')
  return problems
}

/** What the gate does to a clone's server.json before it starts it (demo-gate/src/pool.ts writeInstanceConfig): its
 * own listener and model proxy ports, the gate as the model upstream (a port nothing listens on here: no AI runs). */
export async function gateLikeConfig(clone: string): Promise<void> {
  const file = baseLayout(clone).config
  const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>
  const [port, proxyPort, gate] = [await freePort(), await freePort(), await freePort()]
  c.listen = { host: '127.0.0.1', port }
  c.engine = { ...(c.engine ?? {}), proxyPort, modelUpstreams: { anthropic: `http://127.0.0.1:${gate}/i/verify.not-a-secret` } }
  c.relay = { url: null, teamName: null, officialAvailable: false }
  c.update = { channel: 'stable', feedUrl: null, auto: false }
  fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 })
}

/** Boot a clone of the base folder, sign in as the new hire through the persona switch and check what the content
 * promises them. Returns the lines checked; throws on the first problem. The clone is deleted. */
export async function verifySnapshot(base: string, content: DemoContent, log: (s: string) => void = () => {}): Promise<string[]> {
  const checked: string[] = []
  const problems = hygieneProblems(base)
  if (problems.length) throw new Error(`the snapshot is not clean: ${problems.join('; ')}`)
  checked.push('no setup token, owner password, sessions or WAL')
  const tmp = shortTemp('frs')
  const clone = path.join(tmp, 'base')
  cloneBase(base, clone)
  await gateLikeConfig(clone)
  const inst = await startInstance(clone)
  try {
    const c = content.company
    const hire = c.demo.personas.find((p) => p.key === 'newHire')
    if (!hire) throw new Error('the content has no newHire persona to sign in as')
    // the persona switch (the gate signs visitors in this way): a cookie session
    const r = await fetch(`${inst.url}/api/demo/persona`, { method: 'POST', headers: { 'content-type': 'application/json', origin: inst.url, [CSRF_HEADER]: '1' }, body: JSON.stringify({ key: 'newHire' }) })
    if (!r.ok) throw new Error(`the persona switch answered ${r.status}: ${await r.text()}`)
    const cookie = r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ')
    const api = new ApiClient({ baseUrl: inst.url, fetch: ((u: string | URL | Request, init?: RequestInit) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie, origin: inst.url, [CSRF_HEADER]: '1' } })) as typeof fetch })
    const me = await api.call(API.me)
    if (me.user.username.toLowerCase() !== hire.username.toLowerCase()) throw new Error(`signed in as ${me.user.username}, not ${hire.username}`)
    checked.push(`boots; ${hire.username} signs in through the persona switch`)
    for (const k of c.checks.filter((x) => x.username.toLowerCase() === hire.username.toLowerCase())) {
      for (const f of k.opens) await api.call(API.download, { query: { path: f, disposition: 'attachment' } }).catch(() => { throw new Error(`${hire.username} cannot open ${f}`) })
      for (const f of k.closed) if (await api.call(API.download, { query: { path: f, disposition: 'attachment' } }).then(() => true, () => false)) throw new Error(`${hire.username} opens ${f}`)
      if (k.skills) {
        const names = (await api.call(API.listSkills)).items.map((s) => s.name).sort()
        if (JSON.stringify(names) !== JSON.stringify([...k.skills].sort())) throw new Error(`${hire.username}'s skills are ${names.join(', ')}`)
      }
      checked.push(`${hire.username} opens ${k.opens.length} files, not ${k.closed.length}${k.skills ? `, ${k.skills.length} team skills` : ''}`)
    }
    const rooms = (await api.call(API.listRooms)).items
    const mine = c.rooms.filter((x) => roomMembers(c, x).some((u) => u.toLowerCase() === hire.username.toLowerCase()))
    if (rooms.length < mine.length) throw new Error(`${hire.username} is in ${rooms.length} rooms, the content says ${mine.length}`)
    for (const room of rooms) if (room.unreadCount > 0) throw new Error(`room ${room.name ?? room.kind} has ${room.unreadCount} unread messages`)
    checked.push(`${rooms.length} rooms, all read`)
    const chats = (await api.call(API.listChats, { query: { limit: 200 } })).items.map((x) => x.title)
    for (const x of c.chats.filter((y) => y.username.toLowerCase() === hire.username.toLowerCase())) if (!chats.includes(x.title)) throw new Error(`no chat "${x.title}"`)
    const shared = c.chats.filter((y) => y.project && !y.private && y.username.toLowerCase() !== hire.username.toLowerCase())
    for (const p of (await api.call(API.listProjects)).items) {
      const inP = (await api.call(API.listChats, { query: { limit: 200, projectId: p.id } })).items.map((x) => x.title)
      for (const x of shared.filter((y) => y.project === p.name)) if (!inP.includes(x.title)) throw new Error(`no shared chat "${x.title}" in ${p.name}`)
    }
    checked.push(`${chats.length} chats, ${shared.length} shared project chats of others`)
    // the builder is gone
    const b = await fetch(`${inst.url}/api/demo/builder/welcome`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: inst.url, [CSRF_HEADER]: '1' }, body: '{}' })
    if (b.status !== 404 && b.status !== 403) throw new Error(`the builder's route answered ${b.status} in the snapshot`)
    checked.push('the builder\'s routes are not there')
    log(`verified: ${checked.join('; ')}`)
    return checked
  } finally {
    await inst.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export interface BuildOptions { content: string; locale: string; out: string; name?: string; verify?: boolean; log?: (s: string) => void; now?: number }

/** Build one snapshot; returns its folder (<out>/<locale>/<name>). */
export async function buildSnapshot(o: BuildOptions): Promise<{ dir: string; manifest: Manifest }> {
  const log = o.log ?? ((s: string) => console.log(`[snapshot] ${s}`))
  const work = shortTemp('frb')
  try {
    // the content: Steepling is made from the scripted story (scripts/demo/steepling/make.ts); else a content folder
    let contentDir = o.content
    if (o.content === 'steepling') {
      if (!(STEEPLING_LOCALES as readonly string[]).includes(o.locale)) throw new Error(`Steepling has ${STEEPLING_LOCALES.join(', ')}, not ${o.locale}`)
      contentDir = writeSteepling(o.locale as SteeplingLocale, path.join(work, 'content'))
    }
    const content = loadContent(contentDir)
    if (content.company.locale !== o.locale) throw new Error(`the content is in ${content.company.locale}, not ${o.locale}`)
    const name = o.name ?? new Date(o.now ?? Date.now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const dir = path.join(path.resolve(o.out), o.locale, name)
    if (fs.existsSync(dir)) throw new Error(`${dir} is there already`)

    // a fresh base folder, its server with the builder on
    const base = path.join(work, 'base')
    const L = baseLayout(base)
    fs.mkdirSync(path.dirname(L.config), { recursive: true, mode: 0o700 })
    fs.mkdirSync(L.data, { recursive: true, mode: 0o700 })
    fs.mkdirSync(L.team, { recursive: true, mode: 0o700 })
    fs.writeFileSync(L.config, JSON.stringify(baseConfig('build'), null, 2) + '\n', { mode: 0o600 })
    // building: the scripted kind with the builder on (both people sign in); the snapshot: the free-roam kind, one person
    const demoFile = (building: boolean) => fs.writeFileSync(L.demo, JSON.stringify(content.demoFile({ replays: null, fakes: SNAPSHOT_FAKES, ...(building ? { builder: true } : { freeRoam: true }) }), null, 2) + '\n', { mode: 0o600 })
    writeDemoDriveClient(base)
    demoFile(true)
    // the owner's password lives only in this process: the snapshot never holds it, and nobody signs in as the owner
    const ownerPassword = crypto.randomBytes(24).toString('base64url')
    const now = o.now ?? Date.now()
    const inst = await startInstance(base)
    try {
      let setupToken: string | null = null
      for (let i = 0; i < 40 && !setupToken; i++) {
        try { setupToken = fs.readFileSync(path.join(L.data, 'setup-token'), 'utf8').trim() || null } catch { await Bun.sleep(250) }
      }
      if (!setupToken) throw new Error('the new server wrote no setup token')
      const seeded = await seedDemo({ baseUrl: inst.url, setupToken, company: content.seed, ownerPassword, locale: content.company.locale, log: (s) => log(s) })
      log(`seeded: ${seeded.people.length} people, ${seeded.files.length} files`)
      const story = await seedStoryState({ baseUrl: inst.url, content, ownerPassword, now, log })
      log(`story: ${Object.keys(story.rooms).length} rooms, ${Object.keys(story.chats).length} chats, ${story.connections.length} connections`)
      writeFakesAt(content.dir, content.fakes, path.join(base, SNAPSHOT_FAKES), now)
    } catch (e) {
      if (e instanceof ApiError) log(`the server said: ${JSON.stringify(e.body).slice(0, 400)}`)
      log(inst.output().slice(-2000))
      throw e
    } finally {
      await inst.stop()
    }
    demoFile(false)
    fs.writeFileSync(L.config, JSON.stringify(baseConfig('snapshot'), null, 2) + '\n', { mode: 0o600 })
    scrub(base)

    const manifest: Manifest = {
      codeVersion: codeVersion(), locale: o.locale, createdAt: new Date(now).toISOString(), config: SNAPSHOT_CONFIG, demoFile: SNAPSHOT_DEMO_FILE,
      content: { id: content.company.id, hash: contentHash(contentDir) }, git: gitHead(), checks: null,
    }
    if (o.verify !== false) manifest.checks = await verifySnapshot(base, content, log)

    // into place: the gate takes <out>/<locale>/<name>/{manifest.json, base/}
    const staging = path.join(work, 'snapshot')
    fs.mkdirSync(staging, { mode: 0o700 })
    fs.renameSync(base, path.join(staging, 'base'))
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    try { fs.renameSync(staging, dir) } catch { fs.cpSync(staging, dir, { recursive: true, preserveTimestamps: true }) }
    log(`snapshot ${dir}`)
    return { dir, manifest }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (import.meta.main) {
  const content = arg('content'), locale = arg('locale'), out = arg('out')
  if (!content || !locale || !out) { console.error(USAGE); process.exit(1) }
  buildSnapshot({ content, locale, out, name: arg('name'), verify: !process.argv.includes('--no-verify') })
    .catch((e) => { console.error(`[snapshot] ${e instanceof Error ? e.message : String(e)}`); process.exit(1) })
}
