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
// Words: part 1 never said "webhook"; part 2 (plan 20261114-1522, owner decision 3) uses Slack's own terms ("Webhook
// URL", Copy, Regenerate). An Other app can be set up as a named service (RoomAppPreset: Notion, Typeform, Tally,
// Jotform, Stripe, Shopify, Zendesk; phase 4 Jira, HubSpot and, under "Show more services", Toss Payments, Channel Talk,
// PortOne) and reads Slack-, Discord- and JANDI-shaped messages.
import { z } from 'zod'
import { AVATAR_MAX_BYTES } from '../avatar'
import { emojiForm } from '../emoji-form'
import type { CatalogServiceId } from '../service-catalog'
import { isStatusEmoji } from '../status-message'
import { IsoTime } from './common'
import { binary, empty, endpoint, stream } from './endpoint'
import { UserRef } from './entities'

export const RoomAppKind = z.enum(['sentry', 'github', 'google_forms', 'other'])
export type RoomAppKind = z.infer<typeof RoomAppKind>

/** A named service set up through "Other" (plan docs/AGENTS/plan/20261114-1522-room-apps-presets-email.md, migration
 * 401): the row's kind stays 'other' (an older build and an older phone app still read it as an Other app); the preset
 * names the reader, the switches, the signature scheme and the logo. Fixed when the app is added (a different service
 * is a new app), so a secret is never checked under another preset's scheme. The list grows in code. */
export const RoomAppPreset = z.enum(['notion', 'typeform', 'tally', 'jotform', 'stripe', 'shopify', 'zendesk', 'jira', 'hubspot', 'toss_payments', 'channel_talk', 'portone', 'email'])
export type RoomAppPreset = z.infer<typeof RoomAppPreset>
/** A preset as a client reads it: one this build does not know (a newer server's) is dropped, so the app shows as a
 * plain Other app instead of the whole list or message failing to parse (the list grows: phase 4, then email). */
export const RoomAppPresetSeen = RoomAppPreset.optional().catch(undefined)

/** Each preset's switches and whether each is on when the app is added (as ROOM_APP_SWITCHES). Notion's body cannot
 * say whether a page was added or changed: one switch. Zendesk: the Copy body names the trigger (roomAppZendeskBody). */
export const ROOM_APP_PRESET_SWITCHES = {
  notion: [{ key: 'entry', on: true }],
  typeform: [{ key: 'response', on: true }],
  tally: [{ key: 'response', on: true }],
  jotform: [{ key: 'response', on: true }],
  stripe: [
    { key: 'payment', on: true }, { key: 'refund', on: true }, { key: 'failed', on: true }, { key: 'dispute', on: true },
    { key: 'subscription_ended', on: true }, { key: 'subscription_new', on: false },
  ],
  shopify: [
    { key: 'order', on: true }, { key: 'paid', on: true }, { key: 'cancelled', on: true }, { key: 'refund', on: true },
    { key: 'fulfilled', on: false },
  ],
  zendesk: [{ key: 'new_ticket', on: true }, { key: 'updated', on: true }],
  // phase 4. Jira: one rule per trigger, each with its own Copy body naming it (roomAppJiraBody)
  jira: [{ key: 'created', on: true }, { key: 'transitioned', on: true }, { key: 'commented', on: false }],
  // HubSpot: one workflow per object; the body names the object (the guide's "object" key)
  hubspot: [{ key: 'deal', on: true }, { key: 'contact', on: true }, { key: 'ticket', on: true }],
  toss_payments: [{ key: 'payment', on: true }, { key: 'cancelled', on: true }, { key: 'waiting', on: false }, { key: 'failed', on: false }],
  channel_talk: [{ key: 'new_chat', on: true }, { key: 'customer_message', on: true }, { key: 'manager_message', on: false }],
  portone: [{ key: 'payment', on: true }, { key: 'cancelled', on: true }, { key: 'failed', on: true }, { key: 'virtual_account', on: false }],
  // Email (plan 20261123-0421-room-email): every mail, and out-of-office answers (off: they loop with forwarding rules)
  email: [{ key: 'mail', on: true }, { key: 'auto_replies', on: false }],
} as const satisfies Record<RoomAppPreset, readonly { key: string; on: boolean }[]>

