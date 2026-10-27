// Security regression, round 4 (attach): a team file the person attached (or the AI read) and then lost, because
// someone moved it into a folder the person cannot read, stayed in the person's stashed engine session. The app showed
// the attachment as unavailable, yet the next turn resumed the session (--resume) and the AI answered with the file's
// content (in the repro: a misplaced staff roster with a salary, moved from shared/ into groups/hr). Rule changes
// already reset the sessions of people who lose access (H7, afterAccessChange); moves and deletes did not.
// Now move() and remove() reset the engine sessions of everyone who could read the entry before and cannot after
// (for a delete: cannot see it in the trash either), and a turn never resumes a session whose branch holds a team
// attachment that is unavailable now (whatever made it so).
//
// Port of scratchpad attach/repro-session-resume-after-move.ts with the scripted fake engine instead of Claude
// (it answers "resumed=true|false"); the stashed session stands for one that read the file.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { startInstance, SETUP_TOKEN, type Client, type Instance, type Socket } from './lib/instance'
import { sealSecret } from '../../web/src/lib/seal'

setDefaultTimeout(60_000)
let inst: Instance
let owner: Client
let alice: Client
let sock: Socket
let hrFolder: string
const CANARY = 'R4-ROSTER-CANARY-7731 Kim 9,999,000 KRW'
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
let n = 0

const session = (chatId: string) => inst.ctx.db.query('SELECT engine_session_id AS sid, engine_session_leaf_id AS leaf FROM chats WHERE id = ?').get(chatId) as { sid: string | null; leaf: string | null }
const stashDir = (chatId: string) => path.join(inst.dataDir, 'sessions', chatId)

async function turn(chatId: string, content: string, attachmentIds: string[] = []): Promise<any> {
  const sent = await alice.ok('POST', `/api/chats/${chatId}/messages`, { clientMessageId: cm(), attachmentIds, content })
  return (await sock.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 30_000)).data
}

/** dana saves a roster in shared/, alice attaches it and the first turn stashes an engine session that "read" it */
async function attachedAndStashed(name: string): Promise<{ chat: string; file: string }> {
  const file = `shared/${name}`
  await owner.ok('PUT', '/api/files/content', { path: file, content: `${CANARY}\n`, baseSha256: null })
  const chat = (await alice.ok('POST', '/api/chats', { title: 'roster' })).id as string
  const ref = await alice.ok('POST', '/api/attachments/team-file', { chatId: chat, path: file })
  const done = await turn(chat, fake({ say: 'ok, read' }), [ref.id])
  expect(done.status).toBe('done')
  const s = session(chat)
  expect(s.sid).not.toBeNull()
  // what a real session holds after reading the attachment
  fs.mkdirSync(stashDir(chat), { recursive: true })
  fs.appendFileSync(path.join(stashDir(chat), `${s.sid}.jsonl`), JSON.stringify({ type: 'tool_result', content: CANARY }) + '\n')
  return { chat, file }
}

