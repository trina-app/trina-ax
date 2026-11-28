// A team file attached to what a connected service sends (integrations/connections/team-attach.ts, tools.ts;
// docs/decisions/20261116-mail-attach-team-file.md): the AI gives "team-file:<path>" where the tool takes a file's
// content and the server sends the file's base64 after the connection's own card, which names the file. Only a file the
// person can read, within the size cap, with a tool that changes something, in a turn where a card can be answered.
// The mail service is a made-up MCP server (tests/lib/fake-services.ts): no real mailbox.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { ATTACH_MAX_BYTES, ATTACH_MAX_FILES, TEAM_FILE_PREFIX, teamFileHandles, withTeamFiles } from '../../server/src/integrations/connections/team-attach'
import { appTools } from '../../server/src/integrations/google-apps/catalog'
import { readScope } from '../../server/src/chat/read-scope'
import { TurnFiles } from '../../server/src/files/service'
import type { ConfirmDetail } from '@mycel/shared/api'
import type { TurnTool, TurnToolContext } from '../../server/src/services'

setDefaultTimeout(30_000)

let A: CApp, fake: FakeServices, mail: any, board: any
const post = (as: Person, p: string, body: unknown) => A.json(p, { method: 'POST', as, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const QUOTE = 'groups/marketing/quotes/견적서-사아자.pdf'
const quoteBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3000, 0xa7), Buffer.from('\n%%EOF\n')])
const write = (rel: string, bytes: Uint8Array | string) => { const p = path.join(A.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes) }

beforeAll(async () => {
  A = await makeCApp('c-integrations-attach')
  fake = new FakeServices()
  fake.tools = [
    { name: 'send_mail', title: 'Send mail', description: 'Send a mail. attachments: files as {filename, content_base64}.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, attachments: { type: 'array' } } } },
    { name: 'list_inbox', description: 'List mails', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  ]
  fake.results = { send_mail: { content: [{ type: 'text', text: '{"sent":true}' }] }, list_inbox: { content: [{ type: 'text', text: '[]' }] } }
  integrationsOf(A.ctx, { net: fake.net() })
  mail = (await post('alice', '/api/integrations', { kind: 'mcp', name: 'Mail', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })).body
  board = (await post('carol', '/api/admin/integrations', { kind: 'mcp', name: 'Team mail', url: `${fake.base}/mcp-open`, auth: 'none', writePolicy: 'allow', access: { everyone: false, groups: ['marketing'], users: [] } })).body
  expect([mail.status, board.status]).toEqual(['connected', 'connected'])
  write(QUOTE, quoteBytes)
})
afterAll(async () => { fake?.stop(); await A?.close() })

type Asked = { answer: boolean; questions: string[]; details: ConfirmDetail[][]; beforeAnswer?: () => void | Promise<void> }
const ask = (answer: boolean): Asked => ({ answer, questions: [], details: [] })

function turn(user: Person, o: { person?: Asked; scheduled?: boolean; unattended?: boolean; locale?: 'en' | 'ko'; live?: boolean; attachAsks?: (paths: readonly string[]) => boolean } = {}) {
  const chat = A.chat(user)
  const turnId = A.turn(user, chat)
  const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId, browser: false, scheduled: !!o.scheduled })
  const files = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles() } as TurnToolContext['files']
  if (o.person) { const p = o.person; files.person = { locale: o.locale ?? 'en', async confirm(q, _a, _d, extra) { p.questions.push(q); p.details.push(extra?.details ?? []); await p.beforeAnswer?.(); return p.answer }, *turnUrls() {}, ...(o.unattended ? { unattended: true } : {}), ...(o.live ? { allSitesHere: () => true } : {}), ...(o.attachAsks ? { attachAsks: o.attachAsks } : {}) } }
  const tc: TurnToolContext = { turnId, chatId: chat, userId: user, messageId: 'm', locale: o.locale ?? 'en', signal: new AbortController().signal, files }
  const tools = new Map(built.tools.map((t) => [t.name, t]))
  const call = async (name: string, args: unknown) => {
    const t = tools.get(name) as TurnTool
    if (!t) throw new Error(`no tool ${name}; have ${[...tools.keys()].join(', ')}`)
    const r = await t.call(args, tc)
    return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), isError: !!r.isError, summary: r.summary ?? '' }
  }
  return { chat, prompt: built.prompt, context: built.context, call }
}
const sendArgs = (file: string, more: Record<string, unknown> = {}) => ({ to: 'office@saaja.example', subject: '견적서', body: '수정 견적서 보내드립니다.', attachments: [{ filename: '견적서.pdf', content_base64: TEAM_FILE_PREFIX + file }], ...more })
const sent = () => fake.calls.filter((c) => c.name === 'send_mail')