/** The vendors' own names, the name an app of the preset gets when it is added (a brand: not translated). */
export const ROOM_APP_PRESET_NAMES: Record<RoomAppPreset, string> = {
  notion: 'Notion', typeform: 'Typeform', tally: 'Tally', jotform: 'Jotform', stripe: 'Stripe', shopify: 'Shopify', zendesk: 'Zendesk',
  jira: 'Jira', hubspot: 'HubSpot', toss_payments: 'Toss Payments', channel_talk: 'Channel Talk', portone: 'PortOne',
  // not a brand: the server names a new Email app in the team's language (rooms/apps/text.ts nameEmail)
  email: 'Email',
}

/** Whether the preset's service can sign what it sends, and who makes the secret: `none` (the Webhook URL's token
 * only; setRoomAppSecret answers 400 no_signing), `trina_makes` (the service has a field to paste one in: Trina makes it
 * with `generate`, a pasted one is taken too), `paste` (the service makes it: the person pastes it; `shape` is the check
 * with a plain error). Signatures are optional (owner decision 4); once a secret is saved, unsigned or wrong requests
 * are refused. */
export const ROOM_APP_PRESET_SIGNING: Record<RoomAppPreset, { signing: 'none' } | { signing: 'trina_makes' } | { signing: 'paste'; shape?: RegExp }> = {
  notion: { signing: 'none' },
  typeform: { signing: 'trina_makes' },
  tally: { signing: 'trina_makes' },
  jotform: { signing: 'none' },
  // Stripe's "Reveal secret": whsec_ and base64-ish characters, used as the literal string
  stripe: { signing: 'paste', shape: /^whsec_[A-Za-z0-9+/=_-]{16,200}$/ },
  shopify: { signing: 'paste' },
  zendesk: { signing: 'paste' },
  jira: { signing: 'none' },
  hubspot: { signing: 'none' },
  // the "보안 키" (security key) of the Toss developer center (API 키 › 보안 키, 64 hex characters). Which events Toss
  // signs is not documented (live check, TC-1634): the guide says to take it away if payments stop showing
  toss_payments: { signing: 'paste', shape: /^[0-9a-fA-F]{64}$/ },
  // Channel Talk adds ?token=<its token> to the Webhook URL (no HMAC): the token shown on its webhook's page
  channel_talk: { signing: 'paste' },
  // PortOne V2 signs by Standard Webhooks: the key in base64, "whsec_" before it or not ("웹훅 시크릿 발급")
  portone: { signing: 'paste', shape: /^(whsec_)?[A-Za-z0-9+/]{22,200}={0,2}$/ },
  // mail has no signature Trina can check (forwarding breaks SPF; the sender is always unverified)
  email: { signing: 'none' },
}

/** A named service an app can be set up as: a kind but Other, or a preset (the web's screens call it a "service"). */
export type RoomAppService = Exclude<RoomAppKind, 'other'> | RoomAppPreset

/** The AI connectors (shared/src/service-catalog.ts, Settings › Connectors) whose service also has a conversation app:
 * their row offers "Add to a conversation", which opens that app's guide in a conversation the person picks
 * (docs/decisions/20261116-connector-card-room-apps.md). Atlassian's connector is Jira's and Confluence's; only Jira
 * posts. The one place both lists meet: a new preset with a listed connector is added here. */
export const ROOM_APP_FOR_CATALOG: Partial<Record<CatalogServiceId, RoomAppService>> = {
  sentry: 'sentry', notion: 'notion', stripe: 'stripe', atlassian: 'jira',
}
/** The conversation app of a listed connector, or null (most have none). */
export const roomAppForCatalog = (id: string): RoomAppService | null => ROOM_APP_FOR_CATALOG[id as CatalogServiceId] ?? null

/** What a preset needs on the service's side ("Needs: …" on the picker row and the guide's header): the key of the
 * web app's words (roomApps.needs.*), absent when anyone can set it up. */
