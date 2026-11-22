// copy_files between the team folder, a chat's files (chat:files/) and its work folder (chat:work/) (plan
// docs/AGENTS/plan/20261121-1415-places-copy.md, P2 of 20261121-0615-chat-places-as-paths.md; server/src/chat/
// places-copy.ts). The runner runs against a fake srt system that runs each command with sh (no sandbox), so the copy
// into the work folder really happens through its box command (devenv/work-write.ts); the fence itself is tested on
// real srt in tests/linux and tests/macos. Alice and erin both read groups/marketing; bob may not.
// Covered: every direction of copy, the shared read card (no: nothing copied; yes: a y group in the answer and in the
// workspace key's record, recorded again by a later read, list and grep), a newcomer warned about the answer, a folder
// with an images folder and an inner link, a folder with its own rules under it (boundary folders), the turn's limits,
// the attach into chat:files/, the wider-audience card out to a team folder, a chat file carried by a hidden answer,
// a k turn, a project chat, the old save_chat_file / save_work_file giving the same result, list/glob/grep of
// chat:work/, and query_data on chat:files/ and chat:work/.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, type Attachment, type PutChatAudienceResult } from '@mycel/shared/api'
import { chatFilePath } from '@mycel/shared/places'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { _active, setSrtSystem } from '../../server/src/devenv/srt/runner'
import { chatWork, devenvPaths } from '../../server/src/devenv/srt/config'
import type { SrtSystem } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { copiedInOf } from '../../server/src/devenv/work-write'
import { answerRecord, setAnswerReads } from '../../server/src/chat/shared-answers'
import { setWebAllowAll } from '../../server/src/tools/web-allow-all'
import { updateTeamSettings } from '../../server/src/admin/settings'

import { expectNoRawPlace } from '../lib/card-places'
setDefaultTimeout(120_000)
const PLAN: DevEnvPlan = { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' }
// a fake system: every command runs with sh in the run's cwd (the copy-in script starts at "set -u")
const sys: SrtSystem = {
  spawn(spec) {
    const cmd = spec.command.includes('set -u') ? spec.command.slice(spec.command.indexOf('set -u')) : 'true'
    const p = Bun.spawnSync(['/bin/sh', '-c', cmd], { cwd: spec.cwd, env: { PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' })
    fs.appendFileSync(spec.stdoutFile, p.stdout); fs.appendFileSync(spec.stderrFile, p.stderr)
    fs.writeFileSync(spec.exitFile, `${p.exitCode}\n`)
    return { pid: 999_997, exited: Promise.resolve({ code: p.exitCode, signal: null }) }
  },
  async stop() {}, async unit() { return { state: '', result: '', memoryBytes: null } }, async units() { return [] }, async forget() {},
  oomKills() { return null }, cpuUsec() { return null }, procs() { return [] }, async selfTest() { return '' },
}
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness, base = ''
const ws: Record<string, TestSocket> = {}
const team = (rel: string) => path.join(h.team, rel)
const w = (rel: string, b: string | Uint8Array) => { fs.mkdirSync(path.dirname(team(rel)), { recursive: true }); fs.writeFileSync(team(rel), b) }
const turnOn = () => saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }) })
beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'places-copy', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'))
  setSrtSystem(sys, { base, id: 'mycel', plan: PLAN })
  // a proposal: an HTML file and its images folder in alice's own folder, with a link inside it
  w('users/alice/proposal/proposal.html', '<h1>PROPOSAL</h1><img src="images/a.png">')
  w('users/alice/proposal/images/a.png', 'PNG-A')
  w('users/alice/proposal/images/b.png', 'PNG-B')
  w('users/alice/secret.txt', 'SECRET')
  fs.symlinkSync(team('users/alice/secret.txt'), team('users/alice/proposal/images/link.png'))
  w('groups/marketing/brief.csv', 'name,n\nx,1\ny,2\n')
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); setSrtSystem(null); delete process.env.MYCEL_DEV_ENV; await h.close(); fs.rmSync(base, { recursive: true, force: true }) })
beforeEach(() => { _active().clear(); setSrtSystem(sys, { base, id: 'mycel', plan: PLAN }); turnOn() })

