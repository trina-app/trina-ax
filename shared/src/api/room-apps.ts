// Apps posting in rooms (docs/DECISIONS.md "Apps posting in rooms", plan docs/AGENTS/plan/20261114-0900-room-apps.md).
// Owner: B (server/src/rooms/apps/*, server/src/routes/room-apps.ts, migration 299_b_room_apps.sql).
//
// "Add an app" in a room's menu sets up Sentry, GitHub, Google Forms or any other service ("Other") to post into that
// room. Each app has a secret address, POST /in/<token> (outside /api: the token is the auth); the server turns what
// arrives into a card from the app ("Sentry" with an "App" tag), never a person. Repeats of one thing (a Sentry issue,
// a pull request, an edited form response) go into one thread under the first card.
//
// Who manages a room's apps: in a team room and the everyone room its owners and admins who are in it; in a 1:1 or a
// group chat any of its members (there are no admins there). Everyone else in the room sees the app's messages like any
// message (people who join later too, as a team room's history); anyone not in the room gets 404, whatever their role.
//
// Trina's own words never say "webhook": the vendors' screen labels are quoted where a guide needs them (web phase 2).
import { z } from 'zod'
import { IsoTime } from './common'
import { empty, endpoint } from './endpoint'
import { UserRef } from './entities'

export const RoomAppKind = z.enum(['sentry', 'github', 'google_forms', 'other'])
export type RoomAppKind = z.infer<typeof RoomAppKind>

/** The switches of each kind ("Show in this room") and whether each is on when the app is added. A switch that is off
 * makes its events count as skipped (never shown). Google Forms' `email` sends the respondent's email when the form
 * collects it (on by default, owner decision 12: everyone in the room, people who join later included, sees it). */
export const ROOM_APP_SWITCHES = {
  sentry: [
    { key: 'new_issue', on: true }, { key: 'came_back', on: true }, { key: 'resolved', on: true },
    { key: 'alert', on: false }, { key: 'assigned', on: false }, { key: 'metric', on: false },
  ],
  github: [
    { key: 'pull_request', on: true }, { key: 'issue', on: true }, { key: 'checks_failed', on: true },
    { key: 'release', on: true }, { key: 'push', on: false },
  ],
  google_forms: [{ key: 'response', on: true }, { key: 'email', on: true }],
  other: [{ key: 'message', on: true }],
} as const satisfies Record<RoomAppKind, readonly { key: string; on: boolean }[]>
export type RoomAppSwitch<K extends RoomAppKind = RoomAppKind> = (typeof ROOM_APP_SWITCHES)[K][number]['key']
/** The switches of a kind as {key: on}, the defaults. */
export const roomAppDefaults = (kind: RoomAppKind): Record<string, boolean> =>
  Object.fromEntries(ROOM_APP_SWITCHES[kind].map((s) => [s.key, s.on]))

/** The names an app gets when it is added (the vendor's own name; "Other" is renamed by the person). */
export const ROOM_APP_DEFAULT_NAMES: Record<RoomAppKind, string> = { sentry: 'Sentry', github: 'GitHub', google_forms: 'Google Forms', other: 'Other app' }

/** Apps in one room, at most. */
export const ROOM_APPS_MAX = 10
/** Apps one person adds in an hour, at most (like a group chat: GROUPS_PER_HOUR). */
export const ROOM_APPS_PER_HOUR = 10
/** "Show an example" per app and hour (not counted toward the cap). */
export const ROOM_APP_EXAMPLES_PER_HOUR = 5
/** Messages shown per app and team-local day (owner decision 3): past it the app pauses until the team's midnight;
 * "Resume now" allows as many again, once a day. */
export const ROOM_APP_DAILY_CAP = 500
/** Messages shown per team and day by all its apps together: past it every app pauses the same way. */
export const ROOM_APP_TEAM_DAILY_CAP = 5000
/** Requests received per app and day (before the body is read): past it 429 until the team's midnight. */
export const ROOM_APP_DAILY_RECEIVED = 5000
/** Requests per app: a burst of this many, then one a second (429 over). */
export const ROOM_APP_BURST = 30
export const ROOM_APP_PER_SECOND = 1
/** Requests with an unknown or malformed address per client address (and its /24 or IPv6 /48) and minute; on the
 * server's own public address with a country or network list, which /in/ is exempt from, the stricter number. */
