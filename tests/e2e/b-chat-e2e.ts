// Component B end-to-end check with the REAL engines (owner's local logins): the whole app on a Bun server, a
// WebSocket per person, Claude Code (8 turns) and the Codex CLI (2 turns) through the launcher, gate and bridge.
//   bun run tests/e2e/b-chat-e2e.ts [--no-codex | --codex-only]
// Every call is bounded (max engine turns, per-turn time limit). Prints a JSON report; exit 1 on a failed check.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { CLAUDE_BIN, CODEX_BIN, leakScan } from '../lib/engines'
import { CANARY_RE } from '../lib/fixtures'
import { ask, startHarness } from '../lib/b-harness'

const codexOnly = process.argv.includes('--codex-only')
const withCodex = !process.argv.includes('--no-codex') && !!CODEX_BIN
const h = await startHarness({
  name: 'b-e2e', realEngines: true, realCore: { engine: { authMode: 'local-login', ...(CODEX_BIN ? { codexBin: CODEX_BIN } : {}) } }, maxEngineTurns: 12, turnTimeoutMs: 5 * 60_000, askUserTimeoutMs: 3 * 60_000,
  allowCmds: [CLAUDE_BIN, ...(CODEX_BIN ? [CODEX_BIN] : [])], sessionRoots: [path.join(os.homedir(), '.claude', 'projects')],
})
const checks: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail: unknown = '') => { checks.push({ name, ok, detail: String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) }); console.error(`${ok ? 'PASS' : 'FAIL'} ${name}`) }
const answers: string[] = []
const turns: unknown[] = []
const T = 6 * 60_000
let claudeCalls = 0, codexCalls = 0

const alice = await h.ws('alice', { windowId: 'win-e2e-alice' })
await alice.next('hello')
const bob = await h.ws('bob', { windowId: 'win-e2e-bob01' })
await bob.next('hello')
const audit = (turnId: string) => h.ctx.db.query('SELECT tool, ok FROM tool_events WHERE turn_id = ? ORDER BY id').all(turnId) as { tool: string; ok: number }[]
const run = async (chatId: string, text: string, engine: 'claude' | 'codex' = 'claude') => {
  if (engine === 'claude') claudeCalls++; else codexCalls++
  const t0 = Date.now()
  const r = await ask(h, alice, 'alice', chatId, text, { ms: T })
  answers.push(r.done.content)
  turns.push({ engine, seconds: (Date.now() - t0) / 1000, status: r.done.status, error: r.done.error, tools: r.done.steps.map((s) => `${s.tool}:${s.status}`), files: r.done.files, answer: r.done.content.slice(0, 300) })
  return r
}

