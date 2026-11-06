// 내 스킬 가져오기 (docs/DECISIONS.md "K — 내 스킬 가져오기"): an owner or admin brings the skills they use with Claude to
// the team, from a picked .claude folder (the browser or the desktop app) or from Claude Code through the team
// connector (the `share_skills` tool). Nothing reaches the team before [팀에 공유]: the candidates wait as a share
// proposal staged outside the team files, the server checks every one of them (shape, secrets, scripts, plugin, size,
// personal paths, a team skill of the same name) and one AI turn without tools judges them (recommended or not, with a
// one-line reason; the CLAUDE.md lines that fit the team become one team rule). Applying writes what the person
// ticked as them (FileService.humanSave, like approving a suggestion: folder rules, versions, the skills/ change log,
// 409 on a file that appeared meanwhile). A share belongs to the person who made it: only they see and apply it.
// Members get 403 (their way stays "스킬로 제안"). Route module: server/src/routes/skill-shares.ts.
import { z } from 'zod'
import { empty, endpoint } from './endpoint'
import { IsoTime } from './common'

export const SKILL_SHARE_LIMITS = {
  /** one file of a skill (the team's own skill file cap, chat/skills.ts SKILL_FILE_MAX_BYTES) */
  fileBytes: 128 * 1024,
  /** every file of one skill together */
  skillBytes: 1024 * 1024,
  /** files of one skill */
  skillFiles: 30,
  /** skills in one share from a picked folder */
  skills: 200,
  /** skills in one share from Claude Code (`share_skills`) */
  connectorSkills: 50,
  /** names of skills the sender left out */
  excluded: 500,
  /** CLAUDE.md as sent (user and project files joined) */
  ruleInBytes: 64 * 1024,
  /** the team rule the server keeps from it (a team rule file is cut there: chat/prompt.ts teamRuleFiles) */
  ruleChars: 4000,
  /** remote MCP servers in one share */
  tools: 20,
  /** days a share waits before it expires (its staged files are deleted then) */
  days: 7,
} as const

/** Text files a skill may carry (anything else is not sent; script files are dropped or exclude the skill: K). */
export const SHARE_TEXT_EXTENSIONS = ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'csv', 'tsv', 'html', 'htm', 'xml', 'svg'] as const
/** Small images a skill may carry (base64, at most `fileBytes` each). */
export const SHARE_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const
/** Code files: never run by the team (chat/prompt.ts: bundled scripts cannot execute). A skill whose SKILL.md tells the
 * AI to run one is excluded (`scripts`); otherwise they are left out and the skill goes without them. */
export const SHARE_SCRIPT_EXTENSIONS = ['py', 'sh', 'bash', 'zsh', 'js', 'mjs', 'cjs', 'ts', 'rb', 'pl', 'php', 'ps1', 'bat', 'cmd', 'go', 'rs', 'java', 'kt', 'swift', 'lua', 'r', 'exe', 'bin', 'dylib', 'so', 'dll', 'jar'] as const

export const SkillShareSource = z.enum(['browser', 'desktop', 'claude_code'])
export type SkillShareSource = z.infer<typeof SkillShareSource>

/** Where a candidate came from: ~/.claude/skills (user), a project's .claude/skills (project), a plugin's skills
 * (plugin: always excluded), ~/.claude/commands/*.md (command: listed under 그 밖에). */
export const ShareOrigin = z.enum(['user', 'project', 'plugin', 'command'])
export type ShareOrigin = z.infer<typeof ShareOrigin>

/** A path inside the skill folder ("SKILL.md", "templates/quote.md"): forward slashes, no "..", no leading "/". */
export const ShareRelPath = z.string().min(1).max(300)
  .refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.includes('\u0000') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..'), { message: 'a path inside the skill folder' })

