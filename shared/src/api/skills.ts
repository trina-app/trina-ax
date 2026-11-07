// Team skills: reusable workflows saved as Markdown files under skills/ (server/src/chat/skills.ts). Owner: B
// (server/src/routes/memories.ts registers it with the other per-person chat lists).
//
// Who changes skills/ (docs/DECISIONS.md "팀 스킬 관리"): the people with WRITE on skills/ or one of its subfolders =
// "skill managers" (owner and admins always; others through Admin > 멤버 / 그룹 "팀 스킬 관리", which is a folder
// rule, not a permission system of its own). Everyone else can suggest a skill ("스킬로 제안"): it waits on the server,
// not in skills/, until a manager of the target folder registers it (등록) or turns it down (거절).
// Group skills (docs/DECISIONS.md "Group skills"): groups/<folder>/skills/ of each group the person belongs to; its
// managers are the group's members who may write that folder (every member by default).
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { IsoTime, RelPath, page, PageQuery } from './common'
import { endpoint } from './endpoint'
import { UserRef } from './entities'
import { SkillInput } from './skill-inputs'
import { ShareApp, ShareExcludedReason, ShareSkillIn, SKILL_SHARE_LIMITS, SkillGroupRef } from './skill-shares'

export const SkillInfo = z.object({
  /** Entry point: legacy skills/주간-보고서.md or standard skills/weekly-report/SKILL.md. */
  path: z.string(),
  // Display metadata also accepts standard 64-character names and 1024-character descriptions.
  // The legacy suggestion form below keeps its existing limits; this response never truncates a manifest.
  name: z.string(),
  description: z.string(),
  /** true for a personal skill of the caller (users/<caller>/skills/...): only the caller can see or use it */
  personal: z.boolean().optional(),
  /** a skill of one of the caller's groups (groups/<folder>/skills/...): only that group's members see and use it. The
   * group by its current name (a rename shows at once; its folder keeps the name it was made with). */
  group: SkillGroupRef.optional(),
  /** the short form the skill runs from (its header's metadata `inputs`, ./skill-inputs.ts); absent: a plain skill */
  inputs: z.array(SkillInput).optional(),
  /** the name people read ("광고 문구"): a SKILL.md's metadata `title`, one line of at most SKILL_TITLE_MAX characters.
   * Absent: people read `name`. Commands still run by name ("/ad-copy"): show it through skillTitle(). */
  title: z.string().optional(),
  /** a request people can send as it is ("내 할 일 정리해 줘"): the header's metadata `example`, one line of at most
   * SKILL_EXAMPLE_MAX characters. Absent: skillExample() takes the first quoted request of the description */
  example: z.string().optional(),
  /** a member suggested it and an owner or admin approved it (docs/DECISIONS.md "MC"): the member's name while their
   * account is there ("민준 님이 제안"); the approver's save made the file, so this is never read from the file's text */
  suggestedBy: z.string().optional(),
  /** only in GET /api/skills?shadowed=1, for the Team skills page: a skill of the same name that is not in the caller's
   * list because another one runs instead (personal > group > team). Which one runs is unchanged; the page keeps this
   * one in its own section with a note, so it does not look deleted. Never in the "/" menu or the AI's list. */
  shadowedBy: z.object({ tier: z.enum(['personal', 'group']), group: SkillGroupRef.optional() }).optional(),
  /** a skill in the list that runs instead of a team skill ("team") or a group's ("group") of the same name: the "/"
   * menu's small hint "팀 스킬 대신" */
  replaces: z.enum(['team', 'group']).optional(),
})
export type SkillInfo = z.infer<typeof SkillInfo>
/** The longest metadata `example` (characters); a longer one is ignored. */
export const SKILL_EXAMPLE_MAX = 200
/** Control and text-direction characters: not in a line people read or send (a skill's title, its example request).
 * The server reads metadata `example` with the same class (server/src/chat/skills.ts readSkillExample). */
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/
/**
 * The request a skill's form starts with when the skill has no fields of its own (docs/DECISIONS.md "W5": a member who
 * lands on the skill sees what it does by what they can send): its metadata `example`, else the first request its
 * description quotes ("…처럼 물을 때 써요": "내 할 일 정리해 줘"), else null (the box starts empty). One line, without
 * control or text-direction characters: the description is the skill author's text, and a right-to-left override in
 * the quote would show the member a request other than the one 실행 sends (the example is checked again too, though
 * the server already leaves such a one out).
 */
