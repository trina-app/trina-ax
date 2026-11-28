// One case through the real team AI: sign in as the case's person, open the chat of its context, send the prompt (and
// follow-ups), answer the cards the way a person who wants the task done would, then read back the answer, the tool
// calls (Claude Code's own transcript of the turn, which the server keeps), the files that changed and the tokens.
import { Database } from 'bun:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiClient, ApiError, type Message, type OpenTurnRequest } from '../../../shared/src/api'
import { TEAM_TOOL_PREFIX } from '../../../shared/src/product'
import { goAhead } from '../../../scripts/demo/company/chat-run'
import { PASSWORD, TEAM_ZONE, type FixtureState } from '../fixture/seed'
import { runChecks } from './checks'
import type { Case, CaseResult, CardSeen, ToolCall, TurnRecord } from './types'

export interface Env { base: string; dataDir: string; teamRoot: string; fixture: FixtureState; runId: string; commit: string; log: (s: string) => void; mockState?: string; mockUrl?: string; mockKey?: string; mockPort?: number }

/** Every file under the team folder (team path -> size:mtime); hidden folders (versions, trash) left out. */
export function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (abs: string, rel: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const r = rel ? `${rel}/${e.name.normalize('NFC')}` : e.name.normalize('NFC')
      const a = path.join(abs, e.name)
      if (e.isDirectory()) walk(a, r)
      else if (e.isFile()) { const st = fs.statSync(a); out.set(r, `${st.size}:${st.mtimeMs}`) }
    }
  }
  walk(root, '')
  return out
}

const textOf = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text: unknown }).text) : '')).join('\n') : ''

/** The tool calls and token use in transcript lines (Claude Code JSON lines). Team tools lose their prefix. */
export function readTranscript(lines: string[]): { tools: ToolCall[]; usage: TurnRecord['usage']; model: string | null } {
  const tools: ToolCall[] = []
  const open = new Map<string, ToolCall>()
  const seenMsg = new Set<string>()
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, apiCalls: 0 }
  let model: string | null = null
  for (const line of lines) {
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    const content = o.message?.content
    if (o.type === 'assistant') {
      const mid = o.message?.id
      if (mid && !seenMsg.has(mid) && o.message?.usage) {
        seenMsg.add(mid)
        const u = o.message.usage
        usage.inputTokens += u.input_tokens ?? 0
        usage.outputTokens += u.output_tokens ?? 0
        usage.cacheReadTokens += u.cache_read_input_tokens ?? 0
        usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0
        usage.apiCalls++
      }
      model ??= typeof o.message?.model === 'string' ? o.message.model : null
      if (Array.isArray(content)) for (const b of content) {
        if (b.type !== 'tool_use') continue
        const name = String(b.name).startsWith(TEAM_TOOL_PREFIX) ? String(b.name).slice(TEAM_TOOL_PREFIX.length) : String(b.name)
        const call: ToolCall = { name, input: b.input ?? {}, ok: true }
        tools.push(call)
        if (b.id) open.set(b.id, call)
      }
    } else if (o.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type !== 'tool_result') continue
        const call = open.get(b.tool_use_id)
        if (!call) continue
        call.ok = !b.is_error
        call.result = textOf(b.content).slice(0, 1500)
      }
    }
  }
  return { tools, usage, model }
}

/** the transcript lines of a chat so far (every session file of it, oldest first) */
function transcriptLines(dataDir: string, chatId: string): string[] {
  const dir = path.join(dataDir, 'sessions', chatId)
  let files: string[] = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)) } catch { return [] }
  files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
  return files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()))
}

export type CardMode = 'once' | 'always' | 'decline'
const isAlways = (o: { label: string; value: string }) => /always|항상|all_sites/i.test(`${o.value} ${o.label}`)
/** the answer to a server card: once = go ahead this time only; always = the "always allow" choice when the card has one
 * (else go ahead); decline = the card's no (its last choice, as the app orders them) */
export function pickCard(opts: { label: string; value: string }[], mode: CardMode): string | null {
  if (!opts.length) return null
  if (mode === 'decline') return opts[opts.length - 1]!.value
  if (mode === 'always') { const a = opts.find(isAlways); if (a) return a.value }
  return goAhead(opts.filter((o) => !isAlways(o))) ?? goAhead(opts)
}

const GO_ON = { ko: '네, 그렇게 해주세요. 알아서 정해서 진행해 주세요.', en: 'Yes, please go ahead and use your best judgement.', ja: 'はい、お任せします。そのまま進めてください。' }

