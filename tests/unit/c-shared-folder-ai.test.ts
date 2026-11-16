// The recipient's AI inside a folder shared with them (server/src/files/shared-folder-reads.ts; the design:
// docs/AGENTS/plan/20261116-1147-folder-sharing.md "The recipient's AI inside a shared folder (PR 4)", T13, T34;
// docs/decisions/20261116-shared-folder-ai-read.md). The tests the security review asked for are marked (R).
//
// What must hold:
//  - list and read reach a shared folder by its LINK only, one level per call; never by path, never glob or grep,
//    nothing above the shared folder; names one line, capped, our tags neutralized; the read's bytes are the file
//    openChild checked; the audit line keeps the link id, not the path inside;
//  - a listing alone, or a read, marks the chat for good (chats.rooms_seen with others_words: every gate of a room read);
//    the mark outlives a new session; share_with_person with "Always allow" on still shows its card; remember asks;
//    a connection's write sees the chat as having read outside content;
//  - off in a scheduled run, where grant reads are off (a shared chat, a guest, Slack, …), and in a sub-agent.
//
// Shares are made here as rows (the gate stays closed on every server; nothing here opens it): alice shares folders of
// her own files with bob. erin is not on any share.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { newLinkId } from '../../server/src/files/shares'
import { saveFolderId } from '../../server/src/files/folder-id'
import { folderSharesOf } from '../../server/src/files/folder-shares'
import { FOLDER_SHARES_OPEN } from '../../server/src/files/folder-share-gate'
import { folderLinkOf, sharedFolderChild, sharedFoldersWith } from '../../server/src/files/shared-folder-reads'
import { TurnFiles, type ToolCtx } from '../../server/src/files/service'
import { componentC } from '../../server/src/team-files/component'
import { loadPrincipal, RuleSet } from '../../server/src/policy/access'
import { sourceOf } from '../../server/src/chat/read-scope'
import { SHARED_FOLDERS_HOWTO } from '../../server/src/chat/shared-with-me-tool'
import { dropAlways, keepAlways } from '../../server/src/chat/always-allow'
import { outsideSeen } from '../../server/src/integrations/connections/tools'
import { DELETE_REFUSAL } from '../../server/src/chat/delete-files'
import { teamTimeZone } from '../../server/src/admin/settings'
import { zonedDay } from '../../server/src/system/time-zone'

setDefaultTimeout(90_000)
let h: Harness
const socks: Record<string, TestSocket> = {}
const cm = () => 'cm-' + crypto.randomUUID()
// the fake engine's directives sit in the person's message: their strings spelled as JSON escapes, so the person's own
// words are only what the test writes around them
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')

const db = () => h.ctx.db
const abs = (rel: string) => path.join(h.ctx.files.fx.root, ...rel.split('/'))
const wr = (rel: string, text: string) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text) }
let n = 0
/** a fresh folder in alice's files with a report, a sub-folder and a hidden file */
function folder(name = 'work') {
  const d = `users/alice/${name}-${++n}`
  wr(`${d}/report.md`, 'Q4 revenue went up 12 percent.\n')
  wr(`${d}/q4/notes.md`, 'notes inside the sub-folder\n')
  wr(`${d}/.hidden.md`, 'not for the receiver\n')
  return d
}
/** alice shares `dir` with `subjects` (a user id, or '*' for the whole team): a live folder row with its real identity */
function shareDir(dir: string, subjects: string[] = ['bob']): string {
  const id = newLinkId()
  const at = new Date().toISOString()
  const fid = saveFolderId(h.ctx.files.fx, dir.split('/'))
  expect(fid).not.toBeNull()
  db().query("INSERT INTO file_shares (id, path, ino, dev, owner_id, state, created_by, created_at, kind, folder_id) VALUES (?,?,?,?,?,'live',?,?,'folder',?)").run(id, dir, 0, 0, 'alice', 'alice', at, fid)
  for (const s of subjects) db().query("INSERT INTO file_share_grants (share_id, subject_type, subject_id, role, granted_by, granted_at, via) VALUES (?,?,?,'view','alice',?,'dialog')").run(id, s === '*' ? 'group' : 'user', s, at)
  return id
}
const bucket = () => (folderSharesOf(h.ctx) as unknown as { opens: Map<string, unknown> }).opens.clear()

