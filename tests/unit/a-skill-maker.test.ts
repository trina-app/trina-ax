// Who made a team skill (docs/DECISIONS.md "S"; server/src/skills/author.ts): the person whose save made the skill
// file's first version, read from the file's history (never its text; none for a starter pack's own text). A member who
// joins with a link to such a skill hears who made it (`skillBy`: the line above its form), lands on a new chat with its
// title when it asks nothing (`starter.kind` "skill"), and the answer's receipt names the maker
// ("김지훈님의 팀 스킬 '견적서 쓰기' · 팀 파일 1개") for everyone but the maker.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared/api'
import { setPlanForTests } from '../../server/src/system/limits'
import { skillMakerId } from '../../server/src/skills/author'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

const PW = 'tulip meadow 2026'
const QUOTE = 'skills/general/gyeonjeokseo-sseugi/SKILL.md'
const BRIEF = 'skills/general/bogoseo-yoyak/SKILL.md'
const TASKS = 'skills/general/meeting-tasks/SKILL.md'
const tokenOf = (url: string) => new URL(url).hash.replace(/^#t=/, '')
const skillText = (name: string, title: string, inputs = '') =>
  `---\nname: ${name}\ndescription: "${title} — 테스트"\nmetadata:\n  title: "${title}"\n${inputs}---\n# ${title}\n\n## 하는 방법\n양식대로 써요.\n`

let h: Harness
let owner: Client
let ownerId = ''
let n = 0
const join = (token: string) => h.client({ ip: `10.9.0.${(++n % 200) + 1}` }).try('POST', '/api/team-link/join', { token, username: `maker${n}`, name: '서준', password: PW })

beforeAll(async () => {
  h = await harness('skill-maker')
  owner = await withOwner(h)
  setPlanForTests(null)
  ownerId = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  expect((await owner.try('POST', '/api/onboarding/packs/general/install')).status).toBe(200)
  h.ctx.files.humanSave(ownerId, QUOTE, Buffer.from(skillText('gyeonjeokseo-sseugi', '견적서 쓰기', '  inputs: |\n    [{"name": "customer", "label": "고객사", "required": true}]\n')), null)
  h.ctx.files.humanSave(ownerId, BRIEF, Buffer.from(skillText('bogoseo-yoyak', '보고서 요약')), null)
})
afterAll(async () => { setPlanForTests(undefined); await h.close() })

test('the maker is the first version\'s, whoever edits it later; a pack\'s own text has none; a file written outside the app has none', async () => {
  expect(skillMakerId(h.ctx.db, QUOTE)).toBe(ownerId)
  const admin = await addMember(h, owner, { username: 'ari', role: 'admin' })
  const abs = path.join(h.ctx.config.teamRoot, QUOTE)
  const sha = new Bun.CryptoHasher('sha256').update(fs.readFileSync(abs)).digest('hex')
  h.ctx.files.humanSave(admin.id, QUOTE, Buffer.from(skillText('gyeonjeokseo-sseugi', '견적서 쓰기', '  inputs: |\n    [{"name": "customer", "label": "고객사", "required": true}]\n') + '\n- 고친 줄\n'), sha)
  expect(skillMakerId(h.ctx.db, QUOTE)).toBe(ownerId)
  // installed from the pack by the owner's click: written by us, not by them
  expect(skillMakerId(h.ctx.db, TASKS)).toBeNull()
  fs.mkdirSync(path.join(h.ctx.config.teamRoot, 'skills/general/outside'), { recursive: true })
  fs.writeFileSync(path.join(h.ctx.config.teamRoot, 'skills/general/outside/SKILL.md'), skillText('outside', '밖'))
  expect(skillMakerId(h.ctx.db, 'skills/general/outside/SKILL.md')).toBeNull()
})

test('joining with a link to a skill a person made: who made it; its form, or a new chat with its title when it asks nothing', async () => {
  const withForm = await owner.call('POST', '/api/admin/team-link', { skillPath: QUOTE })
  const a = await join(tokenOf(withForm.link.url))
  expect(a.status).toBe(201)
  expect(a.body).toMatchObject({ next: `/skills?run=${encodeURIComponent(QUOTE)}`, starter: null, skillBy: 'Olga Owner' })

  const noForm = await owner.call('POST', '/api/admin/team-link', { skillPath: BRIEF })
  const b = await join(tokenOf(noForm.link.url))
  expect(b.body.skillBy).toBe('Olga Owner')
  expect(b.body.starter).toEqual({ kind: 'skill', skill: { path: BRIEF, name: 'bogoseo-yoyak', title: '보고서 요약' }, files: [], by: 'Olga Owner' })

  // the pack's meeting tasks: nobody "made" it, the form as before
  const pack = await owner.call('POST', '/api/admin/team-link', { skillPath: TASKS })
  const c = await join(tokenOf(pack.link.url))
  expect(c.body).toMatchObject({ next: `/skills?run=${encodeURIComponent(TASKS)}`, starter: null, skillBy: null })
})

test('the receipt names the maker for others, never for the maker, never for a pack skill', async () => {
  const mia = await addMember(h, owner, { username: 'mia' })
  const answer = (userId: string, skill: { path: string; name: string }) => {
    const chatId = uuidv7(), q = uuidv7(), a = uuidv7(), turnId = uuidv7()
    const db = h.ctx.db
    db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(chatId, userId)
    db.query("INSERT INTO messages (id, chat_id, role, author_id, content, status) VALUES (?, ?, 'user', ?, '/x 고객사: acme', 'done')").run(q, chatId, userId)
    db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status, turn_id) VALUES (?, ?, ?, 'assistant', '견적서예요.', 'done', ?)").run(a, chatId, q, turnId)
    db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, message_id) VALUES (?, ?, ?, 'claude', 'done', ?)").run(turnId, chatId, userId, a)
    db.query("INSERT INTO turn_skill_runs (turn_id, skill_path, skill_name, source) VALUES (?, ?, ?, 'command')").run(turnId, skill.path, skill.name)
    db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(a, chatId)
    return chatId
  }
  const receipt = async (c: Client, chatId: string) => ((await c.call('GET', `/api/chats/${chatId}/messages`)).items as { role: string; receipt?: unknown }[]).find((m) => m.role === 'assistant')!.receipt
  expect(await receipt(mia.client, answer(mia.id, { path: QUOTE, name: 'gyeonjeokseo-sseugi' }))).toEqual({ skill: { path: QUOTE, name: 'gyeonjeokseo-sseugi', by: 'Olga Owner' }, teamFiles: 0 })
  expect(await receipt(owner, answer(ownerId, { path: QUOTE, name: 'gyeonjeokseo-sseugi' }))).toEqual({ skill: { path: QUOTE, name: 'gyeonjeokseo-sseugi' }, teamFiles: 0 })
  expect(await receipt(mia.client, answer(mia.id, { path: TASKS, name: 'meeting-tasks' }))).toEqual({ skill: { path: TASKS, name: 'meeting-tasks' }, teamFiles: 0 })
})