export const ROOM_APP_PRESET_NEEDS: Partial<Record<RoomAppPreset, 'paid_plan' | 'stripe_role' | 'shopify_settings' | 'zendesk_team_admin' | 'jira_space_admin' | 'hubspot_data_hub'>> = {
  notion: 'paid_plan', stripe: 'stripe_role', shopify: 'shopify_settings', zendesk: 'zendesk_team_admin',
  jira: 'jira_space_admin', hubspot: 'hubspot_data_hub',
}

/** Zendesk's documented public test secret (used for "Test webhook" before a webhook exists): never a real one,
 * refused by setRoomAppSecret. */
export const ZENDESK_TEST_SECRET = 'dGhpc19zZWNyZXRfaXNfZm9yX3Rlc3Rpbmdfb25seQ=='

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
export const roomAppDefaults = (kind: RoomAppKind, preset?: RoomAppPreset | null): Record<string, boolean> =>
  Object.fromEntries((preset ? ROOM_APP_PRESET_SWITCHES[preset] : ROOM_APP_SWITCHES[kind]).map((s) => [s.key, s.on]))

/** The names an app gets when it is added, in English (the vendor's own name; "Other" is named by the person). The
 * server gives Google Forms and Other their names in the team's language (rooms/apps/text.ts nameForms, nameOther). */
export const ROOM_APP_DEFAULT_NAMES: Record<RoomAppKind, string> = { sentry: 'Sentry', github: 'GitHub', google_forms: 'Google Forms', other: 'Other app' }

/** Apps in one room, at most. */
export const ROOM_APPS_MAX = 10
/** Apps one person adds in an hour, at most (like a group chat: GROUPS_PER_HOUR). */
export const ROOM_APPS_PER_HOUR = 10
/** "Show an example" per app and hour (not counted toward the cap). */
export const ROOM_APP_EXAMPLES_PER_HOUR = 5
/** "Change icon" (an image, an emoji or Remove icon) per app and hour, refused tries included (the audit log is not
 * a place to flood). */
export const ROOM_APP_ICON_CHANGES_PER_HOUR = 20
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

/** A plain Other app's own icon ("Change icon", docs/decisions/20261116-other-app-icon.md): an image, by its address with
 * its version (roomAppIconUrl: a new icon is a new address, cached for good), or one emoji. Left out: the app shows its
 * name's first letter on a tile coloured from its id. Never taken from what a service sends (a message cannot set it).
 * Older servers omit it; a shape this build does not know reads as none. */
export const RoomAppIcon = z.union([z.object({ image: z.string().max(300) }), z.object({ emoji: z.string().max(32) })])
export type RoomAppIcon = z.infer<typeof RoomAppIcon>
const RoomAppIconSeen = RoomAppIcon.optional().catch(undefined)
/** The address of an app's icon image at a version (the long-cached form). */
export const roomAppIconUrl = (roomId: string, appId: string, version: number) =>
  `/api/rooms/${encodeURIComponent(roomId)}/apps/${encodeURIComponent(appId)}/icon?v=${version}`

/** On a room message an app posted (author null): which app (id null: removed since; the name and kind as they were),
 * `quiet`: a short line (no unread, no alert), `example`: "Show an example". */
export const RoomAppRef = z.object({
  id: z.string().nullable(),
  name: z.string().max(ROOM_APP_NAME_MAX),
  kind: RoomAppKind,
  /** the service of an Other app set up as a preset (its logo); older servers omit it */
  preset: RoomAppPresetSeen,
  /** the app's own icon now (a plain Other app; while the app is there): past messages show the new one too */
  icon: RoomAppIconSeen,
  quiet: z.literal(true).optional(),
  example: z.literal(true).optional(),
  /** who added it, for the sender's popover ("Set up by Mina"; members: "Ask Mina to change what shows here"): null
   * once they left the team or the app was removed. Older servers omit it */
  by: UserRef.nullable().optional(),
})
export type RoomAppRef = z.infer<typeof RoomAppRef>

/** Why the last request was not shown: the signature did not match, the body was not one Trina can read, too big, the
 * server's storage was full (answered 503 with Retry-After, so the service may send it again). */
export const RoomAppRefusal = z.enum(['signature', 'format', 'too_big', 'storage_full'])
export type RoomAppRefusal = z.infer<typeof RoomAppRefusal>

