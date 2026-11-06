// Record a demo content's real answers (the scenarios in <content>/company.json) into <content>/recordings/.
//
//   1. bun run demo:company --content <dir> --port 19832 --relay-port 19833 --data ~/.<id>demo-rec --local --record
//      (--record: no replays, so every prompt goes to the real AI; the Mac's Claude Code login answers)
//   2. bun scripts/demo/company/record.ts --content <dir> --base http://127.0.0.1:19832 --data ~/.<id>demo-rec/data
//      [--only a,b] [--jobs 3]
//
// --content defaults like the starter's (MYCEL_DEMO_CONTENT, else the open example scripts/demo/acme).
// Each scenario runs as its demo person in a new chat, through the public API, to the end. Then the answer is written
// down from Claude Code's own transcript of that turn (the session file the server keeps, <data>/sessions/<chat>/):
// the text blocks and every tool call with its input, in order, with the time since the start. Nothing is written by
// hand: what a replay shows is what this run did. A run that used a sub-agent, was asked a question by the AI, or did
// not finish is refused (run it again).
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, ApiClient, DemoRecording, type DemoRecordingEvent } from '../../../shared/src/api'
import { TEAM_TOOL_PREFIX } from '../../../shared/src/product'
import { DEMO_PASSWORD } from '../seed'
import { runPrompt } from './chat-run'
import { contentDir, loadContent, type Scenario } from './content'

interface Block { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }
const textOf = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text: unknown }).text) : '')).join('\n') : ''

/** The events of one Claude Code transcript (JSON lines), or why it cannot be a recording. */
export function transcriptEvents(jsonl: string): { events: DemoRecordingEvent[]; model: string | null } | { problem: string } {
  const events: DemoRecordingEvent[] = []
  const open = new Map<string, { ev: Extract<DemoRecordingEvent, { type: 'tool' }>; at: number }>()
  let t0: number | null = null
  let model: string | null = null
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    if (o.isSidechain) return { problem: 'the run used a sub-agent' }
    const at = Date.parse(o.timestamp ?? '') || 0
    const content: Block[] | string | undefined = o.message?.content
    if (o.type === 'user' && t0 === null) t0 = at
    if (t0 === null) continue
    const t = Math.max(0, at - t0)
    if (o.type === 'assistant' && Array.isArray(content)) {
      model ??= typeof o.message?.model === 'string' ? o.message.model : null
      for (const b of content) {
        if (b.type === 'text' && b.text) events.push({ type: 'text', t, text: b.text })
        else if (b.type === 'tool_use' && b.id && b.name) {
          if (['Agent', 'Task'].includes(b.name)) return { problem: 'the run used a sub-agent' }
          if (b.name === `${TEAM_TOOL_PREFIX}ask_user` || b.name === 'AskUserQuestion') return { problem: 'the AI asked a question' }
          const ev: Extract<DemoRecordingEvent, { type: 'tool' }> = { type: 'tool', t, name: b.name, input: b.input ?? {}, ok: true }
          events.push(ev)
          open.set(b.id, { ev, at })
        }
      }
    } else if (o.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue
        const call = open.get(b.tool_use_id)
        if (!call) continue
        call.ev.ok = !b.is_error
        call.ev.ms = Math.max(0, at - call.at)
        // the engine's own tools are replayed with what they answered; team tools are called again
        if (!call.ev.name.startsWith(TEAM_TOOL_PREFIX)) call.ev.output = textOf(b.content).slice(0, 4000)
      }
    }
  }
  if (!events.some((e) => e.type === 'text')) return { problem: 'the transcript has no answer text' }
  return { events, model }
}

export async function recordOne(s: Scenario, o: { base: string; data: string; out: string; log: (m: string) => void }): Promise<string> {
  const anon = new ApiClient({ baseUrl: o.base })
  const login = await anon.call(API.login, { body: { username: s.username, password: DEMO_PASSWORD, client: 'web', tokenMode: 'bearer' } })
  const api = new ApiClient({ baseUrl: o.base, token: login.token! })
  const started = Date.now()
  const r = await runPrompt(api, s.prompt, { timeoutMs: 20 * 60_000, log: o.log })
  if (r.message.status !== 'done') throw new Error(`${s.slug}: the answer ended ${r.message.status}${r.message.error ? ` (${r.message.error.message})` : ''}`)
  if (r.cards.some((c) => c.startsWith('ai:'))) throw new Error(`${s.slug}: the AI asked a question (${r.cards.join('; ')})`)
  const db = new Database(path.join(o.data, 'app.db'), { readonly: true })
  let sid: string | null
  try { sid = (db.query('SELECT engine_session_id AS s FROM chats WHERE id = ?').get(r.chatId) as { s: string | null } | null)?.s ?? null } finally { db.close() }
  if (!sid) throw new Error(`${s.slug}: the server kept no engine session for chat ${r.chatId}`)
  const parsed = transcriptEvents(fs.readFileSync(path.join(o.data, 'sessions', r.chatId, `${sid}.jsonl`), 'utf8'))
  if ('problem' in parsed) throw new Error(`${s.slug}: ${parsed.problem}`)
  const rec = DemoRecording.parse({
    v: 1, username: s.username, userId: login.me.user.id, prompt: s.prompt, kind: s.kind, ...(s.daysAgo !== undefined ? { daysAgo: s.daysAgo } : {}),
    recordedAt: new Date().toISOString(), engine: 'claude-code', model: parsed.model, events: parsed.events,
  })
  fs.mkdirSync(o.out, { recursive: true })
  const file = path.join(o.out, `${s.slug}.json`)
  fs.writeFileSync(file, JSON.stringify(rec, null, 1) + '\n')
  const saved = r.message.files?.saved.map((f) => f.path).join(', ') || 'no files'
  o.log(`${s.slug}: ${Math.round((Date.now() - started) / 1000)} s, ${rec.events.filter((e) => e.type === 'tool').length} tool calls, ${saved}${r.cards.length ? `, cards: ${r.cards.join('; ')}` : ''}`)
  return file
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (import.meta.main) {
  const content = loadContent(contentDir(arg('content'))!)
  const base = arg('base') ?? 'http://127.0.0.1:19832'
  const data = path.resolve(arg('data') ?? path.join(os.homedir(), `.${content.company.id}demo-rec`, 'data'))
  const out = path.resolve(arg('out') ?? content.recordingsDir)
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean)
  const jobs = Math.max(1, Number(arg('jobs') ?? 3))
  const list = content.company.scenarios.filter((s) => !only || only.includes(s.slug))
  const log = (m: string) => console.log(`[record] ${m}`)
  // one person's prompts one after another, the people side by side (at most `jobs` at a time)
  const byPerson = new Map<string, Scenario[]>()
  for (const s of list) byPerson.set(s.username, [...(byPerson.get(s.username) ?? []), s])
  const queues = [...byPerson.values()]
  let failed = 0
  const worker = async () => {
    for (let q = queues.shift(); q; q = queues.shift()) {
      for (const s of q) {
        try { await recordOne(s, { base, data, out, log }) } catch (e) { failed++; log(`FAILED ${e instanceof Error ? e.message : String(e)}`) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, queues.length) }, worker))
  log(`done: ${list.length - failed} recorded, ${failed} failed`)
  if (failed) process.exitCode = 1
}