type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const put = (user: string, chatId: string, subjects: Sub[], confirmKey?: string): Promise<PutChatAudienceResult> =>
  h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
async function share(user: string, chatId: string, subjects: Sub[]) {
  let r = await put(user, chatId, subjects)
  if (r.status === 'confirm') r = await put(user, chatId, subjects, r.confirmKey)
  if (r.status !== 'saved') throw new Error('not saved')
}
type Card = { requestId: string; question: string; options?: { value: string }[] }
async function run(user: string, chatId: string, content: string, answer: (c: Card) => string = () => 'skip', attachmentIds: string[] = []) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds } })
  const cards: Card[] = []
  const end = Date.now() + 90_000
  for (;;) {
    const sock = ws[user]!
    const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && x.data.request.kind === 'ask_user' && !cards.some((c) => c.requestId === (x.data.request as Card).requestId))
    if (f && f.type === 'turn.request') {
      const c = f.data.request as unknown as Card
      cards.push(c)
      expectNoRawPlace(c)
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: answer(c) } })
      continue
    }
    const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { turnId: r.turnId, cards, content: done.data.message.content as string, messageId: done.data.message.id as string, attachments: (done.data.message.attachments ?? []) as Attachment[] }
    if (Date.now() > end) throw new Error('turn did not end')
    await Bun.sleep(25)
  }
}
const personal = async () => { const c = await h.api('alice').call(API.createChat, { body: {} }); await run('alice', c.id, fake({ say: 'hi' })); return c.id }
/** a chat alice shares with erin (both read groups/marketing) */
async function shared() {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  await run('alice', c.id, fake({ say: 'hi' }))
  await share('alice', c.id, [{ subjectType: 'user', subjectId: 'erin' }])
  return c.id
}
const sharedWork = (chat: string) => {
  const top = path.join(devenvPaths(base).workShared, chat)
  const keys = fs.readdirSync(top)
  expect(keys.length).toBe(1)
  return path.join(top, keys[0]!)
}
const copy = (paths: string[], to_folder: string, more: Record<string, unknown> = {}) => fake({ tool: 'copy_files', args: { paths, to_folder }, sayResult: true, ...more })
/** the card's yes: its first button ("read and share", "save") */
const shareYes = (c: Card) => c.options?.[0]?.value ?? 'share'
const ys = (messageId: string) => (answerRecord(h.ctx.db, messageId)?.reads ?? []).filter((g) => g.y)
async function upload(user: string, chatId: string, name: string, content: string | Uint8Array) {
  const form = new FormData()
  form.set('chatId', chatId)
  form.set('file', new File([typeof content === 'string' ? content : new Uint8Array(content)], name))
  const res = await h.req(user, '/api/uploads', { method: 'POST', body: form })
  return (await res.json()) as Attachment
}

