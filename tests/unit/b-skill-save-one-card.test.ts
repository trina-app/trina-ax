// One card for one skill save (owner 2026-11-16, docs/decisions/20261116-skill-save-one-card.md; QA TC-3813): a team
// skill saved after the AI read something fewer people can see shows the skill card alone, and that card also says
// what the wider-audience card said (what was read, where it goes, how many people see it there). One yes covers both;
// "Always allow skill edits I ask for" covers both after that. A save outside skills/ still gets the wider-audience card.
// The fake engine through the real launcher and gate; the narrower place is carol's own folder (carol is an admin: only admins write skills/).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type TurnRequest } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { keepAlways } from '../../server/src/chat/always-allow'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let ws: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-skill-save-one-card', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  ws = await h.ws('carol', { windowId: 'win-one-card' })
  await ws.next('hello')
  h.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'carol'").run()
})
afterAll(async () => { ws.close(); await h.close() })

const abs = (rel: string) => path.join(h.team, rel)
const put = (rel: string, b: string) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), b) }
type Ask = TurnRequest & { requestId: string; question?: string; options?: { label: string; value: string }[] }
async function turn(content: string, answers: string[]) {
  const chatId = (await h.api('carol').call(API.createChat, { body: {} })).id
  const r = await h.api('carol').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Ask[] = []
  const seen = new Set<string>()
  for (let waited = 0; ; waited += 50) {
    if (waited > 60_000) throw new Error('the answer did not end')
    for (const f of ws.frames) {
      if (f.type !== 'turn.request' || f.data.turnId !== r.turnId || seen.has(f.data.request.requestId)) continue
      seen.add(f.data.request.requestId)
      cards.push(f.data.request as Ask)
      const answer = answers[Math.min(cards.length - 1, answers.length - 1)]!
      await h.api('carol').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: f.data.request.requestId, answer } })
    }
    const done = ws.frames.find((f) => f.type === 'message.done' && f.data.messageId === r.assistantMessage.id)
    if (done && done.type === 'message.done') return { cards, content: done.data.message.content as string }
    await Bun.sleep(50)
  }
}
const clearAlways = () => h.ctx.db.query('DELETE FROM card_always_allow').run()
const NOTES = 'users/carol/visit-notes.md'
const skill = (name: string) => `---\nname: ${name}\ndescription: Write a visit report\n---\nUse the visit form.\n`
/** read carol's own notes, then save a new team skill */
const readThenSave = (name: string, sayResult = true) => fake(
  { tool: 'read', args: { file_path: NOTES } },
  { tool: 'write', args: { file_path: `skills/${name}/SKILL.md`, content: skill(name) }, sayResult },
)

