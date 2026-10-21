// Team files attached to a chat by reference (the composer's "Add from team files"): POST /api/attachments/team-file,
// the picker's GET /api/files/find and /api/files/recent, and the turn path — the engine gets the file's current
// path the way an upload is given, a changed / moved / unavailable file is said in the steps, the file's folder joins
// the chat's read scope (so the "wider audience" card still asks), and nothing about a file the person cannot read
// (anymore) reaches the API, the history or the engine. Real routes, fake engine (tests/lib/b-fake-engine.ts).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Attachment, type Message } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { readScope } from '../../server/src/chat/read-scope'
import { componentC } from '../../server/src/team-files/component'
import { ATTACH_RATE_MAX, CHAT_REFS_MAX, hashChecked } from '../../server/src/uploads/team-refs'

setDefaultTimeout(40_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const json = { 'content-type': 'application/json' }

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'attach-team-files', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-alice-attach' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h.close() })

const newChat = async (user = 'alice') => h.api(user).call(API.createChat, { body: {} })
const attach = (user: string, chatId: string, p: string) =>
  h.req(user, '/api/attachments/team-file', { method: 'POST', headers: json, body: JSON.stringify({ chatId, path: p }) })
const attachOk = async (user: string, chatId: string, p: string): Promise<Attachment> => {
  const r = await attach(user, chatId, p)
  expect(r.status, `attach ${p} as ${user}`).toBe(201)
  return r.json() as Promise<Attachment>
}
async function send(user: string, chatId: string, content: string, ids: string[], sock: TestSocket = alice) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: ids } })
  const d = await sock.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  return { started: r, done: d.data.message as Message }
}
const messages = async (user: string, chatId: string) => {
  const r = await h.req(user, `/api/chats/${chatId}/messages`)
  return { text: await r.clone().text(), body: (await r.json()) as { items: Message[] } }
}
/** an error body without its per-request id */
const norm = (t: string) => t.replace(/"requestId":"[^"]*"/, '"requestId":"-"')
const write = (rel: string, s: string) => { const p = path.join(h.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }

describe('attach endpoint: only files the person can read, everything else the same 404', () => {
  test('a readable file becomes a reference (no copy), with its hash', async () => {
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'groups/marketing/campaign-brief.md')
    expect(a).toMatchObject({ source: 'team', path: 'groups/marketing/campaign-brief.md', name: 'campaign-brief.md', kind: 'text' })
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.existsSync(path.join(h.team, 'users/alice/.attachments', chat.id))).toBe(false)
  })

  test('missing, hidden, private, server, hard-linked, folder and look-alike paths answer exactly like a missing file', async () => {
    const chat = await newChat()
    const missing = await attach('alice', chat.id, 'shared/does-not-exist.md')
    expect(missing.status).toBe(404)
    const base = norm(await missing.text())
    const probes = [
      'groups/finance/budget.md', // another group's folder
      'groups/marketing/salaries/2026.md', // a 'none' rule inside her own group
      'users/bob/notes.md', // someone else's personal folder
      'users/alice/audit-copy.md', // her own folder, but a hard link to a finance file
      '.system/history/old.bin', // server folder
      'CLAUDE.md', // team root (owner / admins only)
      'users/ALICE/notes.md', 'groups/Marketing/hr-private.md', 'GROUPS/finance/budget.md', // case look-alikes
      'groups/marketing', 'shared', // folders
      'shared/../groups/finance/budget.md'.replace('/../', '/x/../'), // not a real path either way
      'groups/finance/missing.md', // missing inside a hidden folder
    ]
    for (const p of probes) {
      const r = await attach('alice', chat.id, p)
      const text = norm(await r.text())
      if (r.status === 400) { expect(text, p).not.toContain('CANARY'); continue } // syntax (..) is refused before any lookup
      expect({ p, status: r.status, text }).toEqual({ p, status: 404, text: base })
    }
    // the owner and admins cannot attach from a personal folder or the server folder either
    const dchat = await newChat('dana')
    const dmissing = norm(await (await attach('dana', dchat.id, 'shared/nope.md')).text())
    for (const p of ['users/alice/todo.md', 'users/bob/notes.md', '.system/history/old.bin']) {
      const r = await attach('dana', dchat.id, p)
      expect({ p, status: r.status, text: norm(await r.text()) }).toEqual({ p, status: 404, text: dmissing })
    }
  })

  test("another person's chat is refused (no file looked at)", async () => {
    const chat = await newChat('alice')
    const r = await attach('bob', chat.id, 'shared/glossary.md')
    expect(r.status).toBe(404)
  })

  test("a reference can only be sent in its own person's chat", async () => {
    const chat = await newChat('alice')
    const a = await attachOk('alice', chat.id, 'shared/glossary.md')
    const bobChat = await newChat('bob')
    const r = await h.req('bob', `/api/chats/${bobChat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ content: 'x', clientMessageId: cm(), attachmentIds: [a.id] }) })
    expect(r.status).toBe(400)
    // and alice's other chat does not take it either
    const other = await newChat('alice')
    const r2 = await h.req('alice', `/api/chats/${other.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ content: 'x', clientMessageId: cm(), attachmentIds: [a.id] }) })
    expect(r2.status).toBe(400)
  })
})

