// Team skills: reusable workflows saved as Markdown files under skills/ (server/src/chat/skills.ts). Owner: B
// (server/src/routes/memories.ts registers it with the other per-person chat lists).
//
// Who changes skills/ (docs/DECISIONS.md "팀 스킬 관리"): the people with WRITE on skills/ or one of its subfolders =
// "skill managers" (owner and admins always; others through Admin > 멤버 / 그룹 "팀 스킬 관리", which is a folder
// rule, not a permission system of its own). Everyone else can suggest a skill ("스킬로 제안"): it waits on the server,
// not in skills/, until a manager of the target folder registers it (등록) or turns it down (거절).
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { IsoTime, RelPath, page, PageQuery } from './common'
import { endpoint } from './endpoint'
import { UserRef } from './entities'

export const SkillInfo = z.object({
  /** Entry point: legacy skills/주간-보고서.md or standard skills/weekly-report/SKILL.md. */
  path: z.string(),
  // Display metadata also accepts standard 64-character names and 1024-character descriptions.
  // The legacy suggestion form below keeps its existing limits; this response never truncates a manifest.
  name: z.string(),
  description: z.string(),
})
export type SkillInfo = z.infer<typeof SkillInfo>
export const PopularSkills = z.object({
  items: z.array(SkillInfo.extend({ uses: z.number().int().positive(), users: z.number().int().positive() })).max(10),
  days: z.literal(30),
})
export type PopularSkills = z.infer<typeof PopularSkills>

/** skills/ itself or a folder below it (at most two levels: skills/재무/월말). */
export const SkillFolderPath = RelPath.refine((p) => {
  const segs = p.split('/')
  return segs[0] === 'skills' && segs.length <= 3
}, { message: 'must be skills/ or a folder inside it (at most two levels)' })

/** A skill's name: one line, no slash (it is typed after "/" in the composer). */
export const SkillName = z.string().trim().min(1).max(60).refine((s) => !s.includes('/') && !/[\r\n]/.test(s), { message: 'one line, no "/"' })
export const SkillDescription = z.string().trim().max(300)
export const SKILL_CONTENT_MAX = 16_000
export const SkillContent = z.string().max(SKILL_CONTENT_MAX)

export const SkillSuggestionStatus = z.enum(['pending', 'approved', 'rejected'])
export type SkillSuggestionStatus = z.infer<typeof SkillSuggestionStatus>

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
  /** a chat answer, or the file path (users/<id>/… of the suggester) */
  source: z.object({ kind: z.enum(['message', 'file']), path: RelPath.nullable() }),
  suggester: UserRef,
  reviewer: UserRef.nullable(),
  reviewNote: z.string().nullable(),
  /** the skills/ file it became */
  resultPath: RelPath.nullable(),
  createdAt: IsoTime,
  reviewedAt: IsoTime.nullable(),
  /** the caller manages the target folder (may register or turn it down) */
  canReview: z.boolean(),
})
export type SkillSuggestion = z.infer<typeof SkillSuggestion>

export const CreateSkillSuggestionBody = z.object({
  source: SkillSuggestionSource,
  targetFolder: SkillFolderPath.default('skills'),
  name: SkillName,
  description: SkillDescription.default(''),
  content: SkillContent.refine((s) => s.trim().length > 0, { message: 'empty' }),
})
export const ApproveSkillSuggestionBody = z.object({
  targetFolder: SkillFolderPath,
  name: SkillName,
  description: SkillDescription,
  content: SkillContent.refine((s) => s.trim().length > 0, { message: 'empty' }),
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
  listSkills: endpoint({ method: 'GET', path: '/api/skills', auth: 'user', owner: 'B', response: z.object({ items: z.array(SkillInfo) }), summary: 'Skills the caller can use: skills/**/*.md with a name header that the caller can read, by name.' }),
  skillsOverview: endpoint({ method: 'GET', path: '/api/skills/overview', auth: 'user', owner: 'B', response: SkillsOverview, summary: 'The skills folders the caller manages / can suggest into, and how many suggestions wait.' }),
  listSkillSuggestions: endpoint({ method: 'GET', path: '/api/skills/suggestions', auth: 'user', owner: 'B', query: SkillSuggestionsQuery, response: page(SkillSuggestion), summary: 'My suggestions, or (scope=review) the suggestions for skills folders I manage. Nobody else sees them.' }),
  getSkillSuggestion: endpoint({ method: 'GET', path: '/api/skills/suggestions/:id', auth: 'user', owner: 'B', response: SkillSuggestion, summary: 'One suggestion: its suggester and the managers of its target folder only (404 for anyone else).' }),
  createSkillSuggestion: endpoint({ method: 'POST', path: '/api/skills/suggestions', auth: 'user', owner: 'B', status: 201, body: CreateSkillSuggestionBody, response: SkillSuggestion, summary: 'Suggest as skill: from an answer in my chat or a file in my folder; stored on the server (not in skills/); the managers of the target folder are told.' }),
  approveSkillSuggestion: endpoint({ method: 'POST', path: '/api/skills/suggestions/:id/approve', auth: 'user', owner: 'B', body: ApproveSkillSuggestionBody, response: SkillSuggestion, summary: 'Register: a manager of the target folder writes it under skills/ (audited, version history); the suggester is told.' }),
  rejectSkillSuggestion: endpoint({ method: 'POST', path: '/api/skills/suggestions/:id/reject', auth: 'user', owner: 'B', body: RejectSkillSuggestionBody, response: SkillSuggestion, summary: 'Turn down: a manager of the target folder turns it down; the suggester is told.' }),
  listSkillChanges: endpoint({ method: 'GET', path: '/api/admin/skill-changes', auth: 'admin', owner: 'A', query: PageQuery, response: page(SkillChange), summary: 'Every create / edit / move / delete under skills/ (people and AI), newest first.' }),
  listSkillManagers: endpoint({ method: 'GET', path: '/api/admin/skill-managers', auth: 'admin', owner: 'A', response: SkillManagersResponse, summary: 'Who manages team skills: the write rules for people and groups on skills/ and its folders.' }),
  setSkillManager: endpoint({ method: 'PUT', path: '/api/admin/skill-managers', auth: 'admin', owner: 'A', body: SetSkillManagerBody, response: SkillManagersResponse, summary: '"Manages team skills" on / off for a person or group on skills/ or a subfolder: adds or removes their write rule there (audited, like Admin > folder access).' }),
} as const