describe('a team file attached to a mail', () => {
  test('the card names the file first; after yes the service gets the file\'s own bytes as base64', async () => {
    const p = ask(true)
    const before = sent().length
    const t = turn('alice', { person: p })
    const r = await t.call('my_mail__send_mail', sendArgs(QUOTE))
    expect(r.isError).toBe(false)
    // one card, the connection's own
    expect(p.questions).toHaveLength(1)
    expect(p.questions[0]).toContain('The AI wants to send this to Mail: Send mail')
    const [d] = p.details[0]!
    expect(d!.fields![0]).toEqual({ name: 'Team file to attach', value: `견적서-사아자.pdf (3 KB)\nGroups › marketing › quotes` })
    // the recipient and the name the receiver sees are on the card too; the bytes are not (the handle is)
    expect(d!.fields).toContainEqual({ name: 'Recipient', value: 'office@saaja.example' })
    expect(d!.fields!.some((f) => f.value === '견적서.pdf')).toBe(true)
    // the attachment's own line names the file and its place, as the first line does, never the raw handle (the owner,
    // 11-28: "첨부 파일 1 › 내용: team-file:projects/…pdf"; docs/decisions/20261128-stale-approval-cards.md)
    expect(d!.fields!.filter((f) => f.value.includes(TEAM_FILE_PREFIX))).toEqual([])
    expect(d!.fields!.filter((f) => f.value === `견적서-사아자.pdf (3 KB)\nGroups › marketing › quotes`)).toHaveLength(2)
    expect(d!.text).toContain(`"content_base64": "${TEAM_FILE_PREFIX}${QUOTE}"`)
    expect(d!.text).not.toContain(quoteBytes.toString('base64').slice(0, 40))
    // what the service got
    const got = sent().slice(before)
    expect(got).toHaveLength(1)
    expect(got[0]!.args.attachments).toEqual([{ filename: '견적서.pdf', content_base64: quoteBytes.toString('base64') }])
    expect(got[0]!.args.to).toBe('office@saaja.example')
    // the audit line names the file, its size and hash, never its content
    expect(r.summary).toMatch(new RegExp(`^my_mail__send_mail -> ok \\(\\d+ chars\\) \\(team file attached: ${QUOTE} ${quoteBytes.length} B sha256 [0-9a-f]{16}\\) \\(confirmed by the user\\)$`))
    // the AI never sees the bytes
    expect(r.text).not.toContain(quoteBytes.toString('base64').slice(0, 40))
    // who reads the file is in the chat's read scope (what the service says back about it)
    expect(readScope(A.ctx.db, t.chat)).toContainEqual({ type: 'folder', id: 'f_groups_marketing' })
  })

  test('the card says it in the person\'s language', async () => {
    const p = ask(false)
    await turn('alice', { person: p, locale: 'ko' }).call('my_mail__send_mail', sendArgs(QUOTE))
    expect(p.details[0]![0]!.fields![0]).toEqual({ name: '첨부할 팀 파일', value: '견적서-사아자.pdf (3 KB)\n부서 › marketing › quotes' })
  })

  test('no: nothing is sent', async () => {
    const p = ask(false)
    const before = sent().length
    const r = await turn('alice', { person: p }).call('my_mail__send_mail', sendArgs(QUOTE))
    expect(r.isError).toBe(true)
    expect(r.text).toContain('did not allow')
    expect(sent().length).toBe(before)
  })

  test('a file the person cannot read, and one that is not there, are refused alike before any card', async () => {
    const before = sent().length
    const answers: string[] = []
    for (const file of ['groups/finance/budget.md', 'groups/finance/no-such-file.pdf', 'users/bob/notes.md', 'groups/marketing/salaries/2026.md', '../outside/secret.txt', '/etc/passwd']) {
      const p = ask(true)
      const r = await turn('alice', { person: p }).call('my_mail__send_mail', sendArgs(file))
      expect(r.isError).toBe(true)
      expect(r.summary).toBe('my_mail__send_mail -> refused (attachment not found)')
      expect(p.questions).toHaveLength(0)
      expect(r.text).not.toContain('CANARY')
      answers.push(r.text.replace(file, '<file>'))
    }
    expect(new Set(answers).size).toBe(1)
    expect(sent().length).toBe(before)
  })

  test('links and hard links are not followed; a folder is not a file', async () => {
    for (const [file, why] of [['groups/marketing/budget-link.md', 'attachment not found'], ['groups/marketing/margin-copy.md', 'attachment not found'], ['groups/marketing/quotes', 'attachment is a folder']] as const) {
      const p = ask(true)
      const r = await turn('alice', { person: p }).call('my_mail__send_mail', sendArgs(file))
      expect(r.summary).toBe(`my_mail__send_mail -> refused (${why})`)
      expect(r.text).not.toContain('CANARY')
      expect(p.questions).toHaveLength(0)
    }
  })

  test('too big: said in plain words with the size and the limit, nothing read or sent, no card', async () => {
    write('groups/marketing/quotes/film.mov', Buffer.alloc(ATTACH_MAX_BYTES + 1, 1))
    write('groups/marketing/quotes/half-a.bin', Buffer.alloc(ATTACH_MAX_BYTES / 2 + 10, 2))
    write('groups/marketing/quotes/half-b.bin', Buffer.alloc(ATTACH_MAX_BYTES / 2 + 10, 3))
    const before = sent().length
    const p = ask(true)
    const one = await turn('alice', { person: p }).call('my_mail__send_mail', sendArgs('groups/marketing/quotes/film.mov'))
    expect(one.isError).toBe(true)
    expect(one.summary).toBe('my_mail__send_mail -> refused (attachment too large)')
    expect(one.text).toContain('"film.mov" is 18.01 MB')
    expect(one.text).toContain('at most 18.0 MB together')
    expect(one.text).toContain('too large to attach')
    // two files that fit alone and not together
    const two = await turn('alice', { person: p }).call('my_mail__send_mail', { to: 'a@b.example', attachments: [{ filename: 'a', content_base64: `${TEAM_FILE_PREFIX}groups/marketing/quotes/half-a.bin` }, { filename: 'b', content_base64: `${TEAM_FILE_PREFIX}groups/marketing/quotes/half-b.bin` }] })
    expect(two.summary).toBe('my_mail__send_mail -> refused (attachment too large)')
    expect(two.text).toContain('with the other files')
    // more files than one call takes
    const many = await turn('alice', { person: p }).call('my_mail__send_mail', { to: 'a@b.example', attachments: Array.from({ length: ATTACH_MAX_FILES + 1 }, (_, i) => ({ filename: `f${i}`, content_base64: `${TEAM_FILE_PREFIX}groups/marketing/f${i}.md` })) })
    expect(many.summary).toBe('my_mail__send_mail -> refused (too many attachments)')
    expect(p.questions).toHaveLength(0)
    expect(sent().length).toBe(before)
    for (const f of ['film.mov', 'half-a.bin', 'half-b.bin']) fs.rmSync(path.join(A.team, 'groups/marketing/quotes', f))
  })

  test('a file changed, or access taken away, while the card waits: nothing is sent', async () => {
    const before = sent().length
    write('groups/marketing/quotes/draft.txt', 'first version')
    const changed = ask(true)
    changed.beforeAnswer = () => write('groups/marketing/quotes/draft.txt', 'another version, swapped in while the card was open')
    const r = await turn('alice', { person: changed }).call('my_mail__send_mail', sendArgs('groups/marketing/quotes/draft.txt'))
    expect(r.isError).toBe(true)
    expect(r.summary).toBe('my_mail__send_mail -> refused (attachment changed) (confirmed by the user)')
    // taken out of the group while the card waits
    const gone = ask(true)
    gone.beforeAnswer = () => { A.ctx.db.query("DELETE FROM group_members WHERE user_id = 'alice' AND group_id = 'marketing'").run() }
    try {
      const r2 = await turn('alice', { person: gone }).call('my_mail__send_mail', sendArgs(QUOTE))
      expect(r2.isError).toBe(true)
      expect(r2.summary).toBe('my_mail__send_mail -> refused (attachment changed) (confirmed by the user)')
    } finally { A.ctx.db.query("INSERT INTO group_members VALUES ('marketing','alice')").run() }
    expect(sent().length).toBe(before)
  })

  test('only where a card can be answered: not in a scheduled run, an unattended run or a turn without a person', async () => {
    const before = sent().length
    // the team connection sends without asking, so the scheduled refusal here is the attachment's own
    for (const t of [turn('alice', { scheduled: true }), turn('alice', { person: ask(true), unattended: true }), turn('alice')]) {
      const r = await t.call('team_teammail__send_mail', sendArgs(QUOTE))
      expect(r.isError).toBe(true)
      expect(r.summary).toBe('team_teammail__send_mail -> refused (attachment: nobody to ask)')
    }
    expect(sent().length).toBe(before)
  })

  test('a tool that only reads takes no file (it raises no card)', async () => {
    const before = fake.calls.length
    const r = await turn('alice', { person: ask(true) }).call('my_mail__list_inbox', { q: TEAM_FILE_PREFIX + QUOTE })
    expect(r.isError).toBe(true)
    expect(r.summary).toBe('my_mail__list_inbox -> refused (attachment on a read)')
    expect(fake.calls.length).toBe(before)
  })

  test('a file that holds one of the person\'s stored connection keys is not sent', async () => {
    const p = ask(true)
    const before = sent().length
    // as it is, cut by a line break, and in a UTF-16 text file
    for (const bytes of [`notes\nthe mail key is ${MCP_KEY}\n`, `${MCP_KEY.slice(0, 9)}\n${MCP_KEY.slice(9)}`, Buffer.from(`key: ${MCP_KEY}`, 'utf16le')]) {
      write('groups/marketing/quotes/keys.txt', bytes)
      const r = await turn('alice', { person: p }).call('my_mail__send_mail', sendArgs('groups/marketing/quotes/keys.txt'))
      expect(r.isError).toBe(true)
      expect(r.summary).toBe('my_mail__send_mail -> refused (a stored key in the attachment)')
      expect(r.text).not.toContain(MCP_KEY)
    }
    expect(p.questions).toHaveLength(0)
    expect(sent().length).toBe(before)
  })

  test('a connection that sends without asking (the team\'s rule) attaches in a chat without a card, with the audit line', async () => {
    const before = sent().length
    const p = ask(true)
    const r = await turn('alice', { person: p, live: true }).call('team_teammail__send_mail', sendArgs(QUOTE))
    expect(r.isError).toBe(false)
    expect(p.questions).toHaveLength(0)
    expect(sent().slice(before)[0]!.args.attachments[0].content_base64).toBe(quoteBytes.toString('base64'))
    expect(r.summary).toContain(`(team file attached: ${QUOTE} ${quoteBytes.length} B sha256 `)
    expect(r.summary).not.toContain('confirmed by the user')
  })

  test('a connection that sends without asking still asks for a file the person\'s own message did not bring, in a chat that holds content written by others', async () => {
    const before = sent().length
    const seen: string[][] = []
    // (TurnPerson.attachAsks, chat/tools.ts: the chat holds other people's words and the message did not name the file)
    const p = ask(true)
    const r = await turn('alice', { person: p, live: true, attachAsks: (paths) => { seen.push([...paths]); return true } }).call('team_teammail__send_mail', sendArgs(QUOTE))
    expect(seen).toEqual([[QUOTE]])
    expect(p.questions).toHaveLength(1)
    expect(p.details[0]![0]!.fields![0]!.name).toBe('Team file to attach')
    expect(r.isError).toBe(false)
    expect(r.summary).toContain('confirmed by the user')
    expect(sent().length).toBe(before + 1)
    // no: nothing leaves
    const no = ask(false)
    const refused = await turn('alice', { person: no, live: true, attachAsks: () => true }).call('team_teammail__send_mail', sendArgs(QUOTE))
    expect(refused.isError).toBe(true)
    expect(sent().length).toBe(before + 1)
    // a file the message brought (or a chat with nothing from others): no card, as before
    const free = ask(true)
    expect((await turn('alice', { person: free, live: true, attachAsks: () => false }).call('team_teammail__send_mail', sendArgs(QUOTE))).isError).toBe(false)
    expect(free.questions).toHaveLength(0)
    // a send without a file is not asked about
    const plain = ask(true)
    expect((await turn('alice', { person: plain, live: true, attachAsks: () => true }).call('team_teammail__send_mail', { to: 'a@b.example', subject: 's', body: 'b' })).isError).toBe(false)
    expect(plain.questions).toHaveLength(0)
  })

  test('the person\'s own Always allow for the connection is final: no card for attached team files, also where they keep the card otherwise', async () => {
    // alice's own connection set to send without asking (her Always allow on its card)
    A.ctx.db.query("UPDATE integrations SET write_policy = 'allow', version = version + 1 WHERE id = ?").run(mail.id)
    try {
      const before = sent().length
      const p = ask(false)
      const r = await turn('alice', { person: p, live: true, attachAsks: () => true }).call('my_mail__send_mail', sendArgs(QUOTE))
      expect(r.isError).toBe(false)
      expect(p.questions).toHaveLength(0)
      expect(sent().length).toBe(before + 1)
      expect(sent().at(-1)!.args.attachments[0].content_base64).toBe(quoteBytes.toString('base64'))
    } finally { A.ctx.db.query("UPDATE integrations SET write_policy = 'ask', version = version + 1 WHERE id = ?").run(mail.id) }
  })

  test('a service\'s answer marks the chat as holding content written by others', async () => {
    const t = turn('alice', { person: ask(true), live: true })
    const mark = () => (A.ctx.db.query('SELECT others_words AS o FROM chats WHERE id = ?').get(t.chat) as { o: number }).o
    expect(mark()).toBe(0)
    expect((await t.call('team_teammail__list_inbox', {})).isError).toBe(false)
    expect(mark()).toBe(1)
  })

  test('without a card, a file leaves only in a turn the person watches from the app (not a question asked elsewhere)', async () => {
    const before = sent().length
    const p = ask(true)
    const r = await turn('alice', { person: p }).call('team_teammail__send_mail', sendArgs(QUOTE))
    expect(r.isError).toBe(true)
    expect(r.summary).toBe('team_teammail__send_mail -> refused (attachment: not watched)')
    expect(p.questions).toHaveLength(0)
    expect(sent().length).toBe(before)
    // the same call without a file still goes, as before
    expect((await turn('alice', { person: p }).call('team_teammail__send_mail', { to: 'a@b.example', subject: 's', body: 'b' })).isError).toBe(false)
  })

  test('the same file named twice is refused: the card and the size cap count what is sent', async () => {
    const before = sent().length
    const p = ask(true)
    const at = { filename: 'q.pdf', content_base64: TEAM_FILE_PREFIX + QUOTE }
    const r = await turn('alice', { person: p }).call('my_mail__send_mail', { to: 'a@b.example', attachments: [at, at, at] })
    expect(r.isError).toBe(true)
    expect(r.summary).toBe('my_mail__send_mail -> refused (attachment named twice)')
    expect(p.questions).toHaveLength(0)
    expect(sent().length).toBe(before)
  })

  test('a connection set to refuse changes refuses before any file is read', async () => {
    A.ctx.db.query("UPDATE integrations SET write_policy = 'deny', version = version + 1 WHERE id = ?").run(mail.id)
    try {
      const r = await turn('alice', { person: ask(true) }).call('my_mail__send_mail', sendArgs('groups/finance/budget.md'))
      expect(r.summary).toBe('my_mail__send_mail -> refused (write policy deny)')
    } finally { A.ctx.db.query("UPDATE integrations SET write_policy = 'ask', version = version + 1 WHERE id = ?").run(mail.id) }
  })

  test('a call without a handle is unchanged; a handle inside a longer text is only text', async () => {
    const before = sent().length
    const p = ask(true)
    const r = await turn('alice', { person: p }).call('my_mail__send_mail', { to: 'a@b.example', subject: 's', body: `see ${TEAM_FILE_PREFIX}${QUOTE} for the quote` })
    expect(r.isError).toBe(false)
    expect(p.details[0]![0]!.fields!.some((f) => f.name === 'Team file to attach')).toBe(false)
    expect(sent().slice(before)[0]!.args.body).toBe(`see ${TEAM_FILE_PREFIX}${QUOTE} for the quote`)
    expect(r.summary).not.toContain('team file attached')
  })
})