/** One file of a skill. A script file (SHARE_SCRIPT_EXTENSIONS) goes up as its path with `text: ''`: the server judges
 * whether the skill needs it (excluded `scripts`) or goes without it (scriptsDropped), and never keeps a script's
 * content even when a sender includes it. Other binary files are not sent. */
export const ShareFileIn = z.object({
  path: ShareRelPath,
  /** a text file as it is */
  text: z.string().max(SKILL_SHARE_LIMITS.fileBytes).optional(),
  /** a small image, base64 */
  base64: z.string().max(Math.ceil(SKILL_SHARE_LIMITS.fileBytes / 3) * 4).optional(),
}).strict().refine((f) => (f.text === undefined) !== (f.base64 === undefined), { message: 'text or base64, one of them' })
export type ShareFileIn = z.infer<typeof ShareFileIn>

export const ShareSkillIn = z.object({
  /** the skill's folder name ("weekly-report"); a command: its file name without .md */
  name: z.string().min(1).max(100),
  origin: ShareOrigin.default('user'),
  /** a project skill: the project folder's own name (shown; never a full path) */
  project: z.string().max(100).optional(),
  files: z.array(ShareFileIn).min(1).max(SKILL_SHARE_LIMITS.skillFiles),
}).strict()
export type ShareSkillIn = z.infer<typeof ShareSkillIn>

/** Why the sender left a skill out before sending (only its name goes up, never its content). */
export const ShareExcludedReason = z.enum(['secret', 'too_big', 'plugin', 'scripts', 'not_skill'])
export type ShareExcludedReason = z.infer<typeof ShareExcludedReason>
export const ShareExcludedIn = z.object({
  name: z.string().min(1).max(100),
  origin: ShareOrigin.optional(),
  reason: ShareExcludedReason,
  /** secret: its kind as shared/src/secrets.ts names it ("slack", "openai") */
  kind: z.string().max(40).optional(),
}).strict()
export type ShareExcludedIn = z.infer<typeof ShareExcludedIn>

/** A remote MCP server (Streamable HTTP, https) offered to the team as a connection template (docs/INTEGRATIONS.md
 * "Templates"): each member connects it with their own key or sign-in. There is no field for a key. */
export const ShareToolIn = z.object({
  name: z.string().min(1).max(80),
  url: z.string().min(1).max(500),
  auth: z.enum(['bearer', 'header', 'oauth']),
  /** auth "header": the header's name */
  header: z.string().max(80).optional(),
}).strict()
export type ShareToolIn = z.infer<typeof ShareToolIn>

export const CreateSkillShare = z.object({
  source: SkillShareSource,
  /** how the sender names where it looked (".claude", ".claude/skills"): the list's source line */
  where: z.string().max(100).optional(),
  skills: z.array(ShareSkillIn).max(SKILL_SHARE_LIMITS.skills),
  excluded: z.array(ShareExcludedIn).max(SKILL_SHARE_LIMITS.excluded).optional(),
  /** CLAUDE.md as it is: the server keeps only the lines that fit the team, as one team rule */
  rule: z.object({ text: z.string().min(1).max(SKILL_SHARE_LIMITS.ruleInBytes) }).strict().optional(),
  /** Claude Code only: its remote MCP servers */
  tools: z.array(ShareToolIn).max(SKILL_SHARE_LIMITS.tools).optional(),
  /** Claude Code only: how many project folders it looked in */
  projects: z.number().int().min(0).max(100).optional(),
  /** Claude Code only: the names it would pick (the server judges again) */
  picked: z.array(z.string().max(100)).max(SKILL_SHARE_LIMITS.connectorSkills).optional(),
}).strict()
export type CreateSkillShare = z.infer<typeof CreateSkillShare>

/** checking: the AI's judgement is still running (the deterministic checks are in) · ready: waiting for [팀에 공유] ·
 * applied · dismissed (나중에 하기 / 그만 찾기) · expired (after SKILL_SHARE_LIMITS.days; staged files deleted) */
