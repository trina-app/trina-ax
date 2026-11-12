// Security (QA TC-423, docs/DECISIONS.md "Getting back to earlier work, part A"): a file's version history names the AI
// chat that saved a version (FileVersion.savedChatId, current.chatId: the screen's "Open the chat") only to a person who
// may open that chat now (server/src/chat/version-chats.ts). Everyone here may read the file (shared/), so the history
// itself answers everyone; the chat's id must reach only the right people, and nobody else may learn that a chat exists:
// the id appears nowhere in their answer.
//   - someone else's private chat (the owner and an admin included);
//   - a chat in the trash (Deleted history), or gone for good;
//   - a shared project chat of a project the person does not see (erin; the admin and the owner, who are not members),
//     or no longer sees (bob after he left finance), or whose project folder is in the trash;
//   - an answer of a shared chat hidden from the person (chat/shared-answers.ts);
//   - a confidential chat that is not theirs (safe operations 1A);
//   - a chat of their own in a project they do not see now (stricter than opening it);
//   - a room's AI, and the server's own draft chats.
// And never a link to a chat the person cannot open: wherever the id shows, GET /api/chats/:id answers them 200.
// Fixture: alice = member of marketing; bob = member of finance; carol = admin; dana = owner; erin = member of marketing.
// projects/falcon: alice writes it, finance reads it (bob); projects/atlas: finance only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared/api'
import { makeCApp, sha256hex, type CApp, type Person } from '../lib/c-app'
import { legacyProject } from '../lib/legacy-project'

setDefaultTimeout(60_000)
const PEOPLE: readonly Person[] = ['alice', 'bob', 'carol', 'dana', 'erin']

let A: CApp
let falcon: string, atlas: string
beforeAll(async () => {
  A = await makeCApp('sec-version-chat-link')
  falcon = legacyProject(A.ctx.db, A.team, 'alice', { name: 'Falcon', folderPath: 'projects/falcon' })
  atlas = legacyProject(A.ctx.db, A.team, 'bob', { name: 'Atlas', folderPath: 'projects/atlas' })
})
afterAll(async () => { await A.close() })

const db = () => A.ctx.db
/** a chat of `user` (as the chat routes make it), optionally in a project and shared there */
function chat(user: Person, o: { project?: string; shared?: boolean; room?: boolean } = {}): string {
  const id = A.chat(user)
  db().query('UPDATE chats SET project_id = ?, shared_at = ?, room_id = ? WHERE id = ?')
    .run(o.project ?? null, o.shared ? new Date().toISOString() : null, o.room ? uuidv7() : null, id)
  return id
}
/** An AI answer of `runner` in the chat that saves `content` to `p` (its turn, its question and answer, and for a shared
 * chat the answer's record: `seenBy` the people who saw the chat then, nothing read; null: no record, as an answer this
 * build could not judge, hidden from all but its runner). Returns the turn. */
function aiSave(runner: Person, chatId: string, p: string, content: string, o: { record?: boolean } = {}): string {
  const turnId = A.turn(runner, chatId)
  const q = uuidv7(), a = uuidv7()
  db().query("INSERT INTO messages (id, chat_id, role, content, author_id, turn_id) VALUES (?, ?, 'user', 'save it', ?, ?)").run(q, chatId, runner, turnId)
  db().query("INSERT INTO messages (id, chat_id, role, content, parent_id, turn_id) VALUES (?, ?, 'assistant', 'saved', ?, ?)").run(a, chatId, q, turnId)
  db().query("UPDATE turns SET message_id = ?, status = 'done' WHERE id = ?").run(a, turnId)
  if (o.record ?? true) db().query('INSERT INTO shared_answer_reads (message_id, chat_id) VALUES (?, ?)').run(a, chatId)
  const tc = A.toolCtx(runner, turnId)
  const abs = path.join(A.team, ...p.split('/'))
  if (fs.existsSync(abs)) tc.files.readHashes.set(p, sha256hex(fs.readFileSync(abs)))
  A.ctx.files.writeBytes(tc, p, Buffer.from(content), tc.files.readHashes, 'write')
  return turnId
}
/** Two AI saves in the chat: the first is a stored version (savedTurnId), the second the file as it is now (turnId). */
function twoSaves(runner: Person, chatId: string, p: string, o: { record?: boolean } = {}) {
  const first = aiSave(runner, chatId, p, `first ${p}`, o)
  const second = aiSave(runner, chatId, p, `second ${p}`, o)
  return { first, second }
}
const history = async (as: Person, p: string) => {
  const r = await A.json('/api/files/history?path=' + encodeURIComponent(p), { as })
  expect({ as, status: r.status }).toEqual({ as, status: 200 })
  return { body: r.body, text: JSON.stringify(r.body) }
}

/** For every person: the chat's id shows exactly for `allowed`, on both the stored version and the current file, and
 * nowhere else; wherever it shows, the chat opens for them. The AI saves stay marked for everyone ("by AI"). */
async function expectLinks(p: string, chatId: string, turns: { first: string; second: string }, allowed: readonly Person[]) {
  for (const who of PEOPLE) {
    const { body, text } = await history(who, p)
    const v = body.items.find((x: any) => x.savedTurnId === turns.first)
    expect({ who, saved: !!v, current: body.current?.turnId }).toEqual({ who, saved: true, current: turns.second })
    const want = allowed.includes(who)
    expect({ who, version: v.savedChatId ?? null, current: body.current.chatId ?? null }).toEqual({ who, version: want ? chatId : null, current: want ? chatId : null })
    expect({ who, idAnywhere: text.includes(chatId) }).toEqual({ who, idAnywhere: want })
    if (want) expect({ who, opens: (await A.req(`/api/chats/${chatId}`, { as: who })).status }).toEqual({ who, opens: 200 })
  }
}

