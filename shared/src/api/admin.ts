// Admin screens: members, invites, groups, folder permissions (+ "who sees what" preview), AI engines, budgets,
// team settings, usage, audit. Owner: A (server/src/routes/admin.ts). admin or owner unless noted.
// Admins never see other people's chats or memories, and there is no "sign in as" (tab 1).
import { z } from 'zod'
import { UserId, Uuid7 } from '../ids'
import { Access, EngineId, IsoTime, Locale, Ok, PageQuery, QueryBool, RelPath, Role, UserStatus, page } from './common'
import { binary, endpoint, empty } from './endpoint'
import { AuditEntry, Budget, EngineAccount, Folder, FolderRuleInput, Group, Invite, SubjectType, TeamSettings, User, UserRef } from './entities'
import { Password, PersonName, Username } from './auth'
import { TEAM_ICON_MAX_BYTES, TEAM_ICON_TYPES, TEAM_ICON_VERSION_RE } from '../team-icon'
import { SealedSecret } from './credentials'

// ---------------- users ----------------
export const CreateUserBody = z.object({
  username: Username,
  name: PersonName,
  email: z.email().nullable().optional(),
  role: Role.exclude(['owner']),
  groupIds: z.array(Uuid7).default([]),
  /** omitted or null = follows the team default */
  locale: Locale.nullable().optional(),
  /** user id = personal folder name; derived from username when omitted */
  id: UserId.optional(),
  /** the temporary password the admin hands over (the form pre-fills a memorable one); omitted = the server makes one */
  temporaryPassword: Password.optional(),
})
/** The temporary password is shown once; the person must change it at first sign-in (valid 7 days). */
export const CreatedUser = z.object({
  user: User, temporaryPassword: z.string(),
  /** until when the temporary password works, and the address the person signs in at (for the hand-over) */
  expiresAt: IsoTime.optional(), signInUrl: z.string().optional(),
})
export const UpdateUserBody = z.object({
  name: PersonName.optional(),
  email: z.email().nullable().optional(),
  role: Role.exclude(['owner']).optional(),
  status: UserStatus.optional(),
  groupIds: z.array(Uuid7).optional(),
  /** a language, or null = follow the team default */
  locale: Locale.nullable().optional(),
})
/** omitted temporaryPassword = the server makes a memorable one */
export const ResetPasswordBody = z.object({ temporaryPassword: Password.optional() })
export const ResetPasswordResult = z.object({ temporaryPassword: z.string(), expiresAt: IsoTime.optional(), signInUrl: z.string().optional() })
/** One-time reset link (24 h, no mail in v1: the admin hands it over). The token is shown only here. */
export const ResetLinkResult = z.object({ token: z.string(), url: z.string(), expiresAt: IsoTime })
/** What happens to the personal folder users/<id>/ of a deleted member (tab 5): moved into the owner's personal
 * folder (only the owner sees it), or deleted together with the account. */
export const DeleteUserQuery = z.object({ personalFolder: z.enum(['transfer', 'delete']).default('transfer') })
/** An admin types their own password again to delete a member (checked like the AI connections' and the speech key's,
 * rate-limited); the owner is not asked, as before. Without it an admin is refused (403). */
export const DeleteUserBody = z.object({ password: z.string().min(1).max(256).optional() })
export const UsersResponse = z.object({
  items: z.array(User),
  /** "No AI": the active people who cannot use any AI connection now: no personal connection of theirs and no team
   * connection they may use, for every engine that answers them (server/src/credentials/access.ts, the same rules as
   * the turn and the model proxy). A provider's limit that ends within the hour counts as usable (not out of credit).
   * Only when asked for (`?noAi=1`), and absent when this server does not answer with AI connections (engine.authMode
   * other than managed). */
  noAi: z.array(UserId).optional(),
  /** With `noAi`: for the people in it whom waiting alone brings AI back, when (ISO): the earliest end of a limit on a
   * connection of theirs, on any engine that answers them: a provider's limit with a known end that is not "out of
   * credit", or a connection's monthly block limit (the next month). Absent for anyone a wait does not help (no
   * connection, switched off, refused, expired, out of credit): plain "No AI". ("AI 한도 · 11월 8일 오전 12:59까지") */
  noAiUntil: z.record(UserId, IsoTime).optional(),
  /** The people with an open request to have their account deleted (Settings › Profile › 계정 삭제 요청,
   * shared/src/api/account-deletion.ts). For the owner and the admins, who delete accounts (an admin gets the members' requests only). */
  deletionRequested: z.array(UserId).optional(),
})
export type UsersResponse = z.infer<typeof UsersResponse>
/** Hand the owner role to another active member (the old owner becomes admin). */
export const TransferOwnershipBody = z.object({ userId: UserId, password: z.string().min(1).max(256) })

// ---------------- invites ----------------
export const CreateInviteBody = z.object({
  role: Role.exclude(['owner']).default('member'),
  groupIds: z.array(Uuid7).default([]),
  /** default 7 days (tab 1, tab 5) */
  expiresInHours: z.number().int().min(1).max(24 * 30).default(24 * 7),
})
/** No mail in v1: the admin copies the link. The token is shown only here. */
export const CreatedInvite = z.object({ invite: Invite, token: z.string(), url: z.string() })