export function skillExample(s: { description: string; example?: string | null }): string | null {
  const own = s.example?.trim()
  if (own && !HIDDEN_CHARS.test(own) && [...own].length <= SKILL_EXAMPLE_MAX) return own
  const m = /["“「『]([^"”」』\r\n]{2,120})["”」』]/.exec(s.description)
  const quoted = m?.[1]!.trim()
  return quoted && !HIDDEN_CHARS.test(quoted) ? quoted : null
}
/** The longest metadata `title` a skill may have (characters); a longer one is ignored and the name shows. */
export const SKILL_TITLE_MAX = 60
/** A SKILL.md's metadata `title` as people read it, or null when it is not one: empty, more than one line, longer
 * than SKILL_TITLE_MAX, or holding control or text-direction characters (it reaches the join page and the copied
 * invite message). The skill still loads; its name shows instead. */
export function readSkillTitle(raw: string | undefined): string | null {
  const v = raw?.trim()
  return v && !HIDDEN_CHARS.test(v) && [...v].length <= SKILL_TITLE_MAX ? v : null
}
/** What a person reads as a skill's name: its title, else its name. Every screen, message and notice that names a
 * skill to a person uses this; a command the person types or sends stays "/<name>". */
export const skillTitle = (s: { name: string; title?: string | null }): string => s.title?.trim() || s.name
/** A skill's name in a sentence that names it to people who did not pick it (the invite message, the join page, the
 * goal card; docs/DECISIONS.md "W5"): its title, else its folder name as words ("quote-maker" → "quote maker":
 * hyphens and underscores become spaces), never the raw folder name. A title that only repeats the name (what a
 * server's skillTitle() sends without a metadata title) counts as none. */
export function skillLabel(s: { name: string; title?: string | null }): string {
  const title = s.title?.trim()
  if (title && title !== s.name) return title
  return s.name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || s.name
}
/** A skill's description without a lead that only repeats its title: the marketing pack writes "광고 문구 — 알릴 제품과
 * …" so the AI and older screens read the plain name; next to the title the rest is enough. The rest starts as a
 * sentence: "Ad copy — takes what to promote …" reads "Takes what to promote …". */
export function skillSummary(s: { name: string; title?: string | null; description: string }): string {
  const title = s.title?.trim()
  if (!title) return s.description
  const m = /^\s*(.+?)\s+[—–-]\s+/.exec(s.description)
  if (!m || m[1]!.trim().normalize('NFC').toLowerCase() !== title.normalize('NFC').toLowerCase()) return s.description
  const rest = s.description.slice(m[0].length)
  return /^[a-z]/.test(rest) ? rest[0]!.toUpperCase() + rest.slice(1) : rest
}
export const PopularSkills = z.object({
  items: z.array(SkillInfo.extend({ uses: z.number().int().positive(), users: z.number().int().positive() })).max(10),
  days: z.literal(30),
})
export type PopularSkills = z.infer<typeof PopularSkills>
/** Why a skill entry does not load (R2-SKILL-03). The screens translate the code. */
export const SkillProblem = z.enum(['too_large', 'header', 'location', 'name', 'name_folder', 'description', 'compatibility',
  // a whole folder, for the people who manage it: more entries than the server reads (1,000 per skills folder), or more
  // team rule files than the AI follows (10)
  'too_many', 'too_many_rules',
  // the skill loads, but its metadata `inputs` is not a valid form (./skill-inputs.ts): it runs without its form
  'inputs'])
export type SkillProblem = z.infer<typeof SkillProblem>
export const SkillIssue = z.object({ path: z.string(), problem: SkillProblem })
export type SkillIssue = z.infer<typeof SkillIssue>

/** skills/ itself or a folder below it (at most two levels: skills/재무/월말). */
export const SkillFolderPath = RelPath.refine((p) => {
  const segs = p.split('/')
  // the team's skills/ (two levels below at most), or a group's groups/<folder>/skills (docs/DECISIONS.md "Group skills")
  return (segs[0] === 'skills' && segs.length <= 3) || (segs[0] === 'groups' && !!segs[1] && segs[2] === 'skills' && segs.length <= 5)
}, { message: 'must be skills/ or a group\'s groups/<folder>/skills, or a folder inside it (at most two levels)' })

/** A skill's name: one line, no slash (it is typed after "/" in the composer). */
export const SkillName = z.string().trim().min(1).max(60).refine((s) => !s.includes('/') && !/[\r\n]/.test(s), { message: 'one line, no "/"' })
export const SkillDescription = z.string().trim().max(300)
export const SKILL_CONTENT_MAX = 16_000
export const SkillContent = z.string().max(SKILL_CONTENT_MAX)

export const SkillSuggestionStatus = z.enum(['pending', 'approved', 'rejected'])
export type SkillSuggestionStatus = z.infer<typeof SkillSuggestionStatus>