describe('picker listings', () => {
  test('find by name shows only readable files', async () => {
    const find = async (user: string, q: string) => {
      const r = await h.req(user, `/api/files/find?q=${encodeURIComponent(q)}`)
      expect(r.status).toBe(200)
      return ((await r.json()) as { items: { path: string }[] }).items.map((i) => i.path)
    }
    expect(await find('alice', 'budget')).toEqual([])
    expect(await find('bob', 'budget')).toContain('groups/finance/budget.md')
    const audit = await find('alice', 'audit')
    expect(audit).not.toContain('users/alice/audit-copy.md') // hard link
    expect(audit).not.toContain('groups/finance/audit-notes.md')
    expect(await find('alice', 'campaign-brief')).toEqual(['groups/marketing/campaign-brief.md'])
    expect(await find('alice', '2026')).not.toContain('groups/marketing/salaries/2026.md')
    expect(await find('dana', 'notes')).not.toContain('users/bob/notes.md')
    expect((await find('dana', 'old.bin')).length).toBe(0)
    // NFC/NFD and case do not matter for the search itself
    expect(await find('bob', '급여메모'.normalize('NFD'))).toContain('users/bob/급여메모.md')
    expect(await find('carol', 'BUDGET')).toContain('groups/finance/budget.md')
    // a folder the caller cannot list is "not found"
    expect((await h.req('alice', '/api/files/find?q=budget&path=groups%2Ffinance')).status).toBe(404)
  })

  test('recent files are filtered by who may read them now', async () => {
    await h.api('bob').call(API.saveContent, { body: { path: 'groups/finance/recent-fin.md', content: 'fin', baseSha256: null } })
    await h.api('alice').call(API.saveContent, { body: { path: 'shared/recent-shared.md', content: 'shared', baseSha256: null } })
    const recent = async (user: string) => ((await (await h.req(user, '/api/files/recent?limit=50')).json()) as { items: { path: string }[] }).items.map((i) => i.path)
    const a = await recent('alice')
    expect(a).toContain('shared/recent-shared.md')
    expect(a).not.toContain('groups/finance/recent-fin.md')
    expect(await recent('bob')).toContain('groups/finance/recent-fin.md')
    expect(await recent('erin')).not.toContain('groups/finance/recent-fin.md')
  })
})

