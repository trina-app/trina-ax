// The widening hook for folder shares (server/src/files/share-readers.ts; docs/decisions/20261116-folder-share-widening.md;
// the design: docs/AGENTS/plan/20261116-1147-folder-sharing.md "The widening hook"). A folder in a person's own files
// that they share has more readers than its owner, so every "who reads this path" answer counts the share's people,
// and every writer into it asks first. The tests the security review asked for are marked (R).
//
// Shares are made here as rows: alice shares folders of her own files with bob (or the whole team).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type TurnRequest } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { newLinkId } from '../../server/src/files/shares'
import { folderSharesOf } from '../../server/src/files/folder-shares'
import { privateToMe, readersAt, shareAbove, shareReaders } from '../../server/src/files/share-readers'
import { missingReaders, roomWidening, sourceOf, viewersOf, widening, type ReadSource } from '../../server/src/chat/read-scope'
import { keepAlways } from '../../server/src/chat/always-allow'
import { cardSources } from '../../server/src/chat/schedule-scope'
import { folderAudience, readersOf } from '../../server/src/rooms/ai-grants'
import { embedNarrower } from '../../server/src/team-files/embed'
import { componentC } from '../../server/src/team-files/component'
import { folderView, runMayWrite, viewAccess } from '../../server/src/devenv/srt/access'
import { personView } from '../../server/src/devenv/srt/runner'
import { roomsOf } from '../../server/src/rooms/service'
import { loadPrincipal, RuleSet } from '../../server/src/policy/access'
import { HttpError } from '../../server/src/http/errors'

setDefaultTimeout(60_000)
let h: Harness
const socks: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'c-folder-share-widening', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice']) { socks[u] = await h.ws(u, { windowId: `win-fsw-${u}` }); await socks[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h.close() })

const db = () => h.ctx.db
const svc = () => componentC(h.ctx).files
const rules = () => RuleSet.load(db())
const people = () => (db().query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((r) => loadPrincipal(db(), r.id)!).filter(Boolean)
const abs = (rel: string) => path.join(h.team, ...rel.split('/'))
const wr = (rel: string, text: string) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text) }
const exists = (rel: string) => fs.existsSync(abs(rel))
const segs = (rel: string) => rel.split('/')
let n = 0
/** a fresh folder in alice's files, with a file in it */
const folder = (name: string) => { const d = `users/alice/${name}-${++n}`; wr(`${d}/a.md`, 'what the shared folder says\n'); return d }
const iso = (ms = Date.now()) => new Date(ms).toISOString()
/** alice shares `dir` (a live folder row) with `subjects` (a user id, or '*' for the whole team), given at `at` */
function shareDir(dir: string, subjects: string[] = ['bob'], at = iso()): string {
  const id = newLinkId()
  db().query("INSERT INTO file_shares (id, path, ino, dev, owner_id, state, created_by, created_at, kind, folder_id) VALUES (?,?,?,?,?,'live',?,?,'folder',?)").run(id, dir, 0, 0, 'alice', 'alice', at, '0:0:1')
  for (const s of subjects) db().query("INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?,?,?,'view','alice',?,'dialog')").run(id, s === '*' ? 'group' : 'user', s, at)
  return id
}

const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const read = (p: string) => ({ tool: 'read', args: { file_path: p } })
const write = (p: string, content = 'from this chat\n') => ({ tool: 'write', args: { file_path: p, content } })
type Ask = TurnRequest & { requestId: string; question?: string; options?: { label: string; value: string }[] }
const values = (c: Ask) => c.options?.map((o) => o.value)
/** one answer in alice's own chat, from her app; each card answered with `answer` */
async function turn(content: string, answer: string, chatId?: string) {
  const user = 'alice'
  const id = chatId ?? (await h.api(user).call(API.createChat, { body: {} })).id
  const r = await h.api(user).call(API.sendMessage, { params: { id }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Ask[] = []
  const seen = new Set<string>()
  for (let waited = 0; ; waited += 50) {
    if (waited > 60_000) throw new Error('the answer did not end')
    for (const f of socks[user]!.frames) {
      if (f.type !== 'turn.request' || f.data.turnId !== r.turnId || seen.has(f.data.request.requestId)) continue
      seen.add(f.data.request.requestId)
      cards.push(f.data.request as Ask)
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: f.data.request.requestId, answer } })
    }
    const done = socks[user]!.frames.find((f) => f.type === 'message.done' && f.data.messageId === r.assistantMessage.id)
    if (done && done.type === 'message.done') return { cards, content: done.data.message.content as string, chatId: id }
    await Bun.sleep(50)
  }
}

