// A new skill is one save with one card (QA MAN-052, docs/decisions/20261117-new-skill-one-card.md): "Make this a skill
// for the team" from an attached form saved SKILL.md and the form (assets/…) in two calls, and each showed a card with
// the raw file. After a Save on the new skill's SKILL.md, the other new files in that skill's folder in the same answer
// need no card. An existing file, a file saved before the SKILL.md, another skill's folder, a "Don't save" and a later
// answer still ask. The fake engine through the real launcher and gate (carol is an admin: only admins write skills/).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type TurnRequest } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { skillFolderOf } from '../../server/src/chat/turn'
import { NEW_SKILL_RULE } from '../../server/src/chat/prompt'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let ws: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-new-skill-one-card', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  ws = await h.ws('carol', { windowId: 'win-new-skill' })
  await ws.next('hello')
  h.ctx.db.query("UPDATE users SET locale = 'en' WHERE id = 'carol'").run()
})
afterAll(async () => { ws.close(); await h.close() })

const abs = (rel: string) => path.join(h.team, rel)
type Ask = TurnRequest & { requestId: string; question?: string }
async function turn(content: string, answers: string[], chatId?: string) {
  chatId ??= (await h.api('carol').call(API.createChat, { body: {} })).id
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
    if (done && done.type === 'message.done') return { cards, chatId, content: done.data.message.content as string }
    await Bun.sleep(50)
  }
}
const skill = (name: string) => `---\nname: ${name}\ndescription: Fills in the leave request form\n---\n# Leave request\n\n## Steps\n1. Ask for the dates.\n`
const FORM = '# Leave request\n\n- Name:\n- First day off:\n- Last day off:\n'
const write = (file_path: string, content: string) => ({ tool: 'write', args: { file_path, content } })
const gone = (name: string) => fs.rmSync(abs(`skills/${name}`), { recursive: true, force: true })

test('skillFolderOf: the one skill a path is inside', () => {
  expect(skillFolderOf('skills/leave/SKILL.md')).toBe('skills/leave')
  expect(skillFolderOf('skills/leave/assets/form.md')).toBe('skills/leave')
  expect(skillFolderOf('skills/rule.md')).toBeNull()
  expect(skillFolderOf('groups/sales/skills/quote/SKILL.md')).toBe('groups/sales/skills/quote')
  expect(skillFolderOf('projects/p/skills/x/assets/a.md')).toBe('projects/p/skills/x')
  expect(skillFolderOf('groups/sales/skills/rule.md')).toBeNull()
  expect(skillFolderOf('shared/notes.md')).toBeNull()
})

describe('a new team skill with a form file', () => {
  test('SKILL.md, then the form: one card, both saved', async () => {
    try {
      const r = await turn(fake(write('skills/leave-request/SKILL.md', skill('leave-request')), write('skills/leave-request/assets/form.md', FORM)), ['save'])
      expect(r.cards.length).toBe(1)
      expect(r.cards[0]!.question).toContain('leave-request')
      expect(fs.readFileSync(abs('skills/leave-request/SKILL.md'), 'utf8')).toContain('name: leave-request')
      expect(fs.readFileSync(abs('skills/leave-request/assets/form.md'), 'utf8')).toBe(FORM)
    } finally { gone('leave-request') }
  })

  test('"Don\'t save" on the SKILL.md: the form gets its own card, and a no there saves nothing', async () => {
    const r = await turn(fake(write('skills/leave-2/SKILL.md', skill('leave-2')), write('skills/leave-2/assets/form.md', FORM)), ['skip'])
    expect(r.cards.length).toBe(2)
    expect(fs.existsSync(abs('skills/leave-2/SKILL.md'))).toBe(false)
    expect(fs.existsSync(abs('skills/leave-2/assets/form.md'))).toBe(false)
  })

  test('the form saved before the SKILL.md: two cards (the yes on a form file never covers the skill)', async () => {
    try {
      const r = await turn(fake(write('skills/leave-3/assets/form.md', FORM), write('skills/leave-3/SKILL.md', skill('leave-3'))), ['save'])
      expect(r.cards.length).toBe(2)
    } finally { gone('leave-3') }
  })

  test('another skill\'s folder in the same answer still asks', async () => {
    try {
      const r = await turn(fake(write('skills/leave-4/SKILL.md', skill('leave-4')), write('skills/other-skill/assets/form.md', FORM)), ['save'])
      expect(r.cards.length).toBe(2)
    } finally { gone('leave-4'); gone('other-skill') }
  })

  test('a later answer in the same chat asks again for a new file in that skill', async () => {
    try {
      const one = await turn(fake(write('skills/leave-5/SKILL.md', skill('leave-5'))), ['save'])
      expect(one.cards.length).toBe(1)
      const two = await turn(fake(write('skills/leave-5/assets/form.md', FORM)), ['save'], one.chatId)
      expect(two.cards.length).toBe(1)
    } finally { gone('leave-5') }
  })
})

test('the instructions: ask the name once, one SKILL.md with the form in it, plain words in the answer', async () => {
  const r = await turn(fake({ echo: 'system' }), ['skip'])
  expect(r.content).toContain(NEW_SKILL_RULE)
  expect(NEW_SKILL_RULE).toContain('ask once for the name with ask_user before you save')
  expect(NEW_SKILL_RULE).toContain('Keep a new skill in one SKILL.md')
  expect(NEW_SKILL_RULE).toContain('save SKILL.md first')
  expect(NEW_SKILL_RULE).toContain("do not paste the file's text")
})
