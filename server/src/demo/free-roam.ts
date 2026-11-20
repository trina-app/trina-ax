// A free-roam demo instance (docs/decisions/20261119-demo-free-roam-a.md): one visitor's own server, cloned from the
// demo company's snapshot and reached only through demo-gate, with the real AI until the demo limit. The demo file says
// so (DemoFile.kind "freeRoam"); app-config.ts readDemoFile accepts it only on a loopback listener with managed AI
// connections, no relay and the gate as the model upstream. This file is what such a server does at start, and what it
// counts: its one AI connection, the demo limit and the uploads. What it refuses is in ./guard.ts.
import crypto from 'node:crypto'
import path from 'node:path'
import { DEMO_BUSY_REASON, DEMO_LIMIT_DEFAULT, DEMO_REST_REASON, DEMO_UPLOAD_FILE_MAX, DEMO_UPLOAD_TOTAL_MAX, type ApiErrorBody, type DemoFile, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { isFreeRoam } from '../app-config'
import { setDemoLimit } from '../admin/budgets'
import { getSetting, setSetting } from '../admin/settings'
import { credentialsOf, connectionsChanged, listRows } from '../credentials/store'
import { insertRow } from '../credentials/service'
import { MEMBER_OWN_KEY, SHARED_SUBSCRIPTIONS_KEY } from '../credentials/policy'
import { DEMO_GATE_DIR, setDemoDenyRead } from '../tools/isolate'

/** the free-roam demo file, only on the development server it was accepted for (routes/demo.ts demoOf's rule) */
export function freeRoamOf(ctx: AppContext): DemoFile | null {
  const d = ctx.config.demo
  return d && isFreeRoam(ctx.config) && ctx.config.mode === 'dev' && ctx.config.deployment !== 'hosted' && !ctx.config.office ? d : null
}

export const demoLimitOf = (d: DemoFile): number => d.limitTokens ?? DEMO_LIMIT_DEFAULT
export const uploadFileMaxOf = (d: DemoFile): number => d.uploadFileMax ?? DEMO_UPLOAD_FILE_MAX
export const uploadTotalMaxOf = (d: DemoFile): number => d.uploadTotalMax ?? DEMO_UPLOAD_TOTAL_MAX

/** The one AI connection's name, as Admin › AI providers would show it (nobody in a free-roam demo sees that page). */
export const DEMO_AI_LABEL = 'Demo AI'

/**
 * The stand-in token of the "Demo AI" connection: shaped like a Claude subscription token (credentials/validate.ts
 * CLAUDE_TOKEN_RE), so the proxy sends it as a Bearer with the OAuth beta, and worth nothing: demo-gate, the instance's
 * model upstream, checks the instance by the secret in its own address and puts the real credential in its place.
 */
export function dummyClaudeToken(): string {
  return 'sk-ant-oat01-demo' + crypto.randomBytes(32).toString('base64url')
}

/** The folders a free-roam instance's converters may not read: demo-gate's fixed folder and the ones the gate names
 * (MYCEL_DEMO_GATE_DIRS, colon-separated: its state and secret folders; demo-gate/src/pool.ts gateDirs). */
export function freeRoamDenyRead(gateDirs: string | undefined): string[] {
  return [DEMO_GATE_DIR, ...(gateDirs ?? '').split(':').map((s) => s.trim()).filter((s) => path.isAbsolute(s) && s !== '/')]
}

/**
 * At start (routes/demo.ts register), only on a free-roam demo:
 * - the demo limit for the budget checks (admin/budgets.ts setDemoLimit);
 * - the team's AI is the one "Demo AI" connection: made when missing (a stand-in token), its marks cleared (a
 *   refusal never belongs to it: proxy/model-proxy.ts), every other connection switched off, team subscriptions on
 *   (the stand-in is one) and members' own connections off.
 * Never throws: a demo that cannot set its AI up shows "no AI connection", like any server without one.
 */
export function startFreeRoam(ctx: AppContext): void {
  const demo = freeRoamOf(ctx)
  if (!demo) return
  setDemoLimit(ctx.db, demoLimitOf(demo))
  // converters never read demo-gate's folders (its credential), also if the hosting user setup were wrong
  setDemoDenyRead(freeRoamDenyRead(process.env.MYCEL_DEMO_GATE_DIRS))
  try {
    if (getSetting(ctx.db, SHARED_SUBSCRIPTIONS_KEY) !== true) setSetting(ctx.db, SHARED_SUBSCRIPTIONS_KEY, true)
    if (getSetting(ctx.db, MEMBER_OWN_KEY) !== false) setSetting(ctx.db, MEMBER_OWN_KEY, false)
    ensureDemoAi(ctx)
  } catch (e) {
    ctx.log.error('free-roam demo: the demo AI connection could not be set up', { err: e })
  }
}

/** the "Demo AI" connection's id (made when missing); every other connection off */
export function ensureDemoAi(ctx: AppContext): string {
  const cc = credentialsOf(ctx)
  const ours = (r: { kind: string; label: string; owner_user_id: string | null }) => r.kind === 'anthropic-oauth' && r.owner_user_id === null && r.label === DEMO_AI_LABEL
  const id = listRows(ctx.db).find(ours)?.id ?? insertRow(cc, {
    kind: 'anthropic-oauth', label: DEMO_AI_LABEL, secret: { token: dummyClaudeToken() }, ownerUserId: null, priority: 0, assignments: [],
    // no expiry (a stand-in never runs out) and checked: the gate answers for it
    createdBy: null, expiresAt: null, checkedAt: new Date().toISOString(),
  })
  ctx.db.transaction(() => {
    // whatever a copy of the snapshot carried over: the stand-in is never refused, limited or switched off
    ctx.db.query("UPDATE engine_credentials SET disabled = 0, status = 'ok', status_code = NULL, limited_until = NULL, expires_at = NULL WHERE id = ?").run(id)
    ctx.db.query('DELETE FROM engine_credential_assignments WHERE credential_id = ?').run(id)
    ctx.db.query('UPDATE engine_credentials SET disabled = 1 WHERE id <> ? AND disabled = 0').run(id)
  })()
  connectionsChanged(cc)
  return id
}

/** Uploads counted so far on this instance (bytes), kept in the settings table so a restart keeps the count. */
const UPLOADED_KEY = 'demo.uploadedBytes'
export function uploadedBytes(ctx: AppContext): number {
  const v = getSetting<number>(ctx.db, UPLOADED_KEY)
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}
export function addUploadedBytes(ctx: AppContext, n: number): void {
  if (n > 0) setSetting(ctx.db, UPLOADED_KEY, uploadedBytes(ctx) + n)
}

// ---------------- what a visitor reads when an answer fails ----------------
// demo-gate answers the instance's model calls (docs/decisions/20261119-demo-free-roam-a.md): its daily cap or its pause
// is a 403 budget_exceeded (proxy/model-proxy.ts turns it into a budget stop: demoRestError), every other failure a 503
// "busy". Whatever the engine then says, the visitor reads one neutral line: nothing about an AI account, a plan or a
// limit of the subscription behind the gate.
const REST_TEXT: Record<Locale, string> = {
  ko: '라이브 데모가 쉬는 중이에요. 나중에 다시 해 보세요.',
  en: 'The live demo is resting, try again later.',
  id: 'Demo langsung sedang istirahat, coba lagi nanti.',
  ja: 'ライブデモは休止中です。しばらくしてからもう一度お試しください。',
  es: 'La demostración en vivo está en pausa; vuelva a intentarlo más tarde.',
  zh: '在线演示正在休息，请稍后再试。',
}
const BUSY_TEXT: Record<Locale, string> = {
  ko: '데모가 붐비고 있어요. 조금 뒤에 다시 해 보세요.',
  en: 'The demo is busy, try again in a bit.',
  id: 'Demo sedang sibuk, coba lagi sebentar lagi.',
  ja: 'デモが混み合っています。少ししてからもう一度お試しください。',
  es: 'La demostración está ocupada; vuelva a intentarlo en un momento.',
  zh: '演示繁忙，请稍后再试。',
}
/** the gate stopped the answer (its daily cap or pause): a budget stop, like the demo limit, in its own words */
export function demoRestError(locale: Locale): ApiErrorBody {
  return { code: 'budget_exceeded', message: REST_TEXT[locale] ?? REST_TEXT.en, params: { reason: DEMO_REST_REASON } }
}
/** a free-roam answer's error as the visitor reads it: a budget stop (the demo limit, the gate's rest) as it is, any
 * other failure "The demo is busy, try again in a bit." (code kept, params dropped: they can name a limit's time) */
export function freeRoamTurnError(err: ApiErrorBody, locale: Locale): ApiErrorBody {
  if (err.code === 'budget_exceeded' && (err.params?.reason === 'demo_limit' || err.params?.reason === DEMO_REST_REASON)) return err
  return { code: err.code, message: BUSY_TEXT[locale] ?? BUSY_TEXT.en, params: { reason: DEMO_BUSY_REASON } }
}