describe('a chat of one person', () => {
  test('only its person gets the link; the owner and an admin do not', async () => {
    const p = 'shared/vlink/private.md', c = chat('alice')
    await expectLinks(p, c, twoSaves('alice', c, p), ['alice'])
  })

  test('in the trash (Deleted history): nobody, its person included', async () => {
    const p = 'shared/vlink/trash.md', c = chat('alice')
    const turns = twoSaves('alice', c, p)
    await expectLinks(p, c, turns, ['alice'])
    expect((await A.req(`/api/chats/${c}`, { as: 'alice', method: 'DELETE' })).status).toBeLessThan(300)
    expect(db().query('SELECT deleted_at FROM chats WHERE id = ?').get(c)).not.toEqual({ deleted_at: null })
    await expectLinks(p, c, turns, [])
  })

  test('gone for good: nobody', async () => {
    const p = 'shared/vlink/purged.md', c = chat('alice')
    const turns = twoSaves('alice', c, p)
    db().query('DELETE FROM messages WHERE chat_id = ?').run(c)
    db().query('DELETE FROM chats WHERE id = ?').run(c)
    await expectLinks(p, c, turns, [])
  })

  test('confidential: still its person\'s (a confidential chat is never someone else\'s to open)', async () => {
    const p = 'shared/vlink/confidential.md', c = chat('alice')
    db().query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(c)
    await expectLinks(p, c, twoSaves('alice', c, p), ['alice'])
  })

  test('in a project its person sees: the link; in a project they do not see (now): none, though it is theirs', async () => {
    const p = 'shared/vlink/own-in-project.md', c = chat('alice', { project: falcon })
    const turns = twoSaves('alice', c, p)
    await expectLinks(p, c, turns, ['alice'])
    // atlas is finance's only: alice's own chat there (moved in by an older build, or she left the project)
    db().query('UPDATE chats SET project_id = ? WHERE id = ?').run(atlas, c)
    await expectLinks(p, c, turns, [])
    db().query('UPDATE chats SET project_id = ? WHERE id = ?').run(falcon, c)
  })

  test('a room\'s AI and the server\'s own draft chats: nobody', async () => {
    const p1 = 'shared/vlink/room.md', room = chat('alice', { room: true })
    await expectLinks(p1, room, twoSaves('alice', room, p1), [])
    const p2 = 'shared/vlink/draft.md', draft = chat('alice')
    db().query("INSERT INTO onboarding_file_ranks (chat_id, user_id, material, created_at) VALUES (?, 'alice', '[]', ?)").run(draft, new Date().toISOString())
    await expectLinks(p2, draft, twoSaves('alice', draft, p2), [])
  })
})

describe('a shared project chat (projects/falcon: alice and bob see it)', () => {
  test('its audience gets the link; erin, the admin and the owner (not members) do not', async () => {
    const p = 'shared/vlink/shared.md', c = chat('bob', { project: falcon, shared: true })
    await expectLinks(p, c, twoSaves('bob', c, p), ['alice', 'bob'])
  })

  test('bob lost the project: not for him any more, though he made it and saved the file', async () => {
    const p = 'shared/vlink/shared-lost.md', c = chat('bob', { project: falcon, shared: true })
    const turns = twoSaves('bob', c, p)
    db().query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'bob'").run()
    try {
      await expectLinks(p, c, turns, ['alice'])
    } finally { db().query("INSERT INTO group_members VALUES ('finance', 'bob')").run() }
    await expectLinks(p, c, turns, ['alice', 'bob'])
  })

  test('the project\'s folder is in the trash: nobody', async () => {
    const p = 'shared/vlink/shared-trashed.md', c = chat('bob', { project: falcon, shared: true })
    const turns = twoSaves('bob', c, p)
    db().query("UPDATE projects SET trashed_with = 'sec-vlink-trash' WHERE id = ?").run(falcon)
    try {
      await expectLinks(p, c, turns, [])
    } finally { db().query('UPDATE projects SET trashed_with = NULL WHERE id = ?').run(falcon) }
  })

  test('an answer hidden from alice (no record: judged hidden from all but its runner): only bob, who ran it', async () => {
    const p = 'shared/vlink/shared-hidden.md', c = chat('bob', { project: falcon, shared: true })
    await expectLinks(p, c, twoSaves('bob', c, p, { record: false }), ['bob'])
  })

  test('while safe operations (1A) are on every chat is confidential: only its creator; alice still opens her own', async () => {
    const p = 'shared/vlink/shared-1a.md', c = chat('bob', { project: falcon, shared: true })
    const turns = twoSaves('bob', c, p)
    const p2 = 'shared/vlink/own-1a.md', own = chat('alice')
    const ownTurns = twoSaves('alice', own, p2)
    process.env.MYCEL_SAFE_OPS_1A = '1'
    try {
      await expectLinks(p, c, turns, ['bob'])
      await expectLinks(p2, own, ownTurns, ['alice'])
    } finally { delete process.env.MYCEL_SAFE_OPS_1A }
  })

  test('the same shared chat by alice for another: the link follows the viewer, not the person who saved', async () => {
    // alice ran this one in bob's shared chat: bob sees her answer (it read nothing he may not see)
    const p = 'shared/vlink/shared-other-runner.md', c = chat('bob', { project: falcon, shared: true })
    await expectLinks(p, c, twoSaves('alice', c, p), ['alice', 'bob'])
  })
})
