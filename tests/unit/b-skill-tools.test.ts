// The skill tool and find_skills (docs/DECISIONS.md "Skills: the whole list, the skill tool") through the real
// runtime, launcher and gate with the fake engines (no model calls): offered to Claude Code, Codex, the API engine and
// Claude's sub-agents under the same names the model proxy allows (Claude Code's own Skill and ToolSearch stay denied);
// each call checks the person's read access as they are now; a loaded skill counts as a use, joins the read scope and
// shows as a step; the four kinds of instructions hold the same skill list; when the list is cut the matching skills
// go in front of the message; a resumed session is told which skills were added, changed or removed since it started.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type EngineId } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { newId } from '../../server/src/db'
import { setMemberChoice } from '../../server/src/admin/engine-choice'
import { writeApiEngine } from '../../server/src/engine/api-agent'
import { checkToolNames, toolPolicyOf } from '../../server/src/proxy/model-proxy'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const SEP = { say: '\n----\n' }
const FIN = 'FIN-ONLY-SKILL-CANARY-91c'
const MINE = 'ALICE-OWN-SKILL-CANARY-27e'

/** The "## Team skills" part of a set of instructions (up to the next part). */
const skillPart = (prompt: string) => {
  const i = prompt.indexOf('## Team skills')
  if (i < 0) return ''
  const rest = prompt.slice(i)
  const end = rest.slice(1).search(/\n\n(## |<)/)
  return end < 0 ? rest : rest.slice(0, end + 1)
}

/** Chat Completions stream: text, then tool calls. */
function sse(o: { text?: string[]; calls?: { id: string; name: string; args: string }[] }): string {
  const lines: string[] = []
  for (const t of o.text ?? []) lines.push(JSON.stringify({ choices: [{ delta: { content: t } }] }))
  for (const [i, c] of (o.calls ?? []).entries()) lines.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: c.args } }] } }] }))
  lines.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  return lines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n'
}

let h: Harness
let mock: ReturnType<typeof Bun.serve>
const seen: any[] = []
const script: string[] = []
const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(h.team, rel)), { recursive: true }); fs.writeFileSync(path.join(h.team, rel), text) }

beforeAll(async () => {
  mock = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { if (req.method === 'GET') return Response.json({ data: [{ id: 'm-1' }] }); seen.push(await req.json()); return new Response(script.shift() ?? sse({ text: ['(no script)'] })) } })
  h = await startHarness({ name: 'b-skill-tools' })
  // the API engine set up like the owner does in Admin > AI engines; the harness's turns get the same settings
  writeApiEngine(h.ctx.config.dataDir, { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1' })
  const confs = h.rt().engines.get()
  confs.api = { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1', key: null }
  delete confs.problems.api
  setMemberChoice(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] })
  put('skills/영업/견적서-작성.md', '---\nname: 견적서 작성\ndescription: 고객에게 보낼 견적서를 만든다\n---\nQUOTE-STEPS-1\n')
  put('skills/weekly.md', '---\nname: Weekly\ndescription: team weekly report\n---\nWEEKLY-STEPS\n')
  put('skills/finance/close.md', `---\nname: Month close\ndescription: ${FIN} close the books\n---\nCLOSE-STEPS\n`)
  put('users/alice/skills/draft-mail/SKILL.md', `---\nname: draft-mail\ndescription: ${MINE} drafts a mail\n---\nDRAFT-STEPS\n`)
  // skills/finance: the finance group only (bob)
  const folder = 'f_skills_finance_' + newId()
  h.ctx.db.query('INSERT INTO folders (id, path) VALUES (?, ?)').run(folder, 'skills/finance')
  h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'everyone', NULL, 'none')").run(newId(), folder)
  h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'group', 'finance', 'read')").run(newId(), folder)
})
afterAll(async () => { await h?.close(); mock?.stop(true) })

const answer = async (assistantId: string) => {
  await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(assistantId) as { status: string } | null)?.status !== 'streaming', { timeoutMs: 30_000 })
  const m = h.ctx.db.query('SELECT status, content, steps, error FROM messages WHERE id = ?').get(assistantId) as { status: string; content: string; steps: string; error: string | null }
  if (m.status !== 'done') throw new Error(`turn ended ${m.status}: ${m.error}`)
  return { content: m.content, steps: JSON.parse(m.steps) as { tool?: string; label: string; status: string; parentId?: string }[] }
}
const send = async (user: string, chatId: string, content: string, engine?: EngineId) => {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [], ...(engine ? { engine } : {}) } })
  return { turnId: r.turnId, ...(await answer(r.assistantMessage.id)) }
}
const newChat = async (user: string, engine?: EngineId) => (await h.api(user).call(API.createChat, { body: engine ? { engine } : {} })).id
const events = (turnId: string, tool: string) => h.ctx.db.query('SELECT summary, ok, parent_tool_use_id AS parent FROM tool_events WHERE turn_id = ? AND tool = ? ORDER BY id').all(turnId, tool) as { summary: string; ok: number; parent: string | null }[]

