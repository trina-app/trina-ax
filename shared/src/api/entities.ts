// What the API returns for the tables of design tab 1. These are API views (camelCase, no secrets, no hashes),
// not raw rows. Server code maps rows -> these shapes; clients only ever see these.
import { z } from 'zod'
import { UserId, Uuid7 } from '../ids'
import { Access, ApiErrorBody, ClientKind, EngineId, IsoTime, Locale, RelPath, Role, Theme, UserStatus } from './common'

// ---------------- people ----------------
/** Minimal person reference (chat authors, audit actors, file authors). */
export const UserRef = z.object({ id: UserId, name: z.string() })
export type UserRef = z.infer<typeof UserRef>

export const UserPrefs = z.object({
  theme: Theme.optional(),
  /** language for AI answers if different from the UI language */
  answerLocale: Locale.optional(),
  /** own default engine/model for new chats ("내 기본 엔진/모델"; only for people who may pick the engine) */
  engine: EngineId.optional(),
  model: z.string().max(100).optional(),
})
export type UserPrefs = z.infer<typeof UserPrefs>

/** users (admin view). Never includes password_hash. */
export const User = z.object({
  id: UserId,
  username: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  role: Role,
  status: UserStatus,
  mustChangePassword: z.boolean(),
  /** while the account still has a temporary password (admin "add member" / "reset password"): until when it works,
   * and whether it was voided after too many wrong sign-in tries (Admin > Members shows both; a reset gives a new one) */
  tempPassword: z.object({ expiresAt: IsoTime, voided: z.boolean() }).nullable().optional(),
  /** the language the person sees: their own choice, else the team default */
  locale: Locale,
  /** their own choice; null = follows the team default */
  localeChoice: Locale.nullable(),
  groupIds: z.array(Uuid7),
  createdAt: IsoTime,
  lastSeenAt: IsoTime.nullable(),
})
export type User = z.infer<typeof User>

export const Group = z.object({
  id: Uuid7,
  name: z.string(),
  description: z.string().nullable(),
  memberIds: z.array(UserId),
})
export type Group = z.infer<typeof Group>

/** sessions (the signed-in person's own list). */
export const Session = z.object({
  id: Uuid7,
  client: ClientKind,
  userAgent: z.string().nullable(),
  createdAt: IsoTime,
  lastSeenAt: IsoTime,
  expiresAt: IsoTime,
  /** the session making this request */
  current: z.boolean(),
})
export type Session = z.infer<typeof Session>

/** invites. The token is shown once, at creation (CreateInviteResponse). */
export const Invite = z.object({
  id: Uuid7,
  role: Role.exclude(['owner']),
  groupIds: z.array(Uuid7),
  createdBy: UserRef.nullable(),
  createdAt: IsoTime,
  expiresAt: IsoTime,
  usedAt: IsoTime.nullable(),
  usedBy: UserRef.nullable(),
})
export type Invite = z.infer<typeof Invite>

// ---------------- folders and rules (tab 2) ----------------
export const SubjectType = z.enum(['everyone', 'role', 'group', 'user'])
export type SubjectType = z.infer<typeof SubjectType>
/** One rule: who (subject) gets what (access) on a folder. subjectId: null for everyone, a Role for role, group id, user id. */
export const FolderRuleInput = z.discriminatedUnion('subjectType', [
  z.object({ subjectType: z.literal('everyone'), subjectId: z.null(), access: Access }),
  z.object({ subjectType: z.literal('role'), subjectId: Role.exclude(['owner']), access: Access }),
  z.object({ subjectType: z.literal('group'), subjectId: Uuid7, access: Access }),
  z.object({ subjectType: z.literal('user'), subjectId: UserId, access: Access }),
])
export type FolderRuleInput = z.infer<typeof FolderRuleInput>
export const FolderRule = z.object({
  id: Uuid7,
  folderId: Uuid7,
  subjectType: SubjectType,
  subjectId: z.string().nullable(),
  access: Access,
  updatedBy: UserRef.nullable(),
  updatedAt: IsoTime,
})
export type FolderRule = z.infer<typeof FolderRule>
/** folders: a folder that carries rules. path: actual on-disk names, no trailing slash, '' = team root. */
export const Folder = z.object({
  id: Uuid7,
  path: RelPath,
  exists: z.boolean(),
  rules: z.array(FolderRule),
  createdAt: IsoTime,
})
export type Folder = z.infer<typeof Folder>

