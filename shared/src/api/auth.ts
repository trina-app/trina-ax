// Sign-in, the signed-in person, invites, first-run setup. Owner: A (server/src/routes/auth.ts).
import { z } from 'zod'
import { UserId, Uuid7 } from '../ids'
import { ClientKind, DEFAULT_LOCALE, GuestDetail, EngineId, IsoTime, Locale, Ok, Role, TextSize } from './common'
import { endpoint, empty } from './endpoint'
import { TEAM_ICON_VERSION_RE } from '../team-icon'
import { NAME_FORBIDDEN, NAME_FORBIDDEN_FIELD } from '../name-chars'
import { HistoryView, ListFolds, Session, UserPrefs, UserRef } from './entities'
import { MyStatus } from './status-message'

export const Username = z.string().min(2).max(64).regex(/^[A-Za-z0-9._@-]+$/, 'letters, digits, ".", "_", "@", "-"')
/** Password rule: 8-128 characters; the server also refuses the username itself and very common passwords. */
export const Password = z.string().min(8).max(128)
/** A person's name as typed: 1-100 characters after trimming, one line with nothing invisible in it (../name-chars.ts:
 * it is shown and quoted as one line, a line break would end a quote). Names saved before the rule still load (the
 * responses read a plain string) and are made one line where they are quoted. */
export const PersonName = z.string().trim().min(1).max(100).refine((s) => !NAME_FORBIDDEN.test(s), { message: NAME_FORBIDDEN_FIELD })