describe('the turn path', () => {
  test('the engine gets the current path like an upload; the folder joins the read scope', async () => {
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'groups/marketing/campaign-brief.md')
    const { started, done } = await send('alice', chat.id, fake({ echo: 'message' }, { tool: 'read', args: { file_path: a.path }, sayResult: true }), [a.id])
    expect(started.userMessage!.attachments[0]).toMatchObject({ id: a.id, source: 'team', path: a.path })
    expect(done.content).toContain(`- groups/marketing/campaign-brief.md (campaign-brief.md, text/markdown, ${a.size} bytes; from the team folder)`)
    expect(done.content).toContain('Autumn Upgrade') // the read tool, with the person's own access
    expect(readScope(h.ctx.db, chat.id)).toContainEqual({ type: 'folder', id: 'f_groups_marketing' })
  })

  test('the read scope makes saving into a wider folder ask first (the attachment alone, no read by the AI)', async () => {
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'groups/marketing/campaigns/naver-plan.md')
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'write', args: { file_path: 'shared/naver-copy.md', content: 'copied' } }, { say: 'ok' }), clientMessageId: cm(), attachmentIds: [a.id] } })
    const card = await alice.next('turn.request', (f) => f.data.turnId === r.turnId, 20_000)
    expect(card.data.request.kind).toBe('ask_user')
    expect(JSON.stringify(card.data.request)).toContain('shared/naver-copy.md')
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'skip' } })
    await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(fs.existsSync(path.join(h.team, 'shared/naver-copy.md'))).toBe(false)
  })

  test('a file changed after attaching: the current version, said in the steps', async () => {
    write('shared/changing.md', 'version one\n')
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'shared/changing.md')
    write('shared/changing.md', 'version two, longer\n')
    const { done } = await send('alice', chat.id, fake({ echo: 'message' }), [a.id])
    expect(done.steps.some((s) => s.tool === 'attachment' && s.label.includes('changed') && s.label.includes('shared/changing.md'))).toBe(true)
    expect(done.content).toContain('it changed after the user attached it')
    // touched but the same content: not "changed"
    write('shared/same.md', 'same\n')
    const b = await attachOk('alice', chat.id, 'shared/same.md')
    const t = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(h.team, 'shared/same.md'), t, t)
    const second = await send('alice', chat.id, fake({ echo: 'message' }), [b.id])
    expect(second.done.content).toContain('- shared/same.md (same.md, text/markdown, 5 bytes; from the team folder)')
  })

  test('moved on the file screen, renamed in Finder, trashed and restored: followed', async () => {
    write('shared/moving/plan.md', 'plan\n')
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'shared/moving/plan.md')
    // moved (its folder) between attaching and sending: the message carries the new place
    await h.api('alice').call(API.move, { body: { from: 'shared/moving', to: 'shared/moved', onExists: 'fail', confirm: false } })
    const one = await send('alice', chat.id, fake({ echo: 'message' }), [a.id])
    // moved, not changed: the two are told apart (the chip says "moved", the engine gets the new place)
    expect(one.started.userMessage!.attachments[0]).toMatchObject({ path: 'shared/moved/plan.md', moved: true })
    expect(one.started.userMessage!.attachments[0]!.changed).toBeUndefined()
    expect(one.done.content).not.toContain('it changed after the user attached it')
    expect(one.done.content).toContain('it was moved or renamed after the user attached it')
    expect(one.done.content).toContain('- shared/moved/plan.md (plan.md')
    // moved after sending: the next turn on that message follows it and says so
    await h.api('alice').call(API.move, { body: { from: 'shared/moved/plan.md', to: 'shared/plan-moved.md', onExists: 'fail', confirm: false } })
    const re = await h.api('alice').call(API.regenerate, { params: { id: chat.id, messageId: one.started.assistantMessage.id }, body: {} })
    const d = (await alice.next('message.done', (f) => f.data.messageId === re.assistantMessage.id, 30_000)).data.message as Message
    expect(d.content).toContain('- shared/plan-moved.md (plan-moved.md')
    expect(d.steps.some((s) => s.tool === 'attachment' && s.label === 'Attached file moved · shared/plan-moved.md')).toBe(true)
    await h.api('alice').call(API.move, { body: { from: 'shared/plan-moved.md', to: 'shared/moved/plan.md', onExists: 'fail', confirm: false } })
    // a rename that leaves no event (the Mac's Finder): same inode in the same folder
    fs.renameSync(path.join(h.team, 'shared/moved/plan.md'), path.join(h.team, 'shared/moved/plan-final.md'))
    const m = await messages('alice', chat.id)
    expect(m.body.items.find((x) => x.role === 'user')!.attachments[0]).toMatchObject({ path: 'shared/moved/plan-final.md', moved: true })
    // trash and restore
    const del = await h.api('alice').call(API.remove, { query: { path: 'shared/moved/plan-final.md' } })
    expect((await messages('alice', chat.id)).body.items.find((x) => x.role === 'user')!.attachments[0]).toMatchObject({ unavailable: true, name: '', path: '' })
    await h.api('alice').call(API.restoreTrash, { params: { id: del.trashId } })
    expect((await messages('alice', chat.id)).body.items.find((x) => x.role === 'user')!.attachments[0]).toMatchObject({ path: 'shared/moved/plan-final.md' })
  })

  test('access taken away: the history, the engine, a resend and the thumbnail learn nothing about the file', async () => {
    write('shared/secret-plan-XQ7.png', 'not really a png')
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'shared/secret-plan-XQ7.png')
    const first = await send('alice', chat.id, 'look ' + fake({ say: 'ok' }), [a.id])
    expect(first.started.userMessage!.attachments[0]!.name).toBe('secret-plan-XQ7.png')
    // the file moves into finance (alice cannot read there)
    await h.api('dana').call(API.move, { body: { from: 'shared/secret-plan-XQ7.png', to: 'groups/finance/secret-plan-XQ7.png', onExists: 'fail', confirm: false } })
    const m = await messages('alice', chat.id)
    expect(m.text).not.toContain('secret-plan-XQ7')
    expect(m.text).not.toContain('groups/finance')
    expect(m.body.items.find((x) => x.role === 'user')!.attachments[0]).toEqual({ id: a.id, name: '', path: '', size: 0, mime: 'application/octet-stream', kind: 'other', source: 'team', unavailable: true })
    // the realtime copy of the message (message.created on the next send) is blanked the same way
    const resend = await h.req('alice', `/api/chats/${chat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ content: 'again', clientMessageId: cm(), attachmentIds: [a.id] }) })
    expect(resend.status).toBe(400)
    expect(await resend.text()).not.toContain('secret-plan')
    expect((await h.req('alice', `/api/uploads/${a.id}/thumbnail`)).status).toBe(404)
  })

  test('unavailable at turn time: a step, and the engine gets no name or path', async () => {
    write('shared/vanishing-KP2.md', 'gone soon\n')
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'shared/vanishing-KP2.md')
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ echo: 'message' }), clientMessageId: cm(), attachmentIds: [a.id] } })
    await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    // moved out of reach after sending: the next turn on that message (regenerate) checks again
    await h.api('dana').call(API.move, { body: { from: 'shared/vanishing-KP2.md', to: 'groups/finance/vanishing-KP2.md', onExists: 'fail', confirm: false } })
    const re = await h.api('alice').call(API.regenerate, { params: { id: chat.id, messageId: r.assistantMessage.id }, body: {} })
    const d = (await alice.next('message.done', (f) => f.data.messageId === re.assistantMessage.id, 30_000)).data.message as Message
    expect(d.content).not.toContain('vanishing-KP2')
    expect(d.content).not.toContain('groups/finance')
    expect(d.content).toContain('no longer available')
    expect(d.steps.some((s) => s.tool === 'attachment' && s.status === 'ok' && s.label === 'An attached team file is no longer available')).toBe(true)
    expect(JSON.stringify(d.steps)).not.toContain('vanishing')
  })

  test('the earlier messages in a fresh session carry only what the person can read now', async () => {
    write('shared/hist-ZZ9.md', 'hist\n')
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'shared/hist-ZZ9.md')
    await send('alice', chat.id, 'first ' + fake({ say: 'ok' }), [a.id])
    await h.api('dana').call(API.move, { body: { from: 'shared/hist-ZZ9.md', to: 'groups/finance/hist-ZZ9.md', onExists: 'fail', confirm: false } })
    // switching the engine starts a fresh session with the branch history
    const two = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ echo: 'history' }), clientMessageId: cm(), attachmentIds: [], engine: 'codex' } })
    const d = (await alice.next('message.done', (f) => f.data.messageId === two.assistantMessage.id, 30_000)).data.message as Message
    expect(d.content).not.toContain('hist-ZZ9')
  })

  test('a chat title never comes from a team file name', async () => {
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'shared/glossary.md')
    await send('alice', chat.id, '', [a.id])
    const c = await h.api('alice').call(API.getChat, { params: { id: chat.id } })
    expect(c.title).not.toContain('glossary')
  })
})

// ---------------- review fixes (attack + UX review of the first version) ----------------
describe('following a reference: any number of file events, remembered, gone states not redone', () => {
  const refs = () => componentC(h.ctx).teamRefs
  const row = (id: string) => h.ctx.db.query('SELECT path, event_id, trash_id, lost FROM team_file_refs WHERE id = ?').get(id) as { path: string; event_id: number; trash_id: string | null; lost: number }
  const flood = (n: number) => {
    const ins = h.ctx.db.query("INSERT INTO file_events (turn_id, user_id, path, action, size, detail) VALUES (NULL, 'dana', ?, 'delete', 0, NULL)")
    h.ctx.db.transaction(() => { for (let i = 0; i < n; i++) ins.run(`shared/flood/${i}.md`) })()
  }

  test('a move after more than 5000 other events is still followed, and sending works', async () => {
    write('shared/flooded/ATK-T13.md', 'x\n')
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'shared/flooded/ATK-T13.md')
    flood(5100)
    await h.api('alice').call(API.move, { body: { from: 'shared/flooded/ATK-T13.md', to: 'shared/ATK-T13-moved.md', onExists: 'fail', confirm: false } })
    const { started } = await send('alice', chat.id, fake({ say: 'ok' }), [a.id])
    expect(started.userMessage!.attachments[0]).toMatchObject({ path: 'shared/ATK-T13-moved.md', moved: true })
    const last = (h.ctx.db.query('SELECT MAX(id) AS n FROM file_events').get() as { n: number }).n
    expect(row(a.id)).toMatchObject({ path: 'shared/ATK-T13-moved.md' })
    expect(row(a.id).event_id).toBeGreaterThanOrEqual(last - 5) // read up to the end of the log, not stuck at the first batch
  })

  test('a trashed file: the place in the log is saved too (the next lookup reads only newer events), restore still followed', async () => {
    write('shared/trash-follow.md', 't\n')
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'shared/trash-follow.md')
    const del = await h.api('alice').call(API.remove, { query: { path: 'shared/trash-follow.md' } })
    flood(2500)
    const sent = await h.req('alice', `/api/chats/${chat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ content: 'x', clientMessageId: cm(), attachmentIds: [a.id] }) })
    expect(sent.status).toBe(400)
    const last = (h.ctx.db.query('SELECT MAX(id) AS n FROM file_events').get() as { n: number }).n
    expect(row(a.id)).toMatchObject({ event_id: last, trash_id: del.trashId })
    await h.api('alice').call(API.restoreTrash, { params: { id: del.trashId } })
    expect(refs().view('alice', a)).toMatchObject({ path: 'shared/trash-follow.md' })
  })

  test('a file deleted outside the app: its folder is searched by inode once, not on every view; the history stays read-only', async () => {
    write('shared/lostdir/gone.md', 'g\n')
    for (let i = 0; i < 50; i++) write(`shared/lostdir/other-${i}.md`, 'o')
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'shared/lostdir/gone.md')
    fs.rmSync(path.join(h.team, 'shared/lostdir/gone.md'))
    const before = row(a.id)
    let lists = 0
    const orig = fs.readdirSync
    ;(fs as { readdirSync: unknown }).readdirSync = (...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]).endsWith('lostdir')) lists++
      return (orig as (...x: unknown[]) => unknown)(...args)
    }
    try {
      for (let i = 0; i < 5; i++) expect(refs().view('alice', a)).toMatchObject({ unavailable: true })
      for (let i = 0; i < 3; i++) await messages('alice', chat.id)
    } finally { (fs as { readdirSync: unknown }).readdirSync = orig }
    expect(lists).toBe(1)
    expect(row(a.id)).toEqual(before) // views (GET) did not write the row
    // it comes back at its place: available again
    write('shared/lostdir/gone.md', 'g\n')
    expect(refs().view('alice', a)).toMatchObject({ path: 'shared/lostdir/gone.md' })
  })
})