/** Email into rooms (plan docs/AGENTS/plan/20261123-0421-room-email.md): an Email app is an Other app with preset
 * 'email' (older apps show it as an Other app). It has no Webhook URL: its address is `<random>@<mail domain>`, the
 * mail service seals each mail to this server's key and this server pulls it (rooms/apps/mail/*). Its `address` in
 * RoomAppCreated and RoomAppAddress is that email address.
 * `state`: 'setting_up' until the mail service has the address (Copy waits), 'ready', 'unavailable' (the mail service
 * cannot be reached or the team turned email off: mail to it is refused).
 * `confirmation`: the last forwarding confirmation a mail provider sent here (Gmail sends one before a filter forwards),
 * with its code when one was found: shown only to the people who manage the app (never in the room), kept 7 days. */
export const RoomAppMailConfirmation = z.object({
  provider: z.enum(['gmail', 'outlook', 'other']),
  /** the account that asks to forward here, as the mail says it (unverified) */
  from: z.string().max(320),
  code: z.string().max(40).nullable(),
  at: IsoTime,
})
export type RoomAppMailConfirmation = z.infer<typeof RoomAppMailConfirmation>
export const RoomAppMail = z.object({
  state: z.enum(['setting_up', 'ready', 'unavailable']),
  confirmation: RoomAppMailConfirmation.optional(),
})
export type RoomAppMail = z.infer<typeof RoomAppMail>
/** Whether Email can be added here: `reason` when not. 'not_connected': the server has no mail service (it is not
 * connected to the hosting service, or the operator set none); 'off': an admin has not turned on "Let rooms get email"
 * (Admin › Team settings, off by default). */
export const RoomAppMailAvailability = z.object({
  available: z.boolean(),
  reason: z.enum(['not_connected', 'off']).optional(),
})
export type RoomAppMailAvailability = z.infer<typeof RoomAppMailAvailability>
/** Mail limits a team server keeps (the mail service's own are in cloud-protocol/mail-in.ts). */
export const ROOM_APP_MAIL_TEXT_MAX = 20_000
export const ROOM_APP_MAIL_CONFIRMATION_DAYS = 7

/** One app as the people who manage it see it: never its address or secret (getRoomAppAddress). */
export const RoomApp = z.object({
  id: z.string(),
  roomId: z.string(),
  kind: RoomAppKind,
  /** an Other app set up as a named service (fixed when it was added); older servers omit it */
  preset: RoomAppPresetSeen,
  name: z.string(),
  /** its own icon (a plain Other app only; left out: its name's first letter) */
  icon: RoomAppIconSeen,
  /** the switches, every key of the kind's (ROOM_APP_SWITCHES) or the preset's (ROOM_APP_PRESET_SWITCHES) */
  events: z.record(z.string(), z.boolean()),
  quiet: z.boolean(),
  /** a secret is set: requests must carry its signature (GitHub's X-Hub-Signature-256, Sentry's Sentry-Hook-Signature) */
  signed: z.boolean(),
  /** a secret Trina made is saved but no signed request came yet: requests without a signature are still shown until
   * the first signed one (then `signed`). Older servers omit it */
  signingPending: z.literal(true).optional(),
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
  /** while paused, why: 'app' (its own daily cap, ROOM_APP_DAILY_CAP) or 'team' (all the team's apps together reached
   * ROOM_APP_TEAM_DAILY_CAP: every app waits for the team's midnight, nothing to resume). Older servers omit it */
  pausedBy: z.enum(['app', 'team']).optional(),
  /** while paused, the number it reached: the team's cap, or the app's (twice it after "Resume now" that day) */
  pausedCap: z.number().int().positive().optional(),
  /** the team's time zone, while paused by the team's cap (the end of the pause is said in it) */
  timeZone: z.string().optional(),
  /** when the Webhook URL was last regenerated (null: never). Until a message arrives after it (lastOkAt), the status
   * says it waits for the service to use the new one. Older servers omit it */
  rotatedAt: IsoTime.nullable().optional(),
  /** messages shown today (the team's day) */
  today: z.number().int().nonnegative(),
  /** the switch keys an event has arrived for at least once (also while its switch is off): the settings say "Not set
   * up in <service>" under the others. Keys only, never content. Older servers omit it */
  eventsSeen: z.array(z.string().max(32)).optional(),
  /** someone who was shown the address (or a secret Trina made) can no longer manage the app (left the room or the
   * team, or is no longer an admin in a team room): "Someone who left knows this address · Get a new address" */
  leaverKnows: z.literal(true).optional(),
  /** an Email app (preset 'email'): its address's state at the mail service and the last forwarding confirmation.
   * Older servers omit it; a shape this build does not know reads as none */
  mail: RoomAppMail.optional().catch(undefined),
})
export type RoomApp = z.infer<typeof RoomApp>