describe('a new team skill after reading something fewer people can see', () => {
  beforeAll(() => put(NOTES, 'Visit form: date, shop, what was delivered.\n'))

  test('one card: the skill card says who will see it and what was read; one yes saves', async () => {
    try {
      const r = await turn(readThenSave('visit-report'), ['save'])
      expect(r.cards.length).toBe(1)
      const q = r.cards[0]!.question ?? ''
      // the skill card's own words …
      expect(q).toContain('team skill')
      expect(q).toContain('visit-report')
      // … and everything the wider-audience card said: where it came from (with how many see it), how many see the target
      expect(q).toMatch(/This came from .+ \((\d+ (person|people)|only you)\)\./)
      expect(q).toMatch(/\d+ (person|people) can see /)
      expect(r.cards[0]!.options?.map((o) => o.value)).toEqual(['save', '__always', 'skip'])
      expect(fs.existsSync(abs('skills/visit-report/SKILL.md'))).toBe(true)
    } finally { fs.rmSync(abs('skills/visit-report'), { recursive: true, force: true }) }
  })

  test('"Don\'t save": nothing saved, and the AI is told more people can see it there', async () => {
    const r = await turn(readThenSave('visit-report-2'), ['skip'])
    expect(r.cards.length).toBe(1)
    expect(fs.existsSync(abs('skills/visit-report-2/SKILL.md'))).toBe(false)
    expect(r.content).toContain('more people can see')
  })

  test('"Always allow skill edits I ask for" on that card: the next such save asks nothing at all', async () => {
    try {
      const one = await turn(readThenSave('visit-report-3'), ['__always'])
      expect(one.cards.length).toBe(1)
      expect(fs.existsSync(abs('skills/visit-report-3/SKILL.md'))).toBe(true)
      const two = await turn(readThenSave('visit-report-4'), ['skip'])
      expect(two.cards).toEqual([])
      expect(fs.existsSync(abs('skills/visit-report-4/SKILL.md'))).toBe(true)
    } finally {
      clearAlways()
      for (const n of ['visit-report-3', 'visit-report-4']) fs.rmSync(abs(`skills/${n}`), { recursive: true, force: true })
    }
  })

  test('a save outside skills/ still gets the wider-audience card of its own', async () => {
    try {
      const r = await turn(fake(
        { tool: 'read', args: { file_path: NOTES } },
        { tool: 'write', args: { file_path: 'shared/visit-summary.md', content: 'Summary\n' }, sayResult: true },
      ), ['save'])
      expect(r.cards.length).toBe(1)
      expect(r.cards[0]!.question).toContain('This came from ')
      expect(r.cards[0]!.question).toMatch(/Save it to .+ \(\d+ (person|people), \d+ of them can’t see where it came from\)\?/)
      expect(fs.existsSync(abs('shared/visit-summary.md'))).toBe(true)
    } finally { fs.rmSync(abs('shared/visit-summary.md'), { force: true }) }
  })

  test('a project skill (the same card): one card with the line, one yes saves', async () => {
    await h.api('carol').call(API.createProject, { body: { name: 'Kestrel', scope: 'team', slug: 'kestrel', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
    try {
      const r = await turn(fake(
        { tool: 'read', args: { file_path: NOTES } },
        { tool: 'write', args: { file_path: 'projects/kestrel/skills/visit-report/SKILL.md', content: skill('visit-report') }, sayResult: true },
      ), ['save'])
      expect(r.cards.length).toBe(1)
      expect(r.cards[0]!.question).toContain('Kestrel')
      expect(r.cards[0]!.question).toMatch(/This came from .+ \((\d+ (person|people)|only you)\)\./)
      expect(fs.existsSync(abs('projects/kestrel/skills/visit-report/SKILL.md'))).toBe(true)
    } finally { fs.rmSync(abs('projects/kestrel/skills'), { recursive: true, force: true }) }
  })

  test('make_file into a skill folder: one card, the line names the file it makes', async () => {
    try {
      const r = await turn(fake(
        { tool: 'read', args: { file_path: NOTES } },
        { tool: 'make_file', args: { content: '# Visit guide\n', format: 'docx', output: 'skills/visit-report-6/guide' }, sayResult: true },
      ), ['save'])
      expect(r.cards.length).toBe(1)
      const q = r.cards[0]!.question ?? ''
      expect(q).toMatch(/This came from .+ \((\d+ (person|people)|only you)\)\./)
      expect(q).toMatch(/can see [^\n]*guide\.docx/)
      expect(fs.existsSync(abs('skills/visit-report-6/guide.docx'))).toBe(true)
    } finally { fs.rmSync(abs('skills/visit-report-6'), { recursive: true, force: true }) }
  })

  test('a scheduled run with "Always allow" for skill saves on: the wider-audience check still stops it (nobody saw a card)', async () => {
    keepAlways(h.ctx.db, 'carol', 'skill_save', null)
    try {
      const s = h.rt().schedules.create('carol', { title: 'Visit skill', prompt: readThenSave('visit-report-7'), repeat: 'daily', time: '09:00' }, undefined,
        { allowedUrls: [], writeConnections: [], save: null, sources: [], personalSends: [] })
      const { chatId } = h.rt().schedules.runNow('carol', s.id)
      await waitFor(() => { const t = h.ctx.db.query('SELECT status FROM turns WHERE chat_id = ?').get(chatId) as { status: string } | null; return !!t && ['done', 'error', 'stopped', 'interrupted'].includes(t.status) }, { timeoutMs: 60_000 })
      expect(fs.existsSync(abs('skills/visit-report-7/SKILL.md'))).toBe(false)
      // it reached the save and the wider-audience check stopped it (not some other failure)
      const turnId = (h.ctx.db.query('SELECT id FROM turns WHERE chat_id = ?').get(chatId) as { id: string }).id
      const ev = h.ctx.db.query("SELECT summary, ok FROM tool_events WHERE turn_id = ? AND tool = 'write'").all(turnId) as { summary: string; ok: number }[]
      expect(ev).toEqual([{ summary: 'write -> nobody to ask (scheduled run) (wider audience)', ok: 0 }])
    } finally {
      clearAlways()
      fs.rmSync(abs('skills/visit-report-7'), { recursive: true, force: true })
    }
  })

  test('nothing narrower read: the skill card as before, without the line', async () => {
    try {
      const r = await turn(fake({ tool: 'write', args: { file_path: 'skills/plain-skill/SKILL.md', content: skill('plain-skill') }, sayResult: true }), ['save'])
      expect(r.cards.length).toBe(1)
      expect(r.cards[0]!.question).not.toContain('This came from ')
      expect(fs.existsSync(abs('skills/plain-skill/SKILL.md'))).toBe(true)
    } finally { fs.rmSync(abs('skills/plain-skill'), { recursive: true, force: true }) }
  })
})