describe('the readers of a path (share-readers.ts)', () => {
  test('a share counts at and below its folder, nested shares add up, a hidden or temp place inside does not count', () => {
    const work = folder('work'), q4 = `${work}/q4`
    wr(`${q4}/b.md`, 'q4\n')
    shareDir(work, ['bob'])
    shareDir(q4, ['erin'])
    expect([...shareReaders(db(), segs(work))]).toEqual(['bob'])
    expect([...shareReaders(db(), segs(`${q4}/b.md`))].sort()).toEqual(['bob', 'erin'])
    expect(shareReaders(db(), segs(`${work}/.drafts/x.md`)).size).toBe(0)
    expect(shareReaders(db(), segs('users/alice')).size).toBe(0)
    expect([...readersAt(db(), rules(), segs(`${work}/a.md`), people())].sort()).toEqual(['alice', 'bob'])
    expect(privateToMe(db(), 'alice', segs(`${work}/a.md`))).toBe(false)
    expect(privateToMe(db(), 'alice', segs('users/alice/elsewhere/a.md'))).toBe(true)
    expect(shareAbove(db(), segs(`${q4}/b.md`))).not.toBeNull()
  })

  test('a paused share counts for a warning, not as a source that is already shared', () => {
    const d = folder('paused')
    const id = shareDir(d, ['bob'])
    db().query('UPDATE file_shares SET paused_at = ? WHERE id = ?').run(iso(), id)
    expect([...shareReaders(db(), segs(`${d}/a.md`))]).toEqual(['bob'])
    expect(shareAbove(db(), segs(`${d}/a.md`))).toBeNull()
    // a source tagged with a share that is paused (or stopped) since: read by its owner alone
    expect([...viewersOf(db(), rules(), { type: 'user', id: 'alice', share: id }, people())]).toEqual(['alice'])
  })

  test('the places a folder share never reaches: the archive and "From this computer" folders are never shared', () => {
    // (share-places.ts keptNames; these are where Find work files and the archive of a removed member write)
    const { ARCHIVE_DIR, FROM_COMPUTER_DIR } = require('@mycel/shared') as typeof import('@mycel/shared')
    for (const top of [FROM_COMPUTER_DIR, ...Object.values(ARCHIVE_DIR)]) {
      const at = `users/alice/${top}`
      db().query("INSERT INTO file_shares (id, path, ino, dev, owner_id, state, created_by, created_at, kind, folder_id) VALUES (?,?,0,0,'alice','live','alice',?,'folder','0:0:1')").run(newLinkId(), at, iso())
      expect(shareReaders(db(), segs(`${at}/x.md`)).size).toBe(0)
    }
  })
})

describe('C1: a read from a shared folder never hides a read from private files (R)', () => {
  test('shared read first, private read second, save into the shared folder: the card (and nothing saved on No)', async () => {
    const work = folder('c1'), priv = `users/alice/private-c1-${n}/salary.md`
    wr(priv, 'salary 100\n')
    shareDir(work, ['bob'])
    const r = await turn(fake(read(`${work}/a.md`), read(priv), write(`${work}/out.md`), { say: 'done' }), 'skip')
    expect(r.cards).toHaveLength(1)
    expect(values(r.cards[0]!)).toEqual(['save', '__always', 'skip'])
    expect(exists(`${work}/out.md`)).toBe(false)
  })

  test('the other order asks too; a read from the shared folder alone saves there with no card', async () => {
    const work = folder('c1b'), priv = `users/alice/private-c1b-${n}/salary.md`
    wr(priv, 'salary 200\n')
    shareDir(work, ['bob'])
    const a = await turn(fake(read(priv), read(`${work}/a.md`), write(`${work}/out.md`), { say: 'done' }), 'skip')
    expect(a.cards).toHaveLength(1)
    expect(exists(`${work}/out.md`)).toBe(false)
    const b = await turn(fake(read(`${work}/a.md`), write(`${work}/same.md`), { say: 'done' }), 'skip')
    expect(b.cards).toEqual([])
    expect(exists(`${work}/same.md`)).toBe(true)
  })

  test('widening() and roomWidening() judge every distinct own-folder source (the room post path)', () => {
    const work = folder('c1room')
    const id = shareDir(work, ['*'])
    const shared = sourceOf(db(), rules(), `${work}/a.md`)
    const plain = sourceOf(db(), rules(), 'users/alice/private/x.md')
    expect(shared).toEqual({ type: 'user', id: 'alice', share: id })
    expect(plain).toEqual({ type: 'user', id: 'alice' })
    // the target: the shared folder itself (alice and the whole team)
    expect(widening(db(), null, segs(`${work}/out.md`), [shared])).toBeNull()
    expect(widening(db(), null, segs(`${work}/out.md`), [shared, plain])?.narrower).toEqual([plain])
    // a room everyone is in: the shared source is not narrower, the private one is, in either order
    const everyone = (db().query("SELECT id FROM rooms WHERE kind = 'all'").get() as { id: string }).id
    expect(roomWidening(db(), everyone, [shared], undefined, 'alice')).toBeNull()
    expect(roomWidening(db(), everyone, [shared, plain], undefined, 'alice')?.narrower).toEqual([plain])
    expect(roomWidening(db(), everyone, [plain, shared], undefined, 'alice')?.narrower).toEqual([plain])
  })
})