describe('offered to every engine under the same names', () => {
  test('Claude Code: our skill and find_skills are allowed, its own Skill and ToolSearch stay denied', async () => {
    const r = await send('alice', await newChat('alice'), fake({ echo: 'tools' }, SEP, { echo: 'args' }))
    const [tools, argsJson] = r.content.split('\n----\n')
    expect(tools!.split(',')).toEqual(expect.arrayContaining(['skill', 'find_skills']))
    const argv = JSON.parse(argsJson!) as string[]
    const flag = (f: string) => argv[argv.indexOf(f) + 1]!.split(',')
    expect(flag('--allowedTools')).toEqual(expect.arrayContaining(['mcp__team__skill', 'mcp__team__find_skills']))
    expect(flag('--disallowedTools')).toEqual(expect.arrayContaining(['Skill', 'ToolSearch']))
    expect(flag('--tools')).not.toContain('Skill')
    expect(argv).toContain('--disable-slash-commands')
    // the model proxy's names for this turn: the same tools; a request naming Claude Code's own Skill is refused
    const row = h.ctx.db.query('SELECT tools FROM proxy_tokens WHERE turn_id = ? ORDER BY rowid DESC LIMIT 1').get(r.turnId) as { tools: string } | null
    expect(row).not.toBeNull()
    const policy = toolPolicyOf(row!)
    expect(policy.team).toEqual(expect.arrayContaining(['skill', 'find_skills']))
    expect(checkToolNames({ tools: [{ name: 'mcp__team__skill' }, { name: 'mcp__team__find_skills' }] }, policy)).toBeNull()
    expect(checkToolNames({ tools: [{ name: 'Skill' }] }, policy)).toContain('Skill')
    expect(checkToolNames({ tools: [{ name: 'ToolSearch' }] }, policy)).toContain('ToolSearch')
  })

  test('Codex: the team server\'s enabled tools include them', async () => {
    const r = await send('alice', await newChat('alice', 'codex' as EngineId), fake({ echo: 'tools' }, SEP, { echo: 'args' }), 'codex' as EngineId)
    const [tools, argsJson] = r.content.split('\n----\n')
    expect(tools!.split(',')).toEqual(expect.arrayContaining(['skill', 'find_skills']))
    const enabled = (JSON.parse(argsJson!) as string[]).find((a) => a.startsWith('mcp_servers.team.enabled_tools='))!
    expect(JSON.parse(enabled.slice('mcp_servers.team.enabled_tools='.length))).toEqual(expect.arrayContaining(['skill', 'find_skills']))
    // Codex's own skills stay off
    expect(argsJson).toContain('features.skill_search=false')
  })

  test('the API engine: offered as functions; a call loads the skill through the team handler', async () => {
    seen.length = 0
    script.push(sse({ calls: [{ id: 'c1', name: 'mcp__team__skill', args: JSON.stringify({ name: 'Weekly' }) }] }), sse({ text: ['Followed it.'] }))
    const r = await send('alice', await newChat('alice', 'api' as EngineId), 'weekly please', 'api' as EngineId)
    expect(r.content).toBe('Followed it.')
    expect(seen[0].tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(['skill', 'find_skills']))
    const result = seen[1].messages.find((m: any) => m.role === 'tool')
    expect(result.content).toContain('<team_skill name="Weekly" path="skills/weekly.md">')
    expect(result.content).toContain('WEEKLY-STEPS')
    expect(r.steps.find((s) => s.tool === 'skill')).toMatchObject({ label: 'Use skill · Weekly', status: 'ok' })
  })

  test('sub-agents: both definitions list them; a child\'s call checks the same person\'s access', async () => {
    const chat = await newChat('alice')
    const r = await send('alice', chat, fake({ echo: 'agents' }, { agents: [
      { id: 'toolu_S1', type: 'Explore', description: 'Look for skills', steps: [{ tool: 'find_skills', args: { query: 'close books' } }, { tool: 'skill', args: { name: 'Month close' } }, { tool: 'skill', args: { name: '견적서 작성' } }] },
    ] }))
    const defs = JSON.parse(r.content.slice(0, r.content.lastIndexOf('}') + 1))
    for (const type of ['general-purpose', 'Explore']) expect(defs[type].tools).toEqual(expect.arrayContaining(['mcp__team__skill', 'mcp__team__find_skills']))
    const skillCalls = events(r.turnId, 'skill')
    expect(skillCalls.map((e) => [e.summary, e.parent])).toEqual([['skill -> not found', 'toolu_S1'], ['skill -> skills/영업/견적서-작성.md', 'toolu_S1']])
    // alice cannot read skills/finance: nothing of it is found for her
    expect(events(r.turnId, 'find_skills')[0]!.summary).toBe('find_skills -> 0 found')
  })

  test('the instructions of the three engines and of the sub-agents hold the same skill list', async () => {
    const claude = (await send('alice', await newChat('alice'), fake({ echo: 'system' }, SEP, { echo: 'subagentPrompt' }))).content.split('\n----\n')
    const codex = (await send('alice', await newChat('alice', 'codex' as EngineId), fake({ echo: 'system' }), 'codex' as EngineId)).content
    seen.length = 0
    script.push(sse({ text: ['ok'] }))
    await send('alice', await newChat('alice', 'api' as EngineId), 'hello', 'api' as EngineId)
    const api = String(seen[0].messages[0].content)
    const part = skillPart(claude[0]!)
    expect(part).toContain('- draft-mail [personal]: ' + MINE)
    expect(part).toContain('- 견적서 작성: 고객에게 보낼 견적서를 만든다')
    expect(part).not.toContain(FIN)
    for (const p of [claude[1]!, codex, api]) expect(skillPart(p)).toBe(part)
  })
})