/** Members contribute (docs/DECISIONS.md "MC"): skill folders from a member's own computer go as one batch of
 * suggestions; at most `batch` folders in one send, and at most `open` suggestions of one member waiting at a time
 * (every kind of suggestion counts). */
export const CONTRIBUTE_LIMITS = { batch: 10, open: 20 } as const

/** Where the suggestion comes from: an answer in one of the caller's own chats, or a file in their own folder. */
export const SkillSuggestionSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), chatId: Uuid7, messageId: Uuid7 }),
  z.object({ kind: z.literal('file'), path: RelPath }),
])
export type SkillSuggestionSource = z.infer<typeof SkillSuggestionSource>

export const SkillSuggestion = z.object({
  id: Uuid7,
  status: SkillSuggestionStatus,
  targetFolder: RelPath,
  name: z.string(),
  description: z.string(),
  content: z.string(),
  /** a chat answer, the file path (users/<id>/… of the suggester), or a skill folder from the suggester's computer
   * (`folder`, docs/DECISIONS.md "MC"; path null) */
  source: z.object({ kind: z.enum(['message', 'file', 'folder']), path: RelPath.nullable() }),
  suggester: UserRef,
  reviewer: UserRef.nullable(),
  reviewNote: z.string().nullable(),
  /** the skills/ file it became */
  resultPath: RelPath.nullable(),
  createdAt: IsoTime,
  reviewedAt: IsoTime.nullable(),
  /** the caller manages the target folder (may register or turn it down); a skill folder: only owners and admins */
  canReview: z.boolean(),
  /** source `folder` only: what the folder holds (its files and sizes, never their content but SKILL.md's, which is
   * `content`); approving writes skills/<name>/ with them. Absent for other kinds and from older servers */
  folder: z.object({
    app: ShareApp,
    /** the SKILL.md's metadata title, if any */
    title: z.string().nullable(),
    /** `text`: a text file's content (not SKILL.md's: that is `content`), only in GET …/:id for a reviewer of a waiting
     * suggestion, so the owner reads everything the team's AI would read */
    files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), text: z.string().optional() })),
    /** script files left out: the team never runs them */
    scriptsDropped: z.number().int().nonnegative(),
    /** it names a path on the member's computer: it may not work for the team */
    personalPath: z.boolean(),
    /** a team skill of the same name the reviewer can see when it came */
    sameName: z.object({ path: z.string(), title: z.string() }).nullable(),
  }).nullable().optional(),
  /** the batch it came with (one Inbox line per batch); null for a suggestion sent alone */
  batchId: z.string().nullable().optional(),
  /** the target is a group's skills folder (groups/<folder>/skills/…): that group by its current name; its members who
   * may write the folder review it (docs/DECISIONS.md "Group skills") */
  targetGroup: SkillGroupRef.optional(),
})
export type SkillSuggestion = z.infer<typeof SkillSuggestion>

/** POST /api/skills/suggestions/batch (docs/DECISIONS.md "MC"): skill folders a member picked on their computer, as
 * the browser read them (lib/skillScan.ts: a skill with a key never leaves the computer). The server checks each one
 * again with the checks of 내 스킬 가져오기 (skills/share-check.ts) and makes one suggestion per skill that passes. */
export const ContributeSkillsBody = z.object({
  /** whose folder: claude (default) or codex */
  app: ShareApp.optional(),
  skills: z.array(ShareSkillIn).min(1).max(CONTRIBUTE_LIMITS.batch),
}).strict()
export type ContributeSkillsBody = z.infer<typeof ContributeSkillsBody>
/** A skill of the batch the server did not take: the checks of 내 스킬 가져오기 (secret, scripts, plugin, too_big,
 * not_skill), or `pending`: the member already suggested a skill folder of that name that still waits. */
export const ContributeRefusal = z.object({ name: z.string(), reason: z.enum([...ShareExcludedReason.options, 'pending']), detail: z.string().nullable() })
export type ContributeRefusal = z.infer<typeof ContributeRefusal>
export const ContributedSkills = z.object({
  /** the batch (null when nothing was taken) */
  batchId: z.string().nullable(),
  items: z.array(SkillSuggestion),
  refused: z.array(ContributeRefusal),
})
export type ContributedSkills = z.infer<typeof ContributedSkills>