async function checkClaude() {
  // 1) find & summarize (file tools, streaming, steps)
  const main = await h.api('alice').call(API.createChat, { body: {} })
  const t1 = await run(main.id, 'Find the meeting notes in the team drive that record pricing decisions and summarize those decisions in 2-3 bullet points. Mention the file names.')
  check('T1 answer has the pricing decisions', /33,?000|2 free months/i.test(t1.done.content), t1.done.content)
  check('T1 searched and read through our tools', audit(t1.started.turnId).some((a) => ['grep', 'glob'].includes(a.tool)) && audit(t1.started.turnId).some((a) => a.tool === 'read' && a.ok === 1), audit(t1.started.turnId))
  const deltas = alice.frames.filter((f) => f.type === 'message.delta' && f.data.messageId === t1.started.assistantMessage.id).length
  check('T1 streamed as deltas over the WebSocket', deltas > 1, deltas)
  check('T1 steps have human labels', t1.done.steps.length > 0 && t1.done.steps.every((s) => s.label && !s.label.includes('{')), t1.done.steps.map((s) => s.label))

  // 2) change a shared file: summary under the answer, files.changed to bob
  const t2 = await run(main.id, 'In shared/edit-me.md change the status from DRAFT to "IN REVIEW" and add a final line "Reviewed by Alice". Keep everything else.')
  const after = fs.readFileSync(path.join(h.team, 'shared/edit-me.md'), 'utf8')
  check('T2 edit applied', /IN REVIEW/.test(after) && /Reviewed by Alice/.test(after), after)
  check('T2 file summary under the answer', !!t2.done.files?.saved.some((s) => s.path === 'shared/edit-me.md'), t2.done.files)
  const bf = await bob.next('files.changed', (f) => f.data.changes.some((c) => c.path === 'shared/edit-me.md'), 10_000).catch(() => null)
  check('T2 bob (can read shared/) got files.changed', !!bf)

  // 3) resume the stashed session
  const t3 = await run(main.id, 'Which file did you just change, and what exactly did you add? Answer in one sentence without using any tools.')
  check('T3 remembers the previous turn (session resumed)', /edit-me\.md/.test(t3.done.content) && /Reviewed by Alice/i.test(t3.done.content), t3.done.content)
  const leaf = (h.ctx.db.query('SELECT engine_session_leaf_id FROM chats WHERE id = ?').get(main.id) as { engine_session_leaf_id: string }).engine_session_leaf_id
  check('T3 session stash follows the branch', leaf === t3.started.assistantMessage.id && fs.existsSync(path.join(h.dataDir, 'sessions', main.id)))

  // 4) ask_user card answered over REST
  const c4 = await h.api('alice').call(API.createChat, { body: {} })
  claudeCalls++
  const s4 = await h.api('alice').call(API.sendMessage, { params: { id: c4.id }, body: { content: 'Use the ask_user tool to ask me which title I prefer, with the options "Alpha" and "Beta". After I answer, reply with only the chosen title.', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  const card = await alice.next('turn.request', (f) => f.data.turnId === s4.turnId, T).catch(() => null)
  check('T4 ask_user card arrived', !!card, card?.data.request)
  if (card) await h.api('alice').call(API.answerTurn, { params: { id: s4.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'Beta' } })
  const d4 = await alice.next('message.done', (f) => f.data.messageId === s4.assistantMessage.id, T)
  answers.push(d4.data.message.content)
  check('T4 answer uses the person\'s choice', /Beta/.test(d4.data.message.content) && !/Alpha/.test(d4.data.message.content), d4.data.message.content)

  // 5) remember in a clean chat
  const c5 = await h.api('alice').call(API.createChat, { body: {} })
  const t5 = await run(c5.id, 'Please remember for future chats: I prefer answers as short bullet points. Use your remember tool, then confirm in one short sentence.')
  const mem = h.ctx.db.query("SELECT text, source FROM memories WHERE user_id = 'alice'").all() as { text: string; source: string }[]
  check('T5 memory saved by the remember tool', mem.some((m) => /bullet/i.test(m.text)), { mem, steps: t5.done.steps.map((s) => s.label) })

  // 6) project instructions shape the answer
  const proj = await h.api('alice').call(API.createProject, { body: { name: 'Falcon', folderPath: 'projects/falcon', instructions: 'End every answer with the single word FALCON on its own line.' } })
  const c6 = await h.api('alice').call(API.createChat, { body: { projectId: proj.id } })
  const t6 = await run(c6.id, 'In one sentence: what is the kickoff date in the project plan?')
  check('T6 project instructions followed', /FALCON\s*$/.test(t6.done.content.trim()) && /2026-10-01|October 1|10월 1일|1 Oktober/i.test(t6.done.content), t6.done.content)

  // 7) stop while streaming
  const c7 = await h.api('alice').call(API.createChat, { body: {} })
  claudeCalls++
  const s7 = await h.api('alice').call(API.sendMessage, { params: { id: c7.id }, body: { content: 'Write a 1500-word essay about the history of paper. No tools.', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  await alice.next('message.delta', (f) => f.data.messageId === s7.assistantMessage.id, T)
  await h.api('alice').call(API.stop, { params: { id: c7.id } })
  const d7 = await alice.next('message.done', (f) => f.data.messageId === s7.assistantMessage.id, 60_000)
  check('T7 stop: answer stopped with partial text', d7.data.status === 'stopped' && d7.data.message.content.length > 0, { status: d7.data.status, len: d7.data.message.content.length })

  // 8) a resumed session sees instructions that changed since it started (memory saved in T5, after T3)
  const t8 = await run(main.id, 'Without using any tools: in one sentence, how do I prefer my answers to be formatted?')
  check('T8 resumed session got this turn\'s instructions (memory)', /bullet|글머리|불릿|요점/i.test(t8.done.content), t8.done.content)

}

try {
  if (!codexOnly) await checkClaude()
  // codex: tools, then the history in the instructions
  if (withCodex) {
    const cx = await h.api('alice').call(API.createChat, { body: { engine: 'codex' } })
    const x1 = await run(cx.id, 'Using the team tools, find which file in shared/meetings mentions "33,000" and tell me its file name.', 'codex')
    check('C1 codex answer correct', /meeting-03/.test(x1.done.content), x1.done.content)
    check('C1 codex used our tools', audit(x1.started.turnId).some((a) => ['grep', 'glob', 'read'].includes(a.tool)), audit(x1.started.turnId))
    const x2 = await run(cx.id, 'Without using any tools: which file name did you just tell me? Answer with the file name only.', 'codex')
    check('C2 codex continues the conversation (history)', /meeting-03/.test(x2.done.content), x2.done.content)
  }

  if (codexOnly) check('Codex CLI is installed', withCodex)
  const leaks = leakScan(h.team, answers, CANARY_RE)
  check('no canary string reached alice', leaks.length === 0, leaks)
  check(`call budget (claude ${claudeCalls} <= 8, codex ${codexCalls} <= 2)`, claudeCalls <= 8 && codexCalls <= 2)
} catch (e) {
  check('e2e ran to the end', false, (e as Error).stack ?? String(e))
} finally {
  alice.close(); bob.close()
  await h.close()
}
const failed = checks.filter((c) => !c.ok)
console.log(JSON.stringify({ ok: failed.length === 0, checks, turns }, null, 2))
process.exit(failed.length ? 1 : 0)
