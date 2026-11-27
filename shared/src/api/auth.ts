// Sign-in, the signed-in person, invites, first-run setup. Owner: A (server/src/routes/auth.ts).
import { z } from 'zod'
import { UserId, Uuid7 } from '../ids'
import { ClientKind, DEFAULT_LOCALE, Effort, GuestDetail, EngineId, IsoTime, Locale, Ok, ReauthFields, Role, TextSize } from './common'
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
    /** the account has a password. false: it was made with Google (docs/decisions/20261122-google-reauth.md): every
     * re-check confirms with Google instead (`reauthToken`), and Settings › Security & devices offers "Set a password".
     * Absent (older server) = true */
    hasPassword: z.boolean().optional(),
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
    /** my auto mode is on now (docs/decisions/20261125-auto-mode.md; PUT /api/ai-allowances/auto-mode). Absent: off, not
     * available to me, or an older server. */
    autoMode: z.literal(true).optional(),
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
    /** I may use auto mode (Admin › Team AI settings autoMode, with "Always allow" on; never a guest): the composer shows
     * its pill. 'default': it starts on for people who did not choose. Absent: off, or an older server. */
    autoMode: z.enum(['allowed', 'default']).optional(),
    /** the team's address for its members, an origin (https://acme.trina.app): what a new device puts in the app
     * (Settings › 앱 "팀 주소"). The relay address when the server is on a relay, else the public address it knows,
     * else for a server not on a relay the address it is reached at, with its port, http included
     * (server/src/system/connection.ts teamAddressOf). A server on a relay never gives the address the page was opened
     * at (over the office network that is the office's own address). Signed-in people only (this answer); absent =
     * none known or an older server. */
    address: z.string().max(300).optional(),
    /** I may send a problem report (Settings › About "문제 신고", 👎 under an answer): this server can send them and the
     * team switch is on (Admin › Team settings problemReports); never for a guest. Absent: no entry points. */
    problemReports: z.literal(true).optional(),
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
    /** this server can send problem reports to the <app> team (server/src/system/problem-reports.ts): 'hosted' (a team
     * the hosting service runs) or 'self' (a self-installed server: the sheet says the report leaves it). Admin › Team
     * settings shows the switch only then. Absent: none (an edition without a hosted service, MYCEL_PROBLEM_REPORTS=off). */
    problemReports: z.enum(['hosted', 'self']).optional(),
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
  /** the page may offer "Join with Google" (startGoogleInvite; server/src/auth/google-signup.ts): the invite works, it
   * is not a guest invite (guests join with a password), and Google can sign in at this address (the rule of
   * SetupStatus.googleSignIn). Absent: no button */
  googleSignUp: z.literal(true).optional(),
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
  /** the sign-in page may offer "Sign in with Google" (server/src/auth/google-login.ts): this server has a Google client
   * and Google returns to the address this page was opened at. Absent: no button (none, another address, a demo, or an
   * older server). The apps use googleAppSignIn instead. */
  googleSignIn: z.literal(true).optional(),
  /** the desktop and phone apps may offer "Sign in with Google" (docs/decisions/20261122-google-login-apps.md): this
   * server has a Google client and it is no demo. Any address: an app's flow is bound to a secret the app keeps, not
   * to a cookie of this address. Each app shows it only when it can open Google outside its window (its bridge flag). */
  googleAppSignIn: z.literal(true).optional(),
  /** the setup page may offer "Start with Google" (startGoogleSetup; server/src/auth/google-signup.ts): only while
   * `needed` is true for this visitor, and Google can sign in at this address (the rule of googleSignIn). Absent: the
   * password form only */
  googleSignUp: z.literal(true).optional(),
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

/** A team made from the desktop app (server/src/auth/setup-console.ts, docs/decisions/20261126-desktop-create-team.md):
 * the app opens `/app-setup#c=<claim>` from the hosting console; the page asks who the owner is (preview), then makes
 * the owner and signs the app in (a desktop session, cookie). The claim's shape is checked by the server, which counts a
 * bad one against the caller's address, so the schema only bounds its length. */
