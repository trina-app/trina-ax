// share_folder (server/src/chat/share-folder.ts; docs/decisions/20261116-share-folder-tool.md; the folder-sharing design's
// PR 6 with security review M6, M7, M9; QA "Manual AI tests" MAN-019): the AI shares a folder in the asker's own files.
// An add shows the server's card with "Always allow" for folder shares (kind share_folder, its own; once chosen it is
// final: Rule A, docs/decisions/20261116-sharing-all-integration.md), and none when the asker's own message asked for
// exactly it (docs/decisions/20261123-do-then-undo.md); a stop or removal
// narrows, so it runs
// without a card when the asker's own message names the folder, and its record carries the server's Undo. A folder is
// named only by its path, its place in words, a quoted name or the app's own mention. Off where nobody can answer a
// card; in a chat with other people's words only what the asker's own message names. Folder sharing is always on (its
// rollout gate was removed, owner 2026-11-17).
// The fixture team: alice and erin in marketing, bob in finance, carol admin, dana owner (b-harness people), tess added.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Step } from '@mycel/shared/api'
import { FolderShareBlock } from '../../shared/src/api/file-shares'
import { ShareCardRefusal } from '../../shared/src/api/share-card'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { SHARE_FOLDER_TOOL_DESCRIPTION, shareFolderOff } from '../../server/src/chat/share-folder'
import { WHO_CAN_OPEN_DESCRIPTION } from '../../server/src/chat/who-can-open'
import { namesFolder } from '../../server/src/chat/shared-actions'
import { FIND_FOLDER_LINE, REFUSAL_NEXT_RULE, REFUSAL_NEXT_RULE_FOLDERS, SAME_NAME_ACT_LINE, SHARE_FOLDER_DESCRIPTION, SHARE_FOLDER_RULE, TEAM_FOLDER_CALL } from '../../server/src/chat/share-words'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { OWN_WORDS_TOOLS, ROOMS_SEEN_READ_ONLY_TOOLS, SHARED_TOOLS } from '../../server/src/rooms/ai-tools'
import { fileSharesOf } from '../../server/src/files/shares'
import { folderSharesOf } from '../../server/src/files/folder-shares'
import { undoShares } from '../../server/src/files/share-undo'
import { RAN_UNDER_ALWAYS, keepAlways } from '../../server/src/chat/always-allow'
import { tr } from '../../server/src/chat/i18n'
import { roomsOf } from '../../server/src/rooms/service'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
// the fake engine's directives: their strings as JSON escapes, so the person's own words are only what the test writes
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const sf = (args: Record<string, unknown>) => fake({ tool: 'share_folder', args, sayResult: true })
const swp = (args: Record<string, unknown>) => fake({ tool: 'share_with_person', args, sayResult: true })

let h: Harness
const socks: Record<string, TestSocket> = {}
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-share-folder', askUserTimeoutMs: 6000, stallTimeoutMs: 60_000 })
  roomsOf(h.ctx).clock = () => (clock += 60_000)
  h.ctx.db.query("INSERT INTO users (id, username, name, role, status, deleted_at) VALUES ('tess', 'tess', 'Tess Yoon', 'member', 'active', NULL)").run()
  for (const u of ['alice', 'bob', 'carol']) { socks[u] = await h.ws(u, { windowId: `win-sf-${u}` }); await socks[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })
