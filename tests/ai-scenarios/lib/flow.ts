// Flows (tests/ai-scenarios/flows.yaml): whole pieces of work over several steps and several people. A step is either
// a person's turn with the AI, or something another person or a service does through the real API as that fake user
// (a room message, a file edited, a skill changed, an e-mail arriving through a room app, a guest joining). Checks run
// after every step; the report names the first step that broke.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { API, ApiClient } from '../../../shared/src/api'
import { GUEST, PASSWORD } from '../fixture/seed'
import { runChecks } from './checks'
import { attributed, diffOf, jargonIn, login, oneTurn, openChat, snapshot, type CardMode, type Env as CaseEnv } from './run-case'
/** a flow run: a case run's environment plus how every person answers the server's cards in it */
export type Env = CaseEnv & { cardMode?: CardMode }
import { Check, Context, type CardSeen, type CheckResult, type TurnRecord } from './types'

/** checks that only a flow has: the cards this step showed its person, and a person's notifications since the step */
const FlowCheck = z.union([
  Check,
  z.object({ type: z.literal('card_shown'), pattern: z.string() }),
  z.object({ type: z.literal('no_card'), pattern: z.string().default('.') }),
  z.object({ type: z.literal('notified'), as: z.string(), pattern: z.string() }),
  /** the MOCK services' data (mock-services/server.ts State) at a dotted path matches: mail.sent, notion.pages … */
  z.object({ type: z.literal('mock'), path: z.string(), pattern: z.string() }),
  z.object({ type: z.literal('no_mock'), path: z.string(), pattern: z.string() }),
])
type FlowCheck = z.infer<typeof FlowCheck>

const Ask = z.object({
  as: z.string(),
  /** a name for the chat: the same name continues it (same person), a new name opens a new chat in `context` */
  chat: z.string(),
  context: Context.default('personal'),
  prompt: z.string(),
  reply: z.string().optional(),
  /** say no on the server's cards in this turn (the person declines) */
  decline: z.boolean().default(false),
  /** a heavy step (a deck, a video, a long document): stopped and marked slow after about 3 minutes */
  heavy: z.boolean().default(false),
})
const Event = z.discriminatedUnion('type', [
  /** a person writes in the fixture's group chat (a thread reply under the latest message of `threadOf` text) */
  z.object({ type: z.literal('room_message'), as: z.string(), text: z.string(), threadOf: z.string().optional() }),
  /** a person changes a text file: every `from` becomes `to` (read from the team folder, saved through the API) */
  z.object({ type: z.literal('file_edit'), as: z.string(), path: z.string(), from: z.string(), to: z.string() }),
  /** a person saves a new text file */
  z.object({ type: z.literal('file_add'), as: z.string(), path: z.string(), text: z.string() }),
  /** a service posts into the group chat through a room app ("Other", Slack format): how a mail or a form arrives */
  z.object({ type: z.literal('app_post'), app: z.string(), text: z.string() }),
  /** a room member adds someone to the fixture's group chat */
  z.object({ type: z.literal('room_invite'), as: z.string(), user: z.string() }),
  /** a direct message from one person to another (opened if needed), optionally with a team file sent along */
  z.object({ type: z.literal('dm'), as: z.string(), to: z.string(), text: z.string(), file: z.string().optional() }),
  /** a team file sent into the group chat with a line */
  z.object({ type: z.literal('room_file'), as: z.string(), path: z.string(), text: z.string() }),
  /** a teammate answers in the group chat with an edited copy of a team text file (every from -> to) */
  z.object({ type: z.literal('room_edited_file'), as: z.string(), path: z.string(), from: z.string(), to: z.string(), name: z.string(), text: z.string() }),
  /** the person presses "Send to thread" / "Send to room" under the latest answer of a chat (threadOf: the room message
   * whose thread it goes to); a warning in that dialog is a prompt the person sees (counted), then it is sent */
  z.object({ type: z.literal('share_answer'), as: z.string(), chat: z.string(), threadOf: z.string().optional() }),
  /** the person does something on the mock browser's page themselves (mock-services/browser.ts): open an address, or
   * one of the page's own person steps (attach a file, fill fields) with its arguments */
  z.object({ type: z.literal('page_act'), as: z.string(), action: z.string(), url: z.string().optional(), args: z.array(z.unknown()).default([]) }),
  /** a guest joins one place through an invite link */
  z.object({ type: z.literal('guest_join'), username: z.string(), name: z.string(), place: z.enum(['project', 'room']) }),
])
const Step = z.object({
  /** what this step is, for the report */
  say: z.string(),
  ask: Ask.optional(),
  event: Event.optional(),
  checks: z.array(FlowCheck).default([]),
}).refine((s) => !!s.ask !== !!s.event, 'a step is either ask or event')
export const Flow = z.object({
  id: z.string().regex(/^FL-\d{2}$/),
  title: z.string(),
  features: z.array(z.string()).min(1),
  why: z.string().optional(),
  fixInProgress: z.string().optional(),
  /** uses the MOCK services (mock-services/): the report marks it "mocked" */
  mocked: z.boolean().default(false),
  /** core everyday group the owner asked for first: sharing and links */
  group: z.enum(['office', 'making', 'spreadsheets', 'documents', 'connectors', 'pdf', 'sharing', 'people', 'guest']).default('office'),
  steps: z.array(Step).min(2),
})
export type Flow = z.infer<typeof Flow>
export const FlowCatalog = z.object({ version: z.number().int().positive(), flows: z.array(Flow) })