describe('the step about an attached file says nothing once the person cannot open it', () => {
  test('moved under a telling name, then out of reach: the stored step loses the path in the history', async () => {
    write('shared/brief-v1.md', 'brief\n')
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'shared/brief-v1.md')
    const one = await send('alice', chat.id, fake({ say: 'ok' }), [a.id])
    await h.api('dana').call(API.move, { body: { from: 'shared/brief-v1.md', to: 'shared/ATK-LAYOFF-PLAN-NAME.md', onExists: 'fail', confirm: false } })
    const re = await h.api('alice').call(API.regenerate, { params: { id: chat.id, messageId: one.started.assistantMessage.id }, body: {} })
    const d = (await alice.next('message.done', (f) => f.data.messageId === re.assistantMessage.id, 30_000)).data.message as Message
    expect(d.steps.find((s) => s.tool === 'attachment')).toMatchObject({ id: `attach-${a.id}`, label: 'Attached file moved · shared/ATK-LAYOFF-PLAN-NAME.md', status: 'ok' })
    await h.api('dana').call(API.move, { body: { from: 'shared/ATK-LAYOFF-PLAN-NAME.md', to: 'groups/finance/ATK-LAYOFF-PLAN-NAME.md', onExists: 'fail', confirm: false } })
    const m = await messages('alice', chat.id)
    expect(m.text).not.toContain('ATK-LAYOFF')
    expect(m.body.items.find((x) => x.id === re.assistantMessage.id)!.steps.find((s) => s.tool === 'attachment')).toMatchObject({ label: 'An attached team file is no longer available', status: 'ok' })
  })
})

