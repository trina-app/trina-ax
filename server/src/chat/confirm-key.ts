// The keys of the "confirm" steps before content reaches more people ("대화방에 보내기" chat/answer-share.ts, the share of
// a chat chat/share-chat.ts, Slack's "Post anyway" integrations/slack/post-check.ts): an
// opaque key over what the person was shown, made with a secret of this server process (in
// memory: a restart asks again). Each puts its own `kind` (or, for "대화방에 보내기", a `roomId` and no `kind`) in the
// state, so a key of one question is never one of another.
import { createHmac, randomBytes } from 'node:crypto'
import type { AppContext } from '../context'

/** Per AppContext: the secret the confirm keys are made with. */
const secrets = new WeakMap<AppContext, Buffer>()
export const confirmSecret = (ctx: AppContext): Buffer => secrets.get(ctx) ?? secrets.set(ctx, randomBytes(32)).get(ctx)!
/** An opaque key over `state` (HMAC-SHA-256 with this server process's secret): what a person saw when asked. */
export const confirmMac = (ctx: AppContext, state: unknown): string => createHmac('sha256', confirmSecret(ctx)).update(JSON.stringify(state)).digest('base64url')