// ---------------- projects, chats, messages ----------------
export const Project = z.object({
  id: Uuid7,
  name: z.string(),
  /** folder inside the team folder that the project's chats use as default context */
  folderPath: RelPath,
  instructions: z.string(),
  createdBy: UserRef.nullable(),
  createdAt: IsoTime,
  /** the caller may edit/delete the project (write access to folderPath) */
  canEdit: z.boolean(),
})
export type Project = z.infer<typeof Project>

/** Run state of a chat, from the turn queue. */
export const ChatRunState = z.enum(['idle', 'queued', 'running'])
export type ChatRunState = z.infer<typeof ChatRunState>
export const Chat = z.object({
  id: Uuid7,
  projectId: Uuid7.nullable(),
  title: z.string(),
  engine: EngineId,
  model: z.string().nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  /** soft delete; purged 7 days later */
  deletedAt: IsoTime.nullable(),
  runState: ChatRunState,
})
export type Chat = z.infer<typeof Chat>

/**
 * messages.attachments[]: files the person attached. Uploads are stored in users/<id>/.attachments/<chatId>/;
 * team files (source 'team', POST /api/attachments/team-file) are references to a file in the team folder, not copies:
 * the server follows the file (moves, edits) and checks the person's read access again whenever it is shown or sent.
 */
export const Attachment = z.object({
  id: Uuid7,
  name: z.string(),
  /** team-relative path: of the stored upload (users/<me>/.attachments/<chatId>/<name>), or where the referenced team
   * file is now ('' when it is unavailable) */
  path: RelPath,
  size: z.number().int().nonnegative(),
  mime: z.string(),
  kind: z.enum(['image', 'pdf', 'document', 'spreadsheet', 'presentation', 'audio', 'video', 'text', 'other']),
  /** images: width/height for layout before the thumbnail loads */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** 'team': a reference to a team-folder file (absent: an upload) */
  source: z.enum(['upload', 'team']).optional(),
  /** team references: sha256 of the content when it was attached */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** team references: the content changed since it was attached (the AI gets the current version) */
  changed: z.boolean().optional(),
  /** team references: moved or renamed since it was attached (`path` is where it is now) */
  moved: z.boolean().optional(),
  /** team references: deleted, or the viewer can no longer read it; name, path and size are then blanked */
  unavailable: z.boolean().optional(),
})
export type Attachment = z.infer<typeof Attachment>
/** At most this many attachments (uploads and team files together) per message. */
export const MESSAGE_ATTACHMENTS_MAX = 20

/** messages.steps[]: what the AI did ("파일 검색 중"). Shown as a collapsible list under the answer. */
export const StepKind = z.enum(['tool', 'thinking', 'web_search', 'browser', 'artifact', 'ask_user'])
export const Step = z.object({
  id: z.string().max(100),
  kind: StepKind,
  /** tool name as the engine saw it, e.g. "grep", "make_file", "WebSearch", "navigate" */
  tool: z.string().max(100).optional(),
  /** short human summary, e.g. 'grep "invoice" in finance/' (never raw tool input) */
  label: z.string().max(500),
  status: z.enum(['running', 'ok', 'error']),
  /** the step was still running when the answer paused at its per-answer time limit (Message.stopReason): it was cut
   * off, not failed, and "continue" picks the work up. status stays 'error' so apps without this field still show it
   * as not finished; absent on every other step */
  paused: z.literal(true).optional(),
  startedAt: IsoTime,
  endedAt: IsoTime.nullable(),
  /** optional longer result summary (e.g. search result titles), shown when expanded */
  detail: z.string().max(4000).optional(),
  /** web search cards */
  sources: z.array(z.object({ title: z.string(), url: z.string() })).max(50).optional(),
  /** screenshot shared from the browser pane / images the AI shows: served via /api/files/download */
  images: z.array(z.object({ path: RelPath, alt: z.string().optional() })).max(20).optional(),
})
export type Step = z.infer<typeof Step>

/** "파일 3개 저장 · 1개 충돌 사본 · 1개 권한 없음" under an answer (from file_events of the turn). */
export const FileChangeSummary = z.object({
  saved: z.array(z.object({ path: RelPath, action: z.enum(['create', 'update']) })),
  conflicts: z.array(z.object({ path: RelPath, copyPath: RelPath })),
  rejected: z.array(z.object({ path: z.string(), reason: z.string() })),
})
export type FileChangeSummary = z.infer<typeof FileChangeSummary>