describe('sending after access is lost', () => {
  test('the error names the person\'s own unavailable ids (and only those), in team-file words; without them it sends', async () => {
    write('shared/lose-me.md', 'l\n')
    write('shared/keep-me.md', 'k\n')
    const chat = await newChat()
    const gone = await attachOk('alice', chat.id, 'shared/lose-me.md')
    const kept = await attachOk('alice', chat.id, 'shared/keep-me.md')
    await h.api('dana').call(API.move, { body: { from: 'shared/lose-me.md', to: 'groups/finance/lose-me.md', onExists: 'fail', confirm: false } })
    const r = await h.req('alice', `/api/chats/${chat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ content: 'x', clientMessageId: cm(), attachmentIds: [gone.id, kept.id] }) })
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: { message: string; params?: Record<string, string> } }
    expect(body.error.params).toEqual({ reason: 'team_files_unavailable', ids: gone.id })
    expect(body.error.message).toContain('no longer available')
    expect(JSON.stringify(body)).not.toContain('lose-me')
    // an id that is not hers (bob's reference) mixed in: the general answer, nothing named
    const bobChat = await newChat('bob')
    const bobs = await attachOk('bob', bobChat.id, 'shared/keep-me.md')
    const mixed = await h.req('alice', `/api/chats/${chat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ content: 'x', clientMessageId: cm(), attachmentIds: [gone.id, bobs.id] }) })
    expect(((await mixed.json()) as { error: { params?: unknown } }).error.params).toBeUndefined()
    const ok = await send('alice', chat.id, fake({ say: 'ok' }), [kept.id])
    expect(ok.started.userMessage!.attachments.map((x) => x.id)).toEqual([kept.id])
  })
})