test('the first version read directly: back from the trash it is still the maker\'s; a new file of the same name is its own; an older pack install by its audit row', async () => {
  const admin = (h.ctx.db.query("SELECT id FROM users WHERE username = 'ari'").get() as { id: string }).id
  const rel = 'skills/general/bogoseo-sseugi/SKILL.md'
  h.ctx.files.humanSave(ownerId, rel, Buffer.from(skillText('bogoseo-sseugi', '보고서 쓰기')), null)
  const trashId = h.ctx.files.deleteFile(admin, rel)
  h.ctx.files.restoreTrash(admin, trashId)
  expect(skillMakerId(h.ctx.db, rel)).toBe(ownerId)
  // deleted for good, then another person writes a file of that name: theirs
  h.ctx.files.deleteFile(ownerId, rel)
  h.ctx.db.query('UPDATE trash_items SET restored_at = ? WHERE original_path = ?').run(new Date().toISOString(), rel)
  h.ctx.files.humanSave(admin, rel, Buffer.from(skillText('bogoseo-sseugi', '보고서 쓰기 2')), null)
  expect(skillMakerId(h.ctx.db, rel)).toBe(admin)
  // a pack skill written before installs were marked (a plain human save), within a minute of the install's audit row
  const old = 'skills/marketing/ad-copy/SKILL.md'
  h.ctx.db.query("INSERT INTO audit_log (actor_id, action, target, detail) VALUES (?, 'onboarding.pack_install', 'skills/marketing', '{}')").run(ownerId)
  h.ctx.files.humanSave(ownerId, old, Buffer.from(skillText('ad-copy', '광고 문구')), null)
  expect(skillMakerId(h.ctx.db, old)).toBeNull()
  // a file of a pack's name with no install near it is a person's
  h.ctx.db.query("DELETE FROM audit_log WHERE action = 'onboarding.pack_install' AND target = 'skills/marketing'").run()
  expect(skillMakerId(h.ctx.db, old)).toBe(ownerId)
  // the mark itself: the general pack installed in beforeAll
  const ev = h.ctx.db.query("SELECT detail FROM file_events WHERE path = ? AND action = 'create'").get('skills/general/meeting-tasks/SKILL.md') as { detail: string }
  expect(JSON.parse(ev.detail).tool).toBe('pack_install')
})