// ---------------- groups ----------------
export const GroupBody = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).nullable().optional(), memberIds: z.array(UserId).default([]) })
export const UpdateGroupBody = z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().max(500).nullable().optional(), memberIds: z.array(UserId).optional() })

// ---------------- folders and rules ----------------
/** The folder's rules hash the editor started from (`Folder.rulesHash`, `FolderEditPreview.hash`): when the folder's
 * rules are not those any more (another admin, or the Members screen's skill manager switch, changed them), the save is
 * refused with 409 and `params.reason` `rules_changed`, and nothing changes. Optional: without it the save replaces
 * whatever is there, as before. */
const ExpectedHash = z.string().min(1).max(64)
export const CreateFolderBody = z.object({
  path: RelPath,
  /** create the folder on disk if missing */
  create: z.boolean().default(true),
  rules: z.array(FolderRuleInput).default([]),
  /** the hash of the rules the editor started from (no row yet: the hash of no rules) */
  expectedHash: ExpectedHash.optional(),
})
export const PutRulesBody = z.object({ rules: z.array(FolderRuleInput).max(200), expectedHash: ExpectedHash.optional() })
/**
 * "Who sees what" before saving: send the proposed rule sets (each replaces the rules of that folder); the server
 * computes every active person's effective access before/after for those folders and their rule-free subfolders.
 */
export const PreviewBody = z.object({
  changes: z.array(z.object({ path: RelPath, rules: z.array(FolderRuleInput).max(200) })).min(1).max(50),
})
export const PreviewResponse = z.object({
  folders: z.array(z.object({
    path: RelPath,
    users: z.array(z.object({ user: UserRef, role: Role, before: Access, after: Access })),
  })),
  /** people who lose access somewhere: their chats that touched those folders get a fresh engine session (H7) */
  losing: z.array(z.object({ user: UserRef, paths: z.array(RelPath), chatsReset: z.number().int().nonnegative() })),
})
export type PreviewResponse = z.infer<typeof PreviewResponse>

/**
 * Why a person has the access they have at a path: the step of the permission function that decided
 * (server/src/policy/access.ts RuleSet.explain), in its order. system: `.system/` · temp: a server temp name ·
 * own-personal: `users/<me>/` (write) · other-personal: someone else's `users/<id>/` (nobody, owner and admins
 * included) · users-root: `users/` itself (read) · owner-admin: write everywhere else · rule: the deepest folder on
 * the way up with a rule for the person (`folder`, '' = team root), the step that decided there (`tier`: person >
 * group > role > everyone) and that step's rules for the person (`rules`, the widest first: the widest access wins) ·
 * no-rule: no folder on the way up has a rule for the person (only the owner and admins).
 */
export const DecidingRule = z.object({ subjectType: SubjectType, subjectId: z.string().nullable(), access: Access })
export const AccessReasonKind = z.enum(['system', 'temp', 'own-personal', 'other-personal', 'users-root', 'owner-admin', 'rule', 'no-rule'])
export type AccessReasonKind = z.infer<typeof AccessReasonKind>
export const AccessReason = z.discriminatedUnion('kind', [
  z.object({ kind: AccessReasonKind.exclude(['rule']) }),
  z.object({ kind: z.literal('rule'), folder: RelPath, tier: SubjectType, rules: z.array(DecidingRule) }),
])
export type AccessReason = z.infer<typeof AccessReason>
/** Shown in the tree although the access is none? `listable`: the permission function's canList() (a folder without
 * access is listed for navigation when something below it is readable); `via`: those readable folders below (only when
 * the access is none; the topmost ones, by path, at most 20, `viaMore` when there are others). */
const Navigation = { listable: z.boolean(), via: z.array(RelPath), viaMore: z.boolean() }
/** Pages: `limit` rows (default 500, at most 2000) after `cursor` (the `nextCursor` of the page before; null = the
 * last page). `total`: all the rows there are. A cursor names the last row of the page before (a path; a person by name
 * and id), so rows added or gone between two pages neither come twice nor go missing. */
const PageLimit = z.coerce.number().int().min(1).max(2000)
/**
 * GET /api/admin/access/folder?path=: one team folder (outside users/), every active person's access and why, by name.
 * A folder that does not exist yet answers as it would once made (`exists` false). The summary always counts everyone.
 */