/** GET /api/me */
export const Me = z.object({
  /** only for a guest: their one place and AI choice */
  guest: GuestDetail.optional(),
  user: z.object({
    id: UserId,
    username: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    role: Role,
    /** the language the person sees: their own choice, else the team default */
    locale: Locale,
    /** their own choice; null = follow the team default (changes when an admin changes the team default) */
    localeChoice: Locale.nullable(),
    mustChangePassword: z.boolean(),
    prefs: UserPrefs,
    /** may pick the engine / model (composer, retry with another model, own default): owner and admins always, others
     * when Admin > AI engines allows them. Absent (older server) = admins only. */
    canChooseEngine: z.boolean().optional(),
    /** the profile line (Settings › Profile): absent while empty; the photo is at /api/people/:id/avatar?v=<avatarVersion> */
    title: z.string().optional(),
    status: z.string().optional(),
    avatarVersion: z.number().int().positive().optional(),
    /** my status message (docs/DECISIONS.md "상태 메시지"), also one whose first day is still to come; absent: none */
    statusMessage: MyStatus.optional(),
    /** my "Allow all websites" is on for the AI's web reads (Settings › Browser; PUT /api/me/web-access), as it works
     * now: the team allows it and the warning I accepted is the current one. Absent: off (or an older server). */
    webAllowAll: z.literal(true).optional(),
  }),
  groups: z.array(z.object({ id: Uuid7, name: z.string() })),
  team: z.object({
    name: z.string(), defaultLocale: Locale,
    /** people may turn on "Allow all websites" for the desktop app's in-app browser (Admin > Team settings
     * browserAllowAll). The desktop app enforces it. Absent (older server) = no policy. */
    browserAllowAll: z.boolean().optional(),
    /** members may turn on "Allow all websites" for the AI's web reads too (Admin > Team settings webAllowAll, with
     * browserAllowAll on). Absent: not allowed (or an older server). */
    webAllowAll: z.literal(true).optional(),
    /** the team logo's version (Admin > Team settings): the top of the computer's rail shows /team-icon?v=<it>; null or
     * absent (older server) = the product's mark. The tab and app icons are always the product's. */
    iconVersion: z.string().regex(TEAM_ICON_VERSION_RE).nullable().optional(),
    /** voice input works (Admin > Team settings: OpenRouter with a key, or on this server). false: the composer hides
     * the mic (admins see a hint). Absent (older server) = on. */
    voiceInput: z.boolean().optional(),
    /** voice input goes to an outside service (OpenRouter): a confidential chat's composer says it is not used there
     * (the server refuses it either way). Absent: on this server, off, or an older server. */
    voiceInputOutside: z.literal(true).optional(),
    /** voice input recordings go up as 16 kHz WAV: the server decodes with macOS's own programs (an Apple silicon Mac
     * without ffmpeg), which do not open the webm/opus browsers record. Absent: the browser's own recording. */
    voiceInputWav: z.literal(true).optional(),
    /** days a deleted chat stays in the chat trash, and days a deleted account's chats and memories stay (Admin > Team
     * settings chatTrashRetentionDays; the purge uses the current value). Absent (older server) = the default, 7. */
    chatTrashRetentionDays: z.number().int().min(1).max(365).optional(),
    /** days a deleted file, folder or team project stays in Files > Trash (Admin > Team settings trashRetentionDays; the
     * purge uses the value each item was given). Absent (older server): the screens do not name a number. */
    trashRetentionDays: z.number().int().min(1).max(365).optional(),
    /** who may make team projects (Admin > Team settings projectCreators): a member sees "팀 프로젝트" only with
     * 'members'. Absent (older server) = admins only. */
    projectCreators: z.enum(['members', 'admins']).optional(),
    /** a guest only: the largest file they may upload anywhere, in bytes (the team's guestFileMax). Absent (a member,
     * or an older server): each kind of upload's own limit. The server checks it either way. */
    uploadMaxBytes: z.number().int().positive().optional(),
    /** an admin turned off "Always allow" for the team (Admin > Team settings roomAlwaysAllow): a member's own Always allow
     * on a team connection is ignored, and an Always allow or a team connection set to run without asking asks again in
     * a chat that read something from outside (server/src/integrations/connections/tools.ts gate). The connector pages
     * say so. Absent: on (the default), or an older server. */
    alwaysAllowOff: z.literal(true).optional(),
    /** the team's address for its members, an origin (https://acme.trina.app): what a new device puts in the app
     * (Settings › 앱 "팀 주소"). The relay address when the server is on a relay, else the public address it knows,
     * else for a server not on a relay the address it is reached at, with its port, http included
     * (server/src/system/connection.ts teamAddressOf). A server on a relay never gives the address the page was opened
     * at (over the office network that is the office's own address). Signed-in people only (this answer); absent =
     * none known or an older server. */
    address: z.string().max(300).optional(),
  }),
  session: z.object({
    id: Uuid7, client: ClientKind, expiresAt: IsoTime,
    /** made by signing in with a temporary password: the forced change asks only for the new password (true only
     * while mustChangePassword) */
    tempLogin: z.boolean().optional(),
    /** this sign-in's key for addresses of pictures that never change (a room file thumbnail's ?k=): with it the server
     * lets this browser keep them (server/src/auth/media-key.ts); a new sign-in gets a new one. Absent from older servers. */
    mediaKey: z.string().max(64).optional(),
  }),
  server: z.object({
    version: z.string(), dev: z.boolean(),
    /** how this server is installed (server/src/system/deployment.ts, linux-runtime D24): self or hosted (the hosted
     * service). Office mode and dev are told by `dev` and `features`. Absent from older servers. */
    deployment: z.enum(['self', 'hosted']).optional(),
    /** what this deployment offers (the same table the server enforces): the web hides what is off */
    features: z.object({
      connectionChange: z.boolean(), selfUpdate: z.boolean(), officeUpdate: z.boolean(), connectedFolders: z.boolean(),
      apiEngineAnyUrl: z.boolean(), hostDiagnostics: z.boolean(),
      /** Admin > Plugins takes package files (absent from older servers) */
      pluginFileInstall: z.boolean().optional(),
    }).optional(),
    /** the team's time zone (IANA, Admin > Settings): dates and schedules follow it */
    timeZone: z.string().optional(),
    /** Safe operations 1A is on (MYCEL_SAFE_OPS_1A): every conversation is confidential, and so is every HTML / SVG
     * file preview (shown without scripts outside the desktop app). Absent = off. */
    allChatsConfidential: z.literal(true).optional(),
    /** the dev environment experiment is on (MYCEL_DEV_ENV=1): Team settings shows its section. Absent = off. */
    devEnv: z.literal(true).optional(),
    /** this server can print HTML to PDF (a headless browser in the converter isolation, server/src/files/html-pdf.ts):
     * an .html file's preview shows "PDF로 저장". Absent = it cannot (no button that cannot work). */
    htmlPdf: z.literal(true).optional(),
    /** the HWP Preview plugin is on and usable here (server/src/plugins/manager.ts hwpPreviewOn): a Hangul file sent in
     * a room opens in the preview panel (GET /api/rooms/:id/files/:fileId/hwp-preview). Absent = off: it downloads. A
     * team file's preview asks the server either way and says when it is off. */
    hwpPreview: z.literal(true).optional(),
    /** a Linux server's Windows desktop app in Settings > Apps (server/src/system/windows-app.ts): 'feed' = the server
     * (self-installed or a hosted tenant) takes it from the signed release feed by itself after it starts or updates,
     * 'folder' = a self-installed server without a feed (the owner copies the release's files in). Absent: an office Mac
     * (teamax desktop add), dev, a hosted tenant without a feed, or an older server. */
    windowsApp: z.enum(['feed', 'folder']).optional(),
    /** Always true: folder sharing is always on (owner 2026-11-17). Kept only for web and app builds from before, which
     * show folder sharing only when it is true; current clients do not read it. */
    folderShares: z.literal(true).optional(),
  }),
  /** last password reset by an admin / owner recovery: settings shows "last reset: who, when" (tab 5). by null = owner recovery on the server Mac */
  passwordReset: z.object({ by: UserRef.nullable(), at: IsoTime }).nullable().optional(),
})
export type Me = z.infer<typeof Me>

