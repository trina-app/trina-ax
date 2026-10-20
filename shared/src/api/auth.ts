// Sign-in, the signed-in person, invites, first-run setup. Owner: A (server/src/routes/auth.ts).
import { z } from 'zod'
import { UserId, Uuid7 } from '../ids'
import { ClientKind, IsoTime, Locale, Ok, Role } from './common'
import { endpoint, empty } from './endpoint'
import { Session, UserPrefs, UserRef } from './entities'

export const Username = z.string().min(2).max(64).regex(/^[A-Za-z0-9._@-]+$/, 'letters, digits, ".", "_", "@", "-"')
/** Password policy: at least 10 characters; the server also rejects very common passwords. */
export const Password = z.string().min(10).max(256)
export const PersonName = z.string().trim().min(1).max(100)

/** GET /api/me */
export const Me = z.object({
  user: z.object({
    id: UserId,
    username: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    role: Role,
    locale: Locale,
    mustChangePassword: z.boolean(),
    prefs: UserPrefs,
  }),
  groups: z.array(z.object({ id: Uuid7, name: z.string() })),
  team: z.object({ name: z.string(), defaultLocale: Locale }),
  session: z.object({ id: Uuid7, client: ClientKind, expiresAt: IsoTime }),
  server: z.object({ version: z.string(), dev: z.boolean() }),
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

export const ChangePasswordBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: Password })

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
  locale: Locale.optional(),
  client: ClientKind.default('web'),
  tokenMode: z.enum(['cookie', 'bearer']).default('cookie'),
})

export const SetupStatus = z.object({ needed: z.boolean(), teamName: z.string().nullable() })
export const SetupBody = z.object({
  /** one-time token written by the installer / printed by the dev server; proves local access to the Mac */
  setupToken: z.string().min(16).max(200),
  teamName: z.string().trim().min(1).max(100),
  locale: Locale.default('ko'),
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
  locale: Locale.optional(),
  email: z.email().nullable().optional(),
  prefs: UserPrefs.optional(),
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