export const ROOM_APP_UNKNOWN_PER_MINUTE = 30
export const ROOM_APP_UNKNOWN_PER_MINUTE_EXEMPT = 10
/** Body size: GitHub's events can be large; everything else is small. 10 s to read it. */
export const ROOM_APP_BODY_MAX = 256 * 1024
export const ROOM_APP_GITHUB_BODY_MAX = 1024 * 1024
export const ROOM_APP_BODY_SECONDS = 10
/** An app's name (Other is named by the person), at most. */
export const ROOM_APP_NAME_MAX = 40
/** A card's title and its other lines, at most (characters). */
export const ROOM_APP_TITLE_MAX = 200
export const ROOM_APP_LINE_MAX = 300
/** An "Other" app's text and a form's answers in the message's plain text, at most. */
export const ROOM_APP_TEXT_MAX = 4000

/** The address token: "tax_in_" + 43 base64url characters (256 random bits). A secret Trina makes (GitHub):
 * "tax_whs_" + 43. Both shapes are fixed so a leak check can find them. */
export const ROOM_APP_TOKEN_RE = /^tax_in_[A-Za-z0-9_-]{43}$/
export const ROOM_APP_SECRET_RE = /^tax_whs_[A-Za-z0-9_-]{43}$/

/** A card as the room shows it: plain text only (no Markdown, no HTML, no links but `link`). `kind`: the kind line
 * ("New issue · checkout-web · error"); `status`: the root card's status line, changed in place as its thread goes on;
 * `link`: the one https link (no user name or password), with its host shown; `unverified`: an actor name in it came
 * from a request without a signature ("Resolved by Jun (unverified)" is already in the text). */
export const RoomAppCard = z.object({
  kind: z.string().max(ROOM_APP_LINE_MAX).optional(),
  title: z.string().max(ROOM_APP_TITLE_MAX),
  details: z.array(z.string().max(ROOM_APP_LINE_MAX)).max(3),
  status: z.string().max(ROOM_APP_LINE_MAX).optional(),
  link: z.object({ url: z.string().max(2048), host: z.string().max(253) }).optional(),
  unverified: z.literal(true).optional(),
})
export type RoomAppCard = z.infer<typeof RoomAppCard>

/** On a room message an app posted (author null): which app (id null: removed since; the name and kind as they were),
 * `quiet`: a short line (no unread, no alert), `example`: "Show an example". */
export const RoomAppRef = z.object({
  id: z.string().nullable(),
  name: z.string().max(ROOM_APP_NAME_MAX),
  kind: RoomAppKind,
  quiet: z.literal(true).optional(),
  example: z.literal(true).optional(),
  /** who added it, for the sender's popover ("Set up by Mina"; members: "Ask Mina to change what shows here"): null
   * once they left the team or the app was removed. Older servers omit it */
  by: UserRef.nullable().optional(),
})
export type RoomAppRef = z.infer<typeof RoomAppRef>

/** Why the last request was not shown: the signature did not match, the body was not one Trina can read, too big. */
export const RoomAppRefusal = z.enum(['signature', 'format', 'too_big'])
export type RoomAppRefusal = z.infer<typeof RoomAppRefusal>