export const FolderAccessQuery = z.object({ path: RelPath.optional(), cursor: z.string().regex(/^[A-Za-z0-9_-]{1,1400}$/).optional(), limit: PageLimit.optional() })
export const FolderAccessResponse = z.object({
  /** actual names on disk; a part that does not exist yet stays as typed */
  path: RelPath,
  /** a folder is there now (a file or a missing path: false) */
  exists: z.boolean(),
  /** the nearest folder at or above `path` that carries rules (null: none on the way up) */
  ruleFolder: RelPath.nullable(),
  people: z.array(z.object({ user: UserRef, role: Role, access: Access, reason: AccessReason, ...Navigation })),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
  summary: z.object({
    access: z.object({ none: z.number().int(), read: z.number().int(), write: z.number().int() }),
    /** where the answers come from: one row per folder whose rules decided (reason 'rule') and one per other reason;
     * most first */
    sources: z.array(z.object({ reason: AccessReasonKind, folder: RelPath.nullable(), count: z.number().int() })),
  }),
  /** people switched off whom a person rule on `path` or a folder above it names: not in `people` or the summary.
   * `access` and `reason` are what they would get here if switched back on (computed as for an active person, so a
   * rule deeper down can win over theirs); `rules` are those person rules. */
  inactive: z.array(z.object({ user: UserRef, role: Role, access: Access, reason: AccessReason, rules: z.array(z.object({ folder: RelPath, access: Access })) })),
})
export type FolderAccessResponse = z.infer<typeof FolderAccessResponse>
/** What a team folder is (several at once: groups/<name> is a group folder that carries rules). */
export const AccessFolderKind = z.enum(['top', 'rules', 'group', 'project', 'connected', 'personal'])
export type AccessFolderKind = z.infer<typeof AccessFolderKind>
export const PersonFolderAccess = z.object({
  path: RelPath,
  kinds: z.array(AccessFolderKind),
  /** the group whose folder this is (groups.folder_id) */
  group: z.object({ id: z.string(), name: z.string() }).optional(),
  /** team projects using this folder (projects.folder_path; personal projects in users/ never appear) */
  projects: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  /** a connected folder (connected/<name>) */
  connected: z.object({ id: z.string(), name: z.string() }).optional(),
  /** a folder is there now (null: not looked at, the personal folder) */
  exists: z.boolean().nullable(),
  access: Access,
  reason: AccessReason,
  ...Navigation,
})
export type PersonFolderAccess = z.infer<typeof PersonFolderAccess>
/**
 * GET /api/admin/access/people/:id (one person, switched off or not) and POST /api/admin/access/new-person (someone
 * about to be invited with this role and these groups): the team folders (top-level folders, folders with rules,
 * group, project and connected folders; the person's own `users/<id>` from the member list, nothing else under users/
 * and never .system/) with the person's access and why, by path. `prefix`: only that folder and what is below it (to
 * open one part of the tree); pages as above, the cursor being the last path of the page before.
 */
export const PersonAccessQuery = z.object({ prefix: RelPath.optional(), cursor: RelPath.optional(), limit: PageLimit.optional() })
export const PersonAccessResponse = z.object({
  /** null for the new-person preview */
  user: UserRef.nullable(),
  role: Role,
  status: UserStatus.nullable(),
  groups: z.array(z.object({ id: z.string(), name: z.string() })),
  folders: z.array(PersonFolderAccess),
  total: z.number().int(),
  nextCursor: RelPath.nullable(),
})
export type PersonAccessResponse = z.infer<typeof PersonAccessResponse>
export const NewPersonAccessBody = z.object({
  role: Role.exclude(['owner']), groupIds: z.array(z.string().min(1).max(64)).max(200).default([]),
  prefix: RelPath.optional(), cursor: RelPath.optional(), limit: z.number().int().min(1).max(2000).optional(),
})

/**
 * Who sees a folder of the tree, grouped: every active person once, by how they get their access there. `rule`: the
 * deciding folder (`folder`, '' = team root) and the rule that decided (the widest of that step for them: `subject`,
 * with the group's or person's name); `owner-admin`: the owner and admins (rules change nothing for them); `no-rule`:
 * no rule on the way up is for them (they cannot open it). The same RuleSet.explain as the folder answer.
 */
export const AccessTreeWho = z.object({
  reason: z.enum(['rule', 'owner-admin', 'no-rule']),
  folder: RelPath.nullable(),
  subject: z.object({ type: SubjectType, id: z.string().nullable(), name: z.string().nullable() }).nullable(),
  access: Access,
  count: z.number().int().nonnegative(),
})
export type AccessTreeWho = z.infer<typeof AccessTreeWho>
/** A risk the server computes for a folder of the tree. `everyone-writes`: every member writes here (the topmost such
 * folder on the way down: below it the same is inherited); `skills-everyone-writes`: the same in skills/ (the
 * instructions every AI of the team follows); `root-everyone`: the team root gives every member access, so group and
 * project folders that do not shut them out are open to them too. */
export const AccessTreeRisk = z.enum(['everyone-writes', 'skills-everyone-writes', 'root-everyone'])
export type AccessTreeRisk = z.infer<typeof AccessTreeRisk>
export const AccessTreeNode = z.object({
  /** the folder's own name ('' = team root) and its path (actual names on disk) */
  name: z.string(),
  path: RelPath,
  /** rules: it carries rules; group, project, connected: as in the person answer; personal: users/ (never opened) */
  kinds: z.array(AccessFolderKind),
  group: z.object({ id: z.string(), name: z.string() }).optional(),
  projects: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  connected: z.object({ id: z.string(), name: z.string() }).optional(),
  /** how many rules this folder carries itself (0: everyone's access comes from folders above) */
  rules: z.number().int().nonnegative(),
  /** it has folders inside that the tree shows */
  folders: z.boolean(),
  /** folders with rules, group, project and connected folders below it (the tree opens the way to them) */
  marked: z.number().int().nonnegative(),
  /** every active person, grouped (empty for users/) */
  who: z.array(AccessTreeWho),
  risks: z.array(AccessTreeRisk),
  /** some members cannot open it (only part of the team sees it) */
  restricted: z.boolean(),
  /** users/: how many personal folders (active people); nothing in it is read or listed */
  people: z.number().int().nonnegative().optional(),
})
export type AccessTreeNode = z.infer<typeof AccessTreeNode>
export const AccessTreeLevel = z.object({
  /** the folder whose children these are */
  path: RelPath,
  children: z.array(AccessTreeNode),
  total: z.number().int().nonnegative(),
  /** the last name of this page when more follow (byte order), null on the last page */
  nextCursor: z.string().nullable(),
})
export type AccessTreeLevel = z.infer<typeof AccessTreeLevel>
/**
 * GET /api/admin/access/tree?path=&cursor=&limit=&open=: one level of the team folder for the admin's tree, each child
 * with who sees it, where that comes from, its risks. Pages by name (`limit` children, default 200, at most 500).
 * `open=1`: also the levels on the way down to folders with rules, group, project and connected folders (the first
 * page of each, breadth first, while the answer stays small; `levels` after the first). users/ is one row (how many
 * personal folders) and is never listed; .system/, temp names and names the team folder refuses never appear.
 */