describe('M2: a child a receiver cannot open is not "already shared" (R)', () => {
  test('a dot-folder child read by the owner, then a save into the shared folder: the card', async () => {
    const work = folder('dot')
    wr(`${work}/.drafts/secret.md`, 'not for bob\n')
    shareDir(work, ['bob'])
    expect(sourceOf(db(), rules(), `${work}/.drafts/secret.md`)).toEqual({ type: 'user', id: 'alice' })
    const r = await turn(fake(read(`${work}/.drafts/secret.md`), write(`${work}/out.md`), { say: 'done' }), 'skip')
    expect(r.cards).toHaveLength(1)
    expect(exists(`${work}/out.md`)).toBe(false)
  })
})

describe('H3: the AI\'s moves and copies into a shared folder ask (R)', () => {
  test('move_files of a private file into a shared folder: the card says one more person; No keeps it, yes moves it', async () => {
    const work = folder('mv'), priv = `users/alice/private-mv-${n}/m.md`
    wr(priv, 'private\n')
    shareDir(work, ['bob'])
    expect(svc().audienceChange('alice', [priv], work, 'move').added).toBe(1)
    const no = await turn(fake({ tool: 'move_files', args: { paths: [priv], to_folder: work } }, { say: 'done' }), 'deny')
    expect(no.cards).toHaveLength(1)
    expect(values(no.cards[0]!)).toEqual(['allow', '__always', 'deny'])
    expect(exists(priv)).toBe(true)
    expect(exists(`${work}/m.md`)).toBe(false)
    // yes: move() asks again for a shared folder whatever the client says (W7), and the card's yes is passed on
    const yes = await turn(fake({ tool: 'move_files', args: { paths: [priv], to_folder: work } }, { say: 'done' }), 'allow')
    expect(yes.cards).toHaveLength(1)
    expect(exists(`${work}/m.md`)).toBe(true)
    expect(exists(priv)).toBe(false)
  })

  test('copy_files of a private file into a shared folder: the card', async () => {
    const work = folder('cp'), priv = `users/alice/private-cp-${n}/c.md`
    wr(priv, 'private\n')
    shareDir(work, ['bob'])
    const r = await turn(fake({ tool: 'copy_files', args: { paths: [priv], to_folder: work } }, { say: 'done' }), 'deny')
    expect(r.cards).toHaveLength(1)
    expect(exists(`${work}/c.md`)).toBe(false)
    // the person's own copy on the Files screen: its dry run counts the share's people
    expect(await svc().copy('alice', priv, `${work}/c.md`, { dryRun: true })).toEqual({ viewersAdded: 1 })
  })

  test('W7: a move into a shared folder without askWiden answers 409 audience_widened; confirm moves it; a rename of a hidden name too', () => {
    const work = folder('w7'), priv = `users/alice/private-w7-${n}/x.md`
    wr(priv, 'x\n')
    wr(`${work}/.hidden.md`, 'hidden\n')
    shareDir(work, ['bob'])
    let err: any = null
    try { svc().move('alice', priv, `${work}/x.md`, 'fail') } catch (e) { err = e }
    expect(err?.code).toBe('conflict')
    expect(err?.params).toEqual({ reason: 'audience_widened', viewersAdded: 1 })
    expect(exists(priv)).toBe(true)
    expect(svc().move('alice', priv, `${work}/x.md`, 'fail', { confirm: true }).entry.path).toBe(`${work}/x.md`)
    err = null
    try { svc().move('alice', `${work}/.hidden.md`, `${work}/shown.md`, 'fail') } catch (e) { err = e }
    expect(err?.params?.reason).toBe('audience_widened')
    // inside the shared folder, between places its people see: no question
    expect(svc().move('alice', `${work}/x.md`, `${work}/y.md`, 'fail').entry.path).toBe(`${work}/y.md`)
  })

  test('generate_video with save_as: the wider-audience check runs before anything is made', async () => {
    const os = require('node:os') as typeof import('node:os')
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const { ToolRegistry } = require('../../server/src/tools/registry') as typeof import('../../server/src/tools/registry')
    const { registerHiggsfield } = require('../../server/src/tools/higgsfield') as typeof import('../../server/src/tools/higgsfield')
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-fsw-hf-'))
    try {
      fs.mkdirSync(path.join(dataDir, 'secrets'), { recursive: true })
      fs.writeFileSync(path.join(dataDir, 'secrets', 'higgsfield.key'), 'kid:ksecret')
      const mem = new Database(':memory:')
      mem.run('CREATE TABLE tool_events (user_id TEXT, tool TEXT, ok INTEGER, at TEXT)')
      const reg = new ToolRegistry()
      registerHiggsfield({ engineConfig: { dataDir }, db: mem } as never, reg)
      const asked: string[] = []
      const person = { locale: 'en' as const, async confirm() { return true }, async confirmWhy() { return 'yes' as const }, *turnUrls() {} }
      let fetched = 0
      const realFetch = globalThis.fetch
      globalThis.fetch = (async () => { fetched++; return Response.json({ status: 'failed' }, { status: 500 }) }) as unknown as typeof fetch
      try {
        const r = await reg.call('generate_video', { prompt: 'waves', duration: 5, aspect_ratio: '16:9', resolution: '720p', save_as: 'users/alice/work-1/clip' }, {
          user: { id: 'alice', name: 'Alice', role: 'member', groups: [] }, turnId: 't1', files: {} as never, person: person as never,
          confirmWidening: async (t: string) => { asked.push(t); return 'NO: more people can see that folder' },
        } as never)
        expect(asked).toEqual(['users/alice/work-1/clip.mp4'])
        expect(r.isError).toBe(true)
        expect(r.text).toContain('more people can see that folder')
        expect(fetched).toBe(0)
      } finally { globalThis.fetch = realFetch }
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }) }
  })
})

