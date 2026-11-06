// One team invite link (onboarding stream E; docs/DECISIONS.md "E — 팀 초대 링크"). Owner: A (server/src/auth/team-links.ts,
// registered by server/src/routes/admin.ts).
//
// Beside the single-use invites (admin.ts createInvite): one link per team that a leader pastes into KakaoTalk or Slack
// and many people use. It only ever makes members, in the groups the owner/admin chose; it has a number of uses
// (default: the plan's seats left), an expiry (7, 14 or 30 days; 14 = the trial) and a per-link limit on join
// attempts. Every join tells the owners. Only one link is open at a time: making one revokes the one before.
//
// The token is in the address's #fragment (<team>/join#t=<token>), never in its path or query: browsers do not send a
// fragment to the server, to a proxy or in a Referer. The join page reads it and sends it in a POST body, so no
// request path or log line carries it either.
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { IsoTime } from './common'
import { endpoint, empty } from './endpoint'
import { UserRef } from './entities'
import { AcceptInviteBody, LoginResponse } from './auth'

/** how long a new link works, in days (default: TEAM_LINK_DEFAULT_DAYS, the trial's length) */
export const TEAM_LINK_DAYS = [7, 14, 30] as const
export const TEAM_LINK_DEFAULT_DAYS = 14
/** without a plan (self-hosted, no seat limit) a new link takes this many people unless the admin says otherwise */
export const TEAM_LINK_DEFAULT_USES = 20
export const TEAM_LINK_MAX_USES = 1000
/** the address's fragment key: <team>/join#t=<token> */
export const TEAM_LINK_FRAGMENT_KEY = 't'

/**
 * active: works now · expired: past its date · used_up: every use taken · stopped: the person who made it can no
 * longer invite (disabled, deleted or no longer an admin). A revoked link is not shown (the card offers a new one).
 */
export const TeamLinkState = z.enum(['active', 'expired', 'used_up', 'stopped'])
export type TeamLinkState = z.infer<typeof TeamLinkState>

/**
 * A starter (docs/DECISIONS.md "M — One meeting note, everyone's own tasks"): the team files the lead put in (this
 * week's meeting notes) and what a new member asks about them. After joining, the member lands on a new chat with the
 * files attached, the link's skill chosen and the question in the box: `tasks` "내 할 일 정리해 줘", `brief` "내가 알아야
 * 할 것만 알려 줘". The files are checked at the join with the new account: one they cannot read is left out silently.
 */
export const STARTER_KINDS = ['tasks', 'brief'] as const
export const StarterKind = z.enum(STARTER_KINDS)
export type StarterKind = z.infer<typeof StarterKind>
export const TEAM_LINK_STARTER_FILES_MAX = 20
export const TeamLinkStarter = z.object({
  kind: StarterKind,
  files: z.array(z.string().min(1).max(1024)).min(1).max(TEAM_LINK_STARTER_FILES_MAX),
}).strict()
export type TeamLinkStarter = z.infer<typeof TeamLinkStarter>

export const TeamLink = z.object({
  id: Uuid7,
  /** the address to share. null: the sealed copy of the token cannot be opened on this server (its key file is gone,
   * e.g. after moving the data to another machine); the link still works for whoever has it, but the admin must make
   * a new one to copy it again */
  url: z.string().nullable(),
  groupIds: z.array(Uuid7),
  /** the team skill new members land on after joining (`/skills?run=<path>`); name and title null when the viewer
   * cannot read it any more. `title`: the name people read (its metadata title, else its name; absent from an older
   * server), for the card and the ready-made message */
  skill: z.object({ path: z.string(), name: z.string().nullable(), title: z.string().nullable().optional() }).nullable(),
  maxUses: z.number().int().positive(),
  uses: z.number().int().nonnegative(),
  createdBy: UserRef.nullable(),
  createdAt: IsoTime,
  expiresAt: IsoTime,
  state: TeamLinkState,
  /** too many join attempts through it lately (the per-link limit): it refuses everyone until then; a new link is not
   * limited. null or absent: not limited */
  limitedUntil: IsoTime.nullable().optional(),
  /** what people who join land on: the kind, how many files and which (those a person joining with the link's groups
   * could read now; owners and admins read every team folder anyway). null or absent: none */
  starter: z.object({ kind: StarterKind, files: z.number().int().nonnegative(), paths: z.array(z.string()).optional() }).nullable().optional(),
})
export type TeamLink = z.infer<typeof TeamLink>

export const TeamLinkResponse = z.object({
  /** the open link (not revoked), whatever its state; null when there is none */
  link: TeamLink.nullable(),
  /** active accounts and the plan's member limit (null: no limit): the default and the cap of maxUses */
  seats: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive().nullable() }),
})
export type TeamLinkResponse = z.infer<typeof TeamLinkResponse>

export const CreateTeamLinkBody = z.object({
  /** the groups everyone who joins gets */
  groupIds: z.array(Uuid7).max(100).default([]),
  /** omitted: the plan's seats left, or TEAM_LINK_DEFAULT_USES without a plan. Never above the plan's member limit. */
  maxUses: z.number().int().min(1).max(TEAM_LINK_MAX_USES).optional(),
  expiresInDays: z.union([z.literal(7), z.literal(14), z.literal(30)]).default(TEAM_LINK_DEFAULT_DAYS),
  /** a team skill (skills/…/SKILL.md or a legacy skills/….md) that someone joining with these groups can open */
  skillPath: z.string().min(1).max(1024).nullable().optional(),
  /** files and a question for people who join (needs `skillPath`); files someone joining with these groups could not
   * read are left out, and with none left there is no starter */
  starter: TeamLinkStarter.nullable().optional(),
})
export type CreateTeamLinkBody = z.input<typeof CreateTeamLinkBody>

