// A Google app connection's refresh (docs/GOOGLE-APPS.md): connections/service.ts oauthToken calls this instead of the
// generic token request for a row with `google_app`. Its client is the card's client as set up NOW (setupOf), never one
// kept with the tokens: a client secret stays in its private file, and when the card's Google app changed (another
// client, "same as Drive" after Drive's changed, or the hosting service's) the old sign-in ends (GrantError: sign in
// again). A hosted server refreshes through the hosting service with the `app` field.
import crypto from 'node:crypto'
import type { GoogleAppId } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { GoogleTransport, GOOGLE_TOKEN, type DriveFetch } from '../google-drive/client'
import { googleDriveOf } from '../google-drive/oauth'
import { DriveError } from '../google-drive/store'
import { NetError } from '../connections/net'
import { GrantError, type OAuthSecret, type OAuthTokens } from '../connections/oauth'
import { setupOf } from './config'
import { demoFakesOf } from '../../demo/fakes'
import { DEMO_TOKEN_LIFE_S } from '../../demo/fakes/drive'

/** what a Google app connection's sealed secret carries besides the generic OAuth fields */
export interface GoogleAppSecret extends OAuthSecret { google: { app: GoogleAppId; key: string; mode: 'direct' | 'broker' } }
export const isGoogleAppSecret = (s: unknown): s is GoogleAppSecret => !!s && typeof s === 'object' && !!(s as GoogleAppSecret).google && typeof (s as GoogleAppSecret).google.key === 'string'

/** tests only: the stand-in for Google's and the hosting service's addresses (googleAppsOf deps) */
const fetchers = new WeakMap<AppContext, DriveFetch>()
export const setGoogleFetch = (ctx: AppContext, f: DriveFetch) => fetchers.set(ctx, f)
export const googleTransport = (ctx: AppContext) => new GoogleTransport(fetchers.get(ctx) ?? fetch)

/** Google's token answer as tokens: an access token and how long it lives; the refresh token kept when none comes. */
export function tokensOf(j: Record<string, any>, now: number, previous?: string | null): OAuthTokens {
  const access = j.access_token, refresh = typeof j.refresh_token === 'string' ? j.refresh_token : previous ?? null, life = j.expires_in
  if (typeof access !== 'string' || !access || access.length > 16_384 || typeof refresh !== 'string' || !refresh || refresh.length > 16_384) throw new GrantError('no_token')
  if (typeof life !== 'number' || !Number.isFinite(life) || life <= 0 || life > 31_536_000) throw new GrantError('no_token')
  return { accessToken: access, refreshToken: refresh, expiresAt: now + life * 1000 }
}

export async function refreshGoogleApp(ctx: AppContext, secret: OAuthSecret, now: number): Promise<OAuthTokens> {
  if (!isGoogleAppSecret(secret) || !secret.tokens.refreshToken) throw new GrantError('not_google_app')
  // a demo server with fakes (server/src/demo/fakes/): answered here, for another year, whatever the card's setup is
  // now (the demo's sign-ins are seeded); nothing is asked of Google
  if (demoFakesOf(ctx)) return { accessToken: secret.tokens.accessToken || `demo-access-${crypto.randomUUID()}`, refreshToken: secret.tokens.refreshToken, expiresAt: now + DEMO_TOKEN_LIFE_S * 1000 }
  const { app, key } = secret.google
  const setup = setupOf(ctx, app)
  // another Google app now (or none): the sign-in was made with a client this server no longer uses
  if (setup.mode === 'off' || setup.key !== key) throw new GrantError('client_changed')
  try {
    const j = setup.mode === 'broker'
      ? await googleDriveOf(ctx).broker!.refresh(secret.tokens.refreshToken, undefined, app)
      : await googleTransport(ctx).json(GOOGLE_TOKEN, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: secret.tokens.refreshToken, client_id: setup.client!.clientId, client_secret: setup.client!.clientSecret }),
      }, 32_768)
    return tokensOf(j, now, secret.tokens.refreshToken)
  } catch (e) {
    if (e instanceof GrantError) throw e
    if (e instanceof DriveError && (e.reason === 'needs_reconnect' || e.reason === 'unauthorized_provider' || e.reason === 'service_limited')) throw new GrantError(e.reason)
    throw new NetError('unreachable')
  }
}