export const ConsoleSetupPreviewBody = z.object({ claim: z.string().min(1).max(200) })
export const ConsoleSetupPreview = z.object({
  teamName: z.string(),
  name: z.string(),
  email: z.string(),
  /** the owner signed in to the console with Google: the account is made with that Google account and no password;
   * false: the page asks for a password (for the phone and other computers) */
  google: z.boolean(),
})
export type ConsoleSetupPreview = z.infer<typeof ConsoleSetupPreview>
export const ConsoleSetupBody = z.object({
  claim: z.string().min(1).max(200),
  /** required unless the owner signed in with Google (then refused); its strength is checked like every new password */
  password: z.string().max(200).optional(),
  client: z.literal('desktop').default('desktop'),
  tokenMode: z.enum(['cookie']).default('cookie'),
})

/** Sign in with Google (server/src/auth/google-login.ts; docs/AGENTS/plan/20261122-0454-google-login.md). A person
 * connects their Google account in Settings › Security with their current password, then signs in with it. The answer
 * is Google's address to open in this window; Google comes back to this server, which signs in and opens `next`. */
export const GoogleSignInBody = z.object({
  /** a path of this site to open after signing in (the sign-in page's ?next=); anything else is dropped */
  next: z.string().max(500).optional(),
  /** Who starts it (docs/decisions/20261122-google-login-apps.md). Left out or 'web': the browser goes to Google in
   * this window and comes back signed in (a binding cookie). 'desktop' or 'mobile': the app opens Google in the system
   * browser, which comes back with a one-time code for the app only (GOOGLE_APP_RETURN_PATH, GOOGLE_PHONE_RETURN); the
   * app's page redeems it (redeemGoogleSignIn) with the secret whose hash it sends here. */
  client: ClientKind.optional(),
  /** the SHA-256 (hex) of a random secret the app's sign-in page keeps; required for 'desktop' and 'mobile', refused
   * for the web */
  appSecretHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
})
export const GoogleStart = z.object({ url: z.string().url() })
export type GoogleStart = z.infer<typeof GoogleStart>
/** The page of the team that the desktop app opens with the code from Google's return:
 * `<linkScheme>://open?url=<team>/login/google#code=<code>`, taken only for the team on screen (desktop/src/common/
 * address.ts googleSignInCode). */
export const GOOGLE_APP_RETURN_PATH = '/login/google'
/** Where the desktop app posts that code (API.claimDriveFlow, api/drive.ts): here so the desktop app can name the address
 * without bundling the Drive schemas (tests/unit/desktop-shared-imports.test.ts). */
export const CLAIM_DRIVE_FLOW_PATH = '/api/integrations/google-drive/claim'
/** Where Google's return sends a phone app's flow: the address its auth session waits for (expo-web-browser
 * openAuthSessionAsync), with `#code=<code>` or `#error=<reason>`. The phone app keeps the same in
 * mobile/src/protocol.ts (GOOGLE_SIGNIN_RETURN_HOST; a test keeps them equal). */
export const googlePhoneReturn = (scheme: string): string => `${scheme}://google-signin`
/** The redeem of an app's one-time code (server/src/auth/google-login.ts redeemGoogleApp): the code from the address
 * and the secret the page kept. Cookie only, like the app sign-in code's: the session lands in the app's own window. */
export const RedeemGoogleSignInBody = z.object({
  code: z.string().min(1).max(200),
  appSecret: z.string().min(1).max(200),
  client: z.enum(['desktop', 'mobile']),
  tokenMode: z.enum(['cookie']).default('cookie'),
})
/** Sign up with Google (server/src/auth/google-signup.ts; docs/decisions/20261122-google-signup.md): the first owner
 * with the setup token, and the team name, language and time zone typed on the setup page. They travel sealed in the
 * flow; Google's return makes the team and the owner (no password; the username comes from the Google address, the
 * name from Google) and signs in, then opens `next`. The answer is Google's address to open in this window. */