export const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  client: ClientKind.default('web'),
  /** 'cookie' (web, desktop) sets __Host-sid; 'bearer' (mobile shells, scripts) returns the token in the body */
  tokenMode: z.enum(['cookie', 'bearer']).default('cookie'),
})
export const LoginResponse = z.object({
  me: Me,
  /** only for tokenMode 'bearer'; shown once */
  token: z.string().optional(),
})
export type LoginResponse = z.infer<typeof LoginResponse>

/**
 * currentPassword may be left out only by a session made by signing in with a temporary password while the account
 * must still change it (Me.session.tempLogin): that sign-in just proved it. Every other change needs it.
 */
export const ChangePasswordBody = z.object({ currentPassword: z.string().min(1).max(256).optional(), newPassword: Password })

export const InviteInfo = z.object({
  teamName: z.string(),
  role: Role.exclude(['owner']),
  expiresAt: IsoTime,
  /** false when expired, used or revoked (the page shows why instead of the form) */
  valid: z.boolean(),
  /** why a link does not work (only while `valid` is false; absent from an older server): expired, already used, turned
   * off by hand, its maker can no longer invite (left, switched off, lost the room or project), or the room or project
   * of a guest link is gone. Only the reason: nothing about the team, the maker or the place */
  reason: z.enum(['expired', 'used', 'revoked', 'inviter_gone', 'place_gone']).optional(),
  /** who made the invite ("{inviter} invited you to {team}"), only while it is valid; null: not known any more. Absent
   * from an older server */
  inviterName: z.string().nullable().optional(),
  /** true while every seat of the plan is taken: accepting is refused until a seat is free (the page says so instead
   * of the form). Absent from an older server */
  full: z.boolean().optional(),
  /** true for the owner's "this person is the team lead" link (a member now; the owner offers them the team after they join).
   * Only the fact, nothing about who it is for. Absent from an older server and from any other link */
  lead: z.boolean().optional(),
  /** a guest invite: the one place the guest joins, by kind and name */
  guestPlace: z.object({ kind: z.enum(['room', 'project']), name: z.string() }).optional(),
  /** a guest invite: who the link is for, as the inviter typed it (the form's Name starts with it); absent without one */
  guestName: z.string().optional(),
  /** a guest invite: the AI choice the inviter made (none, the team's, or the guest's own sign-in), only while the link works:
   * the page tells a guest who must connect their own account before they open it. Absent from an older server */
  guestAi: z.enum(['none', 'team', 'own']).optional(),
})
export type InviteInfo = z.infer<typeof InviteInfo>
export const AcceptInviteBody = z.object({
  username: Username,
  name: PersonName,
  password: Password,
  /** the language the person picked on the invite page; omitted = follow the team default */
  locale: Locale.optional(),
  client: ClientKind.default('web'),
  tokenMode: z.enum(['cookie', 'bearer']).default('cookie'),
})