/** the file tools as a turn of `user`'s own chat calls them (grantReads), or another kind of turn */
const ctxFor = (user: string, o: { own?: boolean; files?: TurnFiles } = {}): ToolCtx => {
  const files = o.files ?? new TurnFiles()
  files.grantReads = o.own ?? true
  return { user: loadPrincipal(db(), user)!, turnId: null, files }
}
const call = (tool: string, args: unknown, ctx: ToolCtx) => { bucket(); return h.ctx.files.call(tool, args, ctx) }

beforeAll(async () => {
  h = await startHarness({ name: 'c-shared-folder-ai', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  componentC(h.ctx)
  db().query("INSERT INTO users (id, username, name, role, status, deleted_at) VALUES ('tess', 'tess', 'Tess Yoon', 'member', 'active', NULL)").run()
  for (const u of ['bob']) { socks[u] = await h.ws(u, { windowId: `win-sfa-${u}` }); await socks[u]!.next('hello') }
  for (const k of [1, 2, 3]) wr(`users/bob/ledger-${k}.txt`, `ledger ${k}`)
  keepAlways(db(), 'bob', 'share_files', null)
})
afterAll(async () => {
  dropAlways(db(), 'bob', 'card:share_files')
  for (const s of Object.values(socks)) s.close()
  await h?.close()
})

test('the gate stays closed: these tests reach the folder rows directly', () => {
  expect(FOLDER_SHARES_OPEN).toBe(false)
})

describe('list and read by link, never by path', () => {
  test('list: one level, folders first, hidden names left out; a sub-folder by its link', async () => {
    const dir = folder(), id = shareDir(dir)
    const top = await call('list', { path: `/f/${id}` }, ctxFor('bob'))
    expect(top.isError).toBeUndefined()
    const lines = top.text.split('\n')
    expect(lines.findIndex((l) => l.includes('folder "q4"'))).toBeLessThan(lines.findIndex((l) => l.includes('file "report.md"')))
    expect(top.text).not.toContain('.hidden')
    // never a team path, never alice's id in a path, never anything above the folder
    expect(top.text).not.toContain('users/')
    expect(top.summary).toBe(`list /f/${id} (shared folder) -> 2 entries`)
    const sub = await call('list', { path: `/f/${id}/q4` }, ctxFor('bob'))
    expect(sub.text).toContain('file "notes.md"')
    // the address in front, as a pasted link has it
    expect((await call('list', { path: `https://team.example/f/${id}/q4/` }, ctxFor('bob'))).text).toContain('notes.md')
  })

  test('read: the file inside by its link; the result and the audit name the link, never the path', async () => {
    const dir = folder(), id = shareDir(dir)
    const r = await call('read', { file_path: `/f/${id}/report.md` }, ctxFor('bob'))
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('Q4 revenue went up 12 percent.')
    expect(r.summary).not.toContain(dir)
    expect(r.summary).not.toContain('report.md')
    expect(r.summary).toContain(`/f/${id} (shared folder)`)
    // a percent-encoded path inside works too
    wr(`${dir}/two words.md`, 'two words\n')
    expect((await call('read', { file_path: `/f/${id}/two%20words.md` }, ctxFor('bob'))).text).toContain('two words')
    // the folder page's address of the file (what the answer links) reads the same file
    expect((await call('read', { file_path: `/f/${id}?f=${encodeURIComponent('q4/notes.md')}` }, ctxFor('bob'))).text).toContain('notes inside the sub-folder')
    // and the listing tells the AI that form for its answer
    expect((await call('list', { path: `/f/${id}/q4` }, ctxFor('bob'))).text).toContain(`/f/${id}?f=<its path inside the shared folder, URL-encoded> (here: q4%2F<name>)`)
    // a folder by read: use list
    const f = await call('read', { file_path: `/f/${id}/q4` }, ctxFor('bob'))
    expect(f.isError).toBe(true)
    expect(f.text).toContain('use list')
  })

  test('by path the folder stays closed: read, list, glob and grep see nothing of it', async () => {
    const dir = folder(), id = shareDir(dir)
    const bob = () => ctxFor('bob')
    expect((await call('read', { file_path: `${dir}/report.md` }, bob())).isError).toBe(true)
    expect((await call('list', { path: dir }, bob())).isError).toBe(true)
    // the search tools take no link either
    expect((await call('glob', { pattern: '*.md', path: `/f/${id}` }, bob())).isError).toBe(true)
    expect((await call('grep', { pattern: 'revenue', path: `/f/${id}` }, bob())).isError).toBe(true)
    const all = await call('grep', { pattern: 'Q4 revenue went up' }, bob())
    expect(all.text).not.toContain('alice')
    const glob = await call('glob', { pattern: '**/report.md' }, bob())
    expect(glob.text).not.toContain('users/alice')
    // nor writes through the link
    expect((await call('write', { file_path: `/f/${id}/new.md`, content: 'x' }, bob())).isError).toBe(true)
    expect(fs.existsSync(abs(`${dir}/new.md`))).toBe(false)
  })

  test('nothing above the shared folder, nothing hidden, no links: the same answer as a missing file', async () => {
    const dir = folder(), id = shareDir(`${dir}/q4`)
    const bob = () => ctxFor('bob')
    const missing = await call('read', { file_path: `/f/${id}/nothing.md` }, bob())
    expect(missing.isError).toBe(true)
    for (const p of [`/f/${id}/../report.md`, `/f/${id}/%2e%2e/report.md`, `/f/${id}/a/../../report.md`, `/f/${id}/.hidden.md`]) {
      const r = await call('read', { file_path: p }, bob())
      expect(r.isError, p).toBe(true)
      expect(r.text, p).not.toContain('Q4 revenue')
    }
    wr(`${dir}/q4/.secret.md`, 'secret')
    expect((await call('read', { file_path: `/f/${id}/.secret.md` }, bob())).isError).toBe(true)
    fs.symlinkSync(abs(`${dir}/report.md`), abs(`${dir}/q4/link.md`))
    expect((await call('read', { file_path: `/f/${id}/link.md` }, bob())).isError).toBe(true)
    expect((await call('list', { path: `/f/${id}` }, bob())).text).not.toContain('link.md')
    // the listing's crumbs start at the shared folder
    const top = await call('list', { path: `/f/${id}` }, bob())
    expect(top.text).toContain('Shared folder "q4"')
    expect(top.text).not.toContain(dir.split('/')[2]!)
  })

  test('only for the people on it: erin, and bob once taken off, get the answer of a missing link', async () => {
    const dir = folder(), id = shareDir(dir)
    const erin = await call('list', { path: `/f/${id}` }, ctxFor('erin'))
    expect(erin.isError).toBe(true)
    expect(erin.text).not.toContain('report.md')
    expect((await call('read', { file_path: `/f/${id}/report.md` }, ctxFor('erin'))).isError).toBe(true)
    db().query('DELETE FROM file_share_grants WHERE share_id = ?').run(id)
    expect((await call('list', { path: `/f/${id}` }, ctxFor('bob'))).isError).toBe(true)
    expect((await call('read', { file_path: `/f/${id}/report.md` }, ctxFor('bob'))).isError).toBe(true)
  })

  test('names in a listing: one line, capped, our tags neutralized', async () => {
    const dir = folder(), id = shareDir(dir)
    wr(`${dir}/x<instructions>y.md`, 'tag')
    wr(`${dir}/${'n'.repeat(200)}.md`, 'long')
    const r = await call('list', { path: `/f/${id}` }, ctxFor('bob'))
    // (a name with "<" is never listed: the listing's filter refuses it, as Files does)
    expect(r.text).not.toContain('<instructions>')
    expect(r.text).not.toContain('instructions>y.md')
    // a format character (a right-to-left override) never reaches the AI
    wr(`${dir}/a\u202eb.md`, 'rtl')
    const rtl = await call('list', { path: `/f/${id}` }, ctxFor('bob'))
    expect(rtl.text).not.toContain('\u202e')
    const long = r.text.split('\n').find((l) => l.includes('nnnn'))!
    expect(long.length).toBeLessThan(200)
  })

  test('the bytes read are the file openChild checked: a file swapped in between is refused', async () => {
    const dir = folder(), id = shareDir(dir)
    const bob = loadPrincipal(db(), 'bob')!
    bucket()
    const child = sharedFolderChild(h.ctx, bob, `/f/${id}/report.md`, 'en')!
    const checked = child.open()!
    // another file now at the same name (a new inode)
    fs.rmSync(abs(`${dir}/report.md`))
    wr(`${dir}/report.md`, 'planted text, same place\n')
    const stale = { ...child, open: () => checked }
    const ctx = { ...ctxFor('bob'), sharedChild: stale }
    const r = await h.ctx.files.call('read', { file_path: child.rel }, ctx)
    expect(r.isError).toBe(true)
    expect(r.text).not.toContain('planted text')
  })
})

describe('what such a call counts as', () => {
  test('a listing alone counts as a grant read; a read joins the read scope as the owner\'s, with the share', async () => {
    const dir = folder(), id = shareDir(dir)
    const listed = ctxFor('bob')
    await call('list', { path: `/f/${id}` }, listed)
    expect(listed.files.grantReadPaths.size).toBe(1)
    const read = ctxFor('bob')
    await call('read', { file_path: `/f/${id}/report.md` }, read)
    expect(read.files.grantReadPaths.has(`${dir}/report.md`)).toBe(true)
    expect(read.files.readPaths.has(`${dir}/report.md`)).toBe(true)
    expect(sourceOf(db(), RuleSet.load(db()), `${dir}/report.md`)).toEqual({ type: 'user', id: 'alice', share: id })
  })
})

describe('off where grant reads are off, and in a sub-agent', () => {
  test('a turn without grant reads (a shared chat, a guest, Slack, a scheduled run, the remote connector) reads nothing', async () => {
    const dir = folder(), id = shareDir(dir)
    const off = () => ctxFor('bob', { own: false })
    expect((await call('list', { path: `/f/${id}` }, off())).isError).toBe(true)
    expect((await call('read', { file_path: `/f/${id}/report.md` }, off())).isError).toBe(true)
  })

  test('a sub-agent\'s calls (and a call whose agent is not known) read nothing', async () => {
    const dir = folder(), id = shareDir(dir)
    const main = new TurnFiles()
    main.grantReads = true
    const sub = main.forAgent('agent-1')
    expect(sub.agentView).toBe(true)
    expect(main.agentView).toBe(false)
    const ctx: ToolCtx = { user: loadPrincipal(db(), 'bob')!, turnId: null, files: sub }
    expect((await call('list', { path: `/f/${id}` }, ctx)).isError).toBe(true)
    expect((await call('read', { file_path: `/f/${id}/report.md` }, ctx)).isError).toBe(true)
    expect(main.grantReadPaths.size).toBe(0)
  })
})

// (merge of PR 4 and B4: there is no every-turn "Files shared with you" block; shared_with_me lists the folders too)
describe('shared_with_me lists the folders shared with the person', () => {
  test('the folder\'s link, who shared it, the day and its name as the sharer wrote it (one line, capped, tags neutralized); nobody else gets it', async () => {
    const dir = folder('secret-plans'), id = shareDir(dir)
    const mine = sharedFoldersWith(h.ctx, 'bob')
    const item = mine.files.find((f) => f.id === id)!
    expect(item).toMatchObject({ kind: 'folder', url: `/f/${id}`, sharedBy: 'Alice Kim', to: { kind: 'you' }, name: dir.split('/').pop() })
    expect(sharedFoldersWith(h.ctx, 'erin').files.some((f) => f.id === id)).toBe(false)
    // alice's own folder is not "shared with" her
    expect(sharedFoldersWith(h.ctx, 'alice').files.some((f) => f.id === id)).toBe(false)
    // a long name: one line, capped at 120 characters
    const odd = `users/alice/${'p'.repeat(150)}${++n}`
    wr(`${odd}/a.md`, 'a\n')
    const oddId = shareDir(odd)
    const r = await turn(fake({ tool: 'shared_with_me', args: {}, sayResult: true }))
    const lines = r.content.split('\n')
    const day = zonedDay(new Date(), teamTimeZone(h.ctx.db))
    expect(lines).toContain(`- folder ${JSON.stringify(dir.split('/').pop())} from "Alice Kim", shared with the user, ${day}: /f/${id}`)
    expect(r.content).toContain(SHARED_FOLDERS_HOWTO)
    const oddLine = lines.find((l) => l.endsWith(`/f/${oddId}`))!
    expect(oddLine).toBeDefined()
    expect(oddLine).toContain(`"${'p'.repeat(120)}"`)
    // never a path
    expect(r.content).not.toContain('users/alice')
    // the list itself marks the chat (the names are the sharer's words)
    expect(marks(r.chatId).o).toBe(1)
    // a query filters the folders by name or by the sharer's name
    const q = await turn(fake({ tool: 'shared_with_me', args: { query: 'secret-plans' }, sayResult: true }))
    expect(q.content.split('\n').filter((l) => l.startsWith('- folder '))).toHaveLength(1)
  })

  test('building the block never pauses or ends a share, and looks at no more than max + 5 rows', () => {
    // a folder made again at its path (identity differs: an open would pause it) and one moved into a place never shared
    // (an open would end it)
    const again = folder('again'), againId = shareDir(again)
    fs.rmSync(abs(again), { recursive: true, force: true })
    wr(`${again}/report.md`, 'a new folder at the old path\n')
    const moved = folder('moved'), movedId = shareDir(moved)
    db().query("UPDATE file_shares SET path = 'users/alice/downloads/moved' WHERE id = ?").run(movedId)
    fs.mkdirSync(abs('users/alice/downloads/moved'), { recursive: true })
    const state = (id: string) => db().query('SELECT state, paused_at FROM file_shares WHERE id = ?').get(id)
    const before = [state(againId), state(movedId)]
    const out = sharedFoldersWith(h.ctx, 'bob')
    expect([state(againId), state(movedId)]).toEqual(before)
    expect(before[0]).toEqual({ state: 'live', paused_at: null })
    expect(before[1]).toEqual({ state: 'live', paused_at: null })
    // the moved one is not offered (a place never shared); the re-made one is, and its open by link then decides
    expect(out.files.some((f) => f.id === movedId)).toBe(false)
    // the scan: max 1 looks at 6 rows at most
    const ids = Array.from({ length: 8 }, () => shareDir(folder('many')))
    const one = sharedFoldersWith(h.ctx, 'bob', 1)
    expect(one.files).toHaveLength(1)
    expect(one.more).toBe(true)
    expect(ids.length).toBe(8)
  })

  test('folderLinkOf: the link forms the AI may write', () => {
    const id = 'A'.repeat(22)
    expect(folderLinkOf(`/f/${id}`)).toEqual({ id, sub: '', link: `/f/${id}` })
    expect(folderLinkOf(`f/${id}/a/b.md`)).toEqual({ id, sub: 'a/b.md', link: `/f/${id}/a/b.md` })
    expect(folderLinkOf(`https://x.example/f/${id}/a/`)).toEqual({ id, sub: 'a', link: `/f/${id}/a` })
    expect(folderLinkOf(`/f/${id}?x=1`)).toEqual({ id, sub: '', link: `/f/${id}` })
    // the folder page's own address of a place inside (what an answer links)
    expect(folderLinkOf(`/f/${id}?f=${encodeURIComponent('Q4/two words.md')}`)).toEqual({ id, sub: 'Q4/two words.md', link: `/f/${id}/Q4/two words.md` })
    expect(folderLinkOf(`/f/${id}?p=Q4`)).toEqual({ id, sub: 'Q4', link: `/f/${id}/Q4` })
    expect(folderLinkOf(`/f/${id}?f=%E0%A4`)).toBeNull()
    expect(folderLinkOf('users/alice/x')).toBeNull()
    expect(folderLinkOf(`/f/short/a`)).toBeNull()
  })
})

// ---------------- in real turns (the fake engine) ----------------

/** One turn of bob's; a card it raises is left unanswered (it ends by itself). */
async function turn(content: string, chat?: string, parentId?: null) {
  const chatId = chat ?? (await h.api('bob').call(API.createChat, { body: {} })).id
  const r = await h.api('bob').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [], ...(parentId === null ? { parentId: null } : {}) } })
  const done = await socks.bob!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 40_000)
  const cards = socks.bob!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === r.turnId)
    .map((f) => (f as unknown as { data: { request: { question?: string; options?: { value: string }[] } } }).data.request)
  return { chatId, turnId: r.turnId as string, content: done.data.message.content as string, cards }
}
const marks = (chatId: string) => db().query('SELECT rooms_seen AS r, others_words AS o FROM chats WHERE id = ?').get(chatId) as { r: number; o: number }
const shareRow = (p: string) => db().query("SELECT 1 FROM file_shares WHERE path = ? AND kind != 'folder'").get(p)