export interface StepResult {
  index: number; say: string; kind: 'ask' | 'event'; as: string; turn?: TurnRecord; error?: string; changed: string[]; checks: CheckResult[]; jargon: string[]
  /** an ask: the chat it ran in, its place, the prompts said in that chat so far (this one last), and every address
   * seen by then in that chat's prompts and in the group chat's messages (normalized) */
  chat?: string; context?: string; prompts?: string[]; seenUrls?: string[]
  /** an event step: prompts the app showed the acting person (e.g. the Send-to-thread dialog's warning) */
  uiPrompts?: CardSeen[]
}
export interface FlowResult { id: string; runId: string; commit: string; startedAt: string; cardMode: string; steps: StepResult[]; firstBroken: number | null; judge?: unknown }
export const FlowVerdict = z.object({
  pass: z.boolean(),
  first_broken_step: z.number().int().nullable(),
  root_cause: z.enum(['none', 'missing tool', 'prompt over-refusal', 'permission bug', 'jargon', 'wrong claim', 'tool failure', 'wrong result', 'lost context', 'other']),
  why: z.string(),
})
export type FlowVerdict = z.infer<typeof FlowVerdict>

const clients = new Map<string, Promise<ApiClient>>()
function as(env: Env, u: string) {
  const k = `${env.base} ${u}`
  if (!clients.has(k)) clients.set(k, login(env.base, u))
  return clients.get(k)!
}

/** the room app a flow's service posts through: made once per run as the room's admin member, its address kept */
const apps = new Map<string, Promise<string>>()
function appAddress(env: Env, name: string): Promise<string> {
  if (!apps.has(name)) apps.set(name, (async () => {
    const api = await as(env, 'minho')
    const made = await api.call(API.createRoomApp, { params: { id: env.fixture.roomId }, body: { kind: 'other', name } })
    return made.address
  })())
  return apps.get(name)!
}

/** {{file:<team path>}} -> the app's link to that team file; {{chat:<flow chat name>}} -> the link to that chat */
function fill(env: Env, text: string, chats: Map<string, { id: string }>): string {
  return text.replace(/\{\{mock:([^}]+)\}\}/g, (_m, p: string) => `${env.mockUrl ?? 'https://mock.invalid'}${p}`)
    .replace(/\{\{mock\}\}/g, env.mockUrl ?? 'https://mock.invalid')
    .replace(/\{\{file:([^}]+)\}\}/g, (_m, p: string) => `${env.base}/files/view?path=${encodeURIComponent(p)}`)
    .replace(/\{\{chat:([^}]+)\}\}/g, (_m, k: string) => `${env.base}/c/${chats.get(k)?.id ?? 'unknown'}`)
}
async function dmRoom(api: ApiClient, userId: string): Promise<string> {
  return (await api.call(API.createRoom, { body: { kind: 'dm', userId } })).id
}
async function teamFileInRoom(api: ApiClient, roomId: string, p: string): Promise<string> {
  return (await api.call(API.attachRoomTeamFile, { params: { id: roomId }, body: { path: p } })).file.id
}