export const GoogleSetupBody = SetupBody.pick({ setupToken: true, teamName: true, locale: true, timeZone: true, site: true }).extend({
  /** the page to open after the team is made (the setup page's welcome steps or "continue in the app"); a path of this
   * site, anything else is dropped */
  next: z.string().max(500).optional(),
})
/** Join with Google from an invite or the team link (server/src/auth/google-signup.ts): the token in the body (never in
 * an address), and the username, name and language the person picked. The flow keeps the invite's or link's id, not the
 * token. Google's return makes the account (no password) or, when this Google account is already someone's here, signs
 * that person in and leaves the invite unused. Guest invites join with a password only. */
export const GoogleJoinBody = z.object({
  token: z.string().min(16).max(200),
  username: Username,
  name: PersonName,
  /** the language the person picked on the page; omitted = follow the team default */
  locale: Locale.optional(),
})
export const ConnectGoogleBody = z.object({ ...ReauthFields })
/** A Google check instead of the password, for an account without one (docs/decisions/20261122-google-reauth.md):
 * Google's address to open in a new window, and the check's id. The tab asks GET /api/me/google/reauth/:id until it is
 * `confirmed`, then sends the request that needed the check with `reauthFlow: <id>` (once, within 5 minutes). */
export const GoogleReauthStart = z.object({ url: z.string().url(), flow: Uuid7 })
export type GoogleReauthStart = z.infer<typeof GoogleReauthStart>
/** waiting: still at Google; confirmed: send the id now; failed: over without a confirmation (expired, cancelled,
 * another Google account, already used): the Google window said why */
export const GoogleReauthState = z.object({ state: z.enum(['waiting', 'confirmed', 'failed']) })
export type GoogleReauthState = z.infer<typeof GoogleReauthState>
/** "Set a password" for an account without one (made with Google): after a Google check. Refused (409) once the
 * account has a password: that one is changed with POST /api/auth/password. */
export const SetPasswordBody = z.object({ newPassword: Password, reauthFlow: Uuid7 })
export const MyGoogle = z.object({
  /** this page can connect one now (the same rule as SetupStatus.googleSignIn) */
  available: z.boolean(),
  /** the connected Google account; null: none */
  account: z.object({ email: z.string().nullable(), connectedAt: IsoTime, lastUsedAt: IsoTime.nullable() }).nullable(),
})
export type MyGoogle = z.infer<typeof MyGoogle>