describe('the mark (T13): names and contents in a shared folder are the sharer\'s words', () => {
  test('(R) a listing alone marks the chat for good: rooms_seen and others_words', async () => {
    const dir = folder(), id = shareDir(dir)
    bucket()
    const r = await turn(`look\n${fake({ tool: 'list', args: { path: `/f/${id}` }, sayResult: true })}`)
    expect(r.content).toContain('report.md')
    expect(marks(r.chatId)).toEqual({ r: 1, o: 1 })
    // a chat that listed only the person's own folder is not marked
    const own = await turn(`look\n${fake({ tool: 'list', args: { path: 'users/bob' } })}`)
    expect(marks(own.chatId)).toEqual({ r: 0, o: 0 })
  })

  test('(R) a read marks it too, and the mark survives a new session: remember asks, a connection sees outside content', async () => {
    const dir = folder(), id = shareDir(dir)
    bucket()
    const first = await turn(`read it\n${fake({ tool: 'read', args: { file_path: `/f/${id}/report.md` }, sayResult: true })}`)
    expect(first.content).toContain('Q4 revenue went up 12 percent.')
    expect(marks(first.chatId).r).toBe(1)
    // a new session of the same chat (a first message again: chat/turn.ts newSession clears the session's marks)
    const again = await turn(`hello\n${fake({ tool: 'remember', args: { text: 'Prefers Q4 numbers' }, sayResult: true })}`, first.chatId, null)
    expect(marks(first.chatId).r).toBe(1)
    // (R) remember asks after it
    expect(again.cards).toHaveLength(1)
    expect(again.cards[0]!.question).toContain('Prefers Q4 numbers')
    expect((db().query("SELECT COUNT(*) n FROM memories WHERE text = 'Prefers Q4 numbers'").get() as { n: number }).n).toBe(0)
    // (R) a connection's write: the gate counts this chat as having read outside content (connections/tools.ts gate)
    expect(outsideSeen(db(), first.chatId)).toBe(true)
  })

  // Rule A (#1143, the owner's 11-13 rule): a person's own "Always allow" is final, also after a listing of a shared folder;
  // without it the card shows and a planted file is refused (docs/decisions/20261116-sharing-all-integration.md). The
  // security review's (R) "the card still shows under Always allow" is superseded by the owner's rule.
  test('(R) after a listing: without "Always allow" the card shows and a planted file is refused; with it the choice is final', async () => {
    const dir = folder(), id = shareDir(dir)
    bucket()
    dropAlways(db(), 'bob', 'card:share_files')
    try {
      // after a listing of the shared folder, in the same answer: the card (and "no" shares nothing)
      const after = await turn(`share ledger-2.txt with Tess Yoon\n${fake({ tool: 'list', args: { path: `/f/${id}` } }, { tool: 'share_with_person', args: { paths: ['users/bob/ledger-2.txt'], people: ['Tess Yoon'] }, sayResult: true })}`)
      expect(after.cards).toHaveLength(1)
      expect(shareRow('users/bob/ledger-2.txt')).toBeNull()
      // ...and a file the person's message did not bring is refused outright (a planted "share all my files")
      const planted = await turn(`go on\n${fake({ tool: 'share_with_person', args: { paths: ['users/bob/ledger-3.txt'], people: ['Tess Yoon'] }, sayResult: true })}`, after.chatId)
      expect(planted.content).toContain('a file is shared only when the user named it in their own message')
      expect(shareRow('users/bob/ledger-3.txt')).toBeNull()
    } finally { keepAlways(db(), 'bob', 'share_files', null) }
    // "Always allow" on: final, also after the listing (the residual risk Rule A accepts)
    bucket()
    const on = await turn(`share ledger-1.txt with Tess Yoon\n${fake({ tool: 'list', args: { path: `/f/${id}` } }, { tool: 'share_with_person', args: { paths: ['users/bob/ledger-1.txt'], people: ['Tess Yoon'] }, sayResult: true })}`)
    expect(on.cards).toHaveLength(0)
    expect(shareRow('users/bob/ledger-1.txt')).not.toBeNull()
  })

  test('after a listing, a later answer: a team file change waits for the room card, delete_files refuses', async () => {
    const dir = folder(), id = shareDir(dir)
    bucket()
    const first = await turn(`look\n${fake({ tool: 'list', args: { path: `/f/${id}` } })}`)
    const later = await turn(`go on\n${fake({ tool: 'write', args: { file_path: 'shared/after-folder-list.md', content: 'x' } })}`, first.chatId)
    expect(later.cards).toHaveLength(1)
    expect(fs.existsSync(abs('shared/after-folder-list.md'))).toBe(false)
    wr('users/bob/keep-me.md', 'keep')
    const del = await turn(`go on\n${fake({ tool: 'delete_files', args: { paths: ['users/bob/keep-me.md'] }, sayResult: true })}`, first.chatId)
    expect(del.content).toContain(DELETE_REFUSAL.roomsSeen)
    expect(fs.existsSync(abs('users/bob/keep-me.md'))).toBe(true)
  })

  test('(R) a scheduled run cannot list or read a shared folder (T34)', async () => {
    const dir = folder(), id = shareDir(dir)
    bucket()
    const chat = (await h.api('bob').call(API.createChat, { body: {} })).id
    const row = h.rt().store.chatRow(chat)!
    const started = h.rt().createTurn({ chat: row, userId: 'bob', locale: 'en', windowId: null, clientKind: 'schedule', engine: row.engine as 'claude-code', model: null,
      user: { parentId: row.active_leaf_id, content: `weekly task\n${fake({ tool: 'list', args: { path: `/f/${id}` }, sayResult: true })}`, attachments: [], clientMessageId: cm() } })
    const done = await socks.bob!.next('message.done', (f) => f.data.message.turnId === started.turnId, 30_000)
    expect(done.data.message.content).not.toContain('report.md')
    expect(marks(chat).r).toBe(0)
  })
})
