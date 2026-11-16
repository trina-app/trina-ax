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
import { PASSWORD, type FixtureState } from '../fixture/seed'
import { runChecks } from './checks'
import type { Case, CaseResult, CardSeen, ToolCall, TurnRecord } from './types'

export interface Env { base: string; dataDir: string; teamRoot: string; fixture: FixtureState; runId: string; commit: string; log: (s: string) => void }

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

const GO_ON = { ko: '네, 그렇게 해주세요. 알아서 정해서 진행해 주세요.', en: 'Yes, please go ahead and use your best judgement.' }

async function oneTurn(api: ApiClient, env: Env, c: Case, chatId: string, prompt: string, seenLines: number): Promise<{ rec: TurnRecord; lines: number }> {
  const started = Date.now()
  let sent: { assistantMessage: { id: string } }
  try {
    sent = await api.call(API.sendMessage, { params: { id: chatId }, body: { content: prompt, attachmentIds: [], clientMessageId: crypto.randomUUID() } })
  } catch (e) {
    // the app itself said no (a guest without AI, a limit): what the person reads is the message
    if (!(e instanceof ApiError)) throw e
    const rec: TurnRecord = { prompt, status: 'app-refused', error: `${e.status} ${e.code}`, answer: e.message, tools: [], cards: [], saved: [], ms: Date.now() - started, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, apiCalls: 0 }, model: null }
    return { rec, lines: seenLines }
  }
  const answerId = sent.assistantMessage.id
  const cards: CardSeen[] = []
  const answered = new Set<string>()
  const until = Date.now() + 15 * 60_000
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
        const answer = server ? goAhead(req.options ?? []) : req.options?.length && !req.allowText ? req.options[0]!.value : (c.reply ?? GO_ON[c.lang])
        cards.push({ kind: server ? 'server-card' : 'ai-question', origin: server ? 'server' : 'ai', question: req.question.slice(0, 400), answer })
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
  // the transcript is written as the turn goes; give the last lines a moment
  await Bun.sleep(1500)
  const all = transcriptLines(env.dataDir, chatId)
  const t = readTranscript(all.slice(seenLines))
  const rec: TurnRecord = {
    prompt,
    status: m?.status ?? 'timeout',
    error: m?.error ? `${m.error.code}: ${m.error.message}` : m ? null : 'no answer within 15 minutes',
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

async function login(base: string, username: string): Promise<ApiClient> {
  const r = await new ApiClient({ baseUrl: base }).call(API.login, { body: { username, password: PASSWORD, client: 'web', tokenMode: 'bearer' } })
  return new ApiClient({ baseUrl: base, token: r.token! })
}

async function openChat(api: ApiClient, env: Env, c: Case): Promise<string> {
  const f = env.fixture
  try { return await openChatIn(api, f, c) } catch (e) {
    // the app refused to open the chat (a guest outside their place): a chat of their own, so the refusal shows on send
    if (e instanceof ApiError) return (await api.call(API.createChat, { body: {} })).id
    throw e
  }
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

export async function runCase(c: Case, env: Env): Promise<CaseResult> {
  const res: CaseResult = { id: c.id, runId: env.runId, commit: env.commit, startedAt: new Date().toISOString(), chatId: null, turns: [], changed: [], checks: [], jargon: [], error: null }
  const before = snapshot(env.teamRoot)
  let api: ApiClient | null = null
  try {
    api = await login(env.base, c.as)
    const chatId = await openChat(api, env, c)
    res.chatId = chatId
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
  res.changed = [...new Set([...after.keys(), ...before.keys()])].filter((k) => before.get(k) !== after.get(k)).sort()
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