/** Change what the open link leads to, keeping its address: its skill and starter, and groups added to it (never
 * removed: people who joined keep theirs). The welcome steps' invite uses it when a link is already out. */
export const UpdateTeamLinkBody = z.object({
  skillPath: z.string().min(1).max(1024).nullable().optional(),
  starter: TeamLinkStarter.nullable().optional(),
  addGroupIds: z.array(Uuid7).max(100).optional(),
}).strict()
export type UpdateTeamLinkBody = z.input<typeof UpdateTeamLinkBody>

export const TeamLinkToken = z.string().min(16).max(200)
export const TeamLinkInfoBody = z.object({ token: TeamLinkToken })
/** Why a team link does not let anyone in now (the join page says so and asks for a new link). full = the plan's seats
 * are all taken. */
export const TeamLinkProblem = z.enum(['expired', 'used_up', 'revoked', 'stopped', 'full'])
export type TeamLinkProblem = z.infer<typeof TeamLinkProblem>
export const TeamLinkInfo = z.object({
  teamName: z.string(),
  valid: z.boolean(),
  /** null while valid */
  problem: TeamLinkProblem.nullable(),
  expiresAt: IsoTime,
  /** the skill the link names, when someone joining with the link's groups can open it */
  skillName: z.string().nullable(),
  /** the same skill as people read its name (its metadata title, else its name); absent from an older server */
  skillTitle: z.string().nullable().optional(),
})
export type TeamLinkInfo = z.infer<typeof TeamLinkInfo>

export const JoinTeamLinkBody = AcceptInviteBody.extend({ token: TeamLinkToken })
/** What the new member lands on (TeamLinkStarter), checked with their account: the skill they can open, the files
 * they can read (at least one), the name of who made the link. `skill` (docs/DECISIONS.md "S — The lead's way becomes a
 * team skill"): a link to a team skill without a form and without files: the member lands on a new chat with the
 * skill's title in the box and one question; `by` is then who made the skill (its file's first version). */
export const JoinStarterKind = z.enum([...STARTER_KINDS, 'skill'])
export type JoinStarterKind = z.infer<typeof JoinStarterKind>
export const JoinStarter = z.object({
  kind: JoinStarterKind,
  skill: z.object({ path: z.string(), name: z.string(), title: z.string() }),
  /** at least one for `tasks` and `brief`; none for `skill` */
  files: z.array(z.object({ path: z.string(), name: z.string() })),
  /** the link's maker as people know them (`skill`: the skill's maker); null when gone or not known */
  by: z.string().nullable(),
}).refine((s) => s.kind === 'skill' || s.files.length > 0, { message: 'a starter with files needs one', path: ['files'] })
export type JoinStarter = z.infer<typeof JoinStarter>

export const JoinTeamLinkResponse = LoginResponse.extend({
  /** where the new member goes first: `/skills?run=<path>` when the link names a skill they can read, else null (Home) */
  next: z.string().nullable(),
  /** the link's starter as this member may use it: a new chat with the files, the skill and the question (the web
   * goes Home and fills the box). null or absent: none, or nothing of it is readable to them */
  starter: JoinStarter.nullable().optional(),
  /** who made the link's skill (the name of the person whose save made its file's first version), for the line above
   * its form: "{by}님이 만든 팀 스킬이에요". null or absent: not known, a starter pack skill, or no skill */
  skillBy: z.string().nullable().optional(),
})
export type JoinTeamLinkResponse = z.infer<typeof JoinTeamLinkResponse>

export const TEAM_LINKS = {
  getTeamLink: endpoint({ method: 'GET', path: '/api/admin/team-link', auth: 'admin', owner: 'A', response: TeamLinkResponse, summary: 'The open team invite link (address to copy again, uses, expiry, state) and the seats.' }),
  createTeamLink: endpoint({ method: 'POST', path: '/api/admin/team-link', auth: 'admin', owner: 'A', status: 201, body: CreateTeamLinkBody, response: TeamLinkResponse, summary: 'Make the team invite link (members only); the open one before it stops working.' }),
  updateTeamLink: endpoint({ method: 'PATCH', path: '/api/admin/team-link', auth: 'admin', owner: 'A', body: UpdateTeamLinkBody, response: TeamLinkResponse, summary: 'Change the open team link\'s skill and starter, or add groups to it; its address stays the same.' }),
  revokeTeamLink: endpoint({ method: 'DELETE', path: '/api/admin/team-link', auth: 'admin', owner: 'A', response: empty, status: 204, summary: 'Turn the team invite link off; its address never works again (a new link has a new token).' }),
  teamLinkInfo: endpoint({ method: 'POST', path: '/api/team-link/info', auth: 'public', owner: 'A', body: TeamLinkInfoBody, response: TeamLinkInfo, summary: 'What a team invite link is for (team, still valid or why not). The token comes in the body, never in the path.' }),
  joinTeamLink: endpoint({ method: 'POST', path: '/api/team-link/join', auth: 'public', owner: 'A', status: 201, body: JoinTeamLinkBody, response: JoinTeamLinkResponse, summary: 'Create a member account with the team invite link and sign in (rate-limited per link; the owners are told).' }),
} as const