describe('H3: restores into a folder shared since (R)', () => {
  test('trash restore: 409 audience_widened with the count; confirm restores; shared before the trash: no question', () => {
    const work = folder('rt')
    wr(`${work}/old.md`, 'old\n')
    const t = svc().remove('alice', `${work}/old.md`)
    shareDir(work, ['bob'], iso(Date.now() + 1000))
    let err: any = null
    try { svc().restoreTrash('alice', t.trashId) } catch (e) { err = e }
    expect(err?.code).toBe('conflict')
    expect(err?.params).toEqual({ reason: 'audience_widened', viewersAdded: 1 })
    expect(exists(`${work}/old.md`)).toBe(false)
    expect(svc().restoreTrash('alice', t.trashId, { confirm: true }).entry.path).toBe(`${work}/old.md`)
    // shared before it went to the trash: its people had it
    const before = folder('rt2')
    shareDir(before, ['bob'], iso(Date.now() - 60_000))
    wr(`${before}/kept.md`, 'kept\n')
    const t2 = svc().remove('alice', `${before}/kept.md`)
    expect(svc().restoreTrash('alice', t2.trashId).entry.path).toBe(`${before}/kept.md`)
  })

  test('the restore endpoint takes ?confirm=1', async () => {
    const work = folder('rt3')
    wr(`${work}/api.md`, 'api\n')
    const t = svc().remove('alice', `${work}/api.md`)
    shareDir(work, ['bob'], iso(Date.now() + 1000))
    const no = await h.req('alice', `/api/files/trash/${t.trashId}/restore`, { method: 'POST' })
    expect(no.status).toBe(409)
    expect(((await no.json()) as any).error.params).toEqual({ reason: 'audience_widened', viewersAdded: 1 })
    const yes = await h.req('alice', `/api/files/trash/${t.trashId}/restore?confirm=1`, { method: 'POST' })
    expect(yes.status).toBe(200)
  })

  test('version restore: a version from before the share asks; one made after it does not', async () => {
    /** the kept old versions of `rel` (their bytes in the version store) */
    const kept = (rel: string) => db().query('SELECT id FROM file_versions WHERE path = ? AND storage_path IS NOT NULL ORDER BY version').all(rel) as { id: string }[]
    const sha = (t: string) => new Bun.CryptoHasher('sha256').update(t).digest('hex')
    const twoSaves = (rel: string, a: string, b: string) => { wr(rel, a); return svc().save('alice', rel, b, sha(a)) }
    const work = folder('ver')
    const rel = `${work}/doc.md`
    twoSaves(rel, 'v1\n', 'v2\n')
    shareDir(work, ['bob'], iso(Date.now() + 1000))
    const old = kept(rel)[0]!
    let err: any = null
    try { await svc().restoreVersion('alice', rel, old.id) } catch (e) { err = e }
    expect(err?.params).toEqual({ reason: 'audience_widened', viewersAdded: 1 })
    expect((await svc().restoreVersion('alice', rel, old.id, { confirm: true })).path).toBe(rel)
    // shared first, then the versions: bob had each of them
    const after = folder('ver2')
    shareDir(after, ['bob'], iso(Date.now() - 60_000))
    const rel2 = `${after}/doc.md`
    twoSaves(rel2, 'w1\n', 'w2\n')
    expect((await svc().restoreVersion('alice', rel2, kept(rel2)[0]!.id)).path).toBe(rel2)
  })
})

describe('M3: a scheduled run that saves into a shared folder (R)', () => {
  async function scheduled(content: string): Promise<{ asked: boolean }> {
    const chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
    const row = h.rt().store.chatRow(chatId)!
    const started = h.rt().createTurn({ chat: row, userId: 'alice', locale: 'en', windowId: null, clientKind: 'schedule', engine: row.engine as 'claude-code', model: null,
      user: { parentId: row.active_leaf_id, content, attachments: [], clientMessageId: cm() } })
    await socks.alice!.next('message.done', (f) => f.data.message.turnId === started.turnId, 30_000)
    return { asked: socks.alice!.frames.some((f) => f.type === 'turn.request' && f.data.turnId === started.turnId) }
  }
  test('without "Always allow" for wider saves: nothing saved there, nobody asked; with it: saved, no card', async () => {
    const work = folder('sched'), priv = `users/alice/private-sched-${n}/p.md`
    wr(priv, 'private\n')
    shareDir(work, ['bob'])
    const off = await scheduled(fake(read(priv), write(`${work}/daily.md`), { say: 'done' }))
    expect(off.asked).toBe(false)
    expect(exists(`${work}/daily.md`)).toBe(false)
    keepAlways(db(), 'alice', 'save_wider', null)
    try {
      const on = await scheduled(fake(read(priv), write(`${work}/daily2.md`), { say: 'done' }))
      expect(on.asked).toBe(false)
      expect(exists(`${work}/daily2.md`)).toBe(true)
    } finally { db().query("DELETE FROM card_always_allow WHERE user_id = 'alice'").run() }
  })
})