beforeAll(async () => {
  inst = await startInstance('r4-attach-session-after-move')
  owner = inst.client('dana')
  await owner.ok('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'T', locale: 'en', owner: { username: 'dana', name: 'Dana', password: 'Owner-pw-123456!' } })
  // turns run on the team's AI connection (the model proxy in front, docs/DECISIONS.md "AI 연결"): one team API key
  const key = await owner.ok('GET', '/api/credentials/sealing-key')
  await owner.ok('POST', '/api/admin/credentials', { kind: 'anthropic-api-key', label: 'Team key', sealed: await sealSecret(key, ('sk-ant-api03-' + 'r4-attach-test-key-0000000000000000'), 'credential.create'), password: 'Owner-pw-123456!' })
  const u = await owner.ok('POST', '/api/admin/users', { username: 'alice', name: 'Alice', role: 'member', id: 'alice', locale: 'en' })
  alice = inst.client('alice')
  await alice.login('alice', u.temporaryPassword)
  await alice.ok('POST', '/api/auth/password', { currentPassword: u.temporaryPassword, newPassword: `Kx7-quartz-plover-${n++}-91!` })
  await owner.ok('POST', '/api/admin/groups', { name: 'hr', memberIds: ['dana'] })
  hrFolder = ((await owner.ok('GET', '/api/admin/folders')).items as { path: string }[]).find((f) => f.path.startsWith('groups/') && f.path.includes('hr'))!.path
  sock = await alice.ws({ windowId: 'win-r4-attach' })
  await sock.next('hello')
})
afterAll(async () => { sock?.close(); await inst?.close() })

describe('a file that leaves the person\'s reach leaves their AI session too', () => {
  test('moved into a group folder the person is not in: session dropped, next turn starts fresh', async () => {
    const { chat, file } = await attachedAndStashed('r4-roster-move.md')
    await owner.ok('POST', '/api/files/move', { from: file, to: `${hrFolder}/r4-roster-move.md`, onExists: 'fail', confirm: false })
    expect((await alice.req('GET', '/api/files/content?path=' + encodeURIComponent(`${hrFolder}/r4-roster-move.md`))).status).toBe(404)
    expect(session(chat)).toEqual({ sid: null, leaf: null }) // was the turn-1 session
    expect(fs.existsSync(stashDir(chat))).toBe(false) // was there, with the canary
    const next = await turn(chat, fake({ echo: 'resume' }))
    expect(next.message.content).toBe('resumed=false') // was resumed=true: the AI answered from the stash
  })

  test('a move that keeps the file readable (inside shared/) keeps the session', async () => {
    const { chat, file } = await attachedAndStashed('r4-roster-stay.md')
    await owner.ok('POST', '/api/files/move', { from: file, to: 'shared/r4-roster-renamed.md', onExists: 'fail', confirm: false })
    expect(session(chat).sid).not.toBeNull()
    expect((await turn(chat, fake({ echo: 'resume' }))).message.content).toBe('resumed=true')
  })

  test('deleted where the person cannot see it in the trash: session dropped', async () => {
    // skills/ is everyone read, admins write: a member cannot restore (or see) its trash
    const file = 'skills/r4-roster-delete.md'
    await owner.ok('PUT', '/api/files/content', { path: file, content: `${CANARY}\n`, baseSha256: null })
    const chat = (await alice.ok('POST', '/api/chats', { title: 'skills' })).id as string
    const ref = await alice.ok('POST', '/api/attachments/team-file', { chatId: chat, path: file })
    await turn(chat, fake({ say: 'ok' }), [ref.id])
    expect(session(chat).sid).not.toBeNull()
    await owner.ok('DELETE', '/api/files?path=' + encodeURIComponent(file))
    expect(session(chat)).toEqual({ sid: null, leaf: null })
    expect((await turn(chat, fake({ echo: 'resume' }))).message.content).toBe('resumed=false')
  })

  test('any other way an attachment becomes unavailable: the turn does not resume the stashed session', async () => {
    const { chat, file } = await attachedAndStashed('r4-roster-other.md')
    const before = session(chat)
    await owner.ok('POST', '/api/files/move', { from: file, to: `${hrFolder}/r4-roster-other.md`, onExists: 'fail', confirm: false })
    // put the old session back as if nothing had reset it (a path the move hook does not cover)
    inst.ctx.db.query('UPDATE chats SET engine_session_id = ?, engine_session_leaf_id = ? WHERE id = ?').run(before.sid, before.leaf, chat)
    fs.mkdirSync(stashDir(chat), { recursive: true })
    fs.writeFileSync(path.join(stashDir(chat), `${before.sid}.jsonl`), JSON.stringify({ type: 'tool_result', content: CANARY }) + '\n')
    const next = await turn(chat, fake({ echo: 'resume' }))
    expect(next.message.content).toBe('resumed=false')
    expect(fs.existsSync(path.join(stashDir(chat), `${before.sid}.jsonl`))).toBe(false)
  })
})