export const SetupStatus = z.object({
  needed: z.boolean(),
  /** always null since security review round 4 (it told anonymous visitors the team's name); kept for older clients */
  teamName: z.string().nullable(),
  /** the team's default language: what the sign-in, invite and reset pages show until the visitor picks one */
  defaultLocale: Locale.optional(),
  /** a hosted team only: the hosting console's fixed owner-recovery page (`<console origin>/recover`, the same for every
   * team: never this team's host, slug or id). The sign-in page links the owner there with `?team=<its own host>`.
   * null (or left out by an older server): no such page; the sign-in page keeps the plain "ask an admin" line. */
  ownerRecoveryUrl: z.string().url().refine((u) => u.startsWith('https://'), 'https only').nullable().optional(),
})
export const SetupBody = z.object({
  /** one-time token written by the installer / printed by the dev server; proves local access to the Mac */
  setupToken: z.string().min(16).max(200),
  teamName: z.string().trim().min(1).max(100),
  /** the team's default language (the owner follows it until they pick their own) */
  locale: Locale.default(DEFAULT_LOCALE),
  /** the team's time zone (IANA, e.g. Asia/Seoul): the setup page sends the browser's. Omitted or unknown = the
   * server's default (MYCEL_TEAM_TZ, else its own zone, else UTC) */
  timeZone: z.string().min(1).max(64).optional(),
  owner: z.object({ username: Username, name: PersonName, password: Password, email: z.email().optional() }),
  /** the company website the setup link carried (#site=…): kept with the welcome steps' progress, so the company profile
   * step starts from it on any device, the desktop app too. Not an http(s) address, or too long: dropped, never an
   * error (a setup never fails over it) */
  site: z.string().max(300).optional().catch(undefined),
})

/** One-time reset link (admin-issued, 24 h; or owner recovery from the server Mac). Web page: /reset-password/<token>. */
export const PasswordResetInfo = z.object({
  /** false when expired or used (the page says so instead of the form) */
  valid: z.boolean(),
  username: z.string().nullable(),
  name: z.string().nullable(),
  expiresAt: IsoTime.nullable(),
})
export type PasswordResetInfo = z.infer<typeof PasswordResetInfo>
export const CompletePasswordResetBody = z.object({
  newPassword: Password,
  client: ClientKind.default('web'),
  tokenMode: z.enum(['cookie', 'bearer']).default('cookie'),
})

/** A one-time code that signs the desktop app in as the person who asked for it in their browser ("Continue in the Mac
 * app", web /open-app; server/src/auth/app-signin.ts). The browser opens `<scheme>://open?url=<team>/app-signin#c=<code>`;
 * the app's page redeems it. 32 random bytes (base64url, 43 characters), 3 minutes, one use, one live code per person. */
export const AppSignInCode = z.object({ code: z.string(), expiresAt: IsoTime })
export type AppSignInCode = z.infer<typeof AppSignInCode>
/** The body of the redeem, shaped like the sign-in's. Cookie only: the desktop app keeps its session in a cookie; and
 * always a desktop session (a code lifted off the link makes no session that passes for a browser or a phone). */