export const AccessTreeQuery = z.object({
  path: RelPath.optional(),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  open: QueryBool.optional(),
  /** "rule folders only": the folders with rules at or below `path` that are on disk, in the tree's order (a folder,
   * then what is inside it, then its next sibling), one page (the cursor is the last path), with `above` */
  rules: QueryBool.optional(),
})
export const AccessTreeResponse = z.object({
  /** actual names on disk; a part that is not there stays as typed */
  path: RelPath,
  exists: z.boolean(),
  /** active people, and those of them that rules decide for (not the owner or admins) */
  people: z.number().int().nonnegative(),
  members: z.number().int().nonnegative(),
  /** the folder asked for itself */
  self: AccessTreeNode,
  /** its children first; with open, the levels opened on the way down after it. With rules: one list of the rule
   * folders (deeper paths, not children), `levels[0].path` being the folder asked for */
  levels: z.array(AccessTreeLevel),
  /** with rules: the folders on the way to the page's rule folders that are not in the page (the folder asked for aside) */
  above: z.array(AccessTreeNode).optional(),
})
export type AccessTreeResponse = z.infer<typeof AccessTreeResponse>

/**
 * POST /api/admin/access/edit-preview: what saving `rules` as the folder's rules would change, asked while the admin
 * edits (Admin › Folder permissions, the edit panel). Nothing is saved. `path`: a folder with a rule row is taken as
 * stored; any other team folder as typed (actual names on disk, a missing tail as typed). Not for users/.
 */
export const FolderEditBody = z.object({ path: RelPath, rules: z.array(FolderRuleInput).max(200) })
/** People whose access at the folder changes the same way (`before` → `after`). `less`: write → read or anything →
 * none; `more` the other way. `people` by name, at most 50 of `count`. `chatsReset`: their chats that start a fresh AI
 * session because they lose read (H7). */
export const FolderEditChange = z.object({
  direction: z.enum(['less', 'more']),
  before: Access,
  after: Access,
  people: z.array(UserRef),
  count: z.number().int().positive(),
  chatsReset: z.number().int().nonnegative(),
})
export type FolderEditChange = z.infer<typeof FolderEditChange>
/** A folder with rules of its own below the edited one where access changes too: for the people that no rule there (or
 * between) is for, it follows the edited folder. How many lose and gain there, and the first five by name. Folders below
 * without rules of their own change exactly as the edited folder does and are not listed. */
export const FolderEditBelow = z.object({
  path: RelPath,
  less: z.number().int().nonnegative(),
  more: z.number().int().nonnegative(),
  people: z.array(UserRef),
})
export type FolderEditBelow = z.infer<typeof FolderEditBelow>
/** What the server warns about in an edit. `team-files`: members lose read on shared (their AI loses the team's files);
 * `team-instructions`: the same on skills (the team's instructions and skills); `skills-everyone-writes`: everyone gets
 * write in skills/ (every member becomes a skill manager); `root-everyone`: a rule on the team root opens it to every
 * member (and with it group and project folders that do not shut them out). `count`: the members it touches. */
export const FolderEditWarning = z.object({ kind: z.enum(['team-files', 'team-instructions', 'skills-everyone-writes', 'root-everyone']), count: z.number().int().nonnegative() })
export type FolderEditWarning = z.infer<typeof FolderEditWarning>
export const FolderEditPreview = z.object({
  /** actual names on disk */
  path: RelPath,
  exists: z.boolean(),
  /** the folder's rules now, and their hash (`Folder.rulesHash`; no row: the hash of no rules) */
  current: z.array(DecidingRule),
  hash: z.string(),
  /** at or inside a connected folder (a one-way copy of a folder elsewhere) */
  connected: z.boolean(),
  /** active people, and those of them that rules decide for (not the owner or admins) */
  people: z.number().int().nonnegative(),
  members: z.number().int().nonnegative(),
  /** who sees the folder now, and with these rules (as the tree groups them) */
  now: z.array(AccessTreeWho),
  next: z.array(AccessTreeWho),
  /** "follow the folder above": who would see it with no rules of its own (null at the team root, which has none above) */
  above: z.array(AccessTreeWho).nullable(),
  /** less first, then more */
  changes: z.array(FolderEditChange),
  /** the rule folders below that change too, in the tree's order (at most 20; `belowMore` others) */
  below: z.array(FolderEditBelow),
  belowMore: z.number().int().nonnegative(),
  /** people whose access goes down / up (anywhere: here or below) */
  less: z.number().int().nonnegative(),
  more: z.number().int().nonnegative(),
  warnings: z.array(FolderEditWarning),
})
export type FolderEditPreview = z.infer<typeof FolderEditPreview>