async function doEvent(env: Env, e: z.infer<typeof Event>, chats: Map<string, { id: string }>, uiPrompts: CardSeen[] = []): Promise<string[]> {
  if ('text' in e) e = { ...e, text: fill(env, e.text, chats) }
  switch (e.type) {
    case 'share_answer': {
      const api = await as(env, e.as)
      const chatId = chats.get(e.chat)?.id
      if (!chatId) throw new Error(`no chat ${e.chat}`)
      const answer = [...(await api.call(API.listMessages, { params: { id: chatId }, query: {} })).items].reverse().find((m) => m.role === 'assistant')
      if (!answer) throw new Error('no answer to share')
      let threadRootId: string | undefined
      if (e.threadOf) threadRootId = [...(await api.call(API.listRoomMessages, { params: { id: env.fixture.roomId }, query: {} })).items].reverse().find((m) => m.body.includes(e.threadOf!))?.id
      const body = { roomId: env.fixture.roomId, clientMessageId: crypto.randomUUID(), ...(threadRootId ? { threadRootId } : {}) }
      let r = await api.call(API.shareAnswerToRoom, { params: { id: chatId, messageId: answer.id }, body })
      if (r.status === 'confirm') {
        // the dialog's warning before sending: a prompt this person sees
        uiPrompts.push({ kind: 'share-dialog', origin: 'server', question: JSON.stringify(r).slice(0, 400), answer: 'send', options: ['send', 'cancel'], hasAlways: false })
        r = await api.call(API.shareAnswerToRoom, { params: { id: chatId, messageId: answer.id }, body: { ...body, confirmKey: (r as { confirmKey: string }).confirmKey } })
      }
      if (r.status !== 'sent') throw new Error(`share: ${r.status}`)
      return []
    }
    case 'room_invite': {
      const api = await as(env, e.as)
      await api.call(API.inviteRoomMembers, { params: { id: env.fixture.roomId }, body: { userIds: [env.fixture.people[e.user]!.id] } })
      return []
    }
    case 'dm': {
      const api = await as(env, e.as)
      const room = await dmRoom(api, env.fixture.people[e.to]!.id)
      const fileIds = e.file ? [await teamFileInRoom(api, room, e.file)] : []
      await api.call(API.sendRoomMessage, { params: { id: room }, body: { body: e.text, mentions: [], clientMessageId: crypto.randomUUID(), ...(fileIds.length ? { fileIds } : {}) } })
      return []
    }
    case 'room_file': {
      const api = await as(env, e.as)
      const fid = await teamFileInRoom(api, env.fixture.roomId, e.path)
      await api.call(API.sendRoomMessage, { params: { id: env.fixture.roomId }, body: { body: e.text, fileIds: [fid], mentions: [], clientMessageId: crypto.randomUUID() } })
      return []
    }
    case 'room_edited_file': {
      const api = await as(env, e.as)
      const now = fs.readFileSync(path.join(env.teamRoot, e.path), 'utf8')
      if (!now.includes(e.from)) throw new Error(`${e.path} has no "${e.from}"`)
      const f = await api.call(API.uploadRoomFile, { params: { id: env.fixture.roomId }, body: { fields: {}, file: new Blob([now.split(e.from).join(e.to)], { type: 'text/markdown' }), filename: e.name } })
      await api.call(API.sendRoomMessage, { params: { id: env.fixture.roomId }, body: { body: e.text, fileIds: [f.id], mentions: [], clientMessageId: crypto.randomUUID() } })
      return []
    }
    case 'room_message': {
      const api = await as(env, e.as)
      let threadRootId: string | undefined
      if (e.threadOf) {
        const page = await api.call(API.listRoomMessages, { params: { id: env.fixture.roomId }, query: {} })
        threadRootId = [...page.items].reverse().find((m) => m.body.includes(e.threadOf!))?.id
        if (!threadRootId) throw new Error(`no room message with "${e.threadOf}" to reply under`)
      }
      await api.call(API.sendRoomMessage, { params: { id: env.fixture.roomId }, body: { body: e.text, mentions: [], clientMessageId: crypto.randomUUID(), ...(threadRootId ? { threadRootId } : {}) } })
      return []
    }
    case 'file_edit': {
      const api = await as(env, e.as)
      const now = fs.readFileSync(path.join(env.teamRoot, e.path), 'utf8')
      if (!now.includes(e.from)) throw new Error(`${e.path} has no "${e.from}"`)
      const name = path.posix.basename(e.path)
      await api.call(API.upload, { body: { fields: { folder: path.posix.dirname(e.path), name, onExists: 'replace' }, file: new Blob([now.split(e.from).join(e.to)]), filename: name } })
      return [e.path]
    }
    case 'file_add': {
      const api = await as(env, e.as)
      const name = path.posix.basename(e.path)
      await api.call(API.upload, { body: { fields: { folder: path.posix.dirname(e.path), name, onExists: 'replace' }, file: new Blob([e.text]), filename: name } })
      return [e.path]
    }
    case 'app_post': {
      const address = await appAddress(env, e.app)
      const res = await fetch(address.startsWith('http') ? address : `${env.base}${address}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: e.text }) })
      if (!res.ok) throw new Error(`the room app answered ${res.status}`)
      return []
    }
    case 'page_act': {
      if (!env.mockPort || !env.mockKey) throw new Error('page_act needs the mock services (mocked: true)')
      const res = await fetch(`http://127.0.0.1:${env.mockPort}/browser/act`, { method: 'POST', headers: { authorization: `Bearer ${env.mockKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: e.action, url: e.url, args: e.args }) })
      const out = await res.json() as { ok: boolean; error?: string }
      if (!out.ok) throw new Error(`page_act ${e.action}: ${out.error}`)
      return []
    }
    case 'guest_join': {
      const owner = await as(env, 'jiwoo')
      const users = (await owner.call(API.listUsers)).items
      if (users.some((u) => u.username === e.username)) return []
      const place = e.place === 'project' ? { kind: 'project' as const, id: env.fixture.projectId } : { kind: 'room' as const, id: env.fixture.roomId }
      // a room guest is invited by a member of the room
      const inviter = await as(env, e.place === 'room' ? 'sora' : 'jiwoo')
      const inv = await inviter.call(API.createGuestInvite, { body: { place, ai: { mode: 'none' }, expiresInHours: 24, name: e.name } })
      await new ApiClient({ baseUrl: env.base }).call(API.acceptInvite, { params: { token: inv.token }, body: { username: e.username, name: e.name, password: PASSWORD, client: 'web', tokenMode: 'bearer' } })
      return []
    }
  }
}

async function flowChecks(env: Env, checks: FlowCheck[], step: { turns: TurnRecord[]; changed: string[]; since: string }): Promise<CheckResult[]> {
  const plain = checks.filter((c): c is Check => Check.safeParse(c).success && !['card_shown', 'no_card', 'notified', 'mock', 'no_mock'].includes(c.type))
  let room = ''
  if (plain.some((k) => k.type === 'room_message' || k.type === 'no_room_message')) {
    const api = await as(env, 'sora')
    room = (await api.call(API.listRoomMessages, { params: { id: env.fixture.roomId }, query: {} })).items.filter((m) => m.createdAt >= step.since).map((m) => m.body).join('\n')
  }
  const out = await runChecks(step.turns.length ? [{ type: 'answered' }, ...plain] : plain, { teamRoot: env.teamRoot, changed: step.changed, turns: step.turns, room })
  for (const c of checks) {
    if (c.type === 'card_shown' || c.type === 'no_card') {
      const cards = step.turns.flatMap((t) => t.cards.map((k) => `${k.kind}: ${k.question}`))
      const hit = cards.some((k) => new RegExp(c.pattern, 'i').test(k))
      out.push({ check: c as unknown as Check, ok: c.type === 'card_shown' ? hit : !hit, detail: cards.length ? cards.join(' | ').slice(0, 300) : 'no card' })
    } else if (c.type === 'mock' || c.type === 'no_mock') {
      let v: unknown = null
      try { v = c.path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], JSON.parse(fs.readFileSync(env.mockState ?? '', 'utf8'))) } catch {}
      const t = JSON.stringify(v ?? null)
      const hit = new RegExp(c.pattern, 'i').test(t)
      out.push({ check: c as unknown as Check, ok: c.type === 'mock' ? hit : !hit, detail: `${c.path}: ${t.slice(0, 160)}` })
    } else if (c.type === 'notified') {
      try {
        const api = await as(env, c.as)
        const items = (await api.call(API.listNotifications, { query: { limit: 30 } as never })).items as unknown as { createdAt?: string; title?: string; body?: string; text?: string }[]
        const fresh = items.filter((n) => !n.createdAt || n.createdAt >= step.since).map((n) => JSON.stringify(n))
        const hit = fresh.some((n) => new RegExp(c.pattern, 'i').test(n))
        out.push({ check: c as unknown as Check, ok: hit, detail: hit ? `${c.as} was notified` : `${fresh.length} new notices for ${c.as}, none match` })
      } catch (e) { out.push({ check: c as unknown as Check, ok: false, detail: `notifications: ${e instanceof Error ? e.message : e}` }) }
    }
  }
  return out
}

