// Sign-in, the signed-in person, invites, first-run setup. Owner: A (server/src/routes/auth.ts).
import { z } from 'zod'
import { UserId, Uuid7 } from '../ids'
import { ClientKind, DEFAULT_LOCALE, EngineId, IsoTime, Locale, Ok, Role } from './common'
import { endpoint, empty } from './endpoint'
import { TEAM_ICON_VERSION_RE } from '../team-icon'
import { Session, UserPrefs, UserRef } from './entities'

export const Username = z.string().min(2).max(64).regex(/^[A-Za-z0-9._@-]+$/, 'letters, digits, ".", "_", "@", "-"')
/** Password rule: 8-128 characters; the server also refuses the username itself and very common passwords. */
export const Password = z.string().min(8).max(128)
export const PersonName = z.string().trim().min(1).max(100)

/** GET /api/me */
export const Me = z.object({
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
    /** the AI may run code for this person (Admin > Team settings "Code sandbox", and this server can run it): the
     * composer shows a badge. Absent (older server) = off. */
    codeSandbox: z.boolean().optional(),
  }),
  groups: z.array(z.object({ id: Uuid7, name: z.string() })),
  team: z.object({
    name: z.string(), defaultLocale: Locale,
    /** people may turn on "Allow all websites" for the desktop app's in-app browser (Admin > Team settings
     * browserAllowAll). The desktop app enforces it. Absent (older server) = no policy. */
    browserAllowAll: z.boolean().optional(),
    /** the team logo's version (Admin > Team settings): the icon links point at /team-icon?v=<it>; null = the default
     * icon. Absent (older server) = leave the icon links alone. */
    iconVersion: z.string().regex(TEAM_ICON_VERSION_RE).nullable().optional(),
    /** voice input works (Admin > Team settings: OpenRouter with a key, or on this server). false: the composer hides
     * the mic (admins see a hint). Absent (older server) = on. */
    voiceInput: z.boolean().optional(),
    /** days a deleted chat stays in the chat trash, and days a deleted account's chats and memories stay (Admin > Team
     * settings chatTrashRetentionDays; the purge uses the current value). Absent (older server) = the default, 7. */
    chatTrashRetentionDays: z.number().int().min(1).max(365).optional(),
  }),
  session: z.object({
    id: Uuid7, client: ClientKind, expiresAt: IsoTime,
    /** made by signing in with a temporary password: the forced change asks only for the new password (true only
     * while mustChangePassword) */
    tempLogin: z.boolean().optional(),
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

export const UpdateMeBody = z.object({
  name: PersonName.optional(),
  /** a language, or null = follow the team default */
  locale: Locale.nullable().optional(),
  email: z.email().nullable().optional(),
  /** engine / model null = back to the team default ("내 기본 엔진/모델"); ignored for people who may not pick */
  prefs: UserPrefs.extend({ engine: EngineId.nullable().optional(), model: z.string().max(100).nullable().optional() }).optional(),
})

export const AUTH = {
  setupStatus: endpoint({ method: 'GET', path: '/api/setup', auth: 'public', owner: 'A', response: SetupStatus, summary: 'Is first-run setup still needed (no owner yet)?' }),
  setup: endpoint({ method: 'POST', path: '/api/setup', auth: 'public', owner: 'A', status: 201, body: SetupBody, response: LoginResponse, summary: 'Create the team and its owner (only while no user exists; needs the setup token). Signs the owner in.' }),
  login: endpoint({ method: 'POST', path: '/api/auth/login', auth: 'public', owner: 'A', body: LoginBody, response: LoginResponse, summary: 'Sign in with username + password (argon2id). Rate-limited per IP and per account.' }),
  logout: endpoint({ method: 'POST', path: '/api/auth/logout', auth: 'user', owner: 'A', allowWhilePasswordChange: true, response: empty, status: 204, summary: 'End this session and clear the cookie.' }),
  changePassword: endpoint({ method: 'POST', path: '/api/auth/password', auth: 'user', owner: 'A', allowWhilePasswordChange: true, body: ChangePasswordBody, response: Ok, summary: 'Change own password; ends every other session of this person.' }),
  me: endpoint({ method: 'GET', path: '/api/me', auth: 'user', owner: 'A', allowWhilePasswordChange: true, response: Me, summary: 'The signed-in person, groups, team name.' }),
  updateMe: endpoint({ method: 'PATCH', path: '/api/me', auth: 'user', owner: 'A', body: UpdateMeBody, response: Me, summary: 'Profile, language, theme and composer preferences.' }),
  mySessions: endpoint({ method: 'GET', path: '/api/me/sessions', auth: 'user', owner: 'A', response: z.object({ items: z.array(Session) }), summary: 'Own signed-in devices.' }),
  revokeMySession: endpoint({ method: 'DELETE', path: '/api/me/sessions/:id', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Sign out one of own devices.' }),
  inviteInfo: endpoint({ method: 'GET', path: '/api/invites/:token', auth: 'public', owner: 'A', response: InviteInfo, summary: 'What an invite link is for (team name, role, still valid?).' }),
  passwordResetInfo: endpoint({ method: 'GET', path: '/api/password-resets/:token', auth: 'public', owner: 'A', response: PasswordResetInfo, summary: 'What a password reset link is for (whose account, still valid?).' }),
  completePasswordReset: endpoint({ method: 'POST', path: '/api/password-resets/:token', auth: 'public', owner: 'A', body: CompletePasswordResetBody, response: LoginResponse, summary: 'Set a new password with a one-time reset link; ends every other session and signs in.' }),
  acceptInvite: endpoint({ method: 'POST', path: '/api/invites/:token/accept', auth: 'public', owner: 'A', status: 201, body: AcceptInviteBody, response: LoginResponse, summary: 'Create the account from an invite link and sign in.' }),
} as const

