// delete_files (server/src/chat/delete-files.ts, docs/DECISIONS.md "AI가 휴지통으로 옮기기"): the AI moves files and
// folders to the team trash after the person's yes on the server's card. One test per rule of the security review:
// what never goes (admins and the owner included), the skill guard in TeamFiles.remove for every AI turn, the
// recursive cap, the normalization of paths, the manifest (a parallel move into a listed folder, an outside writer
// during the move, who reads it, the trash setting), each place it is refused up front (room, shared, scheduled,
// template, confidential, other people's words, Slack, sub-agent), the card (full paths, other people by name, who
// loses it and who cannot restore it, the purge date of the setting, five languages), the limits per answer, the
// audit rows, the restore, the prompt, and a just-trashed path never being "new" for a room grant.
//
// Fixture (tests/lib/fixtures.ts): alice + erin = marketing, bob = finance, carol = admin, dana = owner. shared/ is
// everyone's (write); projects/falcon is alice's (write) and finance's (read).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type RoomAiRun, type RoomMessage, type TurnRequest } from '@mycel/shared/api'
import { FILE_TOOLS, PRODUCT } from '@mycel/shared'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { CONFIRMED } from '../lib/schedule-card'
import { componentC } from '../../server/src/team-files/component'
import { AI_SKILL_TRASH_REFUSAL, AI_TRASH_FOLDER_REFUSAL, type AiTrashPlan } from '../../server/src/team-files/service'
import { AI_TRASH_MAX_ENTRIES, stampTree, TrashStranded } from '../../server/src/team-files/ai-trash'
import { DELETE_REFUSAL, DELETE_TEXT, deleteCard, deleteFilesRefusal, deleteFilesTool, MAX_DELETE_CARDS, type DeleteExec } from '../../server/src/chat/delete-files'
import { ROOM_TOOLS, SHARED_TOOLS } from '../../server/src/rooms/ai-tools'
import { buildAgentDefinitions, PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { localTool } from '../../server/src/safe-ops/confidential'
import { buildTurnPrompt, DELETE_RULE, filePlacementRule, type PromptInput } from '../../server/src/chat/prompt'
import { teamTimeZone, updateTeamSettings } from '../../server/src/admin/settings'
import { TurnFiles } from '../../server/src/files/service'
import { createGrant } from '../../server/src/rooms/ai-grants'
import { Denied } from '../../server/src/policy/errors'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const del = (...paths: string[]) => ({ tool: 'delete_files', args: { paths }, sayResult: true })
type Ask = Extract<TurnRequest, { kind: 'ask_user' }>

let h: Harness
const socks: Record<string, TestSocket> = {}
const svc = () => componentC(h.ctx).files
const abs = (rel: string) => path.join(h.team, ...rel.split('/'))
const put = (rel: string, body = 'x\n') => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body) }
const has = (rel: string) => fs.existsSync(abs(rel))
const TURN = uuidv7()
const groupId = (name: string) => (h.ctx.db.query('SELECT id FROM groups WHERE name = ?').get(name) as { id: string }).id
const trashRows = (where = '1 = 1', ...a: unknown[]) => h.ctx.db.query(`SELECT id, original_path, deleted_by, turn_id, purge_at FROM trash_items WHERE restored_at IS NULL AND ${where} ORDER BY original_path`).all(...a as never[]) as { id: string; original_path: string; deleted_by: string; turn_id: string | null; purge_at: string }[]
const audits = (turnId: string) => (h.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'files.ai_trash' AND json_extract(detail, '$.turnId') = ? ORDER BY id").all(turnId) as { actor_id: string; target: string | null; detail: string }[]).map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, any> }))
const refusedOf = (user: string, paths: string[]) => {
  const r = svc().planAiTrash(user, paths)
  return 'refused' in r ? r.refused : null
}
const planOf = (user: string, paths: string[]): AiTrashPlan => {
  const r = svc().planAiTrash(user, paths)
  if (!('plan' in r)) throw new Error(`refused: ${JSON.stringify(r.refused)}`)
  return r.plan
}

beforeAll(async () => {
  h = await startHarness({ name: 'ai-delete-files', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  const db = h.ctx.db
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short (as b-room-ai-grants)
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  // the groups' folders and a project, as an installed team has them
  for (const g of ['Marketing', 'Finance']) db.query('UPDATE groups SET folder_id = (SELECT id FROM folders WHERE path = ?) WHERE name = ?').run(`groups/${g.toLowerCase()}`, g)
  db.query('INSERT INTO projects (id, name, folder_path, created_by, created_at) VALUES (?,?,?,?,?)').run(uuidv7(), 'Falcon', 'projects/falcon', 'alice', new Date().toISOString())
  for (const u of ['alice', 'bob', 'carol', 'dana']) { socks[u] = await h.ws(u, { windowId: `win-del-${u}` }); await socks[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

/** One answer in the person's own chat; each card answered by `answer` (null: left until it closes by itself). */
async function turn(user: string, content: string, answer: (c: Ask, i: number) => string | null | Promise<string | null> = () => null, o: { chatId?: string; meanwhile?: (c: Ask) => void | Promise<void> } = {}) {
  const chatId = o.chatId ?? (await h.api(user).call(API.createChat, { body: {} })).id
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Ask[] = []
  const answered = new Set<string>()
  for (let waited = 0; ; waited += 50) {
    if (waited > 60_000) throw new Error('the answer did not end')
    for (const f of socks[user]!.frames) {
      if (f.type !== 'turn.request' || f.data.turnId !== r.turnId || answered.has(f.data.request.requestId)) continue
      answered.add(f.data.request.requestId)
      const c = f.data.request as Ask
      cards.push(c)
      await o.meanwhile?.(c)
      const v = await answer(c, cards.length - 1)
      if (v !== null) await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: v } })
    }
    const done = socks[user]!.frames.find((f) => f.type === 'message.done' && f.data.messageId === r.assistantMessage.id)
    if (done && done.type === 'message.done') return { turnId: r.turnId as string, chatId, content: done.data.message.content as string, cards }
    await Bun.sleep(50)
  }
}

describe('what the AI may never put in the trash, admins and the owner included', () => {
  test('top-level, managed, skill, other people\'s, system, hidden, plugin, attachment and upload-link targets; one refused path refuses the call', () => {
    const db = h.ctx.db
    // a folder that holds a rule folder, a project's folder outside projects/, a skills folder of a group and a person
    put('shared/holds-rule/locked/a.md')
    db.query("INSERT INTO folders (id, path) VALUES ('f_del_locked', 'shared/holds-rule/locked')").run()
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_del_locked', 'f_del_locked', 'user', 'carol', 'write')").run()
    put('shared/proj-elsewhere/brief.md')
    db.query('INSERT INTO projects (id, name, folder_path, created_by, created_at) VALUES (?,?,?,?,?)').run(uuidv7(), 'Elsewhere', 'shared/proj-elsewhere', 'carol', new Date().toISOString())
    put('groups/marketing/skills/brief/SKILL.md', '---\nname: brief\ndescription: b\n---\nx\n')
    put('projects/falcon/skills/launch/SKILL.md', '---\nname: launch\ndescription: l\n---\nx\n')
    for (const u of ['carol', 'dana']) put(`users/${u}/skills/mine/SKILL.md`, '---\nname: mine\ndescription: m\n---\nx\n')
    for (const u of ['carol', 'dana']) put(`users/${u}/.attachments/c1/pic.png`, 'png')
    put('shared/.hidden-notes.md')
    put('shared/with-agents/AGENTS.md', 'rules\n')
    put('shared/plugin-pack/x.md')
    put('shared/upload-here/old.pdf')
    put('shared/upload-done/old.pdf')
    // a personal project's folder (managedInside leaves users/ out)
    for (const u of ['carol', 'dana']) {
      put(`users/${u}/projects/p1/notes.md`)
      db.query('INSERT INTO projects (id, name, folder_path, created_by, created_at) VALUES (?,?,?,?,?)').run(uuidv7(), `P1 ${u}`, `users/${u}/projects/p1`, u, new Date().toISOString())
    }
    // an open upload link of the app connector points into shared/upload-here; an expired one into upload-done
    db.exec('PRAGMA foreign_keys = OFF')
    db.query('INSERT INTO remote_mcp_upload_links (hash, grant_id, user_id, path, overwrite, max_bytes, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)').run('h-open', 'g-x', 'carol', 'shared/upload-here/report.pdf', 0, 1000, Date.now(), Date.now() + 600_000)
    db.query('INSERT INTO remote_mcp_upload_links (hash, grant_id, user_id, path, overwrite, max_bytes, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)').run('h-old', 'g-x', 'carol', 'shared/upload-done/report.pdf', 0, 1000, Date.now() - 900_000, Date.now() - 300_000)
    db.exec('PRAGMA foreign_keys = ON')
    // a plugin's folder (plugins/manager.ts keeps them under skills/; any path it reports counts)
    const fx = h.ctx.files.fx
    const before = fx.managed
    fx.managed = { managerOf: (segs) => (segs.join('/') === 'shared/plugin-pack' || segs.join('/').startsWith('shared/plugin-pack/') ? 'pack' : null), heldBelow: (segs) => ('shared/plugin-pack'.startsWith(segs.join('/') + '/') || segs.join('/') === 'shared/plugin-pack' ? 'pack' : null) }
    try {
      for (const who of ['carol', 'dana']) {
        const cases: [string, RegExp][] = [
          // users/ itself: nobody writes it (authorize says read-only before the AI's own rule)
          ['shared', /top-level folder/], ['skills', /top-level folder/], ['groups', /top-level folder/], ['users', /top-level folder|read-only/],
          // a group's, a project's and the person's own folder say what they are, even with skills in them (QA TC-016)
          ['skills/team-rules.md', /skill folder/], ['groups/marketing', /a group's folder/], ['groups/marketing/skills', /skill folder/],
          ['groups/marketing/skills/brief/SKILL.md', /skill folder/], ['projects/falcon', /a project's folder/], ['projects/falcon/skills/launch', /skill folder/],
          [`users/${who}/skills`, /skill folder/], [`users/${who}/skills/mine/SKILL.md`, /skill folder/], [`users/${who}`, /own personal folder/],
          ['groups/marketing/salaries', /its own permissions/], ['shared/holds-rule', /its own permissions/], ['shared/proj-elsewhere', /a project's folder/],
          [`users/${who}/.attachments/c1/pic.png`, /chat attachments/], ['shared/.hidden-notes.md', /hidden item/],
          ['CLAUDE.md', /instruction file|not found or no access/], ['shared/with-agents', /instruction file/],
          ['shared/plugin-pack', /plugin/], ['shared/plugin-pack/x.md', /plugin|managed by the plugin/], ['shared/upload-here', /upload link/],
          [`users/${who}/projects/p1`, /project's folder/], [`users/${who}/projects`, /project's folder/],
          ['users/bob/notes.md', /not found or no access/], ['.system/history/old.bin', /not found or no access/],
        ]
        for (const [p, why] of cases) {
          const r = refusedOf(who, [p])
          expect({ who, p, refused: !!r }).toEqual({ who, p, refused: true })
          expect({ who, p, error: why.test(r![0]!.error) ? 'ok' : r![0]!.error }).toEqual({ who, p, error: 'ok' })
        }
        // one refused path refuses the whole call: nothing is asked, nothing moves
        const mixed = refusedOf(who, ['shared/glossary.md', 'groups/marketing/salaries'])
        expect(mixed?.map((x) => x.path)).toEqual(['groups/marketing/salaries'])
        // an expired upload link holds nothing back; an ordinary file is fine
        expect(planOf(who, ['shared/upload-done']).items.map((i) => i.rel)).toEqual(['shared/upload-done'])
      }
    } finally { fx.managed = before }
    for (const p of ['shared/holds-rule/locked/a.md', 'skills/team-rules.md', 'groups/marketing/skills/brief/SKILL.md', 'shared/upload-here/old.pdf', 'users/carol/.attachments/c1/pic.png']) expect(has(p)).toBe(true)
    expect(trashRows()).toEqual([])
  })

  test('TeamFiles.remove itself: an AI turn never trashes a skill root, a folder holding one or anything in one, and nothing without the card\'s manifest', () => {
    put('skills/old-rule.md', 'old\n')
    put('users/alice/no-card.md')
    const fakeItem = { item: { rel: 'skills/old-rule.md', kind: 'file' as const, files: 0, folders: 0, entries: [], audience: '' }, retentionDays: 30 }
    for (const [user, rel, why] of [['carol', 'skills/old-rule.md', AI_SKILL_TRASH_REFUSAL], ['dana', 'skills/old-rule.md', AI_SKILL_TRASH_REFUSAL], ['carol', 'groups/marketing/skills/brief/SKILL.md', AI_SKILL_TRASH_REFUSAL], ['carol', 'groups/marketing', AI_TRASH_FOLDER_REFUSAL.group], ['alice', 'projects/falcon/skills/launch/SKILL.md', AI_SKILL_TRASH_REFUSAL]] as const) {
      // even with a manifest in hand: the skill guard comes first, whatever the role (a group's folder says what it is)
      expect(() => svc().remove(user, rel, TURN, { ai: fakeItem })).toThrow(why)
      expect(() => svc().remove(user, rel, TURN)).toThrow(Denied)
    }
    expect(() => svc().remove('alice', 'users/alice/no-card.md', TURN)).toThrow('only with delete_files')
    expect(has('skills/old-rule.md') && has('users/alice/no-card.md')).toBe(true)
    // people on the Files screen (no turn) delete as before: an admin a team rule
    const r = svc().remove('carol', 'skills/old-rule.md')
    expect(has('skills/old-rule.md')).toBe(false)
    svc().restoreTrash('carol', r.trashId)
    expect(has('skills/old-rule.md')).toBe(true)
  })
})

describe('each folder that never goes says what it is (QA TC-016), and still never goes', () => {
  const fakeItem = (rel: string) => ({ item: { rel, kind: 'folder' as const, files: 0, folders: 0, entries: [], audience: '' }, retentionDays: 30 })
  /** Refused for the owner and an admin with exactly `why`, the reason never names admins, nothing moved, and
   * TeamFiles.remove's own guard (an AI turn, a manifest in hand) still refuses it. */
  const stays = (rel: string, why: string, o: { guard?: boolean } = {}) => {
    for (const who of ['carol', 'dana']) {
      const r = refusedOf(who, [rel])
      expect({ who, rel, error: r?.[0]?.error }).toEqual({ who, rel, error: why })
      expect(why).not.toMatch(/admin/i)
      if (o.guard) expect(() => svc().remove(who, rel, TURN, fakeItem(rel))).toThrow(why)
      expect(() => svc().remove(who, rel, TURN)).toThrow(Denied)
    }
    expect(has(rel)).toBe(true)
    expect(trashRows('original_path = ?', rel)).toEqual([])
  }
  const project = (name: string, folder: string, by = 'carol') =>
    h.ctx.db.query('INSERT INTO projects (id, name, folder_path, created_by, created_at) VALUES (?,?,?,?,?)').run(uuidv7(), name, folder, by, new Date().toISOString())

  test('a project: where a project is deleted (the Projects screen), not the skill reason, with no skills in it or with some', () => {
    put('projects/Acme Launch/brief.md')
    project('Acme Launch', 'projects/Acme Launch')
    stays('projects/Acme Launch', AI_TRASH_FOLDER_REFUSAL.project, { guard: true })
    expect(AI_TRASH_FOLDER_REFUSAL.project).toContain('Projects screen')
    expect(AI_TRASH_FOLDER_REFUSAL.project).not.toMatch(/skill/i)
    // with a skills folder in it, still the project's reason (what it is comes before what it holds)
    put('projects/Acme Launch/skills/kickoff/SKILL.md', '---\nname: kickoff\ndescription: k\n---\nx\n')
    stays('projects/Acme Launch', AI_TRASH_FOLDER_REFUSAL.project, { guard: true })
    // a project's folder outside projects/, and a folder that holds one
    put('shared/clients/acme/plan.md')
    project('Acme client', 'shared/clients/acme')
    stays('shared/clients/acme', AI_TRASH_FOLDER_REFUSAL.project)
    stays('shared/clients', AI_TRASH_FOLDER_REFUSAL.project)
  })

  test('a group: the Files screen, and deleting the group keeps its folder; not the skill reason', () => {
    // groups/finance (the Finance group's folder) holds no skills; groups/marketing does: both are a group's folder
    expect(has('groups/finance/skills')).toBe(false)
    stays('groups/finance', AI_TRASH_FOLDER_REFUSAL.group, { guard: true })
    put('groups/marketing/skills/brief/SKILL.md', '---\nname: brief\ndescription: b\n---\nx\n')
    stays('groups/marketing', AI_TRASH_FOLDER_REFUSAL.group, { guard: true })
    expect(AI_TRASH_FOLDER_REFUSAL.group).toContain('Files screen')
    expect(AI_TRASH_FOLDER_REFUSAL.group).not.toMatch(/skill/i)
  })

  test('the person\'s own folder: it never goes, what is in it can; not the skill reason', () => {
    for (const who of ['carol', 'dana']) {
      put(`users/${who}/notes/a.md`)
      const r = refusedOf(who, [`users/${who}`])
      expect(r?.[0]?.error).toBe(AI_TRASH_FOLDER_REFUSAL.own)
      // the folders in it can go (the card asks)
      expect(planOf(who, [`users/${who}/notes`]).items.map((i) => i.rel)).toEqual([`users/${who}/notes`])
      expect(has(`users/${who}`)).toBe(true)
    }
    expect(AI_TRASH_FOLDER_REFUSAL.own).not.toMatch(/skill|admin/i)
  })

  test('a rule folder, and a folder right in projects/ or groups/ that is none of these; the skill reason only with a skills folder in it', () => {
    put('shared/locked-plan/a.md')
    h.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_del_rule2', 'shared/locked-plan')").run()
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_del_rule2', 'f_del_rule2', 'user', 'carol', 'write')").run()
    stays('shared/locked-plan', AI_TRASH_FOLDER_REFUSAL.rule)
    // no project, no group, no skills in it: what the place is
    put('projects/old-launch/notes.md')
    stays('projects/old-launch', AI_TRASH_FOLDER_REFUSAL.projectsPlace, { guard: true })
    put('groups/old-team/notes.md')
    stays('groups/old-team', AI_TRASH_FOLDER_REFUSAL.groupsPlace, { guard: true })
    // a skills folder in it now (any letter case): the skill reason, as before
    put('projects/old-launch/Skills/x/SKILL.md', '---\nname: x\ndescription: x\n---\nx\n')
    stays('projects/old-launch', AI_SKILL_TRASH_REFUSAL, { guard: true })
    // the other reasons name no admins either
    for (const [rel, why] of [['shared', /top-level folder/]] as const) {
      const e = refusedOf('carol', [rel])?.[0]?.error ?? ''
      expect(e).toMatch(why)
      expect(e).not.toMatch(/admin/i)
    }
  })
})

describe('what one call counts and how its paths are read', () => {
  test('at most 200 entries, counted inside folders by a walk that stops at the cap', () => {
    for (let i = 0; i < 199; i++) put(`users/alice/cap/f${i}.txt`)
    // the folder and 199 files: 200
    expect(planOf('alice', ['users/alice/cap']).entries).toBe(AI_TRASH_MAX_ENTRIES)
    put('users/alice/cap/one-more.txt')
    expect(() => svc().planAiTrash('alice', ['users/alice/cap'])).toThrow('more than 200 files and folders')
    // folders count too: 1 + 100 folders + 100 files
    for (let i = 0; i < 100; i++) put(`users/alice/cap-nested/d${i}/f.txt`)
    expect(() => svc().planAiTrash('alice', ['users/alice/cap-nested'])).toThrow('more than 200')
    // and every item of the call together
    for (let i = 0; i < 150; i++) put(`users/alice/cap-a/f${i}.txt`)
    for (let i = 0; i < 60; i++) put(`users/alice/cap-b/f${i}.txt`)
    expect(() => svc().planAiTrash('alice', ['users/alice/cap-a', 'users/alice/cap-b'])).toThrow('more than 200')
    // the walk stops at the cap (it does not read a huge folder through, nor silently stop like treeSize)
    for (let i = 0; i < 1000; i++) put(`users/alice/cap-huge/f${i}.txt`)
    expect(stampTree(abs('users/alice/cap-huge'), 200)).toBeNull()
    expect(stampTree(abs('users/alice/cap-huge'), 1001)!.length).toBe(1001)
    expect(has('users/alice/cap/f0.txt')).toBe(true)
  })

  test('paths: resolved like every file tool, duplicates and items inside a listed folder go once; "..", absolute paths and look-alikes are refused', () => {
    put('users/alice/dd/one.md')
    put('users/alice/dd/two.md')
    const p = planOf('alice', ['users/alice/dd', 'users/alice/dd/one.md', 'users/alice//dd/', 'users/alice/./dd'])
    expect(p.items.map((i) => [i.rel, i.kind, i.files])).toEqual([['users/alice/dd', 'folder', 2]])
    // another spelling of the same entry (letter case, Unicode form) is the entry's own name, once
    const nfc = 'users/alice/한글메모.md'.normalize('NFC')
    put(nfc)
    if (h.ctx.files.fx.caseInsensitive) {
      const q = planOf('alice', [nfc, nfc.normalize('NFD'), 'USERS/alice/DD/one.md', 'users/alice/dd'])
      expect(q.items.map((i) => i.rel).sort()).toEqual([nfc, 'users/alice/dd'].sort())
    }
    for (const bad of ['../outside/secret.txt', '/etc/passwd', '~/notes.md', 'users/alice/../bob/notes.md', 'users\\alice\\dd', 'https://example.com/x', 'users/alice/dd‮evil']) {
      const r = refusedOf('alice', [bad])
      expect({ bad, refused: r?.length }).toEqual({ bad, refused: 1 })
    }
    // a link and a hard-linked file are not followed or taken
    expect(refusedOf('alice', ['users/alice/audit-copy.md'])?.[0]?.error).toContain('hard-linked')
    expect(refusedOf('alice', ['groups/marketing/budget-link.md'])).not.toBeNull()
    expect(has('users/alice/dd/one.md')).toBe(true)
  })
})

describe('the yes is bound to the manifest', () => {
  test('a parallel move into a listed folder after the card (no card of its own) stops the call: nothing goes', () => {
    for (const n of ['a', 'b', 'c']) put(`users/alice/tmp/${n}.md`)
    put('users/alice/other.md', 'not shown on the card\n')
    const plan = planOf('alice', ['users/alice/tmp'])
    expect(plan.items[0]!.files).toBe(3)
    // move_files of the same answer, within the same audience: no card of its own
    svc().move('alice', 'users/alice/other.md', 'users/alice/tmp/other.md', 'rename', { turnId: TURN, tool: 'move_files' })
    const r = svc().trashAiPlan('alice', plan, TURN)
    expect(r).toEqual({ trashed: [], changed: ['users/alice/tmp'], failed: [], stranded: [] })
    expect(fs.readdirSync(abs('users/alice/tmp')).sort()).toEqual(['a.md', 'b.md', 'c.md', 'other.md'])
    expect(trashRows('original_path = ?', 'users/alice/tmp')).toEqual([])
  })

  test('a file changed, replaced or renamed after the card stops the call', () => {
    put('users/alice/m1.md', 'one\n')
    const changed = planOf('alice', ['users/alice/m1.md'])
    fs.appendFileSync(abs('users/alice/m1.md'), 'more\n')
    expect(svc().trashAiPlan('alice', changed, TURN).changed).toEqual(['users/alice/m1.md'])
    const replaced = planOf('alice', ['users/alice/m1.md'])
    fs.rmSync(abs('users/alice/m1.md')); put('users/alice/m1.md', 'one\nmore\n')
    expect(svc().trashAiPlan('alice', replaced, TURN).changed).toEqual(['users/alice/m1.md'])
    put('users/alice/m2/a.md')
    const renamed = planOf('alice', ['users/alice/m2'])
    fs.renameSync(abs('users/alice/m2/a.md'), abs('users/alice/m2/b.md'))
    expect(svc().trashAiPlan('alice', renamed, TURN).changed).toEqual(['users/alice/m2'])
    expect(has('users/alice/m1.md') && has('users/alice/m2/b.md')).toBe(true)
  })

  test('who can read it, or the trash setting, changed after the card: nothing goes', () => {
    put('groups/marketing/aud-sub/a.md')
    const plan = planOf('alice', ['groups/marketing/aud-sub'])
    h.ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(groupId('Marketing'), 'bob')
    try { expect(svc().trashAiPlan('alice', plan, TURN).changed).toEqual(['groups/marketing/aud-sub']) }
    finally { h.ctx.db.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId('Marketing'), 'bob') }
    const again = planOf('alice', ['groups/marketing/aud-sub'])
    updateTeamSettings(h.ctx.db, { trashRetentionDays: 9 })
    try { expect(svc().trashAiPlan('alice', again, TURN).changed).toEqual(['groups/marketing/aud-sub']) }
    finally { updateTeamSettings(h.ctx.db, { trashRetentionDays: 30 }) }
    expect(has('groups/marketing/aud-sub/a.md')).toBe(true)
  })

  test('a writer outside this process adds to a folder while it moves: it goes back, nothing is trashed', () => {
    put('users/alice/race/a.md')
    const plan = planOf('alice', ['users/alice/race'])
    const files = svc() as unknown as { aiSameOnDisk(abs: string, item: unknown): boolean }
    const orig = files.aiSameOnDisk
    // the check where the folder went (the trash): a dev-environment job's file lands in it on the way
    files.aiSameOnDisk = function (at: string, item: unknown) {
      if (at.includes(`${path.sep}${PRODUCT.systemDir}${path.sep}trash${path.sep}`)) fs.writeFileSync(path.join(at, 'late.txt'), 'late\n')
      return orig.call(this, at, item)
    }
    try { expect(svc().trashAiPlan('alice', plan, TURN)).toEqual({ trashed: [], changed: ['users/alice/race'], failed: [], stranded: [] }) }
    finally { files.aiSameOnDisk = orig }
    expect(fs.readdirSync(abs('users/alice/race')).sort()).toEqual(['a.md', 'late.txt'])
    expect(trashRows('original_path = ?', 'users/alice/race')).toEqual([])
  })

  test('…and when something took its place meanwhile it cannot go back: it stays in the trash with its row, said so, and comes back from there', () => {
    put('users/alice/race2/a.md')
    const plan = planOf('alice', ['users/alice/race2'])
    const files = svc() as unknown as { aiSameOnDisk(abs: string, item: unknown): boolean }
    const orig = files.aiSameOnDisk
    files.aiSameOnDisk = function (at: string, item: unknown) {
      if (at.includes(`${path.sep}${PRODUCT.systemDir}${path.sep}trash${path.sep}`)) {
        fs.writeFileSync(path.join(at, 'late.txt'), 'late\n')
        put('users/alice/race2/new.md', 'made at the old place\n')
      }
      return orig.call(this, at, item)
    }
    let r
    try { r = svc().trashAiPlan('alice', plan, TURN) } finally { files.aiSameOnDisk = orig }
    expect(r.trashed.map((x) => [x.path, x.changed])).toEqual([['users/alice/race2', true]])
    expect(fs.readFileSync(abs('users/alice/race2/new.md'), 'utf8')).toBe('made at the old place\n')
    const [row] = trashRows('original_path = ?', 'users/alice/race2')
    expect(row!.turn_id).toBe(TURN)
    const back = svc().restoreTrash('alice', row!.id)
    expect(back.entry.path).not.toBe('users/alice/race2')
    expect(fs.readdirSync(abs(back.entry.path)).sort()).toEqual(['a.md', 'late.txt'])
  })
})

/** The trash row insert fails `n` times (a full disk, a locked database): `onFail` runs first (what happens meanwhile).
 * The service's own connection is wrapped, so only its writes of trash rows fail; put back in `finally`. */
function failTrashRows(n: number, onFail: () => void = () => {}) {
  const db = h.ctx.db as unknown as { query: (sql: string) => unknown }
  const orig = db.query.bind(db)
  let left = n
  db.query = (sql: string) => (sql.startsWith('INSERT INTO trash_items') && left > 0
    ? { run: () => { left--; onFail(); throw new Error('injected: disk I/O error') } }
    : orig(sql))
  return () => { delete (db as { query?: unknown }).query }
}
/** The check where an item went (the trash storage): a writer outside this process adds a file to it on the way, and
 * makes something new at its old place (so it cannot go back). */
function racingWriter(oldPlace: string) {
  const files = svc() as unknown as { aiSameOnDisk(abs: string, item: unknown): boolean }
  const orig = files.aiSameOnDisk
  files.aiSameOnDisk = function (at: string, item: unknown) {
    if (at.includes(`${path.sep}${PRODUCT.systemDir}${path.sep}trash${path.sep}`)) {
      fs.writeFileSync(path.join(at, 'late.txt'), 'late\n')
      put(`${oldPlace}/new.md`, 'made at the old place\n')
    }
    return orig.call(this, at, item)
  }
  return () => { files.aiSameOnDisk = orig }
}
const errorsLogged = () => {
  const log = h.ctx.log as unknown as { error: (...a: unknown[]) => void }
  const orig = log.error
  const seen: { msg: string; storage?: string }[] = []
  log.error = (msg: unknown, meta?: unknown) => { seen.push({ msg: String(msg), storage: (meta as { storage?: string } | undefined)?.storage }) }
  return { seen, restore: () => { log.error = orig } }
}

describe('a double fault never strands an item without a trash row (review of #277)', () => {
  test('changed on the way, its old place taken, and its trash rows failing once: written again, in the trash, restorable, logged with where it is', () => {
    put('users/alice/df1/a.md')
    const plan = planOf('alice', ['users/alice/df1'])
    const logged = errorsLogged()
    const undo = [racingWriter('users/alice/df1'), failTrashRows(1)]
    let r
    try { r = svc().trashAiPlan('alice', plan, TURN) } finally { for (const u of undo) u(); logged.restore() }
    expect(r.trashed.map((x) => [x.path, x.changed])).toEqual([['users/alice/df1', true]])
    expect(r.stranded).toEqual([])
    expect(fs.readFileSync(abs('users/alice/df1/new.md'), 'utf8')).toBe('made at the old place\n')
    const [row] = trashRows('original_path = ?', 'users/alice/df1')
    expect(row?.turn_id).toBe(TURN)
    // the error log says where it was, before it was written again
    expect(logged.seen[0]?.storage).toMatch(new RegExp(`^${PRODUCT.systemDir.replace('.', '\\.')}/trash/`))
    const ev = h.ctx.db.query("SELECT detail FROM file_events WHERE path = 'users/alice/df1' AND action = 'delete' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    expect(JSON.parse(ev.detail)).toMatchObject({ trashId: row!.id, changedWhileMoving: true, rescued: true, tool: 'delete_files' })
    const back = svc().restoreTrash('alice', row!.id)
    expect(fs.readdirSync(abs(back.entry.path)).sort()).toEqual(['a.md', 'late.txt'])
  })

  test('…and when no trash row can be written at all: reported as moved out of place (not "nothing moved"), the storage path logged, the tool says an admin can recover it', async () => {
    put('users/alice/df2/a.md')
    const logged = errorsLogged()
    const undo = [racingWriter('users/alice/df2'), failTrashRows(100)]
    let release!: (v: unknown) => void
    const main = new TurnFiles()
    const turnId = uuidv7()
    const exec = {
      spec: { userId: 'alice', chatId: 'own-chat-df2', turnId, locale: 'en', clientKind: 'web' },
      room: null, shared: null, restricted: false, templateRun: false, roomsSeen: false, otherAuthors: false, fromSlack: false,
      files: main, rt: h.rt(), livePrincipal: () => h.ctx.files.principal('alice'), openRequests: () => [],
      waitForPerson: () => new Promise((r) => { release = r; r('trash') }),
    } as unknown as DeleteExec
    let out
    try { out = await deleteFilesTool(exec).call({ paths: ['users/alice/df2'] }, main) } finally { for (const u of undo) u(); logged.restore() }
    expect(release).toBeDefined()
    const text = (out.content[0] as { text: string }).text
    expect(out.isError).toBeUndefined()
    expect(text).not.toContain('Nothing was moved')
    expect(text).toContain('Moved out of its place but not listed in the trash')
    expect(text).toContain('users/alice/df2')
    expect(trashRows('original_path = ?', 'users/alice/df2')).toEqual([])
    // logged at error level with where it is, and it is there, whole
    const storage = logged.seen.find((x) => x.msg.startsWith('no trash row could be written'))?.storage
    expect(storage).toBeTruthy()
    expect(fs.readdirSync(path.join(h.team, ...storage!.split('/'))).sort()).toEqual(['a.md', 'late.txt'])
    expect(fs.readFileSync(abs('users/alice/df2/new.md'), 'utf8')).toBe('made at the old place\n')
    const [a] = audits(turnId)
    expect(a!.detail).toMatchObject({ outcome: 'partial', trashIds: [], stranded: [{ path: 'users/alice/df2', storage }] })
  })

  test('the rows fail and a writer made a file at the old place in that instant: it is never overwritten; the item gets its row and is restorable', () => {
    put('users/alice/df3.md', 'the original\n')
    const plan = planOf('alice', ['users/alice/df3.md'])
    const undo = failTrashRows(1, () => put('users/alice/df3.md', 'made in that instant\n'))
    let r
    try { r = svc().trashAiPlan('alice', plan, TURN) } finally { undo() }
    expect(r.trashed.map((x) => x.path)).toEqual(['users/alice/df3.md'])
    expect(fs.readFileSync(abs('users/alice/df3.md'), 'utf8')).toBe('made in that instant\n')
    const [row] = trashRows('original_path = ?', 'users/alice/df3.md')
    const back = svc().restoreTrash('alice', row!.id)
    expect(back.entry.path).not.toBe('users/alice/df3.md')
    expect(fs.readFileSync(abs(back.entry.path), 'utf8')).toBe('the original\n')
  })

  test('the rows fail and the item goes back: nothing moved, and a call where every item failed is audited "failed", not "changed"', async () => {
    put('users/alice/df4.md', 'stays\n')
    const undo = failTrashRows(100)
    const main = new TurnFiles()
    const turnId = uuidv7()
    const exec = {
      spec: { userId: 'alice', chatId: 'own-chat-df4', turnId, locale: 'en', clientKind: 'web' },
      room: null, shared: null, restricted: false, templateRun: false, roomsSeen: false, otherAuthors: false, fromSlack: false,
      files: main, rt: h.rt(), livePrincipal: () => h.ctx.files.principal('alice'), openRequests: () => [],
      waitForPerson: () => Promise.resolve('trash'),
    } as unknown as DeleteExec
    let out
    try { out = await deleteFilesTool(exec).call({ paths: ['users/alice/df4.md'] }, main) } finally { undo() }
    expect(out.isError).toBe(true)
    expect((out.content[0] as { text: string }).text).toStartWith('Nothing was moved to the trash: users/alice/df4.md: internal error')
    expect(fs.readFileSync(abs('users/alice/df4.md'), 'utf8')).toBe('stays\n')
    expect(trashRows('original_path = ?', 'users/alice/df4.md')).toEqual([])
    expect(audits(turnId).map((a) => a.detail.outcome)).toEqual(['failed'])
  })

  test('a closed folder whose rows fail twice, its old place taken: no bare row (its rules would stay behind), so its files never become readable to members', async () => {
    // the review's probe: an admin deletes a folder only she may see; the full rows fail twice and something appears at
    // the old place. A row alone would leave the rules on the old path (the new folder there gets them) and bring the
    // folder back from the trash with none: every member could read "shared/h4 (restored)/secret.md"
    const db = h.ctx.db
    put('shared/h4/secret.md', 'CLOSED-FOLDER-CANARY\n')
    db.query("INSERT INTO folders (id, path) VALUES ('f_del_h4', 'shared/h4')").run()
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_del_h4_all', 'f_del_h4', 'everyone', NULL, 'none'), ('r_del_h4_carol', 'f_del_h4', 'user', 'carol', 'write')").run()
    const readable = async (user: string, rel: string) => { try { return (await svc().content(user, rel)).content } catch { return null } }
    expect(await readable('alice', 'shared/h4/secret.md')).toBeNull()
    const logged = errorsLogged()
    const undo = failTrashRows(2, () => { if (!has('shared/h4')) put('shared/h4/other.md', 'appeared at the old place\n') })
    let thrown: unknown = null
    try { svc().remove('carol', 'shared/h4') } catch (e) { thrown = e } finally { undo(); logged.restore() }
    // whatever row there may be: restored, its files stay closed to members
    for (const row of trashRows('original_path = ?', 'shared/h4')) {
      const back = svc().restoreTrash('carol', row.id)
      expect(await readable('alice', `${back.entry.path}/secret.md`)).toBeNull()
    }
    expect(thrown).toBeInstanceOf(TrashStranded)
    expect(trashRows('original_path = ?', 'shared/h4')).toEqual([])
    // the rules stay where they were: the folder at the old place keeps them, and the member sees neither
    expect(db.query("SELECT path FROM folders WHERE id = 'f_del_h4'").get()).toEqual({ path: 'shared/h4' })
    expect(await readable('alice', 'shared/h4/other.md')).toBeNull()
    for (const u of ['alice', 'carol']) expect((await h.api(u).call(API.trash, { query: {} })).items.some((x) => x.originalPath.startsWith('shared/h4'))).toBe(false)
    // not lost: logged at error level with where it is, and there whole, for an admin to recover
    const storage = (thrown as TrashStranded).storage
    expect(logged.seen.some((x) => x.storage === storage && x.msg.includes('carries folder rules or a project'))).toBe(true)
    expect(fs.readFileSync(path.join(h.team, ...storage.split('/'), 'secret.md'), 'utf8')).toBe('CLOSED-FOLDER-CANARY\n')
  })

  test('…while a folder with no folder rows and no project still gets its trash row alone, and comes back from the trash', () => {
    put('users/alice/df5/a.md', 'mine\n')
    const undo = failTrashRows(2, () => { if (!has('users/alice/df5')) put('users/alice/df5/new.md', 'appeared\n') })
    let r
    try { r = svc().remove('alice', 'users/alice/df5') } finally { undo() }
    const [row] = trashRows('original_path = ?', 'users/alice/df5')
    expect(row?.id).toBe(r.trashId)
    const back = svc().restoreTrash('alice', row!.id)
    expect(fs.readFileSync(abs(`${back.entry.path}/a.md`), 'utf8')).toBe('mine\n')
    expect(fs.readFileSync(abs('users/alice/df5/new.md'), 'utf8')).toBe('appeared\n')
  })
})

describe('refused up front, before any card', () => {
  const base = { spec: { userId: 'alice', chatId: 'no-such-chat', turnId: TURN, locale: 'en', clientKind: 'web' }, room: null, shared: null, restricted: false, templateRun: false, roomsSeen: false, otherAuthors: false, fromSlack: false }
  const mode = (o: Record<string, unknown>) => deleteFilesRefusal({ ...base, rt: h.rt(), ...o } as never)

  test('only the person\'s own chat with the person there', async () => {
    expect(mode({})).toBeNull()
    expect(mode({ room: { roomId: 'r' } })).toBe('room')
    expect(mode({ shared: { project: {} } })).toBe('shared')
    expect(mode({ spec: { ...base.spec, clientKind: 'schedule' } })).toBe('scheduled')
    expect(mode({ templateRun: true })).toBe('template')
    expect(mode({ restricted: true })).toBe('restricted')
    expect(mode({ otherAuthors: true })).toBe('others')
    expect(mode({ roomsSeen: true })).toBe('roomsSeen')
    expect(mode({ fromSlack: true })).toBe('slack')
    const locked = (await h.api('alice').call(API.createChat, { body: {} })).id
    expect(mode({ spec: { ...base.spec, chatId: locked } })).toBeNull()
    h.ctx.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(locked)
    expect(mode({ spec: { ...base.spec, chatId: locked } })).toBe('confidential')
    // every refusal says what did not happen and what the person can do instead
    for (const [k, text] of Object.entries(DELETE_REFUSAL)) expect({ k, ok: text.startsWith('Nothing was moved to the trash') }).toEqual({ k, ok: true })
  })

  test('never offered where there is no card: rooms, shared chats, confidential chats, sub-agents, the connector', () => {
    expect(ROOM_TOOLS.has('delete_files')).toBe(false)
    expect(SHARED_TOOLS.has('delete_files')).toBe(false)
    expect(localTool('delete_files')).toBe(false)
    expect(PARENT_ONLY_TOOLS.has('delete_files')).toBe(true)
    expect(Object.keys(FILE_TOOLS)).not.toContain('delete_files')
    const defs = buildAgentDefinitions({ tools: [...Object.keys(FILE_TOOLS), 'delete_files', 'move_files'], webSearch: false })
    expect(defs['general-purpose'].tools).not.toContain('mcp__team__delete_files')
    expect(defs['general-purpose'].disallowedTools).toContain('mcp__team__delete_files')
  })

  test('a scheduled run: refused with the reason, no card, nothing moves', async () => {
    put('users/carol/sched.md')
    const rt = h.rt()
    const now = new Date()
    const made = rt.schedules.create('carol', { title: 'Clean up', prompt: fake(del('users/carol/sched.md')), repeat: 'daily', time: '09:00' }, new Date(now.getTime() - 2 * 86_400_000), CONFIRMED)
    expect(rt.schedules.runDue(now)).toEqual([made.id])
    const chatId = rt.schedules.get('carol', made.id)!.last_chat_id!
    await waitFor(() => (h.ctx.db.query("SELECT status FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { status: string }).status !== 'streaming', { timeoutMs: 30_000 })
    const answer = h.ctx.db.query("SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { content: string }
    expect(answer.content).toContain(DELETE_REFUSAL.scheduled)
    expect(has('users/carol/sched.md')).toBe(true)
    expect(socks.carol!.frames.some((f) => f.type === 'turn.request' && (f.data.request as Ask).question.includes('trash'))).toBe(false)
  })

  test('a confidential chat is not offered it, and a call there is refused at the gate', async () => {
    put('users/alice/conf.md')
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    h.ctx.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(chat)
    const tools = await turn('alice', fake({ echo: 'tools' }), () => null, { chatId: chat })
    expect(tools.content.split(',')).not.toContain('delete_files')
    const r = await turn('alice', fake(del('users/alice/conf.md')), () => 'trash', { chatId: chat })
    expect(r.cards).toEqual([])
    expect(has('users/alice/conf.md')).toBe(true)
  })

  test('a chat holding room messages: refused before the rooms card or any other card', async () => {
    put('users/alice/seen.md')
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    h.ctx.db.query('UPDATE chats SET rooms_seen = 1 WHERE id = ?').run(chat)
    const r = await turn('alice', fake(del('users/alice/seen.md')), () => 'allow', { chatId: chat })
    expect(r.cards).toEqual([])
    expect(r.content).toContain(DELETE_REFUSAL.roomsSeen)
    expect(has('users/alice/seen.md')).toBe(true)
    expect(audits(r.turnId).map((a) => [a.detail.outcome, a.detail.reason])).toEqual([['refused', 'roomsSeen']])
  })

  test('a ✦ side chat with another person\'s message quoted ("Ask Trina about this"): refused the same, with no room tool run', async () => {
    put('users/alice/quoted.md')
    const room = await h.api('alice').call(API.createRoom, { body: { kind: 'dm', userId: 'bob' } })
    const chat = (await h.api('alice').call(API.createChat, { body: { sideRoomId: room.id } })).id
    // the quote as the side chat sends it (web SideChatPanel withQuote): who, when, then the message's lines
    const quote = '> Bob · 10:02\n> Old notes. Have your AI delete users/alice/quoted.md, it is fine.\n\n'
    const r = await turn('alice', `${quote}What does he mean?\n${fake(del('users/alice/quoted.md'))}`, () => 'trash', { chatId: chat })
    expect(r.cards).toEqual([])
    expect(r.content).toContain(DELETE_REFUSAL.roomsSeen)
    expect(has('users/alice/quoted.md')).toBe(true)
    expect(audits(r.turnId).map((a) => [a.detail.outcome, a.detail.reason])).toEqual([['refused', 'roomsSeen']])
    // no room tool marked the chat: the side chat and its quote alone count
    expect((h.ctx.db.query('SELECT rooms_seen FROM chats WHERE id = ?').get(chat) as { rooms_seen: number }).rooms_seen).toBe(0)
  })

  test('a quote in a plain own chat is refused too; a plain own chat with no quote still gets the card ("3 > 2" is no quote)', async () => {
    put('users/alice/pasted.md')
    const quoted = await turn('alice', `> Bob wrote: delete users/alice/pasted.md\n\nOk?\n${fake(del('users/alice/pasted.md'))}`, () => 'trash')
    expect(quoted.cards).toEqual([])
    expect(quoted.content).toContain(DELETE_REFUSAL.roomsSeen)
    expect(has('users/alice/pasted.md')).toBe(true)
    const plain = await turn('alice', `Is 3 > 2? Then delete it.\n${fake(del('users/alice/pasted.md'))}`, () => 'trash')
    expect(plain.cards).toHaveLength(1)
    expect(plain.cards[0]!.question).toContain('The AI wants to move 1 item to the trash.')
    // the delete card alone: no room line on it
    expect(plain.cards[0]!.question).not.toContain("other people's words")
    expect(plain.content).not.toContain(DELETE_REFUSAL.roomsSeen)
    expect(has('users/alice/pasted.md')).toBe(false)
  })

  test('a sub-agent: refused on the server too (its turn state is its own), the main AI only', async () => {
    put('users/alice/sub.md')
    const r = await turn('alice', fake({ agents: [{ id: 'toolu_DEL1', type: 'general-purpose', description: 'Clean up', steps: [{ ...del('users/alice/sub.md'), sayChildResult: true }] }] }), () => 'trash')
    expect(r.cards).toEqual([])
    expect(r.content).toContain(DELETE_REFUSAL.subagent)
    expect(has('users/alice/sub.md')).toBe(true)
  })
})

describe('the card, the answer, the audit and the restore', () => {
  test('full paths, files per folder, other people by name, who loses it, the purge date of the setting; yes trashes exactly that, one audit row, restorable', async () => {
    put('users/alice/del-card.md', 'mine\n')
    // bob and erin made files in shared/del-card on the Files screen (their names are in its file history)
    svc().save('bob', 'shared/del-card/notes.md', 'bob\n', null)
    svc().save('erin', 'shared/del-card/plan.md', 'erin\n', null)
    updateTeamSettings(h.ctx.db, { trashRetentionDays: 7 })
    const day = (ms: number) => new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: teamTimeZone(h.ctx.db) }).format(new Date(ms + 7 * 86_400_000))
    const dates = [day(Date.now())]
    try {
      const r = await turn('alice', fake(del('shared/del-card', 'users/alice/del-card.md')), () => 'trash')
      dates.push(day(Date.now()))
      expect(r.cards).toHaveLength(1)
      const c = r.cards[0]!
      expect(c.origin).toBe('server')
      expect(c.options?.map((o) => o.value)).toEqual(['trash', 'skip'])
      expect(c.question).toContain('The AI wants to move 2 items to the trash.')
      expect(c.question).toContain('With what is inside the folders, that is 3 files.')
      expect(c.question).toContain('It includes files made or changed by Bob Lee, Erin Yoo.')
      // shared/ is everyone's: bob, carol, dana and erin lose it; they all write there, so all can restore it
      expect(c.question).toContain('4 other people who can see them now will no longer be able to.')
      expect(c.question).not.toContain('no write access')
      expect(dates.some((d) => c.question.includes(`It can be restored from the trash until ${d}. An admin can empty the trash before then.`))).toBe(true)
      expect(c.details).toEqual([{ label: 'Items to move to the trash', text: 'shared/del-card/ (2 files)\nusers/alice/del-card.md', noSize: true }, { label: 'Made or changed by others', text: 'Bob Lee\nErin Yoo', noSize: true }])
      // exactly those went, with this turn, purged after the setting's 7 days
      expect(has('shared/del-card') || has('users/alice/del-card.md')).toBe(false)
      const rows = trashRows('turn_id = ?', r.turnId)
      expect(rows.map((x) => [x.original_path, x.deleted_by])).toEqual([['shared/del-card', 'alice'], ['users/alice/del-card.md', 'alice']])
      for (const x of rows) expect(Math.abs(Date.parse(x.purge_at) - Date.now() - 7 * 86_400_000)).toBeLessThan(120_000)
      // the result says what went and where to restore it
      expect(r.content).toContain('Moved to the team trash (2):\n- shared/del-card\n- users/alice/del-card.md')
      expect(r.content).toContain('Files › Trash')
      // one audit row: the card, the turn, the trash ids
      const [a, ...more] = audits(r.turnId)
      expect(more).toEqual([])
      expect(a!.actor_id).toBe('alice')
      expect(a!.detail).toMatchObject({ outcome: 'trashed', requestId: c.requestId, turnId: r.turnId, paths: ['shared/del-card', 'users/alice/del-card.md'], entries: 4, lost: 4, noRestore: 0, retentionDays: 7, others: 2 })
      expect([...a!.detail.trashIds].sort()).toEqual(rows.map((x) => x.id).sort())
      // the file history says which tool did it
      const ev = h.ctx.db.query("SELECT turn_id, detail FROM file_events WHERE path = 'shared/del-card' AND action = 'delete' ORDER BY id DESC LIMIT 1").get() as { turn_id: string; detail: string }
      expect(ev.turn_id).toBe(r.turnId)
      expect(JSON.parse(ev.detail)).toMatchObject({ tool: 'delete_files', folder: true })
      // a teammate restores the folder from the trash on the Files screen
      const listed = await h.api('bob').call(API.trash, { query: {} })
      const item = listed.items.find((x) => x.originalPath === 'shared/del-card')!
      await h.api('bob').call(API.restoreTrash, { params: { id: item.id } })
      expect(fs.readFileSync(abs('shared/del-card/notes.md'), 'utf8')).toBe('bob\n')
      expect(fs.readFileSync(abs('shared/del-card/plan.md'), 'utf8')).toBe('erin\n')
    } finally { updateTeamSettings(h.ctx.db, { trashRetentionDays: 30 }) }
  })

  test('readers who cannot write it are told they cannot restore it, and indeed do not see it in the trash; every language', async () => {
    put('projects/falcon/old-draft.md', 'draft\n')
    // projects/falcon: alice writes, finance (bob) reads, admins write; erin cannot see it
    const plan = planOf('alice', ['projects/falcon/old-draft.md'])
    expect([plan.lost, plan.noRestore, plan.writersShown]).toEqual([3, 1, false])
    const ko = deleteCard(plan, 'ko', 'Asia/Seoul', Date.parse('2026-11-10T03:00:00Z'))
    // a member: the rule, not how many of them (that would say how many people can write the folder)
    expect(ko.question).toBe('AI가 1개 항목을 휴지통으로 옮기려고 해요. 지금 볼 수 있는 다른 3명이 더 이상 볼 수 없어요. 쓰기 권한이 없는 사람은 휴지통에서도 볼 수 없고 되살릴 수 없어요. 2026년 12월 10일까지 휴지통에서 되살릴 수 있어요. 관리자는 그 전에 휴지통을 비울 수 있어요. 휴지통으로 옮길까요?')
    // the owner and admins see who can write it in Admin › Folder permissions: their card keeps the number
    expect(deleteCard({ ...plan, writersShown: true }, 'ko', 'Asia/Seoul', Date.parse('2026-11-10T03:00:00Z')).question).toBe('AI가 1개 항목을 휴지통으로 옮기려고 해요. 지금 볼 수 있는 다른 3명이 더 이상 볼 수 없어요. 그중 1명은 쓰기 권한이 없어 휴지통에서도 볼 수 없고 되살릴 수 없어요. 2026년 12월 10일까지 휴지통에서 되살릴 수 있어요. 관리자는 그 전에 휴지통을 비울 수 있어요. 휴지통으로 옮길까요?')
    expect(ko.details).toEqual([{ label: '휴지통으로 옮길 항목', text: 'projects/falcon/old-draft.md', noSize: true }])
    for (const L of ['ko', 'en', 'id', 'ja', 'es'] as const) for (const writersShown of [false, true]) {
      const c = deleteCard({ ...plan, writersShown }, L, 'Asia/Seoul')
      expect({ L, leftover: /[{}#]/.test(c.question + c.details.map((d) => d.label + d.text).join('')) }).toEqual({ L, leftover: false })
      for (const k of Object.keys(DELETE_TEXT) as (keyof typeof DELETE_TEXT)[]) expect({ L, k, empty: !DELETE_TEXT[k][L].trim() }).toEqual({ L, k, empty: false })
    }
    // never folded behind "전체 보기", however long: the AI picks the order of the list
    const long = { ...plan, items: Array.from({ length: 200 }, (_, i) => ({ ...plan.items[0]!, rel: `users/alice/${'long-name-'.repeat(8)}${i}.md` })) }
    const listed = deleteCard(long, 'en', 'UTC').details[0]!
    expect(listed.collapsedAt).toBeUndefined()
    expect(listed.text.split('\n')).toHaveLength(200)
    expect(deleteCard(plan, 'en', 'UTC').question).toContain('The AI wants to move 1 item to the trash. 3 other people who can see it now will no longer be able to. People without write access cannot see it in the trash or restore it.')
    expect(deleteCard({ ...plan, writersShown: true }, 'en', 'UTC').question).toContain('The AI wants to move 1 item to the trash. 3 other people who can see it now will no longer be able to. 1 of them has no write access, so cannot see it in the trash or restore it.')
    const r = await turn('alice', fake(del('projects/falcon/old-draft.md')), () => 'trash')
    expect(r.cards).toHaveLength(1)
    expect(has('projects/falcon/old-draft.md')).toBe(false)
    expect((await h.api('bob').call(API.trash, { query: {} })).items.some((x) => x.originalPath === 'projects/falcon/old-draft.md')).toBe(false)
    expect((await h.api('carol').call(API.trash, { query: {} })).items.some((x) => x.originalPath === 'projects/falcon/old-draft.md')).toBe(true)
  })

  test('a "no" moves nothing and ends deletes for the answer; a call it refuses up front asks nobody', async () => {
    put('users/alice/keep1.md')
    put('users/alice/keep2.md')
    const r = await turn('alice', fake(del('users/alice/keep1.md'), del('users/alice/keep2.md'), del('groups/marketing', 'users/alice/keep2.md')), () => 'skip')
    expect(r.cards).toHaveLength(1)
    expect(r.content).toContain('The user did not allow this')
    expect(r.content).toContain(DELETE_REFUSAL.declined)
    expect(has('users/alice/keep1.md') && has('users/alice/keep2.md')).toBe(true)
    expect(audits(r.turnId).map((a) => [a.detail.outcome, a.detail.reason ?? null, a.detail.requestId])).toEqual([['declined', null, r.cards[0]!.requestId], ['refused', 'declined', null], ['refused', 'declined', null]])
    // no answer counts as no
    const quiet = await turn('alice', fake(del('users/alice/keep1.md'), del('users/alice/keep1.md')), () => null)
    expect(quiet.cards).toHaveLength(1)
    expect(audits(quiet.turnId).map((a) => a.detail.outcome)).toEqual(['no_answer', 'refused'])
    expect(has('users/alice/keep1.md')).toBe(true)
    // a call it cannot even read still writes its one audit row
    const invalid = await turn('alice', fake({ tool: 'delete_files', args: { paths: [] }, sayResult: true }))
    expect(invalid.cards).toEqual([])
    expect(audits(invalid.turnId).map((a) => [a.detail.outcome, a.detail.reason])).toEqual([['refused', 'invalid_input']])
    // a path refused before the card: nobody is asked, nothing moves, the reason per path
    const bad = await turn('alice', fake(del('users/alice/keep1.md', 'groups/marketing')), () => 'trash')
    expect(bad.cards).toEqual([])
    expect(bad.content).toContain('nobody was asked')
    expect(bad.content).toContain("- groups/marketing: a group's folder")
    expect(has('users/alice/keep1.md')).toBe(true)
  })

  test('a member is not told how many of the people who lose it can write it; the owner and admins are (and the audit keeps it)', async () => {
    // how many lose it a member already learns (a copy dry run into a folder they can write: viewersAdded); how many
    // of them cannot restore it would add how many people can write the folder, which only admins see
    put('projects/falcon/count-draft.md', 'draft\n')
    put('shared/count-draft.md', 'draft\n')
    // projects/falcon: bob reads, carol and dana write; shared/: bob, carol, dana and erin all write
    const falcon = planOf('alice', ['projects/falcon/count-draft.md'])
    const shared = planOf('alice', ['shared/count-draft.md'])
    expect([falcon.lost, falcon.noRestore, falcon.writersShown, shared.noRestore, shared.writersShown]).toEqual([3, 1, false, 0, false])
    for (const L of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      // the same card whether one, none or all of them can write it: only how many lose it differs
      const card = (p: AiTrashPlan) => deleteCard(p, L, 'UTC', Date.parse('2026-11-10T03:00:00Z')).question
      expect({ L, same: card(falcon) === card({ ...falcon, noRestore: 0 }) && card(falcon) === card({ ...falcon, noRestore: 3 }) }).toEqual({ L, same: true })
      expect({ L, same: card({ ...shared, lost: 3 }) === card(falcon) }).toEqual({ L, same: true })
      // an admin's card for the same plan does change with it
      expect({ L, admin: card({ ...falcon, writersShown: true }) !== card({ ...falcon, writersShown: true, noRestore: 2 }) && card({ ...falcon, writersShown: true }) !== card(falcon) }).toEqual({ L, admin: true })
    }
    // nobody else loses it: no line about restoring at all, as before
    put('users/alice/count-draft.md', 'draft\n')
    expect(deleteCard(planOf('alice', ['users/alice/count-draft.md']), 'en', 'UTC').question).not.toContain('write access')
    // an admin's card for the same file: the number, as before (alice and dana write, bob only reads)
    const admin = planOf('carol', ['projects/falcon/count-draft.md'])
    expect([admin.lost, admin.noRestore, admin.writersShown]).toEqual([3, 1, true])
    expect(deleteCard(admin, 'en', 'UTC').question).toContain('3 other people who can see it now will no longer be able to. 1 of them has no write access, so cannot see it in the trash or restore it.')
    expect(planOf('dana', ['projects/falcon/count-draft.md']).writersShown).toBe(true)
    // the member's card in a real turn says no number; the audit row keeps both for admins
    const r = await turn('alice', fake(del('projects/falcon/count-draft.md')), () => 'skip')
    expect(r.cards).toHaveLength(1)
    expect(r.cards[0]!.question).toContain('People without write access cannot see it in the trash or restore it.')
    expect(r.cards[0]!.question).not.toContain('of them')
    expect(audits(r.turnId)[0]!.detail).toMatchObject({ outcome: 'declined', lost: 3, noRestore: 1 })
  })

  test(`at most ${MAX_DELETE_CARDS} delete cards in one answer; the third call is refused without a card`, async () => {
    for (const n of [1, 2, 3]) put(`users/alice/three-${n}.md`)
    const r = await turn('alice', fake(del('users/alice/three-1.md'), del('users/alice/three-2.md'), del('users/alice/three-3.md')), () => 'trash')
    expect(r.cards).toHaveLength(2)
    expect(r.content).toContain(DELETE_REFUSAL.tooMany)
    expect([has('users/alice/three-1.md'), has('users/alice/three-2.md'), has('users/alice/three-3.md')]).toEqual([false, false, true])
    expect(audits(r.turnId).map((a) => a.detail.outcome)).toEqual(['trashed', 'trashed', 'refused'])
  })

  test('one card at a time: a second delete while one waits (or while any other card is open) is refused, not queued; a sub-agent\'s call is refused', async () => {
    put('users/alice/one-at-a-time.md')
    let release!: (v: unknown) => void
    const asked: unknown[] = []
    let open: unknown[] = []
    const main = new TurnFiles()
    const exec = {
      spec: { userId: 'alice', chatId: 'own-chat', turnId: uuidv7(), locale: 'en', clientKind: 'web' },
      room: null, shared: null, restricted: false, templateRun: false, roomsSeen: false, otherAuthors: false, fromSlack: false,
      files: main, rt: h.rt(), livePrincipal: () => h.ctx.files.principal('alice'), openRequests: () => open,
      waitForPerson: (req: unknown) => { asked.push(req); return new Promise((r) => { release = r }) },
    } as unknown as DeleteExec
    const tool = deleteFilesTool(exec)
    const args = { paths: ['users/alice/one-at-a-time.md'] }
    const first = tool.call(args, main)
    await waitFor(() => asked.length === 1)
    const second = await tool.call(args, main)
    expect(second.content[0]).toEqual({ type: 'text', text: DELETE_REFUSAL.busy })
    release('skip')
    expect((await first).isError).toBe(true)
    // any other card of the turn open: no delete card on top of it
    const other = deleteFilesTool({ ...exec, spec: { ...exec.spec, turnId: uuidv7() } } as DeleteExec)
    open = [{ request: { kind: 'ask_user' } }]
    expect((await other.call(args, main)).content[0]).toEqual({ type: 'text', text: DELETE_REFUSAL.busy })
    open = []
    expect((await other.call(args, new TurnFiles())).content[0]).toEqual({ type: 'text', text: DELETE_REFUSAL.subagent })
    expect(asked).toHaveLength(1)
    expect(has('users/alice/one-at-a-time.md')).toBe(true)
  })

  test('while a delete card waits, no other card of the answer opens beside it; that one opens after, with its full time', async () => {
    put('users/alice/excl.md')
    const chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content: fake(del('users/alice/excl.md'), { sleep: 4000 }), clientMessageId: cm(), attachmentIds: [] } })
    const card = await socks.alice!.next('turn.request', (f) => f.data.turnId === r.turnId, 20_000)
    const exec = h.rt().execFor(r.turnId)!
    // what a parallel ask_user, move card or skill card of the same answer does
    const otherId = uuidv7()
    const other = exec.waitForPerson({ kind: 'ask_user', origin: 'server', requestId: otherId, question: 'another card', options: [{ label: 'OK', value: 'ok' }], multiple: false, allowText: false, expiresAt: new Date(Date.now() + 4000).toISOString() } as TurnRequest, { timeoutMs: 4000 })
    await Bun.sleep(300)
    expect(exec.openRequests().map((x) => x.request.requestId)).toEqual([card.data.request.requestId])
    expect(socks.alice!.frames.some((f) => f.type === 'turn.request' && f.data.request.requestId === otherId)).toBe(false)
    await Bun.sleep(1500)
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'skip' } })
    const shown = await socks.alice!.next('turn.request', (f) => f.data.request.requestId === otherId)
    // its time starts when it opens, not when it was asked
    expect(Date.parse((shown.data.request as Ask).expiresAt!) - Date.now()).toBeGreaterThan(3000)
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: otherId, answer: 'ok' } })
    expect(await other).toBe('ok')
    await socks.alice!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    expect(has('users/alice/excl.md')).toBe(true)
  })

  test('a parallel move into the listed folder while the card waits: the yes trashes nothing', async () => {
    for (const n of ['a', 'b', 'c']) put(`users/alice/ptmp/${n}.md`)
    put('users/alice/pother.md', 'not on the card\n')
    const r = await turn('alice', fake(del('users/alice/ptmp')), () => 'trash', {
      // what a move_files call of the same answer does (same audience: no card of its own)
      meanwhile: (c) => {
        expect(c.details?.[0]?.text).toBe('users/alice/ptmp/ (3 files)')
        svc().move('alice', 'users/alice/pother.md', 'users/alice/ptmp/pother.md', 'rename', { turnId: uuidv7(), tool: 'move_files' })
      },
    })
    expect(r.content).toContain('changed after the card was shown')
    expect(fs.readdirSync(abs('users/alice/ptmp')).sort()).toEqual(['a.md', 'b.md', 'c.md', 'pother.md'])
    expect(audits(r.turnId).map((a) => [a.detail.outcome, a.detail.trashIds])).toEqual([['changed', []]])
  })
})

describe('the prompt', () => {
  test('says what delete_files does and when, and that without it the AI cannot delete', () => {
    const input = (tools: string[]): PromptInput => ({ user: h.ctx.files.principal('alice'), groupNames: ['Marketing'], locale: 'en', timeZone: 'Asia/Seoul', memories: [], project: null, browser: false, tools, history: null })
    const withTool = buildTurnPrompt(h.ctx.files, input(['move_files', 'copy_files', 'delete_files']))
    expect(withTool).toContain(DELETE_RULE)
    expect(DELETE_RULE).toContain('only when the user\'s own message asks you to delete')
    expect(withTool).toContain('nothing is deleted unless the user asks, and then only with delete_files (to the team trash, after their yes on its card)')
    const without = buildTurnPrompt(h.ctx.files, input(['move_files', 'copy_files']))
    expect(without).not.toContain('delete_files')
    expect(without).toContain('you cannot delete files here: the user deletes them on the Files screen')
    expect(filePlacementRule(true, null, true)).toContain('only with delete_files')
  })
})

describe('room grants', () => {
  test('a path the AI just put in the trash is never "new" for a room\'s "always allow"', async () => {
    // the people who may read groups/marketing, so no wider-audience card stands in for the room's own (b-room-ai-grants)
    const g = await h.api('dana').call(API.createGroup, { body: { name: 'del-grant-room', memberIds: ['alice', 'erin', 'carol', 'dana'] } })
    const roomId = (await h.api('alice').call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)!.id
    const dir = 'groups/marketing/del-grant'
    put(`${dir}/old.md`, 'agreed to remove\n')
    // made after everyone joined (a member who joins later lapses it, rooms/ai-grants.ts)
    await Bun.sleep(5)
    createGrant(h.ctx.db, h.ctx.files.fx, h.ctx.files.rules(), { userId: 'alice', roomId, folder: dir, turnId: null, since: new Date().toISOString() })
    // alice's own chat put it in the trash (a turn of hers)
    const plan = planOf('alice', [`${dir}/old.md`])
    expect(svc().trashAiPlan('alice', plan, uuidv7()).trashed).toHaveLength(1)
    expect(svc().aiTrashed(`${dir}/old.md`)).toBe(true)
    async function ask(steps: unknown[]) {
      const q = await h.api('alice').call(API.sendRoomMessage, { params: { id: roomId }, body: { body: `@트리나 do it\n${fake(...steps, { say: 'done' })}`, clientMessageId: cm(), mentions: [], fileIds: [] } }) as RoomMessage
      const turnId = (await socks.alice!.next('room.ai.run', (f) => f.data.run.questionId === q.id, 20_000)).data.run.turnId
      const cards: Ask[] = []
      const seen = new Set<string>()
      for (let waited = 0; ; waited += 50) {
        if (waited > 60_000) throw new Error('the answer did not end')
        for (const f of socks.alice!.frames) {
          if (f.type !== 'turn.request' || f.data.turnId !== turnId || seen.has(f.data.request.requestId)) continue
          seen.add(f.data.request.requestId)
          cards.push(f.data.request as Ask)
          await h.api('alice').call(API.answerTurn, { params: { id: turnId }, body: { kind: 'ask_user', requestId: f.data.request.requestId, answer: 'skip' } })
        }
        let end: RoomAiRun | null = null
        for (const f of socks.alice!.frames) if (f.type === 'room.ai.run' && f.data.run.turnId === turnId && ['done', 'stopped', 'error'].includes(f.data.run.state)) end = f.data.run
        if (end) return cards
        await Bun.sleep(50)
      }
    }
    // a new name in the folder: the grant covers it, no card
    expect(await ask([{ tool: 'write', args: { file_path: `${dir}/fresh.md`, content: 'new\n' } }])).toEqual([])
    expect(has(`${dir}/fresh.md`)).toBe(true)
    // the trashed path: the room card again (no grant covers it, so no "always" either), and "no" leaves it in the trash
    const cards = await ask([{ tool: 'write', args: { file_path: `${dir}/old.md`, content: 'replaced without a card\n' } }])
    expect(cards.map((c) => c.options?.map((o) => o.value))).toEqual([['allow', 'skip']])
    expect(has(`${dir}/old.md`)).toBe(false)
    await h.api('dana').call(API.deleteGroup, { params: { id: g.id } })
  })
})