/** A room's apps. `available`: this server has an internet address the services can reach (the relay or its own public
 * host); without one nothing can be added and the apps there cannot be reached. */
export const RoomAppList = z.object({
  items: z.array(RoomApp),
  available: z.boolean(),
  max: z.number().int().positive(),
  /** Email: whether it can be added here. Older servers omit it (no Email) */
  mail: RoomAppMailAvailability.optional(),
})
export type RoomAppList = z.infer<typeof RoomAppList>

/** The address to paste into the service (https://<team address>/in/<token>; an Email app's: its email address). */
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
/** `preset` only with kind 'other' (400 otherwise); it cannot be changed later (UpdateRoomAppBody has none). */
export const CreateRoomAppBody = z.object({ kind: RoomAppKind, preset: RoomAppPreset.optional(), name: AppName.optional() }).strict()
export type CreateRoomAppBody = z.infer<typeof CreateRoomAppBody>
/** Any of: switches (only keys of the kind; the others stay), Quiet, the name. */
export const UpdateRoomAppBody = z.object({
  events: z.record(z.string().max(32), z.boolean()).optional(),
  quiet: z.boolean().optional(),
  name: AppName.optional(),
}).strict()
export type UpdateRoomAppBody = z.infer<typeof UpdateRoomAppBody>
/** "Make it safer" (optional for GitHub and Sentry, owner decision 9): `generate` makes a secret Trina shows once here
 * (and on getRoomAppAddress), for GitHub's Secret field (it waits for the first request signed with it: `signingPending`
 * until then, and unsigned requests are still taken); `secret` saves Sentry's Client Secret (64 hex characters);
 * `secret: null` takes the secret away (requests are then taken unsigned and their names marked "(unverified)"). */
export const SetRoomAppSecretBody = z.union([
  z.object({ generate: z.literal(true) }).strict(),
  z.object({ secret: z.string().trim().max(200).nullable() }).strict(),
])
export type SetRoomAppSecretBody = z.infer<typeof SetRoomAppSecretBody>
export const RoomAppSecretResult = z.object({ app: RoomApp, secret: z.string().optional() })
export type RoomAppSecretResult = z.infer<typeof RoomAppSecretResult>
/** "Change icon" › an image: its type (PNG, JPEG or WebP; the file's first bytes must say the same). */
export const RoomAppIconQuery = z.object({ type: z.string().min(1).max(100) })
/** GET of the image: `v` the version in its address (the current one is cached for a year). */
export const RoomAppIconVersionQuery = z.object({ v: z.string().max(20).optional() })
/** "Change icon" › an emoji: exactly one (the rule of a reaction), in its one form. */
export const SetRoomAppEmojiBody = z.object({ emoji: z.string().max(32).refine(isStatusEmoji, 'one emoji').transform(emojiForm) }).strict()
export type SetRoomAppEmojiBody = z.infer<typeof SetRoomAppEmojiBody>

/** Sentry's Client Secret as Sentry shows it (checked in TC-1546): 64 hex characters. */
export const SENTRY_SECRET_RE = /^[0-9a-f]{64}$/i

/** The JSON body for a Zendesk trigger's "Notify webhook" action (Copy body, inside the step where it is pasted): the
 * placeholders are Zendesk's. `event` names the trigger ('created': "Ticket is Created", 'updated': "Ticket is
 * Updated"), so the app's switches new_ticket / updated can tell them apart. Zendesk does not JSON-escape a
 * placeholder's value, so everything an outsider writes (title, names, the comment) goes through Liquid's `escape`
 * (HTML entities: a `"` can't end the string and add keys); the server decodes them and refuses a body that names a
 * key twice. */