describe('team → chat:work/', () => {
  test('a personal chat: an HTML file with its images folder, no card; the inner link is not copied; then list, glob and grep', async () => {
    const chat = await personal()
    const r = await run('alice', chat, copy(['users/alice/proposal'], 'chat:work/in/'))
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain('Copied 1 to chat:work/in')
    expect(r.content).toContain('chat:work/in/proposal')
    expect(r.content).toContain('images/link.png (link)')
    const root = path.join(chatWork(base, chat), 'in/proposal')
    expect(fs.readFileSync(path.join(root, 'proposal.html'), 'utf8')).toContain('PROPOSAL')
    expect(fs.readFileSync(path.join(root, 'images/b.png'), 'utf8')).toBe('PNG-B')
    expect(fs.existsSync(path.join(root, 'images/link.png'))).toBe(false)
    // a second copy: never an overwrite
    const again = await run('alice', chat, copy(['users/alice/proposal'], 'chat:work/in/'))
    expect(again.content).toContain('chat:work/in/proposal (2)')
    // list, glob and grep take chat:work/ (names only, nothing followed)
    const l = await run('alice', chat, fake({ tool: 'list', args: { path: 'chat:work/in/proposal' }, sayResult: true }))
    expect(l.content).toContain('chat:work/in/proposal/images/')
    expect(l.content).toContain('chat:work/in/proposal/proposal.html (')
    const g = await run('alice', chat, fake({ tool: 'glob', args: { pattern: '**/*.png', path: 'chat:work/in/proposal' }, sayResult: true }))
    expect(g.content).toContain('chat:work/in/proposal/images/a.png')
    const s = await run('alice', chat, fake({ tool: 'grep', args: { pattern: 'PROPOSAL', path: 'chat:work/', output_mode: 'content' }, sayResult: true }))
    expect(s.content).toContain('chat:work/in/proposal/proposal.html:1:')
    expect(s.content).not.toContain(base)
  })

  test('a shared chat: the asker\'s own folder asks the shared read card; no = nothing copied', async () => {
    const chat = await shared()
    const r = await run('alice', chat, copy(['users/alice/proposal'], 'chat:work/in/'), () => 'skip')
    expect(r.cards.length).toBe(1)
    expect(r.content).toContain('Not read')
    expect(fs.existsSync(path.join(devenvPaths(base).workShared, chat))).toBe(false)
  })

  test('yes: a y group in the answer and under the workspace key; a later read, list and grep record it again; a newcomer is warned', async () => {
    const chat = await shared()
    const r = await run('alice', chat, copy(['users/alice/proposal'], 'chat:work/in/'), shareYes)
    expect(r.cards.length).toBe(1)
    expect(r.content).toContain('Everyone in this chat sees what is made from it')
    const root = sharedWork(chat)
    expect(fs.existsSync(path.join(root, 'in/proposal/images/a.png'))).toBe(true)
    expect(ys(r.messageId).some((g) => g.s.some((s) => s.type === 'user' && (s as { id: string }).id === 'alice'))).toBe(true)
    const kept = copiedInOf(chat, root)
    expect(kept.length).toBe(1)
    expect(kept[0]!.s).toContainEqual({ type: 'user', id: 'alice' })
    // erin's turn a day later: a read, a list and a grep of the copy carry the same group
    for (const d of [{ tool: 'read', args: { file_path: 'chat:work/in/proposal/proposal.html' } }, { tool: 'list', args: { path: 'chat:work/in' } }, { tool: 'grep', args: { pattern: 'PROPOSAL', path: 'chat:work/' } }]) {
      const e = await run('erin', chat, fake({ ...d, sayResult: true }))
      expect(e.cards).toHaveLength(0)
      expect(ys(e.messageId).some((g) => g.s.some((s) => s.type === 'user' && (s as { id: string }).id === 'alice')), d.tool).toBe(true)
    }
    const list = await h.api('alice').call(API.wideningAnswers, { body: { target: { kind: 'chat', chatId: chat }, add: [{ subjectType: 'user', subjectId: 'bob' }] } })
    expect(list.items.map((i) => i.messageId)).toContain(r.messageId)
  })

  test('a folder with a sub-folder under its own rules: that folder is a source too (the card asks for it)', async () => {
    const db = h.ctx.db
    db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, 1)').run('f_mk_budget', 'groups/marketing/campaign/budget')
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, 'f_mk_budget', 'everyone', NULL, 'none')").run(crypto.randomUUID())
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, 'f_mk_budget', 'user', 'alice', 'write')").run(crypto.randomUUID())
    w('groups/marketing/campaign/plan.md', '# plan')
    w('groups/marketing/campaign/budget/numbers.csv', 'a,1')
    try {
      const chat = await shared()
      const r = await run('alice', chat, copy(['groups/marketing/campaign'], 'chat:work/'), shareYes)
      // everyone here reads groups/marketing; only the budget folder asks
      expect(r.cards.length).toBe(1)
      const root = sharedWork(chat)
      expect(fs.existsSync(path.join(root, 'campaign/budget/numbers.csv'))).toBe(true)
      const s = copiedInOf(chat, root)[0]!.s
      expect(s.length).toBeGreaterThan(1)
    } finally {
      db.query("DELETE FROM folder_rules WHERE folder_id = 'f_mk_budget'").run()
      db.query("DELETE FROM folders WHERE id = 'f_mk_budget'").run()
    }
  })

  test('limits: over what the answer may still write, nothing is copied', async () => {
    const chat = await personal()
    const prev = h.ctx.engineConfig.maxFilesWrittenPerTurn
    h.ctx.engineConfig.maxFilesWrittenPerTurn = 2
    try {
      const r = await run('alice', chat, copy(['users/alice/proposal'], 'chat:work/in/'))
      expect(r.content).toContain('more files than this answer may still write')
      expect(fs.existsSync(path.join(chatWork(base, chat), 'in/proposal'))).toBe(false)
    } finally { h.ctx.engineConfig.maxFilesWrittenPerTurn = prev }
  })
})