// ---------------- engines ----------------
/** The team's API engine (server/src/engine/api-agent.ts): any OpenAI-compatible Chat Completions API. */
export const ApiEngineConfig = z.object({ baseUrl: z.string().nullable(), model: z.string().nullable(), label: z.string().nullable(), hasKey: z.boolean() })
export const ApiEngineBody = z.object({
  baseUrl: z.string().url().max(300).refine((u) => /^https?:\/\//.test(u), 'http(s) only'),
  model: z.string().min(1).max(200),
  label: z.string().max(40).optional(),
  key: z.string().max(500).nullable().optional(),
})

export const EngineStatus = z.object({
  id: EngineId,
  label: z.string(),
  enabled: z.boolean(),
  /** api-key: the API engine's own key (Admin > AI engines > API engine); local-login: owner's own CLI login (dev / office); managed: the team's AI connections behind the model proxy
   * (Admin > AI connections); proxy / agent-own: older servers (read only) */
  authMode: z.enum(['local-login', 'proxy', 'agent-own', 'managed', 'api-key']),
  /** api-key (the API engine): the provider's host, e.g. openrouter.ai */
  provider: z.string().optional(),
  installed: z.boolean(),
  version: z.string().nullable(),
  status: z.enum(['ok', 'limited', 'not_installed', 'not_logged_in', 'version_unsupported', 'lockdown_failed', 'error', 'unknown']),
  /** limited (managed): every usable-looking AI connection of this engine waits for a limit to end; the earliest end
   * (null when none says when). Set up and working again by itself, so not a problem to fix. */
  limitedUntil: IsoTime.nullable().optional(),
  /** what is missing, in the user's language (e.g. "owner must run `claude setup-token`") */
  detail: z.string().nullable(),
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  checkedAt: IsoTime.nullable(),
  /** still being verified on this installation (Codex on the engine account): labelled beta, owner-only, never the
   * team default */
  beta: z.boolean().optional(),
})
export type EngineStatus = z.infer<typeof EngineStatus>
/**
 * "팀원이 엔진 고르기 허용" (owner decision 2026-10-21: the engine and model are the admin's choice). Owner and admins
 * always pick; everyone else uses the team default unless this lets them: 'off' (default) = nobody else, 'everyone',
 * or 'selected' = the people in userIds and the members of groupIds.
 */
export const MemberEngineChoice = z.object({
  mode: z.enum(['off', 'everyone', 'selected']),
  groupIds: z.array(z.string().min(1).max(64)).max(200).default([]),
  userIds: z.array(UserId).max(1000).default([]),
})
export type MemberEngineChoice = z.infer<typeof MemberEngineChoice>
export const EnginesResponse = z.object({
  engines: z.array(EngineStatus),
  defaultEngine: EngineId,
  defaultModel: z.string().nullable(),
  concurrency: z.number().int(),
  /** the highest concurrency that may be set: the plan's (the hosted cloud), else 16. Absent from older servers. */
  concurrencyMax: z.number().int().min(1).optional(),
  /** deprecated (company keys are AI connections now, shared/src/api/credentials.ts): always empty; removed next release */
  accounts: z.array(EngineAccount),
  memberChoice: MemberEngineChoice,
  /** "Claude 한도에 닿으면 Codex로 넘기기" (off by default): a turn that hits the Claude subscription limit is answered by
   * Codex instead, so the conversation also goes to OpenAI */
  limitFallback: z.boolean(),
  /** false while Codex is off (switched off here, or by the installation: office mode): the fallback cannot be on */
  limitFallbackAvailable: z.boolean(),
})
export type EnginesResponse = z.infer<typeof EnginesResponse>
export const UpdateEnginesBody = z.object({
  defaultEngine: EngineId.optional(),
  defaultModel: z.string().max(100).nullable().optional(),
  concurrency: z.number().int().min(1).max(16).optional(),
  enabled: z.partialRecord(EngineId, z.boolean()).optional(),
  memberChoice: MemberEngineChoice.optional(),
  limitFallback: z.boolean().optional(),
})

// ---------------- budgets, settings, usage, audit ----------------
export const BudgetBody = z.object({
  subjectType: z.enum(['team', 'group', 'user']),
  subjectId: z.string().nullable(),
  period: z.enum(['day', 'month']),
  limitUsd: z.number().nonnegative(),
  limitTokens: z.number().int().nonnegative().nullable().optional(),
  action: z.enum(['warn', 'block']),
})
export const UpdateSettingsBody = TeamSettings.partial()
/** PUT /api/admin/team-icon?type=image/png: the type the file is (PNG, JPEG or WebP; its first bytes must match). The
 * server refuses anything else in words (params.reason: type, mismatch, too_big, too_small, too_large). */
export const TeamIconQuery = z.object({ type: z.string().min(1).max(100) })
/** The team's logo (the tab icon, shared/src/team-icon.ts). `version` names it in /team-icon?v=<version>. */
export const TeamIconInfo = z.object({
  version: z.string().regex(TEAM_ICON_VERSION_RE),
  type: z.enum(TEAM_ICON_TYPES),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  size: z.number().int().positive(),
})
export type TeamIconInfo = z.infer<typeof TeamIconInfo>
/** The team's OpenRouter key for voice input: never returned, only whether one is set and its last 4 characters. */
/** A hosted server's free speech-to-text hours this calendar month (Korea time), for Team settings › Voice input:
 * seconds of sound sent with the hosting service's key (it may go a little past freeSec), never the key. */
export const HostedSpeechUsage = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), usedSec: z.number().nonnegative(), freeSec: z.number().int().positive() })
export type HostedSpeechUsage = z.infer<typeof HostedSpeechUsage>
/** The team's own OpenRouter key (last 4 characters only) and `hosted`: the hosting service's key is on this server
 * (used when the team has none) with this month's free hours; null when there is none. */