export const SkillShareStatus = z.enum(['checking', 'ready', 'applied', 'dismissed', 'expired'])
export type SkillShareStatus = z.infer<typeof SkillShareStatus>

/** recommended: ticked at first · other: can be ticked · excluded: cannot go to the team */
export const ShareGroup = z.enum(['recommended', 'other', 'excluded'])
export type ShareGroup = z.infer<typeof ShareGroup>

/**
 * The one line under a candidate (web copy welcome.skills.reason.<reason>):
 * - recommended: team_any (팀 누구나 쓸 만해요) · team_files (팀 파일을 써요) · with_file ({detail} 파일도 같이 넣어요) ·
 *   similar (비슷한 팀 스킬 '{detail}'가 있어요) · same_name (같은 이름의 팀 스킬이 있어요);
 * - other: personal (나만 쓰는 것 같아요) · dev (개발할 때만 써요) · personal_path (내 컴퓨터 파일을 읽어요 · 팀에선 안 될
 *   수 있어요) · command (명령어예요) · unjudged (no AI: no reason);
 * - excluded: secret (비밀 키가 들어 있어요 ({detail})) · scripts (스크립트가 있어야 돌아가요 · 트리나는 스크립트를 실행하지
 *   않아요) · plugin (플러그인에서 받은 스킬이에요 · 원래 플러그인으로 설치해요) · too_big (너무 커요) · not_skill (스킬
 *   형식이 아니에요).
 */
export const ShareReason = z.enum([
  'team_any', 'team_files', 'with_file', 'similar', 'same_name',
  'personal', 'dev', 'personal_path', 'command', 'unjudged',
  'secret', 'scripts', 'plugin', 'too_big', 'not_skill',
])
export type ShareReason = z.infer<typeof ShareReason>

export const ShareAction = z.enum(['add', 'merge', 'separate'])
export type ShareAction = z.infer<typeof ShareAction>

const TeamSkillRef = z.object({ path: z.string(), title: z.string() })

export const ShareCandidate = z.object({
  /** the name it is saved under (its folder): the sent name, made a valid skill name */
  name: z.string(),
  /** the name people read, made by the AI in the team's language; null without it */
  title: z.string().nullable(),
  /** the skill's own description (its header) */
  description: z.string(),
  origin: ShareOrigin,
  project: z.string().nullable(),
  group: ShareGroup,
  reason: ShareReason,
  /** with_file: the file going with it · similar: the team skill's title · secret: its kind · else null */
  detail: z.string().nullable(),
  /** it names a path on the sender's computer (shown even when the reason says something else) */
  personalPath: z.boolean(),
  /** the files that go (script files left out); empty for an excluded candidate */
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative() })),
  /** script files left out: the skill works without them */
  scriptsDropped: z.number().int().nonnegative(),
  /** a team skill of the same name: the default action is merging into it */
  sameName: TeamSkillRef.nullable(),
  /** a similar team skill the AI named: merging is offered */
  similar: TeamSkillRef.nullable(),
  /** the default action ("merge" when sameName or similar, else "add") */
  action: ShareAction,
  /** after [팀에 공유]: added (path), merge (a chat with the confirmation card: chatId), failed (error, localized) */
  applied: z.object({ status: z.enum(['added', 'merge', 'failed']), path: z.string().nullable(), chatId: z.string().nullable(), error: z.string().nullable() }).nullable(),
})
export type ShareCandidate = z.infer<typeof ShareCandidate>

/** CLAUDE.md → one team rule: the lines kept (rewritten for the team, at most SKILL_SHARE_LIMITS.ruleChars), how many were
 * dropped (tooling, personal lines, paths); `path` once saved (skills/<일하는-방식>.md, a file without a header). */
export const ShareRule = z.object({ lines: z.number().int().nonnegative(), dropped: z.number().int().nonnegative(), text: z.string(), path: z.string().nullable() })
export type ShareRule = z.infer<typeof ShareRule>