export async function oneTurn(api: ApiClient, env: Env, c: Case, chatId: string, prompt: string, seenLines: number): Promise<{ rec: TurnRecord; lines: number }> {
  const started = Date.now()
  let sent: { assistantMessage: { id: string } }
  try {
    // the device's zone, as the web app sends it with every turn (QA TC-4549): the case's, else the team's, so no turn
    // falls back on whatever the server does without one
    sent = await api.call(API.sendMessage, { params: { id: chatId }, body: { content: prompt, attachmentIds: [], clientMessageId: crypto.randomUUID(), ...{ timeZone: c.timeZone ?? TEAM_ZONE } } })
  } catch (e) {
    // the app itself said no (a guest without AI, a limit): what the person reads is the message
    if (!(e instanceof ApiError)) throw e
    const rec: TurnRecord = { prompt, sentAt: new Date(started).toISOString(), status: 'app-refused', error: `${e.status} ${e.code}`, answer: e.message, tools: [], cards: [], saved: [], ms: Date.now() - started, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, apiCalls: 0 }, model: null }
    return { rec, lines: seenLines }
  }
  const answerId = sent.assistantMessage.id
  const cards: CardSeen[] = []
  const answered = new Set<string>()
  // a flow's heavy step has a cap (about 3 minutes): past it the turn is stopped and marked slow
  const capMs = (c as { capMs?: number }).capMs ?? 15 * 60_000
  const until = Date.now() + capMs
  let m: Message | undefined
  while (Date.now() < until) {
    await Bun.sleep(2000)
    let open: OpenTurnRequest[] = []
    try { open = (await api.call(API.listTurnRequests, { params: { id: chatId } })).items } catch {}
    for (const r of open) {
      const req = r.request
      if (answered.has(req.requestId)) continue
      answered.add(req.requestId)
      if (req.kind === 'ask_user') {
        const server = req.origin === 'server'
        // a flow step may say no on the server's cards (the person declines); a case always goes ahead
        // a flow step may say no on the server's cards; so does a case that expects a refusal (a person who wants it
        // done would say yes, but a refusal case checks what the AI does on its own, not what a yes unlocks)
        const mode = (c as { cardMode?: CardMode }).cardMode ?? ((c as { declineCards?: boolean }).declineCards === true || c.expect?.outcome === 'refuse' ? 'decline' : 'once')
        const decline = mode === 'decline'
        const opts = req.options ?? []
        const answer = server ? pickCard(opts, mode) : decline ? null : req.options?.length && !req.allowText ? req.options[0]!.value : (c.reply ?? GO_ON[c.lang])
        // (a server card's small line under its buttons says why it asks: kept with the question, so the flow report still
        // sees it; QA TC-4791 moved the post card's reason there)
        cards.push({ kind: server ? 'server-card' : 'ai-question', origin: server ? 'server' : 'ai', question: [req.question, server ? req.note : ''].filter(Boolean).join('\n').slice(0, 400), answer, options: opts.map((o) => o.label), hasAlways: opts.some(isAlways) })
        await api.call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: req.requestId, answer } }).catch(() => {})
      } else if (req.kind === 'dev_env_site' || req.kind === 'browser_site') {
        cards.push({ kind: req.kind, origin: 'server', question: 'host' in req ? String(req.host) : '', answer: 'once' })
        await api.call(API.answerTurn, { params: { id: r.turnId }, body: { kind: req.kind, requestId: req.requestId, decision: 'once' } }).catch(() => {})
      } else if (req.kind === 'connect_service') {
        cards.push({ kind: 'connect_service', origin: 'server', question: `${req.name} (${req.scope})`, answer: 'skip' })
        await api.call(API.connectTurn, { params: { id: r.turnId }, body: { action: 'skip', requestId: req.requestId } }).catch(() => {})
      }
    }
    const page = await api.call(API.listMessages, { params: { id: chatId }, query: { limit: 50 } })
    m = page.items.find((x) => x.id === answerId)
    if (m && m.status !== 'streaming') break
  }
  let slow = false
  if (m?.status === 'streaming' || !m) {
    slow = true
    await api.call(API.stop, { params: { id: chatId } }).catch(() => {})
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(1000)
      m = (await api.call(API.listMessages, { params: { id: chatId }, query: { limit: 50 } })).items.find((x) => x.id === answerId)
      if (m && m.status !== 'streaming') break
    }
  }
  // the transcript can land a little after the answer ends: wait for this turn's lines (up to 20 s)
  let all = transcriptLines(env.dataDir, chatId)
  let t = readTranscript(all.slice(seenLines))
  for (let i = 0; i < 20 && t.usage.apiCalls === 0; i++) {
    await Bun.sleep(1000)
    all = transcriptLines(env.dataDir, chatId)
    t = readTranscript(all.slice(seenLines))
  }
  // still none: the steps the app shows under the answer (names and ok only, no inputs)
  if (!t.tools.length && m?.steps.length) t = { ...t, tools: m.steps.filter((x) => x.tool).map((x) => ({ name: x.tool!.replace(/^mcp__[^_]+__/, ''), input: { label: x.label }, ok: x.status === 'ok' })) }
  // the buttons the server put under the answer's steps (Step.fixes: "Ask <owner>", "Let them view", ...): the person
  // sees them as the next step, so the judge does too (they are offers, not cards that were answered)
  for (const st of m?.steps ?? []) {
    for (const f of ((st as { fixes?: { kind: string; file?: string; owner?: string; count?: number; state?: string }[] }).fixes ?? [])) {
      cards.push({ kind: `step-fix:${f.kind}`, origin: 'server', question: `${f.kind} for ${f.file ?? '?'}${f.owner ? ` (asks ${f.owner})` : ''}${f.count !== undefined ? `, ${f.count} people` : ''}; ${f.state ?? 'open'}`.slice(0, 400), answer: null })
    }
  }
  const rec: TurnRecord = {
    prompt,
    sentAt: new Date(started).toISOString(),
    status: slow ? 'slow' : m?.status ?? 'timeout',
    error: slow ? `stopped after ${Math.round(capMs / 1000)} s (slow)` : m?.error ? `${m.error.code}: ${m.error.message}` : m ? null : 'no answer within 15 minutes',
    // an answer that ended in an error shows the app's message where the answer would be: that is what the person reads
    answer: m?.content?.trim() ? m.content : m?.error ? `[app message] ${m.error.message}` : '',
    tools: t.tools,
    cards,
    saved: m?.files?.saved.map((f) => f.path) ?? [],
    ms: Date.now() - started,
    usage: { ...t.usage, costUsd: m?.usage?.costUsd ?? 0 },
    model: t.model ?? m?.model ?? null,
  }
  return { rec, lines: all.length }
}