describe('H1: the dev environment never writes in a shared folder (R)', () => {
  test('the run\'s view: a shared folder is read-only, the rest of the own folder stays writable', () => {
    const work = folder('box')
    shareDir(work, ['bob'])
    const v = personView(h.ctx, 'alice', { start: null })!
    expect(v.denyWrite).toContain(work)
    expect(viewAccess(v, `${work}/a.md`)).toBe('read')
    expect(viewAccess(v, 'users/alice/other/a.md')).toBe('write')
    expect(runMayWrite({ start: null, shared: [work] }, 'alice', `${work}/sub`)).toBe(false)
    expect(runMayWrite({ start: null, shared: [work] }, 'alice', 'users/alice/other')).toBe(true)
    // a view made before the share is not the one after it (the tracker compares the hash)
    const plain = folderView(rules(), loadPrincipal(db(), 'alice')!, { start: null })
    expect(viewAccess(plain, `${work}/a.md`)).toBe('write')
  })

  test('a share add is refused (409 folder_share_run_active) while a run of the owner is alive; the dialog says why', () => {
    const work = folder('alive')
    const alice = loadPrincipal(db(), 'alice')!
    const budget = () => (roomsOf(h.ctx) as unknown as { sendBudget: Map<string, unknown> }).sendBudget.clear()
    const runId = 'run-' + crypto.randomUUID()
    db().query("INSERT INTO dev_env_runs (id, user_id, kind, name, root, state, started_at) VALUES (?, 'alice', 'job', 'job-1', '/tmp/x', 'running', ?)").run(runId, iso())
    try {
      budget()
      let err: any = null
      try { folderSharesOf(h.ctx).change(alice, work, [{ subjectType: 'user', subjectId: 'bob' }], [], 'en') } catch (e) { err = e }
      expect(err).toBeInstanceOf(HttpError)
      expect(err.code).toBe('conflict')
      expect(err.extra?.params?.reason).toBe('folder_share_run_active')
      const r = svc()
      const view = folderSharesOf(h.ctx).view(alice, rules(), require('../../server/src/policy/authorize').authorize(h.ctx.files.fx, rules(), alice, work, 'write'), 'en')
      expect(view.blocked).toBe('run_active')
      expect(view.canShare).toBe(false)
      void r
      // the run ended: the share goes through
      db().query("UPDATE dev_env_runs SET state = 'ended', ended_at = ? WHERE id = ?").run(iso(), runId)
      budget()
      const ok = folderSharesOf(h.ctx).change(alice, work, [{ subjectType: 'user', subjectId: 'bob' }], [], 'en')
      expect(ok.view.people.map((p) => p.subjectId)).toEqual(['bob'])
    } finally {
      db().query('DELETE FROM dev_env_runs WHERE id = ?').run(runId)
    }
  })
})

describe('T16: people who stop reaching a shared folder start a fresh AI session', () => {
  test('Stop sharing resets the receiver\'s engine sessions', async () => {
    const work = folder('reset')
    const alice = loadPrincipal(db(), 'alice')!
    ;(roomsOf(h.ctx) as unknown as { sendBudget: Map<string, unknown> }).sendBudget.clear()
    folderSharesOf(h.ctx).change(alice, work, [{ subjectType: 'user', subjectId: 'bob' }], [], 'en')
    const chat = (await h.api('bob').call(API.createChat, { body: {} })).id
    db().query("UPDATE chats SET engine_session_id = 'held' WHERE id = ?").run(chat)
    folderSharesOf(h.ctx).change(alice, work, [], [], 'en', 'dialog', { stop: true })
    for (let i = 0; i < 40 && (db().query('SELECT engine_session_id s FROM chats WHERE id = ?').get(chat) as { s: string | null }).s; i++) await Bun.sleep(25)
    expect((db().query('SELECT engine_session_id s FROM chats WHERE id = ?').get(chat) as { s: string | null }).s).toBeNull()
  })

  test('a move out of a shared folder resets the sessions of the share\'s people (TeamFiles readersOf)', async () => {
    const work = folder('reset-mv')
    shareDir(work, ['bob'])
    const chat = (await h.api('bob').call(API.createChat, { body: {} })).id
    db().query("UPDATE chats SET engine_session_id = 'held' WHERE id = ?").run(chat)
    svc().move('alice', `${work}/a.md`, `users/alice/private-out-${n}.md`, 'fail')
    expect((db().query('SELECT engine_session_id s FROM chats WHERE id = ?').get(chat) as { s: string | null }).s).toBeNull()
  })
})