describe('the skill tool and find_skills check access on every call', () => {
  test('a restricted skill only for its readers, a personal one only for its owner', async () => {
    const tool = (name: string, args: unknown) => ({ tool: name, args, sayResult: true })
    const alice = (await send('alice', await newChat('alice'), fake(tool('skill', { name: 'Month close' }), SEP, tool('find_skills', { query: 'close the books' }), SEP, tool('skill', { name: 'draft-mail' })))).content.split('\n----\n')
    expect(alice[0]).toContain('No skill called "Month close" that this user can use')
    expect(alice[0]).not.toContain('CLOSE-STEPS')
    expect(alice[1]).not.toContain(FIN)
    expect(alice[2]).toContain('<team_skill name="draft-mail" path="users/alice/skills/draft-mail/SKILL.md">')
    expect(alice[2]).toContain('The personal skill you loaded.')
    expect(alice[2]).toContain('Resource base: users/alice/skills/draft-mail/')
    const bob = (await send('bob', await newChat('bob'), fake(tool('skill', { name: 'Month close' }), SEP, tool('find_skills', { query: 'close the books' }), SEP, tool('skill', { name: 'draft-mail' }), SEP, tool('find_skills', { query: 'drafts a mail' })))).content.split('\n----\n')
    expect(bob[0]).toContain('CLOSE-STEPS')
    expect(bob[1]).toContain('- Month close: ' + FIN)
    expect(bob[2]).toContain('No skill called "draft-mail"')
    expect(bob[2]).not.toContain('DRAFT-STEPS')
    expect(bob[3]).not.toContain(MINE)
    // an admin does not see a member's personal skill either
    const carol = (await send('carol', await newChat('carol'), fake(tool('skill', { name: 'users/alice/skills/draft-mail/SKILL.md' })))).content
    expect(carol).toContain('No skill called')
  })

  test('a loaded team skill is a use (team skills only), joins the read scope and is outside content', async () => {
    const chat = await newChat('alice')
    const r = await send('alice', chat, fake({ tool: 'skill', args: { name: '견적서 작성' } }, { tool: 'skill', args: { name: 'draft-mail' } }, { say: 'done' }))
    const uses = h.ctx.db.query('SELECT skill_path, source FROM turn_skill_usage WHERE turn_id = ?').all(r.turnId)
    expect(uses).toEqual([{ skill_path: 'skills/영업/견적서-작성.md', source: 'read' }])
    const c = h.ctx.db.query('SELECT session_read_scope, session_tainted FROM chats WHERE id = ?').get(chat) as { session_read_scope: string; session_tainted: number }
    // the folder whose rules decide who reads the team skill (skills/), and alice herself for her own skill
    expect(JSON.parse(c.session_read_scope).sources).toEqual(expect.arrayContaining([{ type: 'folder', id: 'f_skills' }, { type: 'user', id: 'alice' }]))
    expect(c.session_tainted).toBe(1)
    expect(r.steps.filter((s) => s.tool === 'skill').map((s) => s.label)).toEqual(['Use skill · 견적서 작성', 'Use skill · draft-mail'])
  })

  test('an unknown name answers with similar names; a shared name asks for the path', async () => {
    put('skills/a/dup.md', '---\nname: Dup\ndescription: one\n---\nA\n')
    put('skills/b/dup.md', '---\nname: Dup\ndescription: two\n---\nB\n')
    try {
      const out = (await send('alice', await newChat('alice'), fake({ tool: 'skill', args: { name: '견적서' }, sayResult: true }, SEP, { tool: 'skill', args: { name: 'Dup' }, sayResult: true }, SEP, { tool: 'skill', args: { name: 'skills/b/dup.md' }, sayResult: true }))).content.split('\n----\n')
      expect(out[0]).toContain('Similar: "견적서 작성"')
      expect(out[1]).toContain('Several skills this user can use are called "Dup": skills/a/dup.md, skills/b/dup.md')
      expect(out[2]).toContain('path="skills/b/dup.md"')
    } finally { fs.rmSync(path.join(h.team, 'skills/a'), { recursive: true }); fs.rmSync(path.join(h.team, 'skills/b'), { recursive: true }) }
  })
})