/** One app as the people who manage it see it: never its address or secret (getRoomAppAddress). */
export const RoomApp = z.object({
  id: z.string(),
  roomId: z.string(),
  kind: RoomAppKind,
  name: z.string(),
  /** the switches, every key of the kind's (ROOM_APP_SWITCHES) */
  events: z.record(z.string(), z.boolean()),
  quiet: z.boolean(),
  /** a secret is set: requests must carry its signature (GitHub's X-Hub-Signature-256, Sentry's Sentry-Hook-Signature) */
  signed: z.boolean(),
  /** who added it (null: someone who left) */
  createdBy: UserRef.nullable(),
  createdAt: IsoTime,
  /** the first and the last message shown */
  firstOkAt: IsoTime.nullable(),
  lastOkAt: IsoTime.nullable(),
  /** the last request that was not shown (newer than lastOkAt only matters to the status line) */
  lastRefusal: z.object({ at: IsoTime, reason: RoomAppRefusal }).nullable(),
  /** paused until this time (the team's midnight) after the day's cap; null: running */
  pausedUntil: IsoTime.nullable(),
  /** "Resume now" is offered: paused for its own cap, and not resumed today yet */
  canResume: z.boolean(),
  /** messages shown today (the team's day) */
  today: z.number().int().nonnegative(),
})
export type RoomApp = z.infer<typeof RoomApp>

/** A room's apps. `available`: this server has an internet address the services can reach (the relay or its own public
 * host); without one nothing can be added and the apps there cannot be reached. */
export const RoomAppList = z.object({
  items: z.array(RoomApp),
  available: z.boolean(),
  max: z.number().int().positive(),
})
export type RoomAppList = z.infer<typeof RoomAppList>

/** The address to paste into the service (https://<team address>/in/<token>). */
export const RoomAppAddress = z.object({
  address: z.string(),
  /** a secret Trina made for this app ("Make it safer", GitHub's Secret field), when one is set */
  secret: z.string().optional(),
})
export type RoomAppAddress = z.infer<typeof RoomAppAddress>

/** Added on the first "Copy address" (nothing exists before): the app and its address. */
export const RoomAppCreated = z.object({ app: RoomApp, address: z.string() })
export type RoomAppCreated = z.infer<typeof RoomAppCreated>

const AppName = z.string().trim().min(1).max(ROOM_APP_NAME_MAX).refine((s) => !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(s), 'no control or format characters')
export const CreateRoomAppBody = z.object({ kind: RoomAppKind, name: AppName.optional() }).strict()
export type CreateRoomAppBody = z.infer<typeof CreateRoomAppBody>
/** Any of: switches (only keys of the kind; the others stay), Quiet, the name. */
export const UpdateRoomAppBody = z.object({
  events: z.record(z.string().max(32), z.boolean()).optional(),
  quiet: z.boolean().optional(),
  name: AppName.optional(),
}).strict()
export type UpdateRoomAppBody = z.infer<typeof UpdateRoomAppBody>
/** "Make it safer" (optional for GitHub and Sentry, owner decision 9): `generate` makes a secret Trina shows once here
 * (and on getRoomAppAddress), for GitHub's Secret field; `secret` saves Sentry's Client Secret (64 hex characters);
 * `secret: null` takes the secret away (requests are then taken unsigned and their names marked "(unverified)"). */
export const SetRoomAppSecretBody = z.union([
  z.object({ generate: z.literal(true) }).strict(),
  z.object({ secret: z.string().trim().max(200).nullable() }).strict(),
])
export type SetRoomAppSecretBody = z.infer<typeof SetRoomAppSecretBody>
export const RoomAppSecretResult = z.object({ app: RoomApp, secret: z.string().optional() })
export type RoomAppSecretResult = z.infer<typeof RoomAppSecretResult>

/** Sentry's Client Secret as Sentry shows it (checked in TC-1546): 64 hex characters. */
export const SENTRY_SECRET_RE = /^[0-9a-f]{64}$/i

/** The Google Forms Apps Script (Copy code), with the address filled in. `sendEmail`: the form's respondent email is
 * sent when the form collects it (the app's `email` switch; the server drops it while the switch is off either way). */