export const MessageStatus = z.enum(['streaming', 'done', 'error', 'stopped'])
export type MessageStatus = z.infer<typeof MessageStatus>
/** Why a finished answer ended before the AI was done: it reached the per-answer limit of tool calls (`tool_limit`,
 * Claude Code --max-turns 50 / the API engine's 30 rounds) or of working time (`time_limit`, 20 active minutes or the
 * total time). Its status stays 'done': not an error, not a stop by the person; the screen offers "continue". */
export const TurnStopReason = z.enum(['tool_limit', 'time_limit'])
export type TurnStopReason = z.infer<typeof TurnStopReason>
export const Usage = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative() })
export type Usage = z.infer<typeof Usage>

/**
 * messages. Conversations are trees: editing a user message or regenerating an answer adds a sibling with the
 * same parentId; the chat shows one path (chats.active_leaf_id). `branch` lets the UI show "< 2/3 >".
 */
export const Message = z.object({
  id: Uuid7,
  chatId: Uuid7,
  parentId: Uuid7.nullable(),
  role: z.enum(['user', 'assistant']),
  author: UserRef.nullable(),
  /** markdown; for a streaming answer, the text saved so far (deltas continue from content.length) */
  content: z.string(),
  attachments: z.array(Attachment),
  steps: z.array(Step),
  status: MessageStatus,
  error: ApiErrorBody.nullable(),
  turnId: Uuid7.nullable(),
  engine: EngineId.nullable(),
  model: z.string().nullable(),
  files: FileChangeSummary.nullable(),
  usage: Usage.nullable(),
  createdAt: IsoTime,
  branch: z.object({ index: z.number().int().nonnegative(), count: z.number().int().positive(), siblingIds: z.array(Uuid7) }),
  /** answers only: the answer paused at a per-answer limit (TurnStopReason); absent or null: it ended normally */
  stopReason: TurnStopReason.nullable().optional(),
  /** answers only: the AI got only the recent part of this conversation (the history a fresh engine session gets is
   * cut at 40,000 characters, and a session resumed from such a start keeps that); absent: all of it */
  historyTrimmed: z.boolean().optional(),
})
export type Message = z.infer<typeof Message>

// ---------------- artifacts, memories ----------------
export const ArtifactType = z.enum(['html', 'react', 'svg', 'mermaid', 'markdown', 'code'])
export type ArtifactType = z.infer<typeof ArtifactType>
/** artifacts: one row per version; `key` groups the versions of one artifact in a chat. */
export const Artifact = z.object({
  id: Uuid7,
  chatId: Uuid7,
  messageId: Uuid7.nullable(),
  key: z.string(),
  version: z.number().int().positive(),
  type: ArtifactType,
  title: z.string().nullable(),
  language: z.string().nullable(),
  content: z.string(),
  createdAt: IsoTime,
})
export type Artifact = z.infer<typeof Artifact>
export const ArtifactSummary = Artifact.omit({ content: true }).extend({ size: z.number().int().nonnegative() })
export type ArtifactSummary = z.infer<typeof ArtifactSummary>

export const Memory = z.object({
  id: Uuid7,
  text: z.string(),
  sourceChatId: Uuid7.nullable(),
  createdAt: IsoTime,
})
export type Memory = z.infer<typeof Memory>

// ---------------- turns, jobs ----------------
export const TurnStatus = z.enum(['queued', 'running', 'done', 'error', 'stopped', 'interrupted'])
export const Turn = z.object({
  id: Uuid7,
  chatId: Uuid7,
  userId: UserId,
  messageId: Uuid7.nullable(),
  engine: z.string(),
  model: z.string().nullable(),
  status: TurnStatus,
  startedAt: IsoTime,
  endedAt: IsoTime.nullable(),
  usage: Usage,
})
export type Turn = z.infer<typeof Turn>

