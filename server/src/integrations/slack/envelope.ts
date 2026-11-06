// What arrives over the Socket Mode connection (https://docs.slack.dev/apis/events-api/using-socket-mode/), checked
// strictly before anything is done with it. Socket Mode needs no request signature (the connection itself is
// authenticated with the app-level token), so these shapes are the only gate: who asked is taken from these fields
// (the event's user, team and enterprise), never from the message text. Unknown extra fields are ignored; a field we
// use that has another shape drops the whole envelope.
import { z } from 'zod'

/** Slack ids: U…/W… people, C…/G…/D… conversations, T… workspaces, E… organisations, A… apps, B… bots */
export const SlackId = z.string().regex(/^[A-Z0-9]{2,40}$/)
/** message timestamps ("1355517523.000005") */
export const Ts = z.string().regex(/^\d{1,12}\.\d{1,9}$/)
const Text = z.string().max(40_000)

export const Hello = z.object({ type: z.literal('hello'), connection_info: z.object({ app_id: SlackId }).partial().optional(), num_connections: z.number().optional() })
export const Disconnect = z.object({ type: z.literal('disconnect'), reason: z.string().max(64).optional() })
export const Envelope = z.object({
  envelope_id: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
  type: z.string().max(64),
  payload: z.unknown().optional(),
  accepts_response_payload: z.boolean().optional(),
  retry_attempt: z.number().int().optional(),
  retry_reason: z.string().max(64).optional(),
})
export type Envelope = z.infer<typeof Envelope>

export const EventCallback = z.object({
  type: z.literal('event_callback'),
  event_id: z.string().regex(/^[A-Za-z0-9]{4,64}$/),
  team_id: SlackId,
  api_app_id: SlackId,
  enterprise_id: SlackId.nullable().optional(),
  is_ext_shared_channel: z.boolean().optional(),
  event: z.object({ type: z.string().max(64) }).passthrough(),
})

/** @app in a channel the app is in (scope app_mentions:read) */
export const AppMention = z.object({
  type: z.literal('app_mention'),
  user: SlackId,
  text: Text,
  ts: Ts,
  channel: SlackId,
  thread_ts: Ts.optional(),
  subtype: z.string().max(64).optional(),
  bot_id: z.string().max(64).optional(),
  /** a person of another workspace in a shared channel (Slack Connect) */
  user_team: SlackId.optional(),
})
/** a message in the app's DM (scope im:history) */
export const ImMessage = z.object({
  type: z.literal('message'),
  channel_type: z.literal('im'),
  user: SlackId,
  text: Text,
  ts: Ts,
  channel: SlackId,
  thread_ts: Ts.optional(),
  subtype: z.string().max(64).optional(),
  bot_id: z.string().max(64).optional(),
  user_team: SlackId.optional(),
})

/** a button of ours pressed (interactive envelope, payload type block_actions) */
export const BlockActions = z.object({
  type: z.literal('block_actions'),
  api_app_id: SlackId,
  user: z.object({ id: SlackId, team_id: SlackId.optional() }),
  team: z.object({ id: SlackId }).nullable().optional(),
  enterprise: z.object({ id: SlackId }).nullable().optional(),
  container: z.object({ type: z.string().max(64), channel_id: SlackId.optional(), message_ts: Ts.optional(), is_ephemeral: z.boolean().optional() }).partial().optional(),
  channel: z.object({ id: SlackId }).partial().optional(),
  actions: z.array(z.object({ action_id: z.string().max(255), value: z.string().max(2000).optional(), type: z.string().max(64) })).min(1).max(5),
  response_url: z.string().max(2048).optional(),
})
export type BlockActions = z.infer<typeof BlockActions>