export const CreateSkillSuggestionBody = z.object({
  source: SkillSuggestionSource,
  targetFolder: SkillFolderPath.default('skills'),
  name: SkillName,
  description: SkillDescription.default(''),
  content: SkillContent.refine((s) => s.trim().length > 0, { message: 'empty' }),
})
export const ApproveSkillSuggestionBody = z.object({
  targetFolder: SkillFolderPath,
  /** a skill folder (source `folder`): its folder name, lowercase letters, digits and hyphens, at most 64; another
   * suggestion's name at most 60 (the server checks which applies) */
  name: z.string().trim().min(1).max(64).refine((s) => !s.includes('/') && !/[\r\n]/.test(s), { message: 'one line, no "/"' }),
  /** at most 300 characters, a skill folder's at most 1024 (the server checks which applies) */
  description: z.string().trim().max(1024),
  /** at most SKILL_CONTENT_MAX characters, a skill folder's SKILL.md body at most a skill file's size (the server
   * checks which applies) */
  content: z.string().max(SKILL_SHARE_LIMITS.fileBytes).refine((s) => s.trim().length > 0, { message: 'empty' }),
  /** file name without .md (default: from the name) */
  fileName: z.string().trim().min(1).max(80).optional(),
})
export const RejectSkillSuggestionBody = z.object({ note: z.string().trim().max(500).optional() })
export const SkillSuggestionsQuery = PageQuery.extend({
  /** mine: what I suggested; review: suggestions for folders I manage */
  scope: z.enum(['mine', 'review']).default('mine'),
  status: SkillSuggestionStatus.optional(),
})

export const SkillsOverview = z.object({
  /** skills folders the caller may change (write): they review suggestions for these and below */
  managedFolders: z.array(RelPath),
  /** skills folders the caller can see, to suggest into */
  suggestFolders: z.array(RelPath),
  /** pending suggestions the caller may review */
  pendingReview: z.number().int().nonnegative(),
  /** the caller's own suggestions still waiting */
  myPending: z.number().int().nonnegative(),
  /** open share proposals that others made to a group whose skills folder the caller may write (docs/DECISIONS.md
   * "Group skills"): the caller may apply them (GET /api/skill-shares?scope=review). Absent from older servers: 0 */
  sharesToReview: z.number().int().nonnegative().optional(),
  /** what the AI's instructions hold of the caller's skills (server/src/chat/skill-list.ts): every name while they
   * fit in the list's budget, descriptions while they fit; the rest the AI finds with find_skills. Team rules: how many
   * skills/*.md rule files there are and how many the AI follows (the first 10). Absent from older servers. */
  aiList: z.object({
    skills: z.number().int().nonnegative(),
    described: z.number().int().nonnegative(),
    nameOnly: z.number().int().nonnegative(),
    unlisted: z.number().int().nonnegative(),
    /** the list did not fit: some descriptions (or names) are left out of it */
    cut: z.boolean(),
    rules: z.number().int().nonnegative(),
    rulesFollowed: z.number().int().nonnegative(),
  }).optional(),
})
export type SkillsOverview = z.infer<typeof SkillsOverview>

/** One change under skills/ (by a person or by the AI), with the link to its version history. Admin > 팀 스킬 변경. */
export const SkillChange = z.object({
  id: z.string(),
  at: IsoTime,
  actor: UserRef.nullable(),
  path: RelPath,
  change: z.enum(['create', 'update', 'delete', 'move', 'restore']),
  /** move: the old path */
  from: RelPath.nullable(),
  /** the AI saved it in a chat turn (after the person confirmed) */
  byAi: z.boolean(),
  /** a skill (with a name header) or a team rule (no header); null for deletions and folders */
  kind: z.enum(['skill', 'rule', 'folder', 'other']).nullable(),
  /** a change in a group's skills folder (groups/<folder>/skills/): the group as it was named then; id null when no
   * group had that folder any more */
  group: z.object({ id: z.string().nullable(), name: z.string() }).optional(),
})
export type SkillChange = z.infer<typeof SkillChange>

/** Admin > 멤버 / 그룹 "팀 스킬 관리": a write rule on skills/ or a subfolder for one person or group. */
export const SkillManagerSubject = z.discriminatedUnion('subjectType', [
  z.object({ subjectType: z.literal('user'), subjectId: z.string().min(1).max(64) }),
  z.object({ subjectType: z.literal('group'), subjectId: z.string().min(1).max(64) }),
])
export const SkillManagerGrant = z.object({
  subjectType: z.enum(['user', 'group']),
  subjectId: z.string(),
  /** skills or skills/<sub> */
  path: RelPath,
})
export type SkillManagerGrant = z.infer<typeof SkillManagerGrant>
export const SkillManagersResponse = z.object({
  /** skills/ and its folders (two levels), to pick the scope from */
  folders: z.array(RelPath),
  /** every write rule for a person or group on skills/ or below */
  items: z.array(SkillManagerGrant),
})
export type SkillManagersResponse = z.infer<typeof SkillManagersResponse>
export const SetSkillManagerBody = z.intersection(SkillManagerSubject, z.object({ path: SkillFolderPath.default('skills'), enabled: z.boolean() }))