describe('attaching costs: same file again, limits, unsent references swept, audit', () => {
  test('the same unchanged file attached again to the same chat gives back its reference (no new row)', async () => {
    write('shared/twice.md', 'same\n')
    const chat = await newChat()
    const a = await attachOk('alice', chat.id, 'shared/twice.md')
    const b = await attachOk('alice', chat.id, 'shared/twice.md')
    expect(b.id).toBe(a.id)
    write('shared/twice.md', 'now different\n')
    const c = await attachOk('alice', chat.id, 'shared/twice.md')
    expect(c.id).not.toBe(a.id)
    expect(c.sha256).not.toBe(a.sha256)
  })

  test('new references per person are rate limited, and per chat capped', async () => {
    const chat = await newChat('erin')
    const ins = h.ctx.db.query("INSERT INTO team_file_refs (id, user_id, chat_id, path, path_at_attach, name, size, mime, kind, sha256, mtime_ms, ino, dev, event_id) VALUES (?, 'erin', ?, 'shared/x', 'shared/x', 'x', 0, 'text/plain', 'text', ?, 0, 0, 0, 0)")
    h.ctx.db.transaction(() => { for (let i = 0; i < ATTACH_RATE_MAX; i++) ins.run(crypto.randomUUID(), chat.id, '0'.repeat(64)) })()
    const r = await attach('erin', chat.id, 'shared/glossary.md')
    expect(r.status).toBe(429)
    h.ctx.db.query("UPDATE team_file_refs SET created_at = '2000-01-01T00:00:00.000Z' WHERE user_id = 'erin'").run()
    h.ctx.db.transaction(() => { for (let i = 0; i < CHAT_REFS_MAX - ATTACH_RATE_MAX; i++) ins.run(crypto.randomUUID(), chat.id, '0'.repeat(64)) })()
    h.ctx.db.query("UPDATE team_file_refs SET created_at = '2000-01-01T00:00:00.000Z' WHERE user_id = 'erin'").run()
    expect((await attach('erin', chat.id, 'shared/glossary.md')).status).toBe(429)
    const other = await newChat('erin')
    expect((await attach('erin', other.id, 'shared/glossary.md')).status).toBe(201)
    h.ctx.db.query("DELETE FROM team_file_refs WHERE user_id = 'erin'").run()
  })

  test('references never sent are swept after a week; sent ones stay', async () => {
    const chat = await newChat()
    const unsent = await attachOk('alice', chat.id, 'shared/glossary.md')
    write('shared/sent-ref.md', 's\n')
    const sentRef = await attachOk('alice', chat.id, 'shared/sent-ref.md')
    await send('alice', chat.id, fake({ say: 'ok' }), [sentRef.id])
    h.ctx.db.query('UPDATE team_file_refs SET created_at = ? WHERE id IN (?, ?)').run('2000-01-01T00:00:00.000Z', unsent.id, sentRef.id)
    componentC(h.ctx).teamRefs.sweep()
    const ids = (h.ctx.db.query('SELECT id FROM team_file_refs WHERE chat_id = ?').all(chat.id) as { id: string }[]).map((x) => x.id)
    expect(ids).toContain(sentRef.id)
    expect(ids).not.toContain(unsent.id)
  })

  test('attaching is in the audit list', async () => {
    const chat = await newChat()
    await attachOk('alice', chat.id, 'groups/marketing/campaign-brief.md')
    const a = h.ctx.db.query("SELECT actor_id, target FROM audit_log WHERE action = 'file.attach' ORDER BY id DESC LIMIT 1").get() as { actor_id: string; target: string }
    expect(a).toEqual({ actor_id: 'alice', target: 'groups/marketing/campaign-brief.md' })
  })
})

describe('check-then-read: the hashed / shown file is the one that was checked', () => {
  test('hashChecked refuses a file that is not the checked inode (a swap between check and read)', async () => {
    write('shared/checked-a.md', 'a\n')
    write('shared/checked-b.md', 'b\n')
    const stA = fs.lstatSync(path.join(h.team, 'shared/checked-a.md'))
    expect(await hashChecked(path.join(h.team, 'shared/checked-a.md'), stA)).toMatch(/^[0-9a-f]{64}$/)
    await expect(hashChecked(path.join(h.team, 'shared/checked-b.md'), stA)).rejects.toThrow()
    // a link put in place of the file is not followed
    fs.symlinkSync(path.join(h.team, 'groups/finance/budget.md'), path.join(h.team, 'shared/checked-link.md'))
    await expect(hashChecked(path.join(h.team, 'shared/checked-link.md'), stA)).rejects.toThrow()
    fs.rmSync(path.join(h.team, 'shared/checked-link.md'))
  })
})