export const RedeemAppSignInBody = z.object({
  code: z.string().min(1).max(200),
  client: z.literal('desktop').default('desktop'),
  tokenMode: z.enum(['cookie']).default('cookie'),
})

export const UpdateMeBody = z.object({
  name: PersonName.optional(),
  /** a language, or null = follow the team default */
  locale: Locale.nullable().optional(),
  email: z.email().nullable().optional(),
  /** engine / model null = back to the team default ("내 기본 엔진/모델"); ignored for people who may not pick */
  /** `away` is not set here (PUT /api/me/away tells the team at once); one sent is dropped */
  prefs: UserPrefs.omit({ away: true }).extend({ textSize: TextSize.optional(), engine: EngineId.nullable().optional(), model: z.string().max(100).nullable().optional(), listFolds: ListFolds.nullable().optional(), historyView: HistoryView.nullable().optional(), mentionAllAsk: z.literal('off').nullable().optional(), goalCard: z.literal('hidden').nullable().optional(), preparedCard: z.literal('hidden').nullable().optional(), autoMemory: z.literal('off').nullable().optional() }).optional(),
})

/** PUT /api/me/web-access: my "Allow all websites" for the AI's web reads. Turning it on needs the version of the risk
 * sentence the person was shown (WEB_ALLOW_ALL_WARNING_VERSION) and the team allowing it; off always works. */
export const MyWebAccessBody = z.strictObject({ on: z.boolean(), acceptWarning: z.number().int().optional() })
export const MyWebAccess = z.object({ allowAll: z.boolean() })
export type MyWebAccess = z.infer<typeof MyWebAccess>

/** GET /api/me/usage: the signed-in person's own usage in a period of the team's time zone (today, this week from
 * Monday, this month), never anyone else's, and the usage limits (Admin budgets) that apply to them. A group's or the
 * team's limit shows only how full it is, not who used it. */
const MyUsagePeriod = z.enum(['day', 'week', 'month'])
export const MyUsageQuery = z.object({ period: MyUsagePeriod.default('month') })
const MyUsageAmount = z.object({ turns: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int(), costUsd: z.number(), unpricedTurns: z.number().int().optional(), estimatedTurns: z.number().int().optional() })
/** one engine and model the person's answers used (model null = the engine's default) */
export const MyUsageRow = MyUsageAmount.extend({ key: z.string(), engine: z.string(), model: z.string().nullable() })
export const MyUsageLimit = z.object({
  scope: z.enum(['you', 'group', 'team']),
  /** the group's name (scope 'group') */
  name: z.string().nullable(),
  period: z.enum(['day', 'month']),
  /** how full the limit is in percent (the fuller of money and tokens; over 100 once passed) */
  usedPct: z.number().nonnegative(),
  /** block: answers stop at the limit; warn: they go on and admins are told */
  action: z.enum(['warn', 'block']),
  exceeded: z.boolean(),
  resetsAt: IsoTime,
})
export type MyUsageLimit = z.infer<typeof MyUsageLimit>
export const MyUsage = z.object({
  period: MyUsagePeriod,
  from: IsoTime,
  to: IsoTime,
  totals: MyUsageAmount,
  byModel: z.array(MyUsageRow),
  limits: z.array(MyUsageLimit),
})
export type MyUsage = z.infer<typeof MyUsage>