describe('out of chat:work/', () => {
  test('→ chat:files/ in a shared chat: attached to the answer; erin opens it; save_work_file gives the same', async () => {
    const chat = await shared()
    await run('alice', chat, copy(['groups/marketing/brief.csv'], 'chat:work/'))
    const r = await run('alice', chat, copy(['chat:work/brief.csv'], 'chat:files/'))
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain('Attached chat:work/brief.csv to your answer')
    const att = r.attachments.find((a) => a.name === 'brief.csv')!
    expect(att).toMatchObject({ source: 'chat', origin: 'ai' })
    expect((await h.req('erin', `/api/chats/${chat}/files/${att.id}`)).status).toBe(200)
    const old = await run('alice', chat, fake({ tool: 'save_work_file', args: { path: '$TRINA_WORK/brief.csv' }, sayResult: true }))
    expect(old.content).toContain('Attached $TRINA_WORK/brief.csv to your answer')
    expect(old.attachments.find((a) => a.name === 'brief.csv')).toMatchObject({ source: 'chat', origin: 'ai', size: att.size })
  })

  test('→ users/<me>/ in a personal chat: no card; → a wider folder: the wider-audience card; save_work_file the same', async () => {
    const chat = await personal()
    await run('alice', chat, copy(['users/alice/proposal/proposal.html'], 'chat:work/out/'))
    const mine = await run('alice', chat, copy(['chat:work/out/proposal.html'], 'users/alice/decks/'))
    expect(mine.cards).toHaveLength(0)
    expect(fs.readFileSync(team('users/alice/decks/proposal.html'), 'utf8')).toContain('PROPOSAL')
    fs.mkdirSync(team('shared/pc'), { recursive: true })
    const wide = await run('alice', chat, copy(['chat:work/out/proposal.html'], 'shared/pc/'), () => 'skip')
    expect(wide.cards.length).toBe(1)
    expect(fs.existsSync(team('shared/pc/proposal.html'))).toBe(false)
    const old = await run('alice', chat, fake({ tool: 'save_work_file', args: { path: 'out/proposal.html', save_as: 'shared/pc/' }, sayResult: true }), () => 'skip')
    expect(old.cards.length).toBe(1)
    expect(fs.existsSync(team('shared/pc/proposal.html'))).toBe(false)
  })

  test('a work-folder folder is not copied out (zip it first); a work file into chat:work/ is a box_shell cp', async () => {
    const chat = await personal()
    await run('alice', chat, copy(['users/alice/proposal'], 'chat:work/'))
    const r = await run('alice', chat, copy(['chat:work/proposal'], 'users/alice/'))
    expect(r.content).toContain('zip it')
    const s = await run('alice', chat, copy(['chat:work/proposal/proposal.html'], 'chat:work/x/'))
    expect(s.content).toContain('box_shell')
  })
})