/** The room messages a case's AI posted (post_to_room results that say "sent"): where and which. */
export function roomPostsOf(r: Pick<CaseResult, 'turns'>): { roomId: string; messageId: string }[] {
  return r.turns.flatMap((t) => t.tools).filter((x) => x.name === 'post_to_room' && x.ok && x.result).flatMap((x) => {
    const sent = /"status"\s*:\s*"sent"/.test(x.result!)
    const room = /"room_id"\s*:\s*"([^"]+)"/.exec(x.result!)?.[1], msg = /"message_id"\s*:\s*"([^"]+)"/.exec(x.result!)?.[1]
    return sent && room && msg ? [{ roomId: room, messageId: msg }] : []
  })
}

export async function login(base: string, username: string): Promise<ApiClient> {
  const r = await new ApiClient({ baseUrl: base }).call(API.login, { body: { username, password: PASSWORD, client: 'web', tokenMode: 'bearer' } })
  return new ApiClient({ baseUrl: base, token: r.token! })
}

export async function openChat(api: ApiClient, env: Env, c: Case): Promise<string> {
  const f = env.fixture
  try { return await openChatIn(api, f, c) } catch (e) {
    // the app refused to open the chat (a guest outside their place): a chat of their own, so the refusal shows on send.
    // Only for a guest: a case meant for a shared project chat never runs quietly in a personal chat instead (on
    // 2026-11-17 two admin cases did, and their answers were graded as if the project's members had seen them).
    if (e instanceof ApiError && c.context === 'guest') return (await api.call(API.createChat, { body: {} })).id
    if (e instanceof ApiError) throw new SetupError(`${c.as} cannot open a chat in the ${c.context === 'project' ? 'project' : 'room'} (${e.message}): the case needs someone who can`)
    throw e
  }
}

/** The case cannot run as written (the fixture does not give its person the place it names): reported as "setup", never
 * judged. */
export class SetupError extends Error {
  constructor(why: string) { super(`setup: ${why}`) }
}
async function openChatIn(api: ApiClient, f: FixtureState, c: Case): Promise<string> {
  if (c.context === 'personal') return (await api.call(API.createChat, { body: {} })).id
  if (c.context === 'project' || c.context === 'guest') return (await api.call(API.createChat, { body: { projectId: f.projectId } })).id
  return (await api.call(API.createChat, { body: { sideRoomId: f.roomId } })).id
}

/** the room's messages posted since the case started (for room_message checks), as the case's person sees them:
 * a post of an earlier case never counts */
async function roomText(api: ApiClient, env: Env, since: string): Promise<string> {
  try {
    const p = await api.call(API.listRoomMessages, { params: { id: env.fixture.roomId }, query: {} })
    return p.items.filter((x) => x.createdAt >= since).map((x) => x.body).join('\n')
  } catch { return '' }
}