const put = (rel: string, body = rel) => { const abs = path.join(h.ctx.files.fx.root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }
let n = 0
/** a fresh folder in `owner`'s files with two files and one folder in it */
const folder = (owner: string, name: string) => { const d = `users/${owner}/${name}${++n}`; put(`${d}/a.md`); put(`${d}/b.md`); put(`${d}/sub/c.md`); return d }
const user = (id: string) => ({ subjectType: 'user' as const, subjectId: id })
const peopleOn = (owner: string, dir: string) => fileSharesOf(h.ctx).view(owner, dir).people.map((p) => p.subjectId).sort()

type Card = { question: string; origin?: string; options?: { label: string; value: string }[]; always?: unknown; note?: string; share?: { op: string; files: { name: string; place: string; folder?: unknown }[]; who: { name: string }[] } }
async function turn(who: string, content: string, o: { chat?: string; answer?: string | null } = {}) {
  const chatId = o.chat ?? (await h.api(who).call(API.createChat, { body: {} })).id
  const r = await h.api(who).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  let card = null as Card | null
  if (o.answer !== undefined) {
    const c = await socks[who]!.next('turn.request', (f) => f.data.turnId === r.turnId)
    card = c.data.request as unknown as Card
    if (o.answer !== null) await h.api(who).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: o.answer } })
  }
  const done = await socks[who]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  return { chatId, turnId: r.turnId as string, answerId: r.assistantMessage.id as string, content: done.data.message.content as string, card }
}
const stepOf = async (who: string, chatId: string, answerId: string, tool = 'share_folder') => (await h.api(who).call(API.listMessages, { params: { id: chatId }, query: {} })).items.find((x) => x.id === answerId)!.steps!.find((s: Step) => s.tool === tool)
const cardsTo = (who: string, turnId: string) => socks[who]!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === turnId).length
const opensInside = (who: string, linkId: string) => folderSharesOf(h.ctx).openChild(who, linkId, '').kind