describe('chat:files/', () => {
  test('a team file → chat:files/ attaches (the shared read card asks first for the asker\'s own file); a folder is refused', async () => {
    const chat = await shared()
    const r = await run('alice', chat, copy(['users/alice/proposal/proposal.html'], 'chat:files/'), shareYes)
    expect(r.cards.length).toBe(1)
    expect(r.attachments.find((a) => a.name === 'proposal.html')).toMatchObject({ source: 'chat', origin: 'ai' })
    expect(ys(r.messageId).length).toBeGreaterThan(0)
    const f = await run('alice', chat, copy(['groups/marketing'], 'chat:files/'))
    expect(f.content).toContain('chat files have no folders')
  })

  test('a chat file → chat:work/ and → a team folder; save_chat_file gives the same copy', async () => {
    const chat = await shared()
    const up = await upload('alice', chat, 'notes.csv', 'k,v\na,1\n')
    await run('alice', chat, fake({ say: 'ok' }), () => 'skip', [up.id])
    const p = chatFilePath(up.id, 'notes.csv')
    const intoWork = await run('erin', chat, copy([p], 'chat:work/in/'))
    expect(intoWork.cards).toHaveLength(0)
    expect(fs.readFileSync(path.join(sharedWork(chat), 'in/notes.csv'), 'utf8')).toBe('k,v\na,1\n')
    const out = await run('erin', chat, copy([p], 'users/erin/'))
    expect(out.content).toContain('users/erin/notes.csv')
    const old = await run('erin', chat, fake({ tool: 'save_chat_file', args: { file: up.id, save_as: 'users/erin/old/' }, sayResult: true }))
    expect(old.content).toContain('Saved a copy of "notes.csv" from this chat as users/erin/old/notes.csv')
    expect(fs.readFileSync(team('users/erin/old/notes.csv'))).toEqual(fs.readFileSync(team('users/erin/notes.csv')))
    // query_data takes the chat file and the work file
    const q = await run('erin', chat, fake({ tool: 'query_data', args: { paths: [p], sql: 'SELECT COUNT(*) AS n FROM data' }, sayResult: true }))
    expect(q.content).not.toContain('does not take')
    expect(q.content).toMatch(/\b1\b/)
    const qw = await run('erin', chat, fake({ tool: 'query_data', args: { paths: ['chat:work/in/notes.csv'], sql: 'SELECT k FROM data' }, sayResult: true }))
    expect(qw.content).toContain('k')
    expect(qw.content).not.toContain('does not take')
  })

  test('the k refusal: a chat file carried only by a hidden answer is not copied anywhere', async () => {
    const chat = await shared()
    // an answer the AI attached a file to, then marked as a connection's answer hidden from people added later (k)
    await run('alice', chat, copy(['groups/marketing/brief.csv'], 'chat:work/'))
    const a = await run('alice', chat, copy(['chat:work/brief.csv'], 'chat:files/'))
    const att = a.attachments.find((x) => x.name === 'brief.csv')!
    setAnswerReads(h.ctx.db, chat, a.messageId, [{ c: ['alice', 'erin'], s: [{ type: 'integration', id: 'x' }], k: 1 }])
    const r = await run('alice', chat, copy([chatFilePath(att.id, att.name)], 'chat:work/k/'))
    expect(r.content).toContain('kept from some people who may join')
    expect(fs.existsSync(path.join(sharedWork(chat), 'k'))).toBe(false)
    const t = await run('alice', chat, copy([chatFilePath(att.id, att.name)], 'users/alice/'))
    expect(t.content).toContain('kept from some people who may join')
    expect(fs.existsSync(team('users/alice/brief.csv'))).toBe(false)
  })

  test('a shared project chat: chat:files/ and chat:work/ are not save places (the project folder is)', async () => {
    const p = await h.api('alice').call(API.createProject, { body: { name: 'PC Proj', instructions: '', participants: [{ subjectType: 'group', subjectId: 'marketing' }] } })
    await h.api('alice').call(API.updateProject, { params: { id: p.id }, body: { shareChats: true } })
    const chat = await h.api('alice').call(API.createChat, { body: { projectId: p.id } })
    for (const to of ['chat:files/', 'chat:work/in/']) {
      const r = await run('alice', chat.id, copy(['users/alice/proposal/proposal.html'], to))
      expect(r.content).toContain("files are saved in the project's folder")
      expect(r.attachments ?? []).toHaveLength(0)
    }
  })

  test('a personal chat: chat:files/ is no save place there', async () => {
    const chat = await personal()
    const r = await run('alice', chat, copy(['users/alice/proposal/proposal.html'], 'chat:files/'))
    expect(r.content).toContain('save it in My files')
    // a chat made private again (QA TC-6959): the refusal says nothing is attached here and a file there is just linked
    expect(r.content).toContain('files are not attached to the chat')
    expect(r.content).toContain('link it in the answer; a file already there needs nothing more')
  })
})