export const SKILLS = {
  popularSkills: endpoint({ method: 'GET', path: '/api/skills/popular', auth: 'user', owner: 'B', response: PopularSkills, summary: 'Last 30 days of usage counts for currently readable skills, with no user identities or prompts.' }),
  listSkills: endpoint({ method: 'GET', path: '/api/skills', auth: 'user', owner: 'B', query: z.object({ shadowed: z.literal('1').optional() }), response: z.object({ items: z.array(SkillInfo) }), summary: 'Skills the caller can use: skills/**/*.md with a name header that the caller can read, the skills of the groups they belong to (groups/<folder>/skills/, with `group`), and their own personal skills (users/<caller>/skills/), by name. One name: personal > group > team. `?shadowed=1` also lists the skills that lost to a better tier, each with `shadowedBy` (the Team skills page).' }),
  listSkillIssues: endpoint({ method: 'GET', path: '/api/skills/issues', auth: 'user', owner: 'B', response: z.object({ items: z.array(SkillIssue) }), summary: 'Skill entries the caller can read that do not load: an invalid SKILL.md (also a name that is not its folder name) or a legacy file with a broken header.' }),
  skillsOverview: endpoint({ method: 'GET', path: '/api/skills/overview', auth: 'user', owner: 'B', response: SkillsOverview, summary: 'The skills folders the caller manages / can suggest into, and how many suggestions wait.' }),
  listSkillSuggestions: endpoint({ method: 'GET', path: '/api/skills/suggestions', auth: 'user', owner: 'B', query: SkillSuggestionsQuery, response: page(SkillSuggestion), summary: 'My suggestions, or (scope=review) the suggestions for skills folders I manage. Nobody else sees them.' }),
  getSkillSuggestion: endpoint({ method: 'GET', path: '/api/skills/suggestions/:id', auth: 'user', owner: 'B', response: SkillSuggestion, summary: 'One suggestion: its suggester and the managers of its target folder only (404 for anyone else).' }),
  createSkillSuggestion: endpoint({ method: 'POST', path: '/api/skills/suggestions', auth: 'user', owner: 'B', status: 201, body: CreateSkillSuggestionBody, response: SkillSuggestion, summary: 'Suggest as skill: from an answer in my chat or a file in my folder; stored on the server (not in skills/); the managers of the target folder are told.' }),
  contributeSkills: endpoint({ method: 'POST', path: '/api/skills/suggestions/batch', auth: 'user', owner: 'B', status: 201, body: ContributeSkillsBody, response: ContributedSkills, summary: 'Members contribute: skill folders from my own computer (read in the browser, keys left there) as one batch of suggestions, each checked again like the skill shares of owners (secrets, scripts, size, names, paths); stored outside the team files until an owner or admin approves; the owners and admins get one Inbox line.' }),
  approveSkillSuggestion: endpoint({ method: 'POST', path: '/api/skills/suggestions/:id/approve', auth: 'user', owner: 'B', body: ApproveSkillSuggestionBody, response: SkillSuggestion, summary: 'Register: a manager of the target folder writes it under skills/ (audited, version history); the suggester is told.' }),
  rejectSkillSuggestion: endpoint({ method: 'POST', path: '/api/skills/suggestions/:id/reject', auth: 'user', owner: 'B', body: RejectSkillSuggestionBody, response: SkillSuggestion, summary: 'Turn down: a manager of the target folder turns it down; the suggester is told.' }),
  listSkillChanges: endpoint({ method: 'GET', path: '/api/admin/skill-changes', auth: 'admin', owner: 'A', query: PageQuery, response: page(SkillChange), summary: 'Every create / edit / move / delete under skills/ (people and AI), newest first.' }),
  listSkillManagers: endpoint({ method: 'GET', path: '/api/admin/skill-managers', auth: 'admin', owner: 'A', response: SkillManagersResponse, summary: 'Who manages team skills: the write rules for people and groups on skills/ and its folders.' }),
  setSkillManager: endpoint({ method: 'PUT', path: '/api/admin/skill-managers', auth: 'admin', owner: 'A', body: SetSkillManagerBody, response: SkillManagersResponse, summary: '"Manages team skills" on / off for a person or group on skills/ or a subfolder: adds or removes their write rule there (audited, like Admin > folder access).' }),
} as const