export function roomAppFormsScript(address: string, sendEmail: boolean): string {
  const q = JSON.stringify(address)
  return `const TRINA_ADDRESS = ${q}
// Sends the respondent's email only when the form collects it and "Respondent's email" is on in Trina.
const SEND_EMAIL = ${sendEmail ? 'true' : 'false'}

function sendToTrina(e) {
  const r = e.response
  const answers = r.getItemResponses().map((i) => {
    const a = i.getResponse()
    return { q: i.getItem().getTitle(), a: Array.isArray(a) ? a.join(', ') : String(a) }
  })
  UrlFetchApp.fetch(TRINA_ADDRESS, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      form: FormApp.getActiveForm().getTitle(),
      id: r.getId(),
      at: r.getTimestamp().toISOString(),
      email: SEND_EMAIL ? r.getRespondentEmail() || undefined : undefined,
      answers,
    }),
    muteHttpExceptions: true,
  })
}

function setUp() {
  // running setUp again replaces the trigger instead of adding a second one
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'sendToTrina').forEach((t) => ScriptApp.deleteTrigger(t))
  ScriptApp.newTrigger('sendToTrina').forForm(FormApp.getActiveForm()).onFormSubmit().create()
}
`
}

const WHO = 'In a team room or the everyone room: its owners and admins who are in it; in a 1:1 or a group chat: any of its members. A member without the right gets 403, anyone not in the room 404.'
export const ROOM_APPS = {
  listRoomApps: endpoint({ method: 'GET', path: '/api/rooms/:id/apps', auth: 'user', owner: 'B', response: RoomAppList,
    summary: `The apps posting in a room ("Apps posting here") and whether this server can be reached by them at all. ${WHO}` }),
  createRoomApp: endpoint({ method: 'POST', path: '/api/rooms/:id/apps', auth: 'user', owner: 'B', status: 201, body: CreateRoomAppBody, response: RoomAppCreated,
    summary: `Add an app (on the first "Copy address"): its secret address comes back. ${WHO} At most ${ROOM_APPS_MAX} per room (409 room_apps_full), ${ROOM_APPS_PER_HOUR} added per person and hour (429); 409 no_public_address without an internet address; 400 when the name is a person's in this team. Audited.` }),
  getRoomAppAddress: endpoint({ method: 'GET', path: '/api/rooms/:id/apps/:appId/address', auth: 'user', owner: 'B', response: RoomAppAddress,
    summary: `Copy an app's address again (and a secret Trina made for it). ${WHO}` }),
  updateRoomApp: endpoint({ method: 'PATCH', path: '/api/rooms/:id/apps/:appId', auth: 'user', owner: 'B', body: UpdateRoomAppBody, response: RoomApp,
    summary: `Change an app's switches, Quiet or name. ${WHO} Audited.` }),
  setRoomAppSecret: endpoint({ method: 'PUT', path: '/api/rooms/:id/apps/:appId/secret', auth: 'user', owner: 'B', body: SetRoomAppSecretBody, response: RoomAppSecretResult,
    summary: `"Make it safer": make a secret for GitHub, save Sentry's Client Secret, or take the secret away (optional for both). ${WHO} Audited (never the secret).` }),
  rotateRoomApp: endpoint({ method: 'POST', path: '/api/rooms/:id/apps/:appId/rotate', auth: 'user', owner: 'B', response: RoomAppCreated,
    summary: `"Get a new address": the old one stops working at once. ${WHO} Audited.` }),
  resumeRoomApp: endpoint({ method: 'POST', path: '/api/rooms/:id/apps/:appId/resume', auth: 'user', owner: 'B', response: RoomApp,
    summary: `"Resume now" after the day's cap paused an app: as many messages again today, once a day (409 not_paused / already_resumed; the team's cap still applies). ${WHO} Audited.` }),
  exampleRoomApp: endpoint({ method: 'POST', path: '/api/rooms/:id/apps/:appId/example', auth: 'user', owner: 'B', status: 204, response: empty,
    summary: `"Show an example": a sample card from the app in the room, marked as an example (${ROOM_APP_EXAMPLES_PER_HOUR} an hour, not counted toward the cap). ${WHO}` }),
  deleteRoomApp: endpoint({ method: 'DELETE', path: '/api/rooms/:id/apps/:appId', auth: 'user', owner: 'B', status: 204, response: empty,
    summary: `Remove an app from the room: its address stops working at once, its messages stay. ${WHO} Audited.` }),
} as const