describe('sharing a folder: always the card', () => {
  test('MAN-019: the card names the folder in words, what it holds and that later files follow; Share shares it, audited via ai', async () => {
    const dir = folder('bob', 'QA-test')
    const r = await turn('bob', `Share the folder ${dir.split('/').pop()} with Tess Yoon as viewer\n${sf({ folder: dir, add: ['Tess Yoon'] })}`, { answer: 'yes' })
    expect(r.card!.origin).toBe('server')
    expect(r.card!.options!.map((x) => x.value)).toEqual(['yes', '__always', 'no'])
    expect(r.card!.note).toBe(tr('cardAlwaysNoteShareFolder', 'ko'))
    // (bob reads Korean: the line that says files added later follow)
    expect(r.card!.question).toContain('나중에 넣는 파일까지')
    expect(r.card!.share).toMatchObject({ op: 'share', files: [{ name: dir.split('/').pop(), folder: { files: 2, folders: 1 } }], who: [{ name: 'Tess Yoon' }] })
    expect(JSON.stringify(r.card)).not.toContain('users/')
    const out = JSON.parse(r.content)
    expect(out.status).toBe('shared')
    expect(out.note).toContain('one short sentence')
    expect(peopleOn('bob', dir)).toEqual(['tess'])
    const step = (await stepOf('bob', r.chatId, r.answerId))!
    expect(step.shared).toMatchObject({ op: 'share', outcome: 'done', level: 'view', files: [{ name: dir.split('/').pop(), folder: { files: 2, folders: 1 } }], who: [{ subjectId: 'tess' }], notified: ['tess'] })
    expect(step.shared!.files[0]!.place).not.toContain('users/')
    const linkId = step.shared!.files[0]!.linkId!
    expect(opensInside('tess', linkId)).toBe('open')
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'folder_share.add' AND actor_id = 'bob' ORDER BY id DESC").get() as { detail: string }
    expect(JSON.parse(a.detail)).toMatchObject({ via: 'ai', people: 1 })
    expect((h.ctx.db.query('SELECT via FROM file_share_grants WHERE share_id = ?').get(linkId) as { via: string }).via).toBe('ai')
  })

  test('Cancel shares nothing', async () => {
    const dir = folder('bob', 'Cancel')
    // (no ask in the person's own words: the card; docs/decisions/20261123-do-then-undo.md)
    const r = await turn('bob', `go ahead\n${sf({ folder: dir, add: ['Tess Yoon'] })}`, { answer: 'no' })
    expect(r.content).toContain('chose not to share')
    expect(peopleOn('bob', dir)).toEqual([])
  })

  test('Always allow for FILE shares on: the folder card still shows (its own kind); the folder and person named in a share request: no card (docs/decisions/20261123-do-then-undo.md)', async () => {
    keepAlways(h.ctx.db, 'bob', 'share_files', null)
    // (Always allow is really on: a file share asked the same way goes without its card)
    put('users/bob/plain-file.txt')
    const file = await turn('bob', `share plain-file.txt with Tess Yoon\n${swp({ paths: ['users/bob/plain-file.txt'], people: ['Tess Yoon'] })}`)
    expect(cardsTo('bob', file.turnId)).toBe(0)
    const dir = folder('bob', 'Always')
    const r = await turn('bob', `go on\n${sf({ folder: dir, add: ['Tess Yoon'] })}`, { answer: 'no' })
    expect(r.card).not.toBeNull()
    expect(r.card!.options!.map((o) => o.value)).toEqual(['yes', '__always', 'no'])
    expect(peopleOn('bob', dir)).toEqual([])
    // the person's own message asks for exactly this share: done without the card, its card has the undo
    const asked = await turn('bob', `share the folder ${dir} with Tess Yoon\n${sf({ folder: dir, add: ['Tess Yoon'] })}`)
    expect(cardsTo('bob', asked.turnId)).toBe(0)
    expect(peopleOn('bob', dir)).toEqual(['tess'])
    expect(JSON.parse(asked.content).note).toContain('without a confirmation card')
  })

  test('"Always allow" for folder shares: picked on the card it shares and is kept; then no card, also after other people\'s words in my own chat; a stop still asks unless named', async () => {
    const kind = () => h.ctx.db.query("SELECT 1 FROM card_always_allow WHERE user_id = 'bob' AND kind = 'share_folder'").get()
    try {
      const one = folder('bob', 'AlwaysF')
      const r = await turn('bob', `go ahead\n${sf({ folder: one, add: ['Tess Yoon'] })}`, { answer: '__always' })
      expect(r.card).not.toBeNull()
      expect(peopleOn('bob', one)).toEqual(['tess'])
      expect(kind()).not.toBeNull()
      // the next share: no card
      const two = folder('bob', 'AlwaysG')
      const next = await turn('bob', `share it\n${sf({ folder: two, add: ['Tess Yoon'] })}`)
      expect(cardsTo('bob', next.turnId)).toBe(0)
      expect(JSON.parse(next.content).status).toBe('shared')
      // the AI is told it ran under the person's Always allow (QA 2026-11-17: never "you approved it")
      expect(JSON.parse(next.content).note).toContain(RAN_UNDER_ALWAYS)
      expect(JSON.parse(r.content).note).not.toContain(RAN_UNDER_ALWAYS)
      // my own chat that read something other people wrote: the choice is final (Rule A), no refusal, no card
      const three = folder('bob', 'AlwaysH')
      const chat = (await h.api('bob').call(API.createChat, { body: {} })).id
      h.ctx.db.query('UPDATE chats SET others_words = 1 WHERE id = ?').run(chat)
      const after = await turn('bob', `go on\n${sf({ folder: three, add: ['Tess Yoon'] })}`, { chat })
      expect(cardsTo('bob', after.turnId)).toBe(0)
      expect(peopleOn('bob', three)).toEqual(['tess'])
      // a stop has no "Always allow": not named in my message, the card
      const stop = await turn('bob', `stop it\n${sf({ folder: three, stop: true })}`, { answer: 'no' })
      expect(stop.card).not.toBeNull()
      expect(stop.card!.options!.map((o) => o.value)).toEqual(['yes', 'no'])
      expect(peopleOn('bob', three)).toEqual(['tess'])
    } finally { h.ctx.db.query("DELETE FROM card_always_allow WHERE user_id = 'bob' AND kind = 'share_folder'").run() }
  })

  test('never-shared places and the personal folder itself: refused with a plain next step, no card, a refusal record', async () => {
    put('users/bob/loose.txt')
    for (const [dir, says, block] of [['users/bob', 'whole personal folder', 'root'], ['users/bob/.attachments', 'Trina keeps its own files', 'system_place']] as const) {
      fs.mkdirSync(path.join(h.ctx.files.fx.root, ...dir.split('/')), { recursive: true })
      const r = await turn('bob', `share it\n${sf({ folder: dir, add: ['Tess Yoon'] })}`)
      expect(r.content).toContain(says)
      expect(r.content).toContain('Nothing was')
      expect(cardsTo('bob', r.turnId)).toBe(0)
      if (block) expect((await stepOf('bob', r.chatId, r.answerId))!.shared).toMatchObject({ op: 'share', outcome: 'refused', refusal: { reason: 'place', block } })
    }
    const file = await turn('bob', `share it\n${sf({ folder: 'users/bob/loose.txt', add: ['Tess Yoon'] })}`)
    expect(file.content).toContain('is a file')
  })

  test('a dev environment run alive (run_active): refused with one plain sentence', async () => {
    const dir = folder('bob', 'Busy')
    const fsh = folderSharesOf(h.ctx) as unknown as { view: (...a: unknown[]) => unknown }
    const view0 = fsh.view
    // (the folder view's own answer while a run of the owner is alive: devenv/srt/alive.ts)
    fsh.view = function (...a: unknown[]) { return { ...(view0.apply(this, a) as object), blocked: 'run_active', canShare: false } }
    try {
      const r = await turn('bob', `share it\n${sf({ folder: dir, add: ['Tess Yoon'] })}`)
      expect(r.content).toContain('dev environment task')
      expect(cardsTo('bob', r.turnId)).toBe(0)
      expect((await stepOf('bob', r.chatId, r.answerId))!.shared).toMatchObject({ outcome: 'refused', refusal: { reason: 'place', block: 'run_active' } })
    } finally { fsh.view = view0 }
    expect(peopleOn('bob', dir)).toEqual([])
  })

  test('a team folder: not shared by the tool; a member is told only admins share it', async () => {
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'shared', 'TeamStuff'), { recursive: true })
    const r = await turn('bob', `share it\n${sf({ folder: 'shared/TeamStuff', add: ['Tess Yoon'] })}`)
    expect(r.content).toContain('team folder')
    expect(cardsTo('bob', r.turnId)).toBe(0)
  })

  // (the merge of AI sharing and folder sharing; PR 6's real-AI run: the AI answered a team folder in words)
  test('a team folder for an admin: the result sends the AI to change_folder_access, which asks on its card', async () => {
    fs.mkdirSync(path.join(h.ctx.files.fx.root, 'shared', 'TeamAdmin'), { recursive: true })
    const r = await turn('carol', `share it\n${sf({ folder: 'shared/TeamAdmin', add: ['Tess Yoon'] })}`)
    expect(r.content).toContain('team folder')
    expect(r.content).toContain('call change_folder_access')
    expect(cardsTo('carol', r.turnId)).toBe(0)
  })

  // (the merge of AI sharing and folder sharing: who_can_open knew only file shares and the folder rules)
  test('who_can_open on a file inside my shared folder: the folder\'s people are named, and a recipient "can already open it"', async () => {
    const dir = folder('bob', 'WhoIn')
    fileSharesOf(h.ctx).put('bob', dir, [{ subjectType: 'user', subjectId: 'tess' }], [], 'en')
    const r = await turn('bob', fake({ tool: 'who_can_open', args: { path: `${dir}/a.md`, person: 'Tess Yoon' }, sayResult: true }))
    expect(r.content).toContain(`inside the user's shared folder "${dir.split('/').pop()}"`)
    expect(r.content).toContain('Tess Yoon can already open it: through the shared folder')
    expect(r.content).not.toContain('Tess Yoon cannot open it')
  })

  test('the words: find a folder by looking at folders; a team folder asked for: call the tool, never answer from memory', () => {
    expect(FIND_FOLDER_LINE).toContain('look at folders')
    expect(FIND_FOLDER_LINE).toContain('glob and grep find files, not folders')
    expect(TEAM_FOLDER_CALL).toContain('call the tool anyway (share_folder, or change_folder_access')
    expect(TEAM_FOLDER_CALL).toContain('"Ask an admin"')
    for (const s of [SHARE_FOLDER_TOOL_DESCRIPTION, SHARE_FOLDER_RULE]) { expect(s).toContain(FIND_FOLDER_LINE); expect(s).toContain(TEAM_FOLDER_CALL) }
    expect(SHARE_FOLDER_TOOL_DESCRIPTION).toContain(SAME_NAME_ACT_LINE)
    expect(WHO_CAN_OPEN_DESCRIPTION).toContain(FIND_FOLDER_LINE)
    // where share_folder is not offered (a guest, a scheduled run): share_with_person's folder words find the folder too;
    // the refusal rule names only the tool that is there (never share_folder)
    expect(SHARE_FOLDER_DESCRIPTION).toContain(FIND_FOLDER_LINE)
    expect(REFUSAL_NEXT_RULE).toContain('call change_folder_access when you have it')
    expect(REFUSAL_NEXT_RULE).not.toContain('share_folder')
    expect(REFUSAL_NEXT_RULE_FOLDERS).toContain(TEAM_FOLDER_CALL)
  })
})