/** A remote MCP server offered as a template; `templateId` once made, `error` when that failed (localized). */
export const ShareTool = z.object({ name: z.string(), url: z.string(), auth: z.enum(['bearer', 'header', 'oauth']), header: z.string().nullable(), templateId: z.string().nullable(), error: z.string().nullable() })
export type ShareTool = z.infer<typeof ShareTool>

export const SkillShare = z.object({
  id: z.string(),
  source: SkillShareSource,
  status: SkillShareStatus,
  where: z.string().nullable(),
  /** Claude Code: project folders it looked in */
  projects: z.number().int().nullable(),
  createdAt: IsoTime,
  expiresAt: IsoTime,
  /** pending: the AI turn runs · done · none: no AI answers the person (nothing pre-ticked) · failed: it did not answer
   * usably (nothing pre-ticked) */
  ai: z.enum(['pending', 'done', 'none', 'failed']),
  candidates: z.array(ShareCandidate),
  rule: ShareRule.nullable(),
  tools: z.array(ShareTool),
  /** after [팀에 공유]: the skill the invite opens (the first recommended skill added, else the first added); null when
   * nothing was added */
  landing: z.string().nullable(),
})
export type SkillShare = z.infer<typeof SkillShare>

export const ApplySkillShare = z.object({
  /** the ticked candidates by name; `as`: a new name for "separate" (default: a free "<name>-2") */
  skills: z.array(z.object({ name: z.string().min(1).max(100), action: ShareAction, as: z.string().min(1).max(64).optional() }).strict()).max(SKILL_SHARE_LIMITS.skills),
  /** CLAUDE.md → the team rule */
  rule: z.boolean().optional(),
  /** names of the tools to offer as templates */
  tools: z.array(z.string().max(80)).max(SKILL_SHARE_LIMITS.tools).optional(),
}).strict()
export type ApplySkillShare = z.infer<typeof ApplySkillShare>

export const ListSkillSharesQuery = z.object({ status: SkillShareStatus.optional(), source: SkillShareSource.optional() })

export const SKILL_SHARES = {
  createSkillShare: endpoint({ method: 'POST', path: '/api/skill-shares', auth: 'admin', owner: 'B', body: CreateSkillShare, response: SkillShare, status: 201,
    summary: 'Bring my skills to the team (owners and admins): the candidates from a picked .claude folder are staged outside the team files, checked (shape, secrets, scripts, plugin, size, personal paths, same name) and judged by one AI turn without tools. Nothing reaches the team before apply.' }),
  listSkillShares: endpoint({ method: 'GET', path: '/api/skill-shares', auth: 'admin', owner: 'B', query: ListSkillSharesQuery, response: z.object({ items: z.array(SkillShare) }),
    summary: 'The caller\'s own share proposals, newest first (a Claude Code proposal shows up here as soon as it arrives).' }),
  getSkillShare: endpoint({ method: 'GET', path: '/api/skill-shares/:id', auth: 'admin', owner: 'B', response: SkillShare,
    summary: 'One share proposal of the caller\'s own: its candidates with their group and one-line reason, the CLAUDE.md team rule and the tools.' }),
  applySkillShare: endpoint({ method: 'POST', path: '/api/skill-shares/:id/apply', auth: 'admin', owner: 'B', body: ApplySkillShare, response: SkillShare,
    summary: 'Share the ticked skills with the team as the caller (their own save: folder rules, versions, the skill change log); a skill of the same name is merged through a chat with the confirmation card, the CLAUDE.md lines become a team rule, the tools become connection templates (no key). Idempotent per skill.' }),
  dismissSkillShare: endpoint({ method: 'POST', path: '/api/skill-shares/:id/dismiss', auth: 'admin', owner: 'B', response: empty, status: 204,
    summary: 'Drop a share proposal of the caller\'s own (나중에 하기): its staged files are deleted.' }),
} as const