export function roomAppZendeskBody(event: 'created' | 'updated'): string {
  return `{"trina":"zendesk","event":"${event}","id":"{{ticket.id}}","title":"{{ticket.title | escape}}","status":"{{ticket.status}}",
 "priority":"{{ticket.priority}}","requester":"{{ticket.requester.name | escape}}","assignee":"{{ticket.assignee.name | escape}}",
 "url":"{{ticket.url}}","update":"{{ticket.latest_public_comment | escape}}"}`
}

/** The custom body for a Jira automation flow's "Send web request" (Copy body, inside the step where it is pasted): one
 * flow per trigger, `event` naming it ('created': "Work item created", 'transitioned': "Work item transitioned",
 * 'commented': "Work item commented"; Jira has no documented smart value for the trigger). Jira pastes smart values
 * as they are, so everything a person writes goes through `.jsonEncode` (quotes and backslashes escaped, no quotes
 * added); the server refuses a body that names a key twice and links only to the same key on the pinned site. */
export function roomAppJiraBody(event: 'created' | 'transitioned' | 'commented'): string {
  const comment = event === 'commented' ? `,"comment":"{{comment.body.jsonEncode}}","by":"{{comment.author.displayName.jsonEncode}}"` : ''
  return `{"trina":"jira","event":"${event}","key":"{{issue.key}}","title":"{{issue.summary.jsonEncode}}","status":"{{issue.status.name.jsonEncode}}",
 "assignee":"{{issue.assignee.displayName.jsonEncode}}","url":"{{issue.url}}"${comment}}`
}

/** The Google Forms Apps Script (Copy code), with the address filled in. `sendEmail`: the form's respondent email is
 * sent when the form collects it (the app's `email` switch; the server drops it while the switch is off either way).
 * A file-upload answer is sent as `files: n` (how many), not its Drive file IDs (TC-2803): the names would need
 * DriveApp, which adds "See, edit, create and delete all of your Google Drive files" to the setUp permission prompt;
 * FormApp, UrlFetchApp and ScriptApp (forms, external request, triggers) are all the script asks for. */