describe('stopping and taking people off: narrowing, server Undo', () => {
  test('the folder named by path and the person named: no card, access gone, the record carries the server Undo; Undo restores quietly, once, for the actor only', async () => {
    const dir = folder('bob', 'Stop')
    fileSharesOf(h.ctx).put('bob', dir, [user('tess'), user('alice')], [], 'en')
    const linkId = fileSharesOf(h.ctx).view('bob', dir).link!.id
    const notices0 = (h.ctx.db.query("SELECT COUNT(*) n FROM file_share_notices WHERE user_id = 'tess'").get() as { n: number }).n
    const r = await turn('bob', `stop sharing ${dir} with Tess Yoon\n${sf({ folder: dir, remove: ['Tess Yoon'] })}`)
    expect(cardsTo('bob', r.turnId)).toBe(0)
    expect(JSON.parse(r.content).status).toBe('removed')
    expect(peopleOn('bob', dir)).toEqual(['alice'])
    expect(opensInside('tess', linkId)).toBe('no_access')
    const rec = (await stepOf('bob', r.chatId, r.answerId))!.shared!
    expect(rec).toMatchObject({ op: 'stop', outcome: 'done', who: [{ subjectId: 'tess' }], files: [{ linkId }] })
    expect(rec.undo!.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    // the AI never sees the snapshot's id
    expect(r.content).not.toContain(rec.undo!.id)
    // someone else cannot use it; the actor can, once, and nobody is told again
    expect(() => undoShares(h.ctx, 'alice', rec.undo!.id, 'en')).toThrow()
    const u = undoShares(h.ctx, 'bob', rec.undo!.id, 'en')
    expect(u).toMatchObject({ restored: 1, skipped: 0 })
    expect(peopleOn('bob', dir)).toEqual(['alice', 'tess'])
    expect((h.ctx.db.query("SELECT COUNT(*) n FROM file_share_notices WHERE user_id = 'tess'").get() as { n: number }).n).toBe(notices0)
    expect(() => undoShares(h.ctx, 'bob', rec.undo!.id, 'en')).toThrow()
  })

  test('P6-3: the audit names the turn (add, remove, stop, and a refusal before any change); the undo snapshot names the step', async () => {
    const dir = folder('bob', 'Audit')
    const added = await turn('bob', `share ${dir} with Tess Yoon\n${sf({ folder: dir, add: ['Tess Yoon'] })}`)
    const add = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'folder_share.add' AND actor_id = 'bob' ORDER BY id DESC").get() as { detail: string }
    expect(JSON.parse(add.detail)).toMatchObject({ via: 'ai', turnId: added.turnId })
    const removed = await turn('bob', `stop sharing ${dir} with Tess Yoon\n${sf({ folder: dir, remove: ['Tess Yoon'] })}`)
    const rem = h.ctx.db.query("SELECT detail FROM audit_log WHERE action IN ('folder_share.remove', 'folder_share.stop') AND actor_id = 'bob' ORDER BY id DESC").get() as { detail: string }
    expect(JSON.parse(rem.detail)).toMatchObject({ via: 'ai', turnId: removed.turnId })
    const step = (await stepOf('bob', removed.chatId, removed.answerId))!
    const undo = h.ctx.db.query('SELECT step_id FROM file_share_undos WHERE id = ?').get(step.shared!.undo!.id) as { step_id: string | null }
    expect(undo.step_id).toBe(step.id)
    // a refusal before any change: audited with the turn, no path or name in it
    const refused = await turn('bob', `share it\n${sf({ folder: 'users/bob', add: ['Tess Yoon'] })}`)
    const ref = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'folder_share.refused' AND actor_id = 'bob' ORDER BY id DESC").get() as { detail: string }
    expect(JSON.parse(ref.detail)).toMatchObject({ via: 'ai', turnId: refused.turnId, why: 'refused: root' })
    expect(ref.detail).not.toContain('users/')
    expect(ref.detail).not.toContain('Tess')
  })

  test('Undo skips someone who left the team and puts back the rest', async () => {
    const dir = folder('bob', 'Left')
    h.ctx.db.query("INSERT OR IGNORE INTO users (id, username, name, role, status, deleted_at) VALUES ('lee', 'lee', 'Lee Park', 'member', 'active', NULL)").run()
    fileSharesOf(h.ctx).put('bob', dir, [user('tess'), user('lee')], [], 'en')
    const r = await turn('bob', `stop sharing "${dir.split('/').pop()}"\n${sf({ folder: dir, stop: true })}`)
    expect(JSON.parse(r.content).status).toBe('stopped')
    const rec = (await stepOf('bob', r.chatId, r.answerId))!.shared!
    expect(rec.who.map((w) => w.subjectId).sort()).toEqual(['lee', 'tess'])
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'lee'").run()
    expect(undoShares(h.ctx, 'bob', rec.undo!.id, 'en')).toMatchObject({ restored: 1, skipped: 1 })
    expect(peopleOn('bob', dir)).toEqual(['tess'])
  })

  test('a common word in a sentence does not name the folder: the stop asks on a card', async () => {
    const dir = `users/bob/Work`
    put(`${dir}/x.md`)
    fileSharesOf(h.ctx).put('bob', dir, [user('tess')], [], 'en')
    const r = await turn('bob', `stop sharing Work with Tess Yoon\n${sf({ folder: dir, remove: ['Tess Yoon'] })}`, { answer: 'no' })
    expect(r.card).not.toBeNull()
    expect(r.card!.share).toMatchObject({ op: 'stop', who: [{ name: 'Tess Yoon' }] })
    expect(peopleOn('bob', dir)).toEqual(['tess'])
    // quoted, it is named: no card
    const q = await turn('bob', `stop sharing "Work" with Tess Yoon\n${sf({ folder: dir, remove: ['Tess Yoon'] })}`)
    expect(cardsTo('bob', q.turnId)).toBe(0)
    expect(peopleOn('bob', dir)).toEqual([])
  })

  test('"don\'t" in the asker\'s words keeps the card', async () => {
    const dir = folder('bob', 'Dont')
    fileSharesOf(h.ctx).put('bob', dir, [user('tess')], [], 'en')
    const r = await turn('bob', `don't stop sharing ${dir} with Tess Yoon\n${sf({ folder: dir, remove: ['Tess Yoon'] })}`, { answer: 'no' })
    expect(r.card).not.toBeNull()
    expect(peopleOn('bob', dir)).toEqual(['tess'])
  })

  test('the team switch off: the owner still stops it through the AI', async () => {
    const { updateTeamSettings } = await import('../../server/src/admin/settings')
    const dir = folder('bob', 'SwitchOff')
    fileSharesOf(h.ctx).put('bob', dir, [user('tess')], [], 'en')
    updateTeamSettings(h.ctx.db, { memberFileShares: false })
    try {
      const r = await turn('bob', `stop sharing ${dir}\n${sf({ folder: dir, stop: true })}`)
      expect(JSON.parse(r.content).status).toBe('stopped')
      expect(peopleOn('bob', dir)).toEqual([])
    } finally { updateTeamSettings(h.ctx.db, { memberFileShares: true }) }
  })
})

describe('other people\'s words in the chat', () => {
  test('a chat marked as holding other people\'s words: refused unless the asker names the folder (and, for an add, the person)', async () => {
    const dir = folder('bob', 'Marked')
    const first = await turn('bob', fake({ say: 'hi' }))
    const mark = () => h.ctx.db.query('UPDATE chats SET others_words = 1 WHERE id = ?').run(first.chatId)
    mark()
    const unnamed = await turn('bob', `share that folder with Tess Yoon\n${sf({ folder: dir, add: ['Tess Yoon'] })}`, { chat: first.chatId })
    expect(unnamed.content).toContain('by its full name in quotes')
    expect(cardsTo('bob', unnamed.turnId)).toBe(0)
    mark()
    const noPerson = await turn('bob', `share ${dir} with her\n${sf({ folder: dir, add: ['Tess Yoon'] })}`, { chat: first.chatId })
    expect(noPerson.content).toContain('only with the people the user')
    mark()
    // (named in full in the person's own words: no card, docs/decisions/20261123-do-then-undo.md)
    const ok = await turn('bob', `share ${dir} with Tess Yoon\n${sf({ folder: dir, add: ['Tess Yoon'] })}`, { chat: first.chatId })
    expect(cardsTo('bob', ok.turnId)).toBe(0)
    expect(JSON.parse(ok.content).status).toBe('shared')
  })

  test('a shared chat: only the asker gets the record; the other viewer (and a chat shared later) sees the verb alone (M7)', async () => {
    const chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
    const dir = folder('alice', 'Shared')
    // alice's own chat, shared with bob only after the stop (a chat shared later)
    fileSharesOf(h.ctx).put('alice', dir, [user('tess')], [], 'en')
    const r = await turn('alice', `stop sharing ${dir} with Tess Yoon\n${sf({ folder: dir, remove: ['Tess Yoon'] })}`, { chat: chatId })
    expect(JSON.parse(r.content).status).toBe('removed')
    const subjects = [{ subjectType: 'user' as const, subjectId: 'bob' }]
    let s = await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects } })
    if (s.status === 'confirm') s = await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects, confirmKey: s.confirmKey } })
    expect(s.status).toBe('saved')
    expect((await stepOf('alice', chatId, r.answerId))!.shared!.undo).toBeDefined()
    const seen = (await stepOf('bob', chatId, r.answerId))!
    expect(seen.shared).toBeUndefined()
    expect(JSON.stringify(seen)).not.toContain('Tess')
    expect(JSON.stringify(seen)).not.toContain(dir.split('/').pop()!)
  })
})

