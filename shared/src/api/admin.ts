// Admin screens: members, invites, groups, folder permissions (+ "who sees what" preview), AI engines, budgets,
// team settings, usage, audit. Owner: A (server/src/routes/admin.ts). admin or owner unless noted.
// Admins never see other people's chats or memories, and there is no "sign in as" (tab 1).
import { z } from 'zod'
import { UserId, Uuid7 } from '../ids'
import { Access, EngineId, IsoTime, Locale, Ok, PageQuery, RelPath, Role, UserStatus, page } from './common'
import { endpoint, empty } from './endpoint'
import { AuditEntry, Budget, EngineAccount, Folder, FolderRuleInput, Group, Invite, TeamSettings, User, UserRef } from './entities'
import { Password, PersonName, Username } from './auth'

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
export const CreateFolderBody = z.object({
  path: RelPath,
  /** create the folder on disk if missing */
  create: z.boolean().default(true),
  rules: z.array(FolderRuleInput).default([]),
})
export const PutRulesBody = z.object({ rules: z.array(FolderRuleInput).max(200) })
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
  /** local-login: owner's own CLI login (dev / subscription); proxy: company key behind the model proxy; agent-own: engine account's own login */
  authMode: z.enum(['local-login', 'proxy', 'agent-own']),
  installed: z.boolean(),
  version: z.string().nullable(),
  status: z.enum(['ok', 'not_installed', 'not_logged_in', 'version_unsupported', 'lockdown_failed', 'error', 'unknown']),
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
/** Company API key (proxy mode; code-only for now). The secret is stored outside the DB; only a reference + hint stay. */
export const AddEngineAccountBody = z.object({ engine: z.enum(['anthropic', 'openai']), label: z.string().max(100).optional(), secret: z.string().min(10).max(500) })

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
export const UsageQuery = z.object({
  from: IsoTime.optional(),
  to: IsoTime.optional(),
  groupBy: z.enum(['user', 'engine', 'model', 'day', 'group']).default('user'),
})
export const UsageRow = z.object({ key: z.string(), label: z.string(), turns: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int(), costUsd: z.number() })
export const UsageResponse = z.object({ from: IsoTime, to: IsoTime, rows: z.array(UsageRow), totals: UsageRow.omit({ key: true, label: true }) })
export const AuditQuery = PageQuery.extend({
  source: z.enum(['admin', 'file', 'tool', 'auth']).optional(),
  actor: UserId.optional(),
  /** file events at or under this path */
  path: RelPath.optional(),
  from: IsoTime.optional(),
  to: IsoTime.optional(),
})

export const ADMIN = {
  listUsers: endpoint({ method: 'GET', path: '/api/admin/users', auth: 'admin', owner: 'A', response: z.object({ items: z.array(User) }), summary: 'All members.' }),
  createUser: endpoint({ method: 'POST', path: '/api/admin/users', auth: 'admin', owner: 'A', status: 201, body: CreateUserBody, response: CreatedUser, summary: 'Add a member with a temporary password (alternative to an invite).' }),
  updateUser: endpoint({ method: 'PATCH', path: '/api/admin/users/:id', auth: 'admin', owner: 'A', body: UpdateUserBody, response: User, summary: 'Role, groups, disable (ends their sessions). Only the owner changes admins.' }),
  deleteUser: endpoint({ method: 'DELETE', path: '/api/admin/users/:id', auth: 'owner', owner: 'A', query: DeleteUserQuery, response: empty, status: 204, summary: 'Owner only. Remove a member: sessions end now, chats and memories are purged after the chat retention period; the personal folder goes to the owner or is deleted.' }),
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

  engines: endpoint({ method: 'GET', path: '/api/admin/engines', auth: 'admin', owner: 'A', response: EnginesResponse, summary: 'Engine install/login/lockdown status, models, defaults, concurrency.' }),
  getApiEngine: endpoint({ method: 'GET', path: '/api/admin/engines/api-config', auth: 'owner', owner: 'A', response: ApiEngineConfig, summary: 'The team API engine settings (the key is never returned, only whether one is set).' }),
  putApiEngine: endpoint({ method: 'PUT', path: '/api/admin/engines/api-config', auth: 'owner', owner: 'A', body: ApiEngineBody, response: ApiEngineConfig, summary: 'Set the team API engine: OpenAI-compatible base URL, model, label; key: a new one, null to remove, absent to keep.' }),
  updateEngines: endpoint({ method: 'PATCH', path: '/api/admin/engines', auth: 'admin', owner: 'A', body: UpdateEnginesBody, response: EnginesResponse, summary: 'Defaults, concurrency, enable/disable, who else may pick the engine, Claude-limit fallback to Codex.' }),
  checkEngine: endpoint({ method: 'POST', path: '/api/admin/engines/:id/check', auth: 'admin', owner: 'A', response: EngineStatus, summary: 'Re-check one engine now (bounded, no model call unless needed).' }),
  addEngineAccount: endpoint({ method: 'POST', path: '/api/admin/engines/accounts', auth: 'owner', owner: 'A', status: 201, body: AddEngineAccountBody, response: EngineAccount, summary: 'Company API key for proxy mode (code-only for now).' }),
  deleteEngineAccount: endpoint({ method: 'DELETE', path: '/api/admin/engines/accounts/:id', auth: 'owner', owner: 'A', response: empty, status: 204, summary: 'Remove a company key.' }),

  listBudgets: endpoint({ method: 'GET', path: '/api/admin/budgets', auth: 'admin', owner: 'A', response: z.object({ items: z.array(Budget) }), summary: 'Budgets with current spend.' }),
  createBudget: endpoint({ method: 'POST', path: '/api/admin/budgets', auth: 'admin', owner: 'A', status: 201, body: BudgetBody, response: Budget, summary: 'New budget.' }),
  updateBudget: endpoint({ method: 'PATCH', path: '/api/admin/budgets/:id', auth: 'admin', owner: 'A', body: BudgetBody.partial(), response: Budget, summary: 'Change a budget.' }),
  deleteBudget: endpoint({ method: 'DELETE', path: '/api/admin/budgets/:id', auth: 'admin', owner: 'A', response: empty, status: 204, summary: 'Delete a budget.' }),

  settings: endpoint({ method: 'GET', path: '/api/admin/settings', auth: 'admin', owner: 'A', response: TeamSettings, summary: 'Team settings.' }),
  updateSettings: endpoint({ method: 'PATCH', path: '/api/admin/settings', auth: 'admin', owner: 'A', body: UpdateSettingsBody, response: TeamSettings, summary: 'Change team settings (team name change also renames the relay address: owner only).' }),
  usage: endpoint({ method: 'GET', path: '/api/admin/usage', auth: 'admin', owner: 'A', query: UsageQuery, response: UsageResponse, summary: 'Usage and cost per person / engine / model / day.' }),
  audit: endpoint({ method: 'GET', path: '/api/admin/audit', auth: 'admin', owner: 'A', query: AuditQuery, response: page(AuditEntry), summary: 'Admin actions, file changes, tool calls, sign-ins.' }),
} as const