export const JobKind = z.enum(['transcribe', 'backup', 'restore', 'update', 'export'])
export type JobKind = z.infer<typeof JobKind>
export const JobStatus = z.enum(['queued', 'running', 'done', 'failed', 'canceled'])
export type JobStatus = z.infer<typeof JobStatus>
export const TranscribeResult = z.object({
  text: z.string(),
  language: z.string().nullable(),
  durationSec: z.number().nonnegative().nullable(),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })).optional(),
})
export type TranscribeResult = z.infer<typeof TranscribeResult>
export const BackupResult = z.object({ backupId: z.string(), size: z.number().int().nonnegative(), createdAt: IsoTime })
export const RestoreResult = z.object({ backupId: z.string(), restoredAt: IsoTime, lostSince: IsoTime.nullable() })
export const UpdateResult = z.object({ fromVersion: z.string(), toVersion: z.string(), rolledBack: z.boolean() })
export const ExportResult = z.object({ path: RelPath, size: z.number().int().nonnegative() })
export const JobResult = z.union([TranscribeResult, BackupResult, RestoreResult, UpdateResult, ExportResult])
export const Job = z.object({
  id: Uuid7,
  kind: JobKind,
  status: JobStatus,
  /** 0..1, null while unknown */
  progress: z.number().min(0).max(1).nullable(),
  /** short human status line ("모델 내려받는 중") */
  message: z.string().nullable(),
  result: JobResult.nullable(),
  error: ApiErrorBody.nullable(),
  createdAt: IsoTime,
  finishedAt: IsoTime.nullable(),
})
export type Job = z.infer<typeof Job>

// ---------------- files ----------------
export const FileEntry = z.object({
  name: z.string(),
  path: RelPath,
  type: z.enum(['file', 'folder']),
  /** bytes; null for folders */
  size: z.number().int().nonnegative().nullable(),
  mtime: IsoTime,
  mime: z.string().nullable(),
  /** the caller's access (folders shown only for navigation have 'none' and are greyed out) */
  access: Access,
})
export type FileEntry = z.infer<typeof FileEntry>