describe('the handle', () => {
  test('found as a whole value at any depth, each time it stands there; swapped for base64 everywhere it stands', () => {
    const a = { a: 'team-file:x.pdf', b: [{ c: 'team-file:x.pdf', d: 'team-file:y.png' }], e: ' team-file:z', f: 'see team-file:z', g: 7, h: null }
    expect(teamFileHandles(a)).toEqual(['team-file:x.pdf', 'team-file:x.pdf', 'team-file:y.png'])
    expect(teamFileHandles('team-file:x')).toEqual(['team-file:x'])
    expect(teamFileHandles(null)).toEqual([])
    const file = { handle: 'team-file:x.pdf', rel: 'x.pdf', name: 'x.pdf', size: 3, sha256: '', identity: '', bytes: Buffer.from('abc') }
    expect(withTeamFiles(a, [file])).toEqual({ ...a, a: 'YWJj', b: [{ c: 'YWJj', d: 'team-file:y.png' }] })
    // the arguments the card showed are not changed
    expect(a.a).toBe('team-file:x.pdf')
  })
})

describe('what the AI is told', () => {
  test('the instructions say how to attach, also for a resumed chat; not in a scheduled run', () => {
    const t = turn('alice')
    for (const text of [t.prompt, t.context]) {
      expect(text).toContain(`"${TEAM_FILE_PREFIX}<the file's path in the team folder>"`)
      expect(text).toContain('At most 20 files and 18.0 MB together')
    }
    expect(turn('alice', { scheduled: true }).prompt).not.toContain(TEAM_FILE_PREFIX)
  })
  test('Gmail\'s send and draft say it in their own description; other tools do not', () => {
    const tools = appTools('gmail', ['send_gmail_message', 'draft_gmail_message', 'search_gmail_messages'].map((name) => ({ name, title: null, description: 'The library\'s words.', inputSchema: { type: 'object' }, readOnly: name.startsWith('search') })))
    const by = new Map(tools.map((x) => [x.name, x.description]))
    expect(by.get('send_gmail_message')).toContain(`"content": "${TEAM_FILE_PREFIX}<the file's path in the team folder>"`)
    expect(by.get('draft_gmail_message')).toContain(TEAM_FILE_PREFIX)
    expect(by.get('search_gmail_messages')).not.toContain(TEAM_FILE_PREFIX)
  })
})