describe('where it is off; the lists', () => {
  test('never in a scheduled run, a confidential chat, Slack, a restricted run, or for a guest; always on otherwise', () => {
    const base = { restricted: false, templateRun: null, rt: { db: h.ctx.db, ctx: h.ctx }, spec: { clientKind: 'web', chatId: 'none', userId: 'bob' } } as never
    expect(shareFolderOff(base)).toBeNull()
    expect(shareFolderOff({ ...(base as object), spec: { clientKind: 'schedule', chatId: 'none', userId: 'bob' } } as never)?.summary).toContain('scheduled run')
    expect(shareFolderOff({ ...(base as object), restricted: true } as never)?.summary).toContain('not here')
    expect(shareFolderOff({ ...(base as object), templateRun: {} } as never)?.summary).toContain('not here')
    expect(shareFolderOff({ ...(base as object), spec: { clientKind: 'slack', chatId: 'none', userId: 'bob' } } as never)?.summary).toContain('Slack')
    h.ctx.db.query("INSERT OR IGNORE INTO users (id, username, name, role, status, deleted_at, guest) VALUES ('gus', 'gus', 'Gus Guest', 'member', 'active', NULL, 1)").run()
    const guest = shareFolderOff({ ...(base as object), spec: { clientKind: 'web', chatId: 'none', userId: 'gus' } } as never)
    // (a guest account without a guest grant reads as an ordinary member to isGuestUser; the tool list keeps guests out)
    expect(guest === null || guest.summary.includes('guest')).toBe(true)
    expect(shareFolderOff(base)).toBeNull()
  })

  test('the lists: main AI only, a shared chat\'s list, its own words, no room card for it', () => {
    expect(PARENT_ONLY_TOOLS.has('share_folder')).toBe(true)
    expect(SHARED_TOOLS.has('share_folder')).toBe(true)
    expect(OWN_WORDS_TOOLS.has('share_folder')).toBe(true)
    expect(ROOMS_SEEN_READ_ONLY_TOOLS.has('share_folder')).toBe(true)
  })

  test('offered, and share_with_person sends the user\'s own folder to share_folder (no interim "files in it" answer)', async () => {
    const dir = folder('bob', 'Gate')
    const tools = async () => (await turn('bob', fake({ echo: 'tools' }))).content.split(',').map((t) => t.replace(/^mcp__team__/, ''))
    const desc = async () => JSON.parse((await turn('bob', fake({ echo: 'toolDescriptions' }))).content) as Record<string, string>
    expect(await tools()).toContain('share_folder')
    expect((await desc())['share_with_person'] ?? (await desc())['mcp__team__share_with_person']).toContain('shared as a whole with share_folder')
    const open = await turn('bob', `share it\n${swp({ paths: [dir], people: ['Tess Yoon'] })}`)
    expect(open.content).toContain('call share_folder')
    expect(open.content).not.toContain('cannot be shared yet')
    expect(open.content).not.toContain("I can't share the whole folder")
    // the rule the prompt carries follows the tool; no rule says "yet"
    expect(REFUSAL_NEXT_RULE).not.toContain('yet')
    expect(REFUSAL_NEXT_RULE).toContain('Share on the folder in Files')
    expect(REFUSAL_NEXT_RULE_FOLDERS).toContain('share_folder')
    expect(REFUSAL_NEXT_RULE_FOLDERS).not.toContain('yet')
    expect(await (async () => (await turn('bob', fake({ echo: 'system' }))).content)()).toContain(REFUSAL_NEXT_RULE_FOLDERS)
  })

  test('the card record\'s folder reasons are the Share dialog\'s', () => {
    expect(ShareCardRefusal.shape.block.unwrap().options).toEqual(FolderShareBlock.options)
  })
})