describe('every function that counts readers counts the share\'s people (one per row of the design\'s table)', () => {
  test('viewersOf and missingReaders: a source from inside the share is read by its people', () => {
    const work = folder('vo')
    const id = shareDir(work, ['bob'])
    const s: ReadSource = { type: 'user', id: 'alice', share: id }
    expect([...viewersOf(db(), rules(), s, people())].sort()).toEqual(['alice', 'bob'])
    expect(missingReaders(db(), rules(), [s], ['bob'], 'alice')).toEqual([])
    expect(missingReaders(db(), rules(), [{ type: 'user', id: 'alice' }], ['bob'], 'alice')).toEqual([{ source: { type: 'user', id: 'alice' }, missing: ['bob'] }])
  })
  test('rooms/ai-grants readersOf and folderAudience; schedule cardSources', () => {
    const work = folder('ag')
    const before = folderAudience(db(), rules(), segs(work))
    expect(readersOf(db(), rules(), segs(work))).toEqual(['alice'])
    shareDir(work, ['bob'])
    expect(readersOf(db(), rules(), segs(work)).sort()).toEqual(['alice', 'bob'])
    expect(folderAudience(db(), rules(), segs(work))).not.toBe(before)
    // a task that may read "my folder" and save into the shared folder: "my folder" is narrower there
    expect(cardSources(db(), rules(), [{ type: 'user', id: 'alice' }], work, 'alice')).toEqual([{ type: 'user', id: 'alice' }])
  })
  test('TeamFiles: the folder audience count, the AI trash audience, page embeds', () => {
    const work = folder('tf')
    shareDir(work, ['bob'])
    expect(svc().audience('alice', work).people).toBe(2)
    const aud = (svc() as unknown as { aiAudience(r: RuleSet, self: string, s: string[]): { readers: string[] } }).aiAudience(rules(), 'alice', segs(`${work}/a.md`))
    expect(aud.readers).toEqual(['bob'])
    // a page in the shared folder may not show a private file: bob reads the page and not the file
    expect(embedNarrower(db(), rules(), segs(`${work}/page.html`), segs('users/alice/private/pic.png'))).toBe(true)
    expect(embedNarrower(db(), rules(), segs(`${work}/page.html`), segs(`${work}/pic.png`))).toBe(false)
  })
  test('the dev environment\'s audience of a project run counts a share\'s people', () => {
    const p = loadPrincipal(db(), 'alice')!
    const all = people()
    const work = 'users/alice/everyone-reads'
    // a project run whose project the whole team sees: the own folder is hidden (only alice reads it), a folder of it
    // the whole team reads through a share stays readable, never writable
    const v = folderView(rules(), p, { start: 'shared', shared: [work] }, all, [], (f) => (f === work ? new Set(all.map((x) => x.id)) : new Set()))
    expect(viewAccess(v, `${work}/a.md`)).toBe('read')
    expect(viewAccess(v, 'users/alice/private/a.md')).toBe('none')
  })
})

// ---------------- second security review of PR 3 (its proving tests, and the fixes' own) ----------------

describe('review 2, H-A: skill_files moving or copying out of a skill folder into a shared folder', () => {
  const { planFolderAction, runFolderAction } = require('../../server/src/skills/folder-actions') as typeof import('../../server/src/skills/folder-actions')
  test('the card counts the share\'s people (seeAdded has bob); into an unshared own folder it adds nobody', () => {
    wr('groups/marketing/skills/kit/SKILL.md', '---\nname: kit\ndescription: a kit\n---\nbody\n')
    wr('groups/marketing/skills/kit/secret-notes.md', 'marketing-only notes\n')
    const work = folder('work-sk')
    shareDir(work, ['bob'])
    const p = planFolderAction(h.ctx, h.ctx.files.principal('alice'), { action: 'move', path: 'groups/marketing/skills/kit/secret-notes.md', to_folder: work })
    if ('refused' in p) throw new Error('refused: ' + p.refused.why)
    expect(p.kind).toBe('out')
    expect(rules().access(h.ctx.files.principal('bob'), segs('groups/marketing/skills/kit/secret-notes.md'))).toBe('none')
    expect(p.seeAdded).toContain('bob')
    const plain = folder('plain-sk')
    const q = planFolderAction(h.ctx, h.ctx.files.principal('alice'), { action: 'copy', path: 'groups/marketing/skills/kit/SKILL.md', to_folder: plain })
    if ('refused' in q) throw new Error('refused: ' + q.refused.why)
    expect(q.seeAdded).toEqual([])
  })
  test('the copy the card allowed goes through the shared folder\'s check with the card\'s yes', async () => {
    const work = folder('work-sk2')
    shareDir(work, ['bob'])
    const a = { action: 'copy' as const, path: 'groups/marketing/skills/kit/SKILL.md', to_folder: work }
    const p = planFolderAction(h.ctx, h.ctx.files.principal('alice'), a)
    if ('refused' in p) throw new Error('refused: ' + p.refused.why)
    expect(p.seeAdded).toContain('bob')
    expect((await runFolderAction(h.ctx, 'alice', a, p, { turnId: 'turn-review2', tool: 'skill_files' })).path).toBe(`${work}/SKILL.md`)
  })
})

