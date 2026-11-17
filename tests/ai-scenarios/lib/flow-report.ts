// A flow's Sonnet judge and the flow report: per flow the first step that broke and why, cost and time, and the
// prompts (cards, confirmations, questions) each person saw, with the prompt-fatigue flags the owner asked for.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { normUrl, urlsIn, type Flow, type FlowResult } from './flow'
import { ROOM_NAME } from '../fixture/seed'

export const FlowJudgement = z.object({
  pass: z.boolean(),
  first_broken_step: z.number().int().nullable(),
  root_cause: z.enum(['none', 'missing tool', 'prompt over-refusal', 'permission bug', 'jargon', 'wrong claim', 'tool failure', 'wrong result', 'lost context', 'other']),
  why: z.string(),
  /** cards or questions for something the person had plainly asked for in that same step */
  needless_prompts: z.array(z.string()),
})
export type FlowJudgement = z.infer<typeof FlowJudgement>

const RUBRIC = `You grade one multi-step work flow of "Trina", a team AI used by ordinary office workers (not developers).
Several fictional people take turns: each "ask" step is a person's message to the AI and its answer (with the actions it
took and the confirmation cards the app showed that person); each "event" step is something another person or a service
did (a room message, a file changed, a mail arriving through a room app). Automatic checks ran after every step.

Decide:
- first_broken_step: the number of the first step where the flow went wrong for the people (wrong or missing result,
  a wrong refusal, a wrong claim, lost context from earlier steps, a permission problem, developer jargon), or null.
  A failed automatic check usually means that step broke, unless the check itself is clearly wrong.
- root_cause of that first break: missing tool / prompt over-refusal / permission bug / jargon / wrong claim / tool
  failure / wrong result / lost context (forgot or misread what happened in earlier steps) / other; none when it passed.
- needless_prompts: each confirmation card or question that asked the person about something they had plainly just
  asked for in that same step (e.g. "send this to the room?" right after "send this to the room"), as
  "step N: <card in a few words>". Cards that protect other people (who can see what) are not needless.
- pass: true only when every step did what it should.
- why: two or three plain sentences.
Answer with the JSON object only.`

const SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' }, first_broken_step: { type: ['integer', 'null'] },
    root_cause: { enum: ['none', 'missing tool', 'prompt over-refusal', 'permission bug', 'jargon', 'wrong claim', 'tool failure', 'wrong result', 'lost context', 'other'] },
    why: { type: 'string' }, needless_prompts: { type: 'array', items: { type: 'string' } },
  },
  required: ['pass', 'first_broken_step', 'root_cause', 'why', 'needless_prompts'],
}

export function flowJudgeInput(f: Flow, r: FlowResult): string {
  const steps = r.steps.map((s) => {
    const def = f.steps[s.index - 1]!
    const head = def.ask ? `### Step ${s.index} — ${def.ask.as} asks the AI (${def.ask.context} chat "${def.ask.chat}"): ${def.ask.prompt}` : `### Step ${s.index} — event: ${JSON.stringify(def.event)}`
    const t = s.turn
    return [
      head, `Purpose: ${s.say}`,
      t ? `Actions: ${t.tools.map((x) => `${x.name}${x.ok ? '' : ' (FAILED)'} ${JSON.stringify(x.input).slice(0, 200)}${x.result ? ` -> ${x.result.slice(0, 150).replace(/\s+/g, ' ')}` : ''}`).join('\n  ') || 'none'}` : '',
      t ? `Cards shown to ${s.as}: ${t.cards.map((k) => `[${k.origin}] ${k.question.slice(0, 200)} -> ${k.answer}`).join('; ') || 'none'}` : '',
      t ? `Status: ${t.status}${t.error ? ` (${t.error})` : ''}\nAI answer:\n${t.answer || '(empty)'}` : s.error ? `Event failed: ${s.error}` : 'Event done.',
      `Files changed: ${s.changed.join(', ') || 'none'}`,
      `Checks: ${s.checks.map((k) => `${k.ok ? 'PASS' : 'FAIL'} ${k.check.type}: ${k.detail}`).join('; ') || 'none'}`,
    ].filter(Boolean).join('\n')
  }).join('\n\n')
  return `${RUBRIC}\n\n## Flow ${f.id}: ${f.title}\n${f.why ? `Why: ${f.why}\n` : ''}${f.mocked ? 'The connected services in this flow are MOCKS with made-up data (treat them as real).\n' : ''}\n${steps}`
}