export const AUTH = {
  setupStatus: endpoint({ method: 'GET', path: '/api/setup', auth: 'public', owner: 'A', response: SetupStatus, summary: 'Is first-run setup still needed (no owner yet)?' }),
  setup: endpoint({ method: 'POST', path: '/api/setup', auth: 'public', owner: 'A', status: 201, body: SetupBody, response: LoginResponse, summary: 'Create the team and its owner (only while no user exists; needs the setup token). Signs the owner in.' }),
  login: endpoint({ method: 'POST', path: '/api/auth/login', auth: 'public', owner: 'A', body: LoginBody, response: LoginResponse, summary: 'Sign in with username + password (argon2id). Rate-limited per IP and per account.' }),
  logout: endpoint({ method: 'POST', path: '/api/auth/logout', auth: 'user', owner: 'A', allowWhilePasswordChange: true, response: empty, status: 204, summary: 'End this session and clear the cookie.' }),
  changePassword: endpoint({ method: 'POST', path: '/api/auth/password', auth: 'user', owner: 'A', allowWhilePasswordChange: true, body: ChangePasswordBody, response: Ok, summary: 'Change own password; ends every other session of this person.' }),
  me: endpoint({ method: 'GET', path: '/api/me', auth: 'user', owner: 'A', allowWhilePasswordChange: true, response: Me, summary: 'The signed-in person, groups, team name.' }),
  updateMe: endpoint({ method: 'PATCH', path: '/api/me', auth: 'user', owner: 'A', body: UpdateMeBody, response: Me, summary: 'Profile, language, theme and composer preferences.' }),
  // not allowWhilePasswordChange: a person who must change the password first cannot widen what the AI opens
  setMyWebAccess: endpoint({ method: 'PUT', path: '/api/me/web-access', auth: 'user', owner: 'A', body: MyWebAccessBody, response: MyWebAccess, summary: 'Turn my "Allow all websites" for the AI\'s web reads on (with the current risk sentence accepted, while the team allows it) or off.' }),
  myUsage: endpoint({ method: 'GET', path: '/api/me/usage', auth: 'user', owner: 'A', query: MyUsageQuery, response: MyUsage, summary: 'My own usage this day / week / month (never anyone else\'s) and the usage limits that apply to me.' }),
  mySessions: endpoint({ method: 'GET', path: '/api/me/sessions', auth: 'user', owner: 'A', response: z.object({ items: z.array(Session) }), summary: 'Own signed-in devices.' }),
  revokeMySession: endpoint({ method: 'DELETE', path: '/api/me/sessions/:id', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Sign out one of own devices.' }),
  inviteInfo: endpoint({ method: 'GET', path: '/api/invites/:token', auth: 'public', owner: 'A', response: InviteInfo, summary: 'What an invite link is for (team name, role, still valid?).' }),
  passwordResetInfo: endpoint({ method: 'GET', path: '/api/password-resets/:token', auth: 'public', owner: 'A', response: PasswordResetInfo, summary: 'What a password reset link is for (whose account, still valid?).' }),
  completePasswordReset: endpoint({ method: 'POST', path: '/api/password-resets/:token', auth: 'public', owner: 'A', body: CompletePasswordResetBody, response: LoginResponse, summary: 'Set a new password with a one-time reset link; ends every other session and signs in.' }),
  // "Continue in the Mac app" after setup (web /open-app): the browser's cookie session makes a one-time code, the
  // desktop app's /app-signin page spends it (server/src/auth/app-signin.ts). Never a GET: the code is a sign-in
  appSignIn: endpoint({ method: 'POST', path: '/api/auth/app-signin', auth: 'user', owner: 'A', response: AppSignInCode, summary: 'Make a one-time code (3 minutes) that signs the desktop app in as me. Cookie sessions only; rate-limited; my earlier codes stop working.' }),
  redeemAppSignIn: endpoint({ method: 'POST', path: '/api/auth/app-signin/redeem', auth: 'public', owner: 'A', body: RedeemAppSignInBody, response: LoginResponse, summary: 'Sign in with a one-time code from appSignIn (once, within 3 minutes). Sets the session cookie.' }),
  acceptInvite: endpoint({ method: 'POST', path: '/api/invites/:token/accept', auth: 'public', owner: 'A', status: 201, body: AcceptInviteBody, response: LoginResponse, summary: 'Create the account from an invite link and sign in.' }),
} as const