export async function runFlow(f: Flow, env: Env): Promise<FlowResult> {
  const res: FlowResult = { id: f.id, runId: env.runId, commit: env.commit, startedAt: new Date().toISOString(), cardMode: env.cardMode ?? 'once', steps: [], firstBroken: null }
  const chats = new Map<string, { id: string; as: string; lines: number }>()
  const said_ = new Map<string, string[]>()
  // the mock browser starts each mocked flow with no page open (no tab left from the flow before)
  if (f.mocked && env.mockPort && env.mockKey) await fetch(`http://127.0.0.1:${env.mockPort}/browser/act`, { method: 'POST', headers: { authorization: `Bearer ${env.mockKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reset' }) }).catch(() => {})
  for (const [i, s] of f.steps.entries()) {
    const since = new Date().toISOString()
    const before = snapshot(env.teamRoot)
    const r: StepResult = { index: i + 1, say: s.say, kind: s.ask ? 'ask' : 'event', as: s.ask?.as ?? ('as' in (s.event ?? {}) ? String((s.event as { as?: string }).as) : (s.event?.type ?? '')), changed: [], checks: [], jargon: [] }
    let touched: string[] = []
    try {
      if (s.ask) {
        const a = s.ask
        const api = await as(env, a.as)
        const pseudo = { id: `${f.id}-${i + 1}`, lang: /[가-힣]/.test(a.prompt) ? 'ko' : 'en', context: a.context, as: a.as, reply: a.reply, cardMode: a.decline ? 'decline' : env.cardMode ?? 'once', capMs: a.heavy ? 180_000 : 10 * 60_000 } as never
        const said = [...(said_.get(a.chat) ?? []), fill(env, a.prompt, chats)]
        said_.set(a.chat, said)
        let roomUrls: string[] = []
        try { roomUrls = (await (await as(env, 'sora')).call(API.listRoomMessages, { params: { id: env.fixture.roomId }, query: {} })).items.flatMap((m) => urlsIn(m.body)) } catch {}
        r.chat = a.chat; r.context = a.context; r.prompts = said
        r.seenUrls = [...new Set([...said.flatMap(urlsIn), ...roomUrls].map(normUrl))]
        let chat = chats.get(a.chat)
        if (!chat) { chat = { id: await openChat(api, env, pseudo), as: a.as, lines: 0 }; chats.set(a.chat, chat) }
        if (chat.as !== a.as) throw new Error(`chat "${a.chat}" belongs to ${chat.as}, not ${a.as}`)
        const t = await oneTurn(api, env, pseudo, chat.id, fill(env, a.prompt, chats), chat.lines)
        chat.lines = t.lines
        r.turn = t.rec
        r.jargon = jargonIn(t.rec.answer)
        env.log(`${f.id} step ${i + 1} (${a.as}): ${t.rec.status} in ${Math.round(t.rec.ms / 1000)} s, ${t.rec.tools.length} tool calls${t.rec.cards.length ? `, ${t.rec.cards.length} cards` : ''}`)
      } else {
        const ui: CardSeen[] = []
        touched = await doEvent(env, s.event!, chats, ui)
        if (ui.length) r.uiPrompts = ui
        env.log(`${f.id} step ${i + 1}: ${s.event!.type} done`)
      }
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e)
      env.log(`${f.id} step ${i + 1}: ERROR ${r.error}`)
    }
    const diff = diffOf(before, snapshot(env.teamRoot))
    r.changed = [...new Set([...(r.turn ? attributed(diff, [r.turn]) : []), ...touched.filter((p) => diff.includes(p))])].sort()
    r.checks = await flowChecks(env, s.checks, { turns: r.turn ? [r.turn] : [], changed: r.changed, since })
    if (r.error) r.checks.unshift({ check: { type: 'answered' }, ok: false, detail: r.error })
    res.steps.push(r)
    if (res.firstBroken === null && r.checks.some((c) => !c.ok)) res.firstBroken = r.index
  }
  return res
}

export const urlsIn = (t: string): string[] => t.match(/https?:\/\/[^\s)<>\]"'`]+/g) ?? []
/** an address as people mean it: host in lower case, no fragment, no tracking query (utm_*, fbclid, gclid), no
 * trailing slash */
export function normUrl(u: string): string {
  try {
    const x = new URL(u.replace(/[.,;!?]+$/, ''))
    x.hash = ''
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) x.searchParams.delete(k)
    let s = `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}`
    if ([...x.searchParams.keys()].length) s += `?${x.searchParams.toString()}`
    return s
  } catch { return u }
}

/** every team path a flow's steps made or changed (for the clean-up after it) */
export const flowChanged = (r: FlowResult) => [...new Set(r.steps.flatMap((s) => s.changed))]
export { GUEST }