export async function judgeFlow(f: Flow, r: FlowResult): Promise<FlowJudgement> {
  const p = Bun.spawn(['claude', '-p', '--model', 'sonnet', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--no-session-persistence', '--json-schema', JSON.stringify(SCHEMA)], { stdin: new TextEncoder().encode(flowJudgeInput(f, r)), stdout: 'pipe', stderr: 'pipe', cwd: '/tmp' })
  const out = await new Response(p.stdout).text()
  await p.exited
  const o = JSON.parse(out)
  const v = FlowJudgement.safeParse(o.structured_output)
  if (!v.success) throw new Error(`flow verdict is not valid: ${String(o.result ?? out).slice(0, 300)}`)
  return v.data
}

/** every prompt each person saw in a flow, and the fatigue flags */
export function prompts(r: FlowResult) {
  const list = r.steps.flatMap((s) => [...(s.turn?.cards ?? []), ...(s.uiPrompts ?? [])].map((k) => ({ step: s.index, as: s.as, kind: k.kind, origin: k.origin, question: k.question.replace(/\s+/g, ' '), hasAlways: !!k.hasAlways, options: k.options ?? [] })))
  // the same kind of card again for one person: the first 30 characters of its question, numbers and names taken out
  const key = (q: string) => q.replace(/[0-9]+/g, '#').replace(/[«“"'].*?[»”"']/g, '…').slice(0, 30)
  const seen = new Map<string, number>()
  const repeats: string[] = []
  for (const p of list.filter((x) => x.origin === 'server')) {
    const k = `${p.as}|${key(p.question)}`
    seen.set(k, (seen.get(k) ?? 0) + 1)
    if (seen.get(k) === 2) repeats.push(`${p.as}: "${p.question.slice(0, 70)}" (again at step ${p.step})`)
  }
  const noAlways = list.filter((p) => p.origin === 'server' && !p.hasAlways).map((p) => `step ${p.step} ${p.as}: "${p.question.slice(0, 80)}" [${p.options.join(' / ')}]`)
  const perPerson: Record<string, number> = {}
  for (const p of list) perPerson[p.as] = (perPerson[p.as] ?? 0) + 1
  return { list, repeats, noAlways, perPerson }
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

export function writeFlowReport(flows: Flow[], runs: { label: string; results: FlowResult[] }[], file: string): string {
  const L: string[] = []
  const main = runs[0]!
  const byId = new Map(main.results.map((r) => [r.id, r]))
  const ran = flows.filter((f) => byId.has(f.id))
  const verdict = (r: FlowResult) => (r.judge as unknown as FlowJudgement | undefined)
  const pass = ran.filter((f) => verdict(byId.get(f.id)!)?.pass && !absurdPrompts(byId.get(f.id)!, { roomName: ROOM_NAME, afterAlways: runs[1]?.results.find((x) => x.id === f.id) }).length).length
  const turns = main.results.flatMap((r) => r.steps.flatMap((s) => (s.turn ? [s.turn] : [])))
  L.push(`# AI scenario flows: ${main.label}`, '')
  L.push(`${ran.length} flows: ${pass} pass; ${ran.length - pass} broke or have flagged prompts. ${turns.length} AI turns, ${turns.reduce((a, t) => a + t.usage.outputTokens, 0).toLocaleString('en')} output tokens, ${turns.reduce((a, t) => a + t.usage.cacheReadTokens, 0).toLocaleString('en')} cache read, list-price equivalent $${turns.reduce((a, t) => a + t.usage.costUsd, 0).toFixed(2)}; ${Math.round(turns.reduce((a, t) => a + t.ms, 0) / 60000)} min of turns.`, '')
  L.push('| Flow | Group | Steps | Result | First broken step | Why | Prompts (per person) | Time | Cost |', '|---|---|---|---|---|---|---|---|---|')
  for (const f of ran) {
    const r = byId.get(f.id)!
    const v = verdict(r)
    const p = prompts(r)
    const t = r.steps.flatMap((s) => (s.turn ? [s.turn] : []))
    const slow = t.filter((x) => x.status === 'slow').length
    const broken = v?.first_broken_step ?? r.firstBroken
    const say = broken ? f.steps[broken - 1]?.say ?? '' : ''
    const fl = absurdPrompts(r, { roomName: ROOM_NAME, afterAlways: runs[1]?.results.find((x) => x.id === f.id) })
    L.push(`| ${f.id} ${cell(f.title)}${f.mocked ? ' (mocked)' : ''}${f.fixInProgress ? ' (fix in progress)' : ''} | ${f.group} | ${f.steps.length} | ${v ? (v.pass && !fl.length ? 'pass' : v.pass ? `fail (${fl.length} prompt flags)` : `broke${fl.length ? `, ${fl.length} prompt flags` : ''}`) : 'not judged'} | ${broken ? `${broken}: ${cell(say)}` : '-'} | ${v ? `[${v.root_cause}] ${cell(v.why)}` : ''} | ${p.list.length}${Object.keys(p.perPerson).length ? ` (${Object.entries(p.perPerson).map(([a, n]) => `${a} ${n}`).join(', ')})` : ''} | ${Math.round(t.reduce((a, x) => a + x.ms, 0) / 1000)} s${slow ? `, ${slow} slow` : ''} | $${t.reduce((a, x) => a + x.usage.costUsd, 0).toFixed(2)} |`)
  }
  const second = runs[1] ? new Map(runs[1].results.map((r) => [r.id, r])) : null
  const flags = new Map(ran.map((f) => [f.id, absurdPrompts(byId.get(f.id)!, { roomName: ROOM_NAME, afterAlways: second?.get(f.id) })]))
  L.push('', '## Absurd prompts (each fails its flow)', '', 'A prompt is flagged when it asks about what the person explicitly asked in that message, repeats for the same target in the same chat, opens an address already pasted in the chat or its room (tracking query, fragment and trailing slash ignored), warns about private content that came from that same room, or has no "Always allow"; a flow is also flagged for more than 1 prompt with the defaults or more than 0 after Always allow.', '')
  const flaggedFlows = ran.filter((f) => flags.get(f.id)!.length)
  L.push(`${flaggedFlows.length} of ${ran.length} flows have flagged prompts.`, '')
  for (const f of flaggedFlows) {
    L.push(`### ${f.id} ${f.title}`)
    for (const x of flags.get(f.id)!) L.push(`- ${x.step ? `step ${x.step}, ${x.as}: "${x.question}"` : x.question} — **${x.reason}**`)
    L.push('')
  }
  L.push('', '## Prompts per flow', '', 'Every card, confirmation and question each person saw (default run: the person answers "this time" on a card).', '')
  for (const f of ran) {
    const p = prompts(byId.get(f.id)!)
    const v = verdict(byId.get(f.id)!)
    L.push(`### ${f.id} — ${p.list.length} prompts`)
    for (const x of p.list) L.push(`- step ${x.step}, ${x.as}, ${x.origin === 'server' ? 'card' : 'AI question'}: ${x.question.slice(0, 160)}${x.origin === 'server' ? (x.hasAlways ? ' — has Always allow' : ' — **no Always allow**') : ''}`)
    if (p.repeats.length) L.push(`- **Repeats:** ${p.repeats.join('; ')}`)
    if (v?.needless_prompts.length) L.push(`- **Asked for what was plainly asked:** ${v.needless_prompts.join('; ')}`)
    L.push('')
  }
  const allNoAlways = ran.flatMap((f) => prompts(byId.get(f.id)!).noAlways.map((x) => `${f.id} ${x}`))
  L.push('## Cards without an "Always allow" choice', '', ...(allNoAlways.length ? allNoAlways.map((x) => `- ${x}`) : ['- none']), '')
  if (runs[1]) {
    const second = new Map(runs[1].results.map((r) => [r.id, r]))
    L.push(`## After "Always allow" (${runs[1].label})`, '', 'The same flows, the people choosing "Always allow" on every card that has it. Near zero is the goal.', '', '| Flow | Prompts, default | Prompts, after always allow | Left |', '|---|---|---|---|')
    for (const f of ran) {
      const a = prompts(byId.get(f.id)!), b = second.get(f.id) ? prompts(second.get(f.id)!) : null
      L.push(`| ${f.id} | ${a.list.length} | ${b ? b.list.length : '-'} | ${b ? cell(b.list.map((x) => `step ${x.step} ${x.as}: ${x.question.slice(0, 60)}`).join('; ')) : ''} |`)
    }
    L.push('')
  }
  L.push('## Steps', '')
  for (const f of ran) {
    const r = byId.get(f.id)!
    L.push(`### ${f.id} ${f.title}`)
    for (const s of r.steps) {
      const bad = s.checks.filter((k) => !k.ok)
      L.push(`${s.index}. ${s.say} (${s.kind}${s.as ? `, ${s.as}` : ''})${s.turn ? ` — ${s.turn.status}, ${Math.round(s.turn.ms / 1000)} s, ${s.turn.tools.length} actions, ${s.turn.cards.length} prompts` : ''}${s.error ? ` — ERROR ${s.error}` : ''}${bad.length ? ` — **failed:** ${bad.map((k) => `${k.check.type} (${k.detail.slice(0, 100)})`).join('; ')}` : ''}${s.jargon.length ? ` — words: ${s.jargon.join(', ')}` : ''}`)
    }
    L.push('')
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, L.join('\n') + '\n')
  return file
}

// ---------------- absurd prompts (owner 2026-11-16: "5 prompts to save a teammate's meeting-notes link") ----------------
export interface Flagged { step: number; as: string; question: string; reason: string }

/** what a server card asks to do, and the words in a person's message that ask for that same thing */
const ACTIONS: { kind: string; card: RegExp; asked: RegExp }[] = [
  { kind: 'share', card: /공유할까요|share .*\?|공유하려고/i, asked: /공유|share|보여\s?줘/i },
  { kind: 'connector write', card: /에 이 내용을 보내려고 해요|wants to send this to/i, asked: /바꿔|고쳐|추가|만들|올려|달아|옮겨|보내|넣어|update|add|create|comment|move|send|change/i },
  { kind: 'open address', card: /주소를 열려고|open this address/i, asked: /https?:\/\//i },
  { kind: 'skill save', card: /팀 스킬|스킬\/규칙|team skill/i, asked: /스킬|skill/i },
  { kind: 'send', card: /보낼까요|올릴까요|보내기 전에|post (it|this)|send (it|this)/i, asked: /보내|올려|전달|답글|남겨|달아|공유|send|post|forward|reply/i },
  { kind: 'save', card: /저장할까요|저장하려고|save (it|this)/i, asked: /저장|만들어|넣어|옮겨|save|make|create|put/i },
  { kind: 'delete', card: /지울까요|휴지통|delete/i, asked: /지워|삭제|빼|delete|remove/i },
  { kind: 'change', card: /바꾸기 전에|이 작업을 하려고|파일 수정/i, asked: /고쳐|바꿔|수정|추가|넣어|edit|change|fix|update/i },
]
const SAME_ROOM_CONTENT = /대화의 메시지|다른 사람이 쓴 글|messages from (the|this) (room|conversation)|room's messages/i
/** the place a card is about: a quoted name, a path after ›, or the room's name */
function target(q: string, roomName: string): string {
  if (q.includes(roomName)) return roomName
  const m = /›\s*([^?]+?)(에|을|를|\?|$)/.exec(q) ?? /'([^']+)'|"([^"]+)"/.exec(q)
  return (m?.[1] ?? m?.[2] ?? '').trim().slice(0, 60)
}

/** Every prompt of a flow run that should not have been there, with why; and the flow-level counts against the
 * owner's limits (more than 1 prompt with defaults, more than 0 after Always allow). */
export function absurdPrompts(r: FlowResult, o: { roomName: string; afterAlways?: FlowResult }): Flagged[] {
  const out: Flagged[] = []
  const seen = new Map<string, number>()
  let total = 0
  for (const s of r.steps) {
    const cards = [...(s.turn?.cards ?? []), ...(s.uiPrompts ?? [])]
    const prompt = s.prompts?.[s.prompts.length - 1] ?? ''
    for (const k of cards) {
      total++
      const q = k.question.replace(/\s+/g, ' ')
      const flag = (reason: string) => out.push({ step: s.index, as: s.as, question: q.slice(0, 160), reason })
      if (k.origin !== 'server') continue
      const act = ACTIONS.find((a) => a.card.test(q))
      if (act?.kind === 'open address') {
        const u = (q.match(/https?:\/\/[^\s)<>]+/) ?? [])[0]
        const nu = u ? normUrl(u) : ''
        const inPrompt = (s.prompts ?? []).slice(-1).flatMap(urlsIn).map(normUrl)
        if (nu && inPrompt.includes(nu)) flag('opens an address the person pasted in this very message')
        else if (nu && (s.seenUrls ?? []).includes(nu)) flag(`opens an address already in this ${s.context === 'room-side' ? 'chat or its room' : 'chat or the group chat'}`)
      } else if (act && act.asked.test(prompt)) flag(`asks about what ${s.as} explicitly asked for (${act.kind}) in this message`)
      if (SAME_ROOM_CONTENT.test(q) && (s.context === 'room-side' || q.includes(o.roomName)) && (q.includes(o.roomName) || /스레드|thread|이 방|this room|대화방/i.test(q)))
        flag('a private-content warning about content that came from that same room')
      if (!k.hasAlways) flag('this card has no "Always allow"')
      const key = `${s.as}|${s.chat}|${act?.kind ?? q.slice(0, 20)}|${target(q, o.roomName)}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
      if (seen.get(key)! > 1) flag('asks again for the same target in the same chat')
    }
  }
  if (total > 1) out.push({ step: 0, as: '', question: `${total} prompts in the flow`, reason: 'more than 1 prompt with the defaults' })
  if (o.afterAlways) {
    const n = o.afterAlways.steps.reduce((a, s) => a + (s.turn?.cards.length ?? 0) + (s.uiPrompts?.length ?? 0), 0)
    if (n > 0) out.push({ step: 0, as: '', question: `${n} prompts after Always allow: ${o.afterAlways.steps.flatMap((s) => (s.turn?.cards ?? []).map((k) => `step ${s.index} ${k.question.replace(/\s+/g, ' ').slice(0, 50)}`)).join('; ')}`, reason: 'more than 0 prompts after Always allow' })
  }
  // one line per prompt and reason (a card that fails several rules is listed under each)
  return out
}