describe('review 2, H-B: a person\'s copy into a shared folder asks, whatever the client did before', () => {
  test('copy and folder copy: 409 audience_widened without confirm; confirm copies; the endpoint takes confirm', async () => {
    const work = folder('cp2'), priv = `users/alice/private-cp2-${n}/c.md`
    wr(priv, 'private\n')
    wr(`users/alice/private-cp2-${n}/dir/x.md`, 'x\n')
    shareDir(work, ['bob'])
    let err: any = null
    try { await svc().copy('alice', priv, `${work}/c.md`) } catch (e) { err = e }
    expect(err?.params).toEqual({ reason: 'audience_widened', viewersAdded: 1 })
    expect(exists(`${work}/c.md`)).toBe(false)
    expect(await svc().copy('alice', priv, `${work}/c.md`, { confirm: true })).toMatchObject({ path: `${work}/c.md` })
    err = null
    try { await svc().copyFolderTree('alice', `users/alice/private-cp2-${n}/dir`, work) } catch (e) { err = e }
    expect(err?.params?.reason).toBe('audience_widened')
    expect(await svc().copyFolderTree('alice', `users/alice/private-cp2-${n}/dir`, work, { confirm: true })).toMatchObject({ path: `${work}/dir` })
    const no = await h.req('alice', '/api/files/copy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: priv, to: `${work}/d.md` }) })
    expect(no.status).toBe(409)
    const yes = await h.req('alice', '/api/files/copy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: priv, to: `${work}/d.md`, confirm: true }) })
    expect(yes.status).toBe(201)
    // into an unshared folder nothing changes: no confirm needed
    wr(`users/alice/plain-cp2-${n}/keep.md`, 'k\n')
    expect(await svc().copy('alice', priv, `users/alice/plain-cp2-${n}/c.md`)).toMatchObject({ path: `users/alice/plain-cp2-${n}/c.md` })
  })
  test('the AI\'s copy_files, after the card\'s yes, copies into the shared folder', async () => {
    const work = folder('cp3'), priv = `users/alice/private-cp3-${n}/c.md`
    wr(priv, 'private\n')
    shareDir(work, ['bob'])
    const r = await turn(fake({ tool: 'copy_files', args: { paths: [priv], to_folder: work } }, { say: 'done' }), 'allow')
    expect(r.cards).toHaveLength(1)
    expect(exists(`${work}/c.md`)).toBe(true)
  })
})

describe('review 2, M-A: a trash restore after the item\'s folder was moved into a shared folder', () => {
  test('restore into the shared folder asks (bob never had the trashed file)', () => {
    const work = folder('work-tr')
    shareDir(work, ['bob'], iso(Date.now() - 60_000))
    const priv = `users/alice/priv-tr-${n}`
    wr(`${priv}/secret.md`, 'salary\n')
    wr(`${priv}/keep.md`, 'keep\n')
    const t = svc().remove('alice', `${priv}/secret.md`)
    // the person moves the private folder into the shared one, confirming for what is in it now
    svc().move('alice', priv, `${work}/priv-tr`, 'fail', { confirm: true })
    let err: any = null
    try { svc().restoreTrash('alice', t.trashId) } catch (e) { err = e }
    expect(err?.params?.reason).toBe('audience_widened')
    expect(svc().restoreTrash('alice', t.trashId, { confirm: true }).entry.path).toBe(`${work}/priv-tr/secret.md`)
  })
})

describe('review 2, M-C: a run being started counts as alive; Undo of a folder share waits for it too', () => {
  const { startingRun, devRunAlive } = require('../../server/src/devenv/srt/alive') as typeof import('../../server/src/devenv/srt/alive')
  test('startingRun marks the person alive until it is done', () => {
    expect(devRunAlive(db(), 'alice')).toBe(false)
    const done = startingRun('alice')
    expect(devRunAlive(db(), 'alice')).toBe(true)
    done(); done()
    expect(devRunAlive(db(), 'alice')).toBe(false)
  })
  test('a share add and an Undo of a folder share are refused while a run is being started', async () => {
    const work = folder('undo-alive')
    const alice = loadPrincipal(db(), 'alice')!
    const budget = () => (roomsOf(h.ctx) as unknown as { sendBudget: Map<string, unknown> }).sendBudget.clear()
    budget()
    folderSharesOf(h.ctx).change(alice, work, [{ subjectType: 'user', subjectId: 'bob' }], [], 'en')
    const stop = folderSharesOf(h.ctx).change(alice, work, [], [], 'en', 'dialog', { stop: true })
    const undoId = (stop.view as { undo?: { id: string } }).undo!.id
    const done = startingRun('alice')
    try {
      budget()
      let err: any = null
      try { folderSharesOf(h.ctx).change(alice, work, [{ subjectType: 'user', subjectId: 'bob' }], [], 'en') } catch (e) { err = e }
      expect(err?.extra?.params?.reason).toBe('folder_share_run_active')
      const no = await h.req('alice', '/api/files/shares/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: undoId }) })
      expect(no.status).toBe(409)
      expect(((await no.json()) as any).error.params.reason).toBe('folder_share_run_active')
    } finally { done() }
    // the run is gone: the same Undo (not used up by the refusal) puts bob back
    const yes = await h.req('alice', '/api/files/shares/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: undoId }) })
    expect(yes.status).toBe(200)
  })
})

describe('Undo puts grants back with the Undo\'s time, not their old one (the gap is not access)', () => {
  test('a file trashed while bob was off the share asks on restore after the Undo put him back', async () => {
    const work = folder('undo-gap')
    const alice = loadPrincipal(db(), 'alice')!
    ;(roomsOf(h.ctx) as unknown as { sendBudget: Map<string, unknown> }).sendBudget.clear()
    folderSharesOf(h.ctx).change(alice, work, [{ subjectType: 'user', subjectId: 'bob' }], [], 'en')
    const id = (db().query("SELECT id FROM file_shares WHERE kind = 'folder' AND state = 'live' AND path = ?").get(work) as { id: string }).id
    db().query('UPDATE file_share_grants SET granted_at = ? WHERE share_id = ?').run(iso(Date.now() - 60_000), id)
    const stop = folderSharesOf(h.ctx).change(alice, work, [], [], 'en', 'dialog', { stop: true })
    const undoId = (stop.view as { undo?: { id: string } }).undo!.id
    await Bun.sleep(5)
    wr(`${work}/gap.md`, 'written while nobody was on the share\n')
    const t = svc().remove('alice', `${work}/gap.md`)
    await Bun.sleep(5)
    const yes = await h.req('alice', '/api/files/shares/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: undoId }) })
    expect(yes.status).toBe(200)
    const g = db().query("SELECT granted_at at, granted_by gb, via FROM file_share_grants WHERE share_id = ? AND subject_id = 'bob'").get(id) as { at: string; gb: string; via: string }
    expect({ gb: g.gb, via: g.via }).toEqual({ gb: 'alice', via: 'dialog' })
    expect(g.at > (db().query('SELECT deleted_at FROM trash_items WHERE id = ?').get(t.trashId) as { deleted_at: string }).deleted_at).toBe(true)
    let err: any = null
    try { svc().restoreTrash('alice', t.trashId) } catch (e) { err = e }
    expect(err?.params).toEqual({ reason: 'audience_widened', viewersAdded: 1 })
    expect(svc().restoreTrash('alice', t.trashId, { confirm: true }).entry.path).toBe(`${work}/gap.md`)
  })
})

describe('review 2, Low: every way a folder share ends gives its people a fresh AI session', () => {
  const held = async () => { const c = (await h.api('bob').call(API.createChat, { body: {} })).id; db().query("UPDATE chats SET engine_session_id = 'held' WHERE id = ?").run(c); return c }
  const cleared = async (chat: string) => {
    for (let i = 0; i < 40 && (db().query('SELECT engine_session_id s FROM chats WHERE id = ?').get(chat) as { s: string | null }).s; i++) await Bun.sleep(25)
    return (db().query('SELECT engine_session_id s FROM chats WHERE id = ?').get(chat) as { s: string | null }).s === null
  }
  beforeAll(() => { folderSharesOf(h.ctx) })
  test('the shared folder trashed', async () => {
    const work = folder('end-trash')
    shareDir(work, ['bob'])
    const chat = await held()
    svc().remove('alice', work)
    expect(await cleared(chat)).toBe(true)
  })
  test('the row marked dead (the folder moved out of the owner\'s shareable places)', async () => {
    const work = folder('end-dead')
    shareDir(work, ['bob'])
    const chat = await held()
    fs.mkdirSync(abs('users/alice/downloads'), { recursive: true })
    svc().move('alice', work, `users/alice/downloads/end-dead-${n}`, 'fail', { confirm: true })
    expect(await cleared(chat)).toBe(true)
  })
  test('the owner\'s account turned off', async () => {
    const work = folder('end-off')
    shareDir(work, ['bob'])
    const chat = await held()
    // (the answer's own check trips on this fixture's group ids, which are not UUIDs; the change itself is made first)
    await h.req('dana', '/api/admin/users/alice', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'disabled' }) })
    try {
      expect((db().query('SELECT status FROM users WHERE id = ?').get('alice') as { status: string }).status).toBe('disabled')
      expect(await cleared(chat)).toBe(true)
    } finally { db().query("UPDATE users SET status = 'active' WHERE id = 'alice'").run() }
  })
})
