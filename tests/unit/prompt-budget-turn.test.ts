// The prompt budget in a real turn (docs/decisions/20261118-limits-caps.md "The prompt budget"): a "/skill" has its own
// share and never takes from the team rules, which a resumed Claude session keeps from its first instructions (review
// of #1284: a chat started with a skill kept a smaller rules section for good). Fake engine through the real launcher.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { promptBudget } from '../../server/src/chat/prompt'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
let h: Harness
let alice: TestSocket
const put = (rel: string, text: string) => { const abs = path.join(h.ctx.config.teamRoot, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text) }

beforeAll(async () => {
  h = await startHarness({ name: 'prompt-budget-turn' })
  alice = await h.ws('alice', { windowId: 'win-alice-budget' })
  await alice.next('hello')
  // three Korean rule files of about 15,000 tokens each: 45,000 of the 50,000 a Claude model gives rules and memories
  for (let i = 0; i < 3; i++) put(`skills/규칙-${i}.md`, `# 규칙 ${i}\nRULE-${i}-START ${'가'.repeat(14_800)} RULE-${i}-END\n`)
  // a skill bigger than its own share (25,000 tokens)
  put('skills/big-skill/SKILL.md', `---\nname: big-skill\ndescription: A long team skill\n---\nSKILL-START ${'S'.repeat(120_000)} SKILL-END\n`)
})
afterAll(async () => { alice?.close(); await h.close() })

const systemOf = async (content: string) => {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  return (await ask(h, alice, 'alice', chat.id, content)).done.content as string
}

test('a "/skill" has its own share: the rules in the instructions are the same with and without it', async () => {
  expect(promptBudget(200_000)).toEqual({ total: 50_000, skillTokens: 25_000 })
  const plain = await systemOf(fake({ echo: 'system' }))
  const withSkill = await systemOf(`/big-skill go\n${fake({ echo: 'system' })}`)
  for (const sys of [plain, withSkill]) for (let i = 0; i < 3; i++) expect(sys).toContain(`RULE-${i}-END`)
  // the skill itself is cut to its share, with the note to read the rest
  const msg = await systemOf(`/big-skill go\n${fake({ echo: 'message' })}`)
  expect(msg).toContain('SKILL-START')
  expect(msg).not.toContain('SKILL-END')
  expect(msg).toContain('Read skills/big-skill/SKILL.md with the read tool for the rest')
})