/** the team paths that changed between two snapshots */
export const diffOf = (before: Map<string, string>, after: Map<string, string>) => [...new Set([...after.keys(), ...before.keys()])].filter((k) => before.get(k) !== after.get(k))
/** of those, the ones this chat's turns saved or named in their tool calls (other work runs at the same time) */
export function attributed(diff: string[], turns: TurnRecord[]): string[] {
  const saved = new Set(turns.flatMap((t) => t.saved.map((p) => p.normalize('NFC'))))
  const named = turns.flatMap((t) => t.tools.map((x) => JSON.stringify(x.input))).join('\n').normalize('NFC')
  return diff.filter((k) => saved.has(k) || named.includes(k) || named.includes(k.split('/').pop()!)).sort()
}

export async function runCase(c: Case, env: Env): Promise<CaseResult> {
  const res: CaseResult = { id: c.id, runId: env.runId, commit: env.commit, startedAt: new Date().toISOString(), chatId: null, turns: [], changed: [], checks: [], jargon: [], error: null }
  const before = snapshot(env.teamRoot)
  let api: ApiClient | null = null
  try {
    api = await login(env.base, c.as)
    const chatId = await openChat(api, env, c)
    res.chatId = chatId
    try { res.chatShared = !!(await api.call(API.getChat, { params: { id: chatId } })).shared } catch {}
    // a shared project chat case runs in a chat the server calls shared, or not at all
    if (c.context === 'project' && !res.chatShared) throw new SetupError(`the chat ${c.as} opened in the project is not a shared chat`)
    let lines = 0
    for (const p of [c.prompt, ...c.followUps]) {
      const r = await oneTurn(api, env, c, chatId, p, lines)
      lines = r.lines
      res.turns.push(r.rec)
      env.log(`${c.id}: turn ${res.turns.length} ${r.rec.status} in ${Math.round(r.rec.ms / 1000)} s, ${r.rec.tools.length} tool calls${r.rec.cards.length ? `, ${r.rec.cards.length} cards` : ''}`)
      if (r.rec.status !== 'done') break
    }
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e)
    env.log(`${c.id}: ERROR ${res.error}`)
  }
  const after = snapshot(env.teamRoot)
  // made or changed, and fixture files that are gone (renamed, moved, deleted)
  // Only what THIS case did: other cases run at the same time on the same team folder. A path counts when the server
  // says this chat saved it, or when this case's own tool calls name it (a rename, a move, a delete).
  const diff = [...new Set([...after.keys(), ...before.keys()])].filter((k) => before.get(k) !== after.get(k))
  const saved = new Set(res.turns.flatMap((t) => t.saved.map((p) => p.normalize('NFC'))))
  const named = res.turns.flatMap((t) => t.tools.map((x) => JSON.stringify(x.input))).join('\n').normalize('NFC')
  res.changed = diff.filter((k) => saved.has(k) || named.includes(k) || named.includes(k.split('/').pop()!)).sort()
  const room = api && c.expect.checks.some((k) => k.type === 'room_message' || k.type === 'no_room_message') ? await roomText(api, env, res.startedAt) : ''
  res.checks = await runChecks([{ type: 'answered' }, ...c.expect.checks], { teamRoot: env.teamRoot, changed: res.changed, turns: res.turns, room })
  res.jargon = jargonIn(res.turns.map((t) => t.answer).join('\n'))
  return res
}

/** Words a non-developer should not have to read (docs/DECISIONS.md and the owner's 11-11 rule): engine and tool
 * words, programming words and internal names. The judge decides; this list only points at them. */
const JARGON: [string, RegExp][] = [
  ['terminal', /\bterminal\b|터미널/i], ['python', /\bpython\b|파이썬/i], ['script', /\bscripts?\b|스크립트/i],
  ['command', /\bcommand(-| )line\b|\bshell\b|\bbash\b|명령어|명령줄|셸/i], ['code', /\b(run|write|execute)s? (the )?code\b|코드(를|로)? ?(실행|작성|돌)/i],
  ['server', /\bserver\b|서버/i], ['sandbox', /\bsandbox\b|샌드박스/i], ['MCP/API', /\bMCP\b|\bAPI\b/], ['plugin', /\bplug-?in\b|플러그인/i],
  ['engine', /\bengine\b|엔진/i], ['tool name', /\b(make_file|edit_files|edit_hwp|box_shell|share_file|post_to_room|find_skills|hwp_render|save_url|web_fetch|ask_user|move_files|copy_files|rename_file|stamp_pdf|room_read)\b/],
  ['tool', /\b(the |a |no )tool\b|도구가 없|툴이 없|툴로/i], ['json', /\bJSON\b|\bregex\b|정규식/],
]
export function jargonIn(text: string): string[] {
  return JARGON.filter(([, re]) => re.test(text)).map(([w]) => w)
}