describe('namesFolder (M9)', () => {
  const rel = 'users/bob/Projects/Work'
  test('a common word in a sentence is not a name; a short name never by itself', () => {
    expect(namesFolder('share Work with Jun', rel)).toBe(false)
    expect(namesFolder('stop sharing the work folder', rel)).toBe(false)
    expect(namesFolder('share Q with Jun', 'users/bob/Q')).toBe(false)
  })
  test('the path, the place in words, a quoted name, the app\'s own mention', () => {
    expect(namesFolder(`share ${rel} with Jun`, rel)).toBe(true)
    expect(namesFolder(`share ${rel}/ with Jun`, rel)).toBe(true)
    expect(namesFolder('share My files › Projects › Work with Jun', rel, { place: 'My files › Projects › Work' })).toBe(true)
    expect(namesFolder('share my files > projects > work with Jun', rel, { place: 'My files › Projects › Work' })).toBe(true)
    for (const q of ['"Work"', '“Work”', "'Work'", '「Work」', '`Work`']) expect(namesFolder(`share ${q} with Jun`, rel), q).toBe(true)
    expect(namesFolder('share "Q" with Jun', 'users/bob/Q')).toBe(true)
    expect(namesFolder(`share [Work](/files/view?path=${encodeURIComponent(rel)}) with Jun`, rel)).toBe(true)
    expect(namesFolder('share this', rel, { attached: new Set([rel]) })).toBe(true)
    // another folder's quoted name or link is not this one
    expect(namesFolder('share "Work2" with Jun', rel)).toBe(false)
    expect(namesFolder(`share [x](/files/view?path=${encodeURIComponent('users/bob/Other')})`, rel)).toBe(false)
  })
  test('the one check for every folder tool (PR 7 used the same rules): a path needs a "/", as a whole', () => {
    // a one-part path is the bare name: not enough
    expect(namesFolder('share Reports with Jun', 'Reports')).toBe(false)
    expect(namesFolder('share Sales/Reports with Jun', 'Sales/Reports')).toBe(true)
    expect(namesFolder('share Sales/Reports/ with Jun', 'Sales/Reports')).toBe(true)
    // part of a longer name or path is not this one
    expect(namesFolder('share Sales/Reports2 with Jun', 'Sales/Reports')).toBe(false)
    expect(namesFolder('share Old/Sales/Reports with Jun', 'Sales/Reports')).toBe(false)
    // quotes with spaces inside, and mixed quotation marks
    expect(namesFolder('share " Reports " with Jun', 'Reports')).toBe(true)
    expect(namesFolder('share «Reports» with Jun', 'Reports')).toBe(true)
  })
  test('what looking_at reported is never the asker\'s word: only their own text counts', () => {
    // the tool reads the asker's own message only; a folder the screen showed is not in it
    expect(namesFolder('stop sharing this folder with Tess', rel)).toBe(false)
  })
})