/** file_versions */
export const FileVersion = z.object({
  id: Uuid7,
  path: RelPath,
  version: z.number().int().positive(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  /** the person whose save REPLACED this content (and stored it as a version); kept for older clients */
  author: UserRef.nullable(),
  /** the AI turn of that replacing save */
  turnId: Uuid7.nullable(),
  kind: z.enum(['edit', 'conflict_copy', 'restore']),
  conflictPath: RelPath.nullable(),
  createdAt: IsoTime,
  /** the person whose save PRODUCED this content (null: not known, e.g. versions stored before this was recorded;
   * then only `author`, "replaced by", is known) */
  savedBy: UserRef.nullable().optional(),
  /** the AI turn of the save that produced this content (null: not during an AI answer, or not known) */
  savedTurnId: Uuid7.nullable().optional(),
})
export type FileVersion = z.infer<typeof FileVersion>

/** One change in a file's history (GET /api/files/history `events`), newest first. Read from file_events, following
 * moves and renames back to earlier paths. */
export const FileHistoryEvent = z.object({
  id: z.number().int(),
  at: IsoTime,
  kind: z.enum(['created', 'edited', 'uploaded', 'restored', 'moved', 'renamed', 'copied', 'conflict']),
  by: UserRef.nullable(),
  /** the AI turn it happened in (null: a person on the file screen) */
  turnId: Uuid7.nullable(),
  /** the file's path just after the change */
  path: RelPath,
  /** moved / renamed: the path before; copied: the source; restored from the trash: the original path.
   * null also when the caller may not read that path. */
  from: RelPath.nullable(),
  size: z.number().int().nonnegative().nullable(),
})
export type FileHistoryEvent = z.infer<typeof FileHistoryEvent>

/** trash_items (30 days; restore needs write access to the original path) */
export const TrashItem = z.object({
  id: Uuid7,
  originalPath: RelPath,
  size: z.number().int().nonnegative(),
  deletedBy: UserRef.nullable(),
  turnId: Uuid7.nullable(),
  deletedAt: IsoTime,
  purgeAt: IsoTime,
  /** a whole folder was deleted (restored as one); absent = file */
  type: z.enum(['file', 'folder']).optional(),
})
export type TrashItem = z.infer<typeof TrashItem>

/** upload_sessions */
export const UploadTarget = z.discriminatedUnion('kind', [
  /** a file in the team folder (full path including the name); write access checked at create and at complete */
  z.object({ kind: z.literal('path'), path: RelPath, onExists: z.enum(['fail', 'replace', 'rename']).default('rename') }),
  /** a chat attachment, stored in users/<me>/.attachments/<chatId>/ */
  z.object({ kind: z.literal('attachment'), chatId: Uuid7, name: z.string().min(1).max(255) }),
  /** audio for transcription (not kept in the team folder) */
  z.object({ kind: z.literal('transcribe'), name: z.string().min(1).max(255) }),
])
export type UploadTarget = z.infer<typeof UploadTarget>
export const UploadSession = z.object({
  id: Uuid7,
  target: UploadTarget,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  chunkSize: z.number().int().positive(),
  chunkCount: z.number().int().nonnegative(),
  /** chunk numbers (0-based) already stored */
  received: z.array(z.number().int().nonnegative()),
  expiresAt: IsoTime,
})
export type UploadSession = z.infer<typeof UploadSession>

// ---------------- admin data ----------------
export const EngineAccount = z.object({
  id: Uuid7,
  engine: z.enum(['anthropic', 'openai']),
  label: z.string().nullable(),
  status: z.enum(['ok', 'invalid']),
  checkedAt: IsoTime.nullable(),
  /** last 4 characters of the key, for recognition */
  hint: z.string().nullable(),
})
export type EngineAccount = z.infer<typeof EngineAccount>

export const Budget = z.object({
  id: Uuid7,
  subjectType: z.enum(['team', 'group', 'user']),
  subjectId: z.string().nullable(),
  period: z.enum(['day', 'month']),
  limitUsd: z.number().nonnegative(),
  limitTokens: z.number().int().nonnegative().nullable(),
  action: z.enum(['warn', 'block']),
  /** spent in the current period */
  usedUsd: z.number().nonnegative(),
  usedTokens: z.number().int().nonnegative(),
})
export type Budget = z.infer<typeof Budget>

/** audit_log (admin actions) and file_events (file changes) in one list for the admin screen. */
export const AuditEntry = z.object({
  id: z.string(),
  source: z.enum(['admin', 'file', 'tool', 'auth']),
  at: IsoTime,
  actor: UserRef.nullable(),
  action: z.string(),
  target: z.string().nullable(),
  turnId: Uuid7.nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
})
export type AuditEntry = z.infer<typeof AuditEntry>

/** Voice input (speech to text): off (default), OpenRouter's speech-to-text API with the team's key (cloud), or
 * whisper.cpp on this server (private, slow on small servers). docs/DECISIONS.md "Voice input through OpenRouter". */
export const SpeechProvider = z.enum(['off', 'openrouter', 'local'])
export type SpeechProvider = z.infer<typeof SpeechProvider>
export const DEFAULT_SPEECH_MODEL = 'openai/whisper-large-v3-turbo'
/** an OpenRouter model id: "<vendor>/<model>" */
export const SpeechModel = z.string().max(128).regex(/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/)

/** settings (team-level, key/value json in the DB). */
export const TeamSettings = z.object({
  teamName: z.string().min(1).max(100),
  defaultLocale: Locale,
  defaultEngine: EngineId,
  defaultModel: z.string().nullable(),
  /** turns running at the same time across the team */
  concurrency: z.number().int().min(1).max(16),
  updateChannel: z.enum(['stable', 'beta']),
  /** when updates may install automatically: "HH:mm-HH:mm" in the team time zone; null = default 03:00-05:00 */
  updateWindow: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/).nullable(),
  auditRetentionDays: z.number().int().min(7).max(3650),
  fileHistoryRetentionDays: z.number().int().min(1).max(3650),
  trashRetentionDays: z.number().int().min(1).max(365),
  chatTrashRetentionDays: z.number().int().min(1).max(365),
  /** the team's time zone (IANA, e.g. Asia/Seoul): "today" / "this month" of budgets and usage, schedules, the nightly
   * backup. Changing it moves the current day / month boundaries (the data stays). */
  timeZone: z.string().min(1).max(64).refine((tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false } }, 'unknown time zone'),
  /** people may turn on "Allow all websites" in the desktop app's in-app browser (default on). Off: the desktop app
   * refuses it and turns it back to "ask for each new site" for anyone who had it on. */
  browserAllowAll: z.boolean(),
  /** members may add their own external-service connections (Settings > External services; default on). Off: none can
   * be added and the ones there are left out of chats (team connections are not affected). */
  personalIntegrations: z.boolean(),
  /** "Send images and PDF pages to the AI" (default on): an AI read of a photo, screenshot or scanned PDF page gives
   * the model the image (like Claude Code). Off: no pixels go to the provider; a Mac server reads the text with Apple
   * Vision instead, a Linux server says the image is not shown. */
  aiVision: z.boolean(),
  /** voice input: 'off' (default) | 'openrouter' (needs the OpenRouter key, Admin > Team settings) | 'local' */
  speechProvider: SpeechProvider,
  /** the OpenRouter speech-to-text model */
  speechModel: SpeechModel,
})
export type TeamSettings = z.infer<typeof TeamSettings>