export const UpdateMeBody = z.object({
  name: PersonName.optional(),
  /** a language, or null = follow the team default */
  locale: Locale.nullable().optional(),
  email: z.email().nullable().optional(),
  /** engine / model null = back to the team default ("내 기본 엔진/모델"); ignored for people who may not pick */
  /** `away` is not set here (PUT /api/me/away tells the team at once); one sent is dropped */
  prefs: UserPrefs.omit({ away: true }).extend({ textSize: TextSize.optional(), engine: EngineId.nullable().optional(), model: z.string().max(100).nullable().optional(), effort: Effort.nullable().optional(), listFolds: ListFolds.nullable().optional(), historyView: HistoryView.nullable().optional(), mentionAllAsk: z.literal('off').nullable().optional(), goalCard: z.literal('hidden').nullable().optional(), preparedCard: z.literal('hidden').nullable().optional(), autoMemory: z.literal('off').nullable().optional() }).optional(),
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
  setupConsolePreview: endpoint({ method: 'POST', path: '/api/setup/console/preview', auth: 'public', owner: 'A', body: ConsoleSetupPreviewBody, response: ConsoleSetupPreview, summary: 'A hosted team made from the desktop app, before its owner exists: the team name and who the owner is, from the hosting console\'s one-time claim (not spent).' }),
  setupConsole: endpoint({ method: 'POST', path: '/api/setup/console', auth: 'public', owner: 'A', status: 201, body: ConsoleSetupBody, response: LoginResponse, summary: 'A hosted team made from the desktop app: make the owner from the hosting console\'s one-time claim (spent only after the account is made) and sign the app in.' }),
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
  // Sign in with Google (server/src/auth/google-login.ts): the start sets a short binding cookie; Google returns to the
  // server's registered address (routes/drive.ts looks the state up here first). Never a GET: each start is a row
  startGoogleSignIn: endpoint({ method: 'POST', path: '/api/auth/google/start', auth: 'public', owner: 'A', body: GoogleSignInBody, response: GoogleStart, summary: 'Start signing in with a connected Google account: Google\'s address to open. Rate-limited per IP.' }),
  // the desktop and phone apps (docs/decisions/20261122-google-login-apps.md): the code Google's return gave the app,
  // with the secret whose hash the start got. Never signs in the system browser that did the Google step
  redeemGoogleSignIn: endpoint({ method: 'POST', path: '/api/auth/google/redeem', auth: 'public', owner: 'A', body: RedeemGoogleSignInBody, response: LoginResponse, summary: 'Sign the desktop or phone app in with the one-time code from a Google sign-in (once, within 5 minutes, only with the app\'s secret). Sets the session cookie.' }),
  // Sign up with Google (server/src/auth/google-signup.ts): the setup token and the invite token only in the body; the
  // start checks them as the password forms do, Google's return makes the account (team links: TEAM_LINKS.startGoogleJoin)
  startGoogleSetup: endpoint({ method: 'POST', path: '/api/setup/google', auth: 'public', owner: 'A', body: GoogleSetupBody, response: GoogleStart, summary: 'Start making the team and its owner with Google (only while no user exists; needs the setup token): Google\'s address to open.' }),
  startGoogleInvite: endpoint({ method: 'POST', path: '/api/invites/google', auth: 'public', owner: 'A', body: GoogleJoinBody, response: GoogleStart, summary: 'Start joining with an invite and a Google account instead of a password (not for guest invites): Google\'s address to open.' }),
  myGoogle: endpoint({ method: 'GET', path: '/api/me/google', auth: 'user', owner: 'A', response: MyGoogle, summary: 'My connected Google account, and whether one can be connected here.' }),
  // not allowWhilePasswordChange (a temporary-password session cannot connect one), not for guests (GUEST_ENDPOINTS)
  connectGoogle: endpoint({ method: 'POST', path: '/api/me/google/connect', auth: 'user', owner: 'A', body: ConnectGoogleBody, response: GoogleStart, summary: 'Start connecting my Google account (needs my current password, or a Google check without one): Google\'s address to open.' }),
  disconnectGoogle: endpoint({ method: 'DELETE', path: '/api/me/google', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Disconnect my Google account: it no longer signs me in. Refused (409) while I have no password.' }),
  // a re-check without a password (server/src/auth/reauth.ts): not allowWhilePasswordChange, not for guests; only an
  // account without a password, with a Google account connected, from a browser's cookie session
  startGoogleReauth: endpoint({ method: 'POST', path: '/api/me/google/reauth', auth: 'user', owner: 'A', response: GoogleReauthStart, summary: 'Start a Google check instead of the password (an account without one): Google\'s address to open in a new window, and the check\'s id. Refused while my re-check limit is locked.' }),
  googleReauthState: endpoint({ method: 'GET', path: '/api/me/google/reauth/:id', auth: 'user', owner: 'A', response: GoogleReauthState, summary: 'Whether my Google check came back confirmed (only the session that started it; no-store).' }),
  setPassword: endpoint({ method: 'POST', path: '/api/me/password', auth: 'user', owner: 'A', body: SetPasswordBody, response: Ok, summary: 'Set a first password for an account made with Google, after a Google check. Refused (409) when the account has a password. Other sessions stay; open reset links stop.' }),
} as const