export function roomAppFormsScript(address: string, sendEmail: boolean): string {
  const q = JSON.stringify(address)
  return `const TRINA_ADDRESS = ${q}
// Sends the respondent's email only when the form collects it and "Respondent's email" is on in Trina.
const SEND_EMAIL = ${sendEmail ? 'true' : 'false'}

function sendToTrina(e) {
  const r = e.response
  const answers = r.getItemResponses().map((i) => {
    const item = i.getItem()
    const a = i.getResponse()
    // A file upload answers with Drive file IDs: send how many files. Their names would need access to your Drive.
    if (item.getType() === FormApp.ItemType.FILE_UPLOAD) return { q: item.getTitle(), a: '', files: Array.isArray(a) ? a.length : 1 }
    return { q: item.getTitle(), a: Array.isArray(a) ? a.join(', ') : String(a) }
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
    summary: `Add an app (on the first "Copy address"): its secret address comes back (preset email: an email address, 409 room_email_off while the team has email off, 409 mail_not_connected without a mail service). \`preset\` (only with kind other, 400 otherwise) sets it up as a named service (Notion, Typeform, Tally, Jotform, Stripe, Shopify, Zendesk); it is fixed from then on. ${WHO} At most ${ROOM_APPS_MAX} per room (409 room_apps_full), ${ROOM_APPS_PER_HOUR} added per person and hour (429); 409 no_public_address without an internet address; 400 when the name is a person's in this team. Audited.` }),
  getRoomAppAddress: endpoint({ method: 'GET', path: '/api/rooms/:id/apps/:appId/address', auth: 'user', owner: 'B', response: RoomAppAddress,
    summary: `Copy an app's address again (and a secret Trina made for it). ${WHO}` }),
  updateRoomApp: endpoint({ method: 'PATCH', path: '/api/rooms/:id/apps/:appId', auth: 'user', owner: 'B', body: UpdateRoomAppBody, response: RoomApp,
    summary: `Change an app's switches, Quiet or name. ${WHO} Audited.` }),
  setRoomAppSecret: endpoint({ method: 'PUT', path: '/api/rooms/:id/apps/:appId/secret', auth: 'user', owner: 'B', body: SetRoomAppSecretBody, response: RoomAppSecretResult,
    summary: `"Make it safer" / "Signing secret (optional)": make a secret (GitHub, Typeform, Tally), save the service's own (Sentry's Client Secret; Stripe's, Shopify's, Zendesk's, Toss Payments' or PortOne's signing secret, Channel Talk's webhook token; checked by its shape; Zendesk's public test secret is refused), or take the secret away. 400 no_signing for a service that cannot sign (plain Other, Google Forms, Notion, Jotform, Jira, HubSpot). Once a secret is saved, unsigned or wrong requests are refused (401). ${WHO} Audited (never the secret).` }),
  rotateRoomApp: endpoint({ method: 'POST', path: '/api/rooms/:id/apps/:appId/rotate', auth: 'user', owner: 'B', response: RoomAppCreated,
    summary: `"Get a new address": the old one stops working at once (an Email app: mail to the old address is refused from now on; 503 mail_unreachable when the mail service cannot be told, nothing changed). ${WHO} Audited.` }),
  resumeRoomApp: endpoint({ method: 'POST', path: '/api/rooms/:id/apps/:appId/resume', auth: 'user', owner: 'B', response: RoomApp,
    summary: `"Resume now" after the day's cap paused an app: as many messages again today, once a day (409 not_paused / already_resumed; the team's cap still applies). ${WHO} Audited.` }),
  exampleRoomApp: endpoint({ method: 'POST', path: '/api/rooms/:id/apps/:appId/example', auth: 'user', owner: 'B', status: 204, response: empty,
    summary: `"Show an example": a sample card from the app in the room, marked as an example (${ROOM_APP_EXAMPLES_PER_HOUR} an hour, not counted toward the cap). ${WHO}` }),
  putRoomAppIcon: endpoint({ method: 'PUT', path: '/api/rooms/:id/apps/:appId/icon', auth: 'user', owner: 'B', query: RoomAppIconQuery, body: binary(AVATAR_MAX_BYTES), response: RoomApp,
    summary: `"Change icon" › Upload an image, for a plain Other app (400 not_other for a named service, Sentry, GitHub or Google Forms): a square PNG, JPEG or WebP of 64–512 px, up to 256 KiB, as a profile photo (SVG and animations refused; metadata cut out). It replaces an emoji. At most ${ROOM_APP_ICON_CHANGES_PER_HOUR} icon changes per app and hour (429). ${WHO} Audited.` }),
  setRoomAppEmoji: endpoint({ method: 'PUT', path: '/api/rooms/:id/apps/:appId/icon/emoji', auth: 'user', owner: 'B', body: SetRoomAppEmojiBody, response: RoomApp,
    summary: `"Change icon" › Pick an emoji, for a plain Other app (400 not_other otherwise): exactly one emoji; it replaces an image. At most ${ROOM_APP_ICON_CHANGES_PER_HOUR} icon changes per app and hour (429). ${WHO} Audited.` }),
  deleteRoomAppIcon: endpoint({ method: 'DELETE', path: '/api/rooms/:id/apps/:appId/icon', auth: 'user', owner: 'B', response: RoomApp,
    summary: `"Remove icon": the app shows its name's first letter again (nothing to remove: unchanged). Counts toward the ${ROOM_APP_ICON_CHANGES_PER_HOUR} icon changes per app and hour (429). ${WHO} Audited when there was one.` }),
  roomAppIcon: endpoint({ method: 'GET', path: '/api/rooms/:id/apps/:appId/icon', auth: 'user', owner: 'B', query: RoomAppIconVersionQuery, response: stream(false),
    summary: 'An app\'s icon image, for anyone in the room (404 otherwise, and without an image); cached for a year when ?v= is the current version. An image only: nosniff and a sandbox policy.' }),
  deleteRoomApp: endpoint({ method: 'DELETE', path: '/api/rooms/:id/apps/:appId', auth: 'user', owner: 'B', status: 204, response: empty,
    summary: `Remove an app from the room: its address stops working at once, its messages stay (with its name's first letter: its icon goes with it). ${WHO} Audited.` }),
} as const