export const SpeechKeyStatus = z.object({ set: z.boolean(), hint: z.string().nullable(), updatedAt: IsoTime.nullable(), hosted: HostedSpeechUsage.nullable() })
export type SpeechKeyStatus = z.infer<typeof SpeechKeyStatus>
/** How this server turns the sound of video and audio files into text itself (the 'local' speech provider), for the
 * "Turn video sound into text" switch: its default (mediaTranscriptsDefault with cpuCores) and what one read does. */
export const SpeechHost = z.object({
  /** CPU cores the server's helpers may use (the plan's, else the machine's) */
  cpuCores: z.number().int().positive(),
  /** whisper.cpp pieces of a read, in seconds of sound (each is cached; reading again goes on from there) */
  localPieceSec: z.number().int().positive(),
  /** measured on this server: seconds of whisper.cpp work per second of sound (null = not measured yet) */
  localSecPerSec: z.number().nonnegative().nullable(),
  /** a hosted server: the most new sound one read turns into text here, in seconds (null = no such cap) */
  hostedNewSec: z.number().int().positive().nullable(),
})
export type SpeechHost = z.infer<typeof SpeechHost>
/** sealed in the browser (purpose 'speech.key'); null removes the key. The password again, like AI connections. */
export const SetSpeechKeyBody = z.object({ sealed: SealedSecret.nullable(), password: z.string().min(1).max(256) })
export const UsageQuery = z.object({
  from: IsoTime.optional(),
  to: IsoTime.optional(),
  /** credential: per AI connection (turns.credential_id; a removed connection shows as one row) */
  groupBy: z.enum(['user', 'engine', 'model', 'day', 'group', 'credential', 'skill']).default('user'),
  /** filters (Admin > Usage's pills): one person, engine, model ('' = the default model), AI connection, or the members
   * of one group. Rows, totals and series all follow them; facets do not, so the choices stay listed. */
  user: z.string().min(1).max(200).optional(),
  engine: z.string().min(1).max(100).optional(),
  model: z.string().max(200).optional(),
  credential: z.string().min(1).max(200).optional(),
  group: z.string().min(1).max(200).optional(),
  /** series=1: tokens per day in the team time zone, split by the groupBy key (the chart) */
  series: QueryBool.optional(),
  /** facets=1: who, which engines, models, AI connections and groups have usage in the range (the filter choices) */
  facets: QueryBool.optional(),
})
/** unpricedTurns: how many of the turns have an amount with an unknown part (the API engine's provider gave no cost and
 * the model has no list price); absent = none */
export const UsageRow = z.object({ key: z.string(), label: z.string(), turns: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int(), costUsd: z.number(), unpricedTurns: z.number().int().optional() })
const UsageFacet = z.object({ key: z.string(), label: z.string() })
/** one day (YYYY-MM-DD in the team time zone) and one groupBy key; skill and group keys may overlap like their rows */
export const UsageSeriesPoint = z.object({ day: z.string(), key: z.string(), turns: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int() })
export const UsageResponse = z.object({
  from: IsoTime,
  to: IsoTime,
  rows: z.array(UsageRow),
  totals: UsageRow.omit({ key: true, label: true }),
  /** with series=1 */
  series: z.array(UsageSeriesPoint).optional(),
  /** with facets=1 */
  facets: z.object({ users: z.array(UsageFacet), engines: z.array(UsageFacet), models: z.array(UsageFacet), credentials: z.array(UsageFacet), groups: z.array(UsageFacet) }).optional(),
})
export const AuditQuery = PageQuery.extend({
  source: z.enum(['admin', 'file', 'tool', 'auth']).optional(),
  actor: UserId.optional(),
  /** file events at or under this path */
  path: RelPath.optional(),
  from: IsoTime.optional(),
  to: IsoTime.optional(),
})