describe('a cut list and a continued chat', () => {
  test('a resumed session is told the skills added, changed or removed since it started', async () => {
    const chat = await newChat('alice')
    const first = await send('alice', chat, fake({ echo: 'resume' }, SEP, { echo: 'message' }))
    expect(first.content).toContain('resumed=false')
    expect(first.content).not.toContain('<turn_context>')
    put('skills/new-one.md', '---\nname: New one\ndescription: added during the chat\n---\nNEW\n')
    put('skills/weekly.md', '---\nname: Weekly\ndescription: team weekly report\n---\nWEEKLY-STEPS v2\n')
    fs.renameSync(path.join(h.team, 'skills/영업'), path.join(h.team, 'skills-old-sales'))
    try {
      const second = await send('alice', chat, fake({ echo: 'resume' }, SEP, { echo: 'message' }))
      expect(second.content).toContain('resumed=true')
      expect(second.content).toContain('## Skills changed since this chat started')
      expect(second.content).toContain('- added: New one: added during the chat')
      expect(second.content).toContain('- changed: Weekly: team weekly report')
      expect(second.content).toContain('- removed: 견적서 작성 (no longer available')
      // Codex starts fresh every turn: its instructions list the skills as they are now, no change note
      const codex = await newChat('alice', 'codex' as EngineId)
      const c = await send('alice', codex, fake({ echo: 'system' }, SEP, { echo: 'message' }), 'codex' as EngineId)
      expect(c.content).toContain('- New one: added during the chat')
      expect(c.content).not.toContain('Skills changed since')
    } finally {
      fs.renameSync(path.join(h.team, 'skills-old-sales'), path.join(h.team, 'skills/영업'))
      fs.rmSync(path.join(h.team, 'skills/new-one.md'))
    }
  })

  test('over the budget: every name stays, and the skills matching the message go in front of it', async () => {
    for (let i = 0; i < 150; i++) put(`skills/bulk/s-${String(i).padStart(3, '0')}.md`, `---\nname: Bulk workflow ${String(i).padStart(3, '0')}\ndescription: Something the team does now and then, number ${i}. ${'With more words. '.repeat(6)}\n---\nx\n`)
    put('skills/zz/견적-연장.md', '---\nname: 계약 연장 견적\ndescription: 계약을 연장하는 고객에게 견적서를 다시 보낸다\n---\nRENEW\n')
    try {
      const r = await send('alice', await newChat('alice'), '계약 연장 견적서를 보내 줘\n' + fake({ echo: 'system' }, SEP, { echo: 'message' }))
      const [system, message] = r.content.split('\n----\n')
      const part = skillPart(system!)
      for (let i = 0; i < 150; i++) expect(part).toContain(`- Bulk workflow ${String(i).padStart(3, '0')}`)
      expect(part).toContain('This list is cut to fit')
      expect(message).toStartWith('<skill_hints>')
      expect(message).toContain('- 계약 연장 견적: 계약을 연장하는 고객에게 견적서를 다시 보낸다')
      // "/name" gets the skill itself, not hints
      const invoked = await send('alice', await newChat('alice'), '/계약 연장 견적\n' + fake({ echo: 'message' }))
      expect(invoked.content).not.toContain('<skill_hints>')
      expect(invoked.content).toContain('<team_skill name="계약 연장 견적"')
      // the Team skills page says how many the AI sees by name only
      const o = await h.api('alice').call(API.skillsOverview)
      expect(o.aiList).toMatchObject({ cut: true, unlisted: 0 })
      expect(o.aiList!.nameOnly).toBeGreaterThan(0)
      expect(o.aiList!.skills).toBe(o.aiList!.described + o.aiList!.nameOnly)
    } finally {
      fs.rmSync(path.join(h.team, 'skills/bulk'), { recursive: true })
      fs.rmSync(path.join(h.team, 'skills/zz'), { recursive: true })
    }
  })
})