describe('review of P2 (adversarial)', () => {
  test('copy_files ["users"] (or "users/") into a shared chat\'s chat:work/ asks for the asker\'s own folder; no = nothing copied', async () => {
    for (const top of ['users', 'users/']) {
      const chat = await shared()
      const r = await run('alice', chat, copy([top], 'chat:work/in/'), () => 'skip')
      // before the fix: no card, users/alice/secret.txt landed in the shared work folder, recorded only as the name "users"
      expect(r.cards.length, top).toBe(1)
      expect(fs.existsSync(path.join(devenvPaths(base).workShared, chat))).toBe(false)
      const y = await run('alice', chat, copy([top], 'chat:work/in/'), shareYes)
      expect(y.cards.length, top).toBe(1)
      expect(copiedInOf(chat, sharedWork(chat))[0]!.s).toContainEqual({ type: 'user', id: 'alice' })
    }
  })

  test('grep of chat:work/ runs the pattern in ripgrep: a backtracking pattern over a long line does not stop the server', async () => {
    // (the server's own regex engine gives up on each such line after seconds: 15 lines held the whole server for most of
    // a minute before the fix)
    w('users/alice/long/aaa.txt', `${('a'.repeat(200) + 'b\n').repeat(15)}PLAIN line\n`)
    const chat = await personal()
    await run('alice', chat, copy(['users/alice/long'], 'chat:work/'))
    const t = Date.now()
    const s = await run('alice', chat, fake({ tool: 'grep', args: { pattern: '(a+)+$', path: 'chat:work/' }, sayResult: true }))
    expect(Date.now() - t).toBeLessThan(20_000)
    expect(s.content).toContain('No matches found')
    const c = await run('alice', chat, fake({ tool: 'grep', args: { pattern: 'plain', '-i': true, path: 'chat:work/', output_mode: 'content' }, sayResult: true }))
    expect(c.content).toContain('chat:work/long/aaa.txt:16:PLAIN line')
    const bad = await run('alice', chat, fake({ tool: 'grep', args: { pattern: '(', path: 'chat:work/' }, sayResult: true }))
    expect(bad.content).toContain('Invalid regular expression')
  })
})