export const ADMIN = {
  listUsers: endpoint({ method: 'GET', path: '/api/admin/users', auth: 'admin', owner: 'A', query: z.object({ noAi: QueryBool.optional() }), response: UsersResponse, summary: 'All members, and with ?noAi=1 who cannot use AI now ("No AI").' }),
  createUser: endpoint({ method: 'POST', path: '/api/admin/users', auth: 'admin', owner: 'A', status: 201, body: CreateUserBody, response: CreatedUser, summary: 'Add a member with a temporary password (alternative to an invite).' }),
  updateUser: endpoint({ method: 'PATCH', path: '/api/admin/users/:id', auth: 'admin', owner: 'A', body: UpdateUserBody, response: User, summary: 'Role, groups, disable (ends their sessions). Only the owner changes admins.' }),
  deleteUser: endpoint({ method: 'DELETE', path: '/api/admin/users/:id', auth: 'admin', owner: 'A', query: DeleteUserQuery, body: DeleteUserBody, response: empty, status: 204, summary: 'The owner removes anyone but themselves; an admin removes a member only (never the owner, an admin or themselves), with their password again in the body. Sessions end now, chats and memories are purged after the chat retention period; the personal folder goes to the owner or is deleted.' }),
  resetPassword: endpoint({ method: 'POST', path: '/api/admin/users/:id/reset-password', auth: 'admin', owner: 'A', body: ResetPasswordBody, response: ResetPasswordResult, summary: 'New temporary password (given, or a memorable one is made); the person must change it at next sign-in; valid 7 days; audited.' }),
  createResetLink: endpoint({ method: 'POST', path: '/api/admin/users/:id/reset-link', auth: 'admin', owner: 'A', response: ResetLinkResult, summary: 'One-time password reset link (24 h) to hand over; ends their sessions when used; audited.' }),
  transferOwnership: endpoint({ method: 'POST', path: '/api/admin/transfer-ownership', auth: 'owner-reauth', owner: 'A', body: TransferOwnershipBody, response: Ok, summary: 'Make another member the owner (password re-entry); the old owner becomes admin.' }),

  listInvites: endpoint({ method: 'GET', path: '/api/admin/invites', auth: 'admin', owner: 'A', response: z.object({ items: z.array(Invite) }), summary: 'Open and used invite links.' }),
  createInvite: endpoint({ method: 'POST', path: '/api/admin/invites', auth: 'admin', owner: 'A', status: 201, body: CreateInviteBody, response: CreatedInvite, summary: 'New invite link (copy it; no mail in v1).' }),
  revokeInvite: endpoint({ method: 'DELETE', path: '/api/admin/invites/:id', auth: 'admin', owner: 'A', response: empty, status: 204, summary: 'Revoke an unused invite.' }),

  listGroups: endpoint({ method: 'GET', path: '/api/admin/groups', auth: 'admin', owner: 'A', response: z.object({ items: z.array(Group) }), summary: 'Groups with members.' }),
  createGroup: endpoint({ method: 'POST', path: '/api/admin/groups', auth: 'admin', owner: 'A', status: 201, body: GroupBody, response: Group, summary: 'New group.' }),
  updateGroup: endpoint({ method: 'PATCH', path: '/api/admin/groups/:id', auth: 'admin', owner: 'A', body: UpdateGroupBody, response: Group, summary: 'Rename / change members.' }),
  deleteGroup: endpoint({ method: 'DELETE', path: '/api/admin/groups/:id', auth: 'admin', owner: 'A', response: empty, status: 204, summary: 'Delete a group (its folder rules go too).' }),

  listFolders: endpoint({ method: 'GET', path: '/api/admin/folders', auth: 'admin', owner: 'A', response: z.object({ items: z.array(Folder) }), summary: 'Folders that carry rules, with their rules (= /api/admin/folder-rules of the design).' }),
  createFolder: endpoint({ method: 'POST', path: '/api/admin/folders', auth: 'admin', owner: 'A', status: 201, body: CreateFolderBody, response: Folder, summary: 'Put rules on a folder (creates it on disk if asked).' }),
  putFolderRules: endpoint({ method: 'PUT', path: '/api/admin/folders/:id/rules', auth: 'admin', owner: 'A', body: PutRulesBody, response: Folder, summary: 'Replace the rules of a folder; audited; affected chats get fresh engine sessions.' }),
  deleteFolder: endpoint({ method: 'DELETE', path: '/api/admin/folders/:id', auth: 'admin', owner: 'A', response: empty, status: 204, summary: 'Remove all rules of a folder (the folder on disk stays).' }),
  previewRules: endpoint({ method: 'POST', path: '/api/admin/folder-rules/preview', auth: 'admin', owner: 'A', body: PreviewBody, response: PreviewResponse, summary: '"Who sees what" for proposed rules, before saving.' }),
  explainFolderAccess: endpoint({ method: 'GET', path: '/api/admin/access/folder', auth: 'admin', owner: 'A', query: FolderAccessQuery, response: FolderAccessResponse, summary: 'One team folder: every active person\'s access, the folder and rule it comes from, and counts. Not for users/.' }),
  explainPersonAccess: endpoint({ method: 'GET', path: '/api/admin/access/people/:id', auth: 'admin', owner: 'A', query: PersonAccessQuery, response: PersonAccessResponse, summary: 'One person: their access to every team folder (rule, top-level, group, project, connected) and why.' }),
  explainNewPersonAccess: endpoint({ method: 'POST', path: '/api/admin/access/new-person', auth: 'admin', owner: 'A', body: NewPersonAccessBody, response: PersonAccessResponse, summary: 'The same for someone about to be invited with this role and these groups (nothing is saved).' }),
  explainAccessTree: endpoint({ method: 'GET', path: '/api/admin/access/tree', auth: 'admin', owner: 'A', query: AccessTreeQuery, response: AccessTreeResponse, summary: 'One level of the team folder for the admin tree: each child folder with who sees it, from where, and its risks. users/ is one row, never listed.' }),
  previewFolderEdit: endpoint({ method: 'POST', path: '/api/admin/access/edit-preview', auth: 'admin', owner: 'A', body: FolderEditBody, response: FolderEditPreview, summary: 'What saving these rules on one folder would change: who loses and gains access there and below, what "follow the folder above" gives now, warnings, and the hash of the rules now. Nothing is saved.' }),

  engines: endpoint({ method: 'GET', path: '/api/admin/engines', auth: 'admin', owner: 'A', response: EnginesResponse, summary: 'Engine install/login/lockdown status, models, defaults, concurrency.' }),
  getApiEngine: endpoint({ method: 'GET', path: '/api/admin/engines/api-config', auth: 'owner', owner: 'A', response: ApiEngineConfig, summary: 'The team API engine settings (the key is never returned, only whether one is set).' }),
  putApiEngine: endpoint({ method: 'PUT', path: '/api/admin/engines/api-config', auth: 'owner', owner: 'A', body: ApiEngineBody, response: ApiEngineConfig, summary: 'Set the team API engine: OpenAI-compatible base URL, model, label; key: a new one, null to remove, absent to keep.' }),
  updateEngines: endpoint({ method: 'PATCH', path: '/api/admin/engines', auth: 'admin', owner: 'A', body: UpdateEnginesBody, response: EnginesResponse, summary: 'Defaults, concurrency, enable/disable, who else may pick the engine, Claude-limit fallback to Codex.' }),
  checkEngine: endpoint({ method: 'POST', path: '/api/admin/engines/:id/check', auth: 'admin', owner: 'A', response: EngineStatus, summary: 'Re-check one engine now (bounded, no model call unless needed).' }),

  listBudgets: endpoint({ method: 'GET', path: '/api/admin/budgets', auth: 'admin', owner: 'A', response: z.object({ items: z.array(Budget) }), summary: 'Budgets with current spend.' }),
  createBudget: endpoint({ method: 'POST', path: '/api/admin/budgets', auth: 'admin', owner: 'A', status: 201, body: BudgetBody, response: Budget, summary: 'New budget.' }),
  updateBudget: endpoint({ method: 'PATCH', path: '/api/admin/budgets/:id', auth: 'admin', owner: 'A', body: BudgetBody.partial(), response: Budget, summary: 'Change a budget.' }),
  deleteBudget: endpoint({ method: 'DELETE', path: '/api/admin/budgets/:id', auth: 'admin', owner: 'A', response: empty, status: 204, summary: 'Delete a budget.' }),

  settings: endpoint({ method: 'GET', path: '/api/admin/settings', auth: 'admin', owner: 'A', response: TeamSettings, summary: 'Team settings.' }),
  updateSettings: endpoint({ method: 'PATCH', path: '/api/admin/settings', auth: 'admin', owner: 'A', body: UpdateSettingsBody, response: TeamSettings, summary: 'Change team settings (team name change also renames the relay address: owner only).' }),
  putTeamIcon: endpoint({ method: 'PUT', path: '/api/admin/team-icon', auth: 'admin', owner: 'A', query: TeamIconQuery, body: binary(TEAM_ICON_MAX_BYTES), response: TeamIconInfo, summary: 'Set the team logo (tab icon, home-screen app icon): PNG, JPEG or WebP up to 1 MiB, 32–4096 px a side; audited.' }),
  deleteTeamIcon: endpoint({ method: 'DELETE', path: '/api/admin/team-icon', auth: 'admin', owner: 'A', response: empty, status: 204, summary: 'Remove the team logo: back to the default icon; audited.' }),
  speechHost: endpoint({ method: 'GET', path: '/api/admin/speech-host', auth: 'admin', owner: 'A', response: SpeechHost, summary: 'How this server turns video and audio sound into text itself: its cores, piece length and measured speed.' }),
  speechKey: endpoint({ method: 'GET', path: '/api/admin/speech-key', auth: 'admin', owner: 'A', response: SpeechKeyStatus, summary: 'Whether the OpenRouter key for voice input is set (last 4 characters only, never the key).' }),
  setSpeechKey: endpoint({ method: 'PUT', path: '/api/admin/speech-key', auth: 'admin', owner: 'A', body: SetSpeechKeyBody, response: SpeechKeyStatus, summary: 'Set (sealed in the browser) or remove (null) the OpenRouter key for voice input; asks for the password again.' }),
  usage: endpoint({ method: 'GET', path: '/api/admin/usage', auth: 'admin', owner: 'A', query: UsageQuery, response: UsageResponse, summary: 'Usage and cost per person / engine / model / day / group / AI connection / skill. Skill rows attribute the entire turn and may overlap.' }),
  audit: endpoint({ method: 'GET', path: '/api/admin/audit', auth: 'admin', owner: 'A', query: AuditQuery, response: page(AuditEntry), summary: 'Admin actions, file changes, tool calls, sign-ins.' }),
} as const