// QA TC-f2-c02: one chart request in a room's ✦ side chat raised three cards (a command twice, the copy into my folder).
// A copy of what it made into my own folder as a new file goes without a card; the command keeps the room card (a room
// message could steer it to change my own files, which runs keep no versions of yet: owner 11-22,
// docs/decisions/20261122-ask-less-side-chat-runs.md); an overwrite in my folder and a team folder ask.
describe('after a room read: the side chat makes a chart (QA TC-f2-c02)', () => {
  /** alice's own chat that has read a room (chats.rooms_seen, as room_read leaves it; a ✦ side chat counts the same,
   * chat/read-rooms.ts readRooms) */
  async function side() {
    const chat = await personal()
    h.ctx.db.query('UPDATE chats SET rooms_seen = 1, session_tainted = 1 WHERE id = ?').run(chat)
    return chat
  }
  const chart = `cd "$TRINA_WORK" && python3 - <<'EOF'\nimport matplotlib.pyplot as plt\nplt.bar(['a'],[1])\nplt.savefig('out/chart.png')\nEOF`
  const made = (chat: string, name: string) => { const p = path.join(chatWork(base, chat), 'out', name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'PNG-CHART') }

  test('the command keeps the room card in plain words; the copy into users/<me>/ asks nothing; the step says why', async () => {
    const chat = await side()
    const ran = await run('alice', chat, fake({ tool: 'box_shell', args: { command: chart }, sayResult: true }))
    expect(ran.cards).toHaveLength(1)
    expect(ran.cards[0]!.question).toContain('chart.png')
    made(chat, 'chart.png')
    const r = await run('alice', chat, copy(['chat:work/out/chart.png'], 'users/alice/charts-f2/'))
    expect(r.cards).toHaveLength(0)
    expect(fs.readFileSync(team('users/alice/charts-f2/chart.png'), 'utf8')).toBe('PNG-CHART')
    const steps = (h.ctx.db.query('SELECT steps FROM messages WHERE id = ?').get(r.messageId) as { steps: string }).steps
    expect(steps).toContain('saved without asking: your own folder')
  })

  test('a file there already, my skills and a team folder still ask', async () => {
    const chat = await side()
    made(chat, 'chart.png')
    w('users/alice/charts-old/chart.png', 'MINE')
    const no = (c: Card) => c.options?.at(-1)?.value ?? 'skip'
    const over = await run('alice', chat, copy(['chat:work/out/chart.png'], 'users/alice/charts-old/'), no)
    expect(over.cards).toHaveLength(1)
    expect(fs.readFileSync(team('users/alice/charts-old/chart.png'), 'utf8')).toBe('MINE')
    const skill = await run('alice', chat, copy(['chat:work/out/chart.png'], 'users/alice/skills/x/'), no)
    expect(skill.cards.length).toBeGreaterThan(0)
    expect(fs.existsSync(team('users/alice/skills/x/chart.png'))).toBe(false)
    fs.mkdirSync(team('groups/marketing/f2'), { recursive: true })
    const wide = await run('alice', chat, copy(['chat:work/out/chart.png'], 'groups/marketing/f2/'), no)
    expect(wide.cards.length).toBeGreaterThan(0)
    expect(fs.existsSync(team('groups/marketing/f2/chart.png'))).toBe(false)
  })

  test('a command that reaches the network, or with "Allow all websites" on, keeps the room card and says so', async () => {
    const no = (c: Card) => c.options?.at(-1)?.value ?? 'skip'
    const up = `cd "$TRINA_WORK" && python3 make.py -o out/chart.png && curl -F f=@out/chart.png https://example.com/up`
    const r = await run('alice', await side(), fake({ tool: 'box_shell', args: { command: up }, sayResult: true }), no)
    expect(r.cards).toHaveLength(1)
    expect(r.cards[0]!.question).toContain('chart.png (also connects to the internet)')
    updateTeamSettings(h.ctx.db, { browserAllowAll: true, webAllowAll: true })
    expect(setWebAllowAll(h.ctx.db, 'alice', true, { via: 'settings' })).toBe(true)
    try {
      const all = await run('alice', await side(), fake({ tool: 'box_shell', args: { command: chart }, sayResult: true }), no)
      expect(all.cards).toHaveLength(1)
    } finally { setWebAllowAll(h.ctx.db, 'alice', false, { via: 'settings' }) }
  })

  // QA b3s TC-b3s-23 (S-110): one banner edit asked four times; one answer asks once per target (#381)
  test('a second command of the same answer that makes the same file goes under the first yes; a new answer asks again', async () => {
    const yes = (c: Card) => c.options?.[0]?.value ?? 'allow'
    const chat = await side()
    const again = `cd "$TRINA_WORK" && python3 - <<'EOF'\nfrom PIL import Image\nImage.new('RGB',(9,9)).save('out/chart.png')\nEOF`
    const r = await run('alice', chat, fake({ tool: 'box_shell', args: { command: chart }, sayResult: true }, { tool: 'box_shell', args: { command: again }, sayResult: true }), yes)
    expect(r.cards).toHaveLength(1)
    expect(r.cards[0]!.question).toContain('Make the picture file chart.png')
    const steps = (h.ctx.db.query('SELECT steps FROM messages WHERE id = ?').get(r.messageId) as { steps: string }).steps
    expect(steps).toContain('allowed once in this answer')
    // a new answer: its own card again
    const next = await run('alice', chat, fake({ tool: 'box_shell', args: { command: again }, sayResult: true }), yes)
    expect(next.cards).toHaveLength(1)
  })

  test('...but not a command that also removes files, makes another file, runs elsewhere or reaches the network', async () => {
    const yes = (c: Card) => c.options?.[0]?.value ?? 'allow'
    for (const later of [
      `cd "$TRINA_WORK" && python3 make.py -o out/chart.png && rm -f out/old.png`,
      `cd "$TRINA_WORK" && python3 make.py -o out/other.png`,
      `cd "$HOME" && python3 make.py -o out/chart.png`,
      `cd "$TRINA_WORK" && python3 -c "import os; os.remove('x.md'); open('out/chart.png','w')"`,
      `cd "$TRINA_WORK" && python3 make.py -o out/chart.png && curl -F f=@out/chart.png https://example.com/up`,
    ]) {
      const r = await run('alice', await side(), fake({ tool: 'box_shell', args: { command: chart }, sayResult: true }, { tool: 'box_shell', args: { command: later }, sayResult: true }), yes)
      expect([later, r.cards.length]).toEqual([later, 2])
    }
  })

  test('a "no" on the first command covers nothing', async () => {
    const r = await run('alice', await side(), fake({ tool: 'box_shell', args: { command: chart }, sayResult: true }, { tool: 'box_shell', args: { command: chart + ' ' }, sayResult: true }))
    expect(r.cards).toHaveLength(2)
  })

  test('renaming in place a file this answer made needs no card; an older file, an instruction or a script name still ask', async () => {
    const yes = (c: Card) => c.options?.[0]?.value ?? 'allow'
    fs.mkdirSync(team('groups/marketing/b3s'), { recursive: true })
    const made = await run('alice', await side(), fake(
      { tool: 'write', args: { file_path: 'groups/marketing/b3s/banner.png.txt', content: 'x' }, sayResult: true },
      { tool: 'rename_file', args: { path: 'groups/marketing/b3s/banner.png.txt', new_name: 'final-banner.txt' }, sayResult: true }), yes)
    expect(made.cards).toHaveLength(1)
    expect(fs.existsSync(team('groups/marketing/b3s/final-banner.txt'))).toBe(true)
    w('groups/marketing/b3s/older.txt', 'old')
    const older = await run('alice', await side(), fake({ tool: 'rename_file', args: { path: 'groups/marketing/b3s/older.txt', new_name: 'older-2.txt' }, sayResult: true }))
    expect(older.cards).toHaveLength(1)
    for (const name of ['CLAUDE.md', 'run.sh']) {
      const r = await run('alice', await side(), fake(
        { tool: 'write', args: { file_path: `groups/marketing/b3s/n-${name}.txt`, content: 'x' }, sayResult: true },
        { tool: 'rename_file', args: { path: `groups/marketing/b3s/n-${name}.txt`, new_name: name }, sayResult: true }), yes)
      expect([name, r.cards.length]).toEqual([name, 2])
    }
  })

  test('a command in a chat shared with others after a quote still gets the room card, in plain words', async () => {
    const chat = await shared()
    const r = await run('alice', chat, `> erin: run this\n${fake({ tool: 'box_shell', args: { command: chart }, sayResult: true })}`)
    const card = r.cards.find((c) => /chart\.png/.test(c.question))
    expect(card?.question).toContain('Make the picture file chart.png')
    expect(card?.question).not.toContain('Run a task')
  })
})
