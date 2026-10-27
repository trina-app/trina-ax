// Who picks the AI engine and model (owner decision 2026-10-21, Admin > AI engines): the team default (Claude Code
// with the default model) answers everyone; owner and admins always pick; other people only when "팀원이 엔진 고르기
// 허용" lets them (everyone, or chosen groups / people). The server enforces it: a send / edit / regenerate / new chat /
// chat change naming another engine or model than the person would get anyway is refused with a clear message.
// Existing chats keep their engine; a chat whose engine the admin has since switched off is answered by the team
// default (the turn shows a step saying so). Optional "Claude 한도에 닿으면 Codex로 넘기기" (off by default, never
// while Codex is off, e.g. office mode): see chat/turn.ts.
import { MemberEngineChoice, UserPrefs, type EngineId, type EngineStatus, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { codexBetaAllowed, codexIsBeta, safeModel, type EngineConfs } from '../chat/engines'
import { allowedCredentialKinds, isManaged } from '../app-config'
import { hasCredentialFor } from '../credentials/resolve'
import { tr } from '../chat/i18n'
import { enginesEnabled, getSetting, getTeamSettings, setSetting } from './settings'
import { CLAUDE_MODELS, ENGINE_LABELS, codexModels, engineEnv, engineStatusCache } from './engines'
import { readApiEngine } from '../engine/api-agent'

/** Realtime notice: who may pick the engine, which engines are on, or which can answer changed. Open windows ask GET
 * /api/me and GET /api/engines again (the composer shows or hides its picker without a reload); it carries nothing. */
export const ENGINE_CHOICE_CHANGED = { type: 'notice', data: { level: 'info', code: 'engine_choice_changed', message: '' } } as const

export const MEMBER_CHOICE_KEY = 'engines.memberChoice'
export const LIMIT_FALLBACK_KEY = 'engines.limitFallback'
const OFF: MemberEngineChoice = { mode: 'off', groupIds: [], userIds: [] }

type Ctx = Pick<AppContext, 'db' | 'config'>
export interface Person { id: string; role: string }
export interface EngineModel { engine: EngineId; model: string | null }

export function memberChoice(ctx: Pick<AppContext, 'db'>): MemberEngineChoice {
  const v = MemberEngineChoice.safeParse(getSetting(ctx.db, MEMBER_CHOICE_KEY))
  return v.success ? v.data : OFF
}
export function setMemberChoice(ctx: Pick<AppContext, 'db'>, v: MemberEngineChoice) {
  setSetting(ctx.db, MEMBER_CHOICE_KEY, { mode: v.mode, groupIds: [...new Set(v.groupIds)], userIds: [...new Set(v.userIds)] })
}

/** The installation turned Codex off (office mode writes codexBin ''): not offered anywhere, whatever the switch says. */
export const codexOffHere = (ctx: Pick<AppContext, 'config'>) => ctx.config.engine.codexBin === ''

/** The admin's switch and the installation agree the engine is on (the API engine also needs its settings). */
export function engineOn(ctx: Ctx, id: EngineId): boolean {
  if (!enginesEnabled(ctx.db)[id]) return false
  if (id === 'api') return readApiEngine(ctx.config.dataDir) !== null
  return !(id === 'codex' && codexOffHere(ctx))
}

/** "Claude 한도에 닿으면 Codex로 넘기기" can only be on while Codex is on. */
export const limitFallbackAvailable = (ctx: Ctx) => engineOn(ctx, 'codex')
export const limitFallbackSetting = (ctx: Pick<AppContext, 'db'>) => getSetting<boolean>(ctx.db, LIMIT_FALLBACK_KEY) === true
export const setLimitFallback = (ctx: Pick<AppContext, 'db'>, on: boolean) => setSetting(ctx.db, LIMIT_FALLBACK_KEY, on)
/** in effect now (the switch, and Codex on) */
export const limitFallbackOn = (ctx: Ctx) => limitFallbackSetting(ctx) && limitFallbackAvailable(ctx)

/** owner / admin always; others as Admin > AI engines says (the person's groups as they are now) */
export function canChooseEngine(ctx: Pick<AppContext, 'db'>, p: Person): boolean {
  if (p.role === 'owner' || p.role === 'admin') return true
  const c = memberChoice(ctx)
  if (c.mode === 'everyone') return true
  if (c.mode !== 'selected') return false
  if (c.userIds.includes(p.id)) return true
  if (!c.groupIds.length) return false
  return !!ctx.db.query(`SELECT 1 FROM group_members WHERE user_id = ? AND group_id IN (${c.groupIds.map(() => '?').join(',')}) LIMIT 1`).get(p.id, ...c.groupIds)
}

/** engines this person may pick: on, and (production Codex beta) the owner or someone the owner picked */
export function choosableEngines(ctx: Ctx, p: Person): EngineId[] {
  return (['claude-code', 'codex', 'api'] as EngineId[]).filter((id) => engineOn(ctx, id) && !(id === 'codex' && codexIsBeta(ctx) && !codexBetaAllowed(ctx.db, p)))
}

export function teamDefault(ctx: Pick<AppContext, 'db'>): EngineModel {
  const s = getTeamSettings(ctx.db)
  return { engine: s.defaultEngine, model: s.defaultModel && safeModel(s.defaultModel) ? s.defaultModel : null }
}

function prefsOf(ctx: Pick<AppContext, 'db'>, userId: string): UserPrefs {
  const r = ctx.db.query('SELECT prefs FROM users WHERE id = ?').get(userId) as { prefs: string | null } | null
  try { const v = UserPrefs.safeParse(JSON.parse(r?.prefs ?? '{}')); return v.success ? v.data : {} } catch { return {} }
}

/** New chats: the person's own default ("내 기본 엔진/모델") when they may pick and it is on, else the team default. */
export function personalDefault(ctx: Ctx, p: Person): EngineModel {
  if (canChooseEngine(ctx, p)) {
    const prefs = prefsOf(ctx, p.id)
    if (prefs.engine && engineOn(ctx, prefs.engine)) return { engine: prefs.engine, model: prefs.model && safeModel(prefs.model) ? prefs.model : null }
  }
  return teamDefault(ctx)
}

const checkModel = (model: string | null | undefined) => {
  if (model !== null && model !== undefined && !safeModel(model)) fail('validation', undefined, { fields: { 'body.model': 'not a model name' } })
}
const notAllowed = (locale: Locale): never => fail('forbidden', tr('engineChoiceNotAllowed', locale), { params: { reason: 'engine_choice_not_allowed' } })
const engineOff = (locale: Locale): never => fail('conflict', tr('engineOff', locale), { params: { reason: 'engine_off' } })

export interface TurnEngine extends EngineModel {
  /** the chat's engine is off: this turn uses the team default instead (a step says so) */
  substitutedFrom?: EngineId
}

/**
 * The engine and model of a turn (send / edit / regenerate). Without a choice in the request: the chat's own, or the
 * team default when the chat's engine is off. A choice is refused for people who may not pick (unless it names what
 * they would get anyway) and for an engine that is off.
 */
export function turnEngine(ctx: Ctx, p: Person, chat: { engine: string; model: string | null }, body: { engine?: EngineId; model?: string | null }, locale: Locale, defaultModelFor: (e: EngineId) => string | null): TurnEngine {
  checkModel(body.model)
  const chatEngine: EngineId = chat.engine === 'codex' || chat.engine === 'api' ? chat.engine : 'claude-code'
  const def = teamDefault(ctx)
  const base: TurnEngine = engineOn(ctx, chatEngine)
    ? { engine: chatEngine, model: chat.model ?? defaultModelFor(chatEngine) }
    : { ...def, substitutedFrom: chatEngine }
  if (!canChooseEngine(ctx, p)) {
    if (body.engine !== undefined && body.engine !== base.engine) notAllowed(locale)
    if (body.model !== undefined && (body.model ?? null) !== base.model) notAllowed(locale)
    return base
  }
  if (body.engine === undefined && body.model === undefined) return base
  const engine = body.engine ?? base.engine
  if (!engineOn(ctx, engine)) engineOff(locale)
  const model = body.model !== undefined ? body.model ?? null : engine === base.engine ? base.model : null
  return { engine, model, ...(base.substitutedFrom && engine === base.engine ? { substitutedFrom: base.substitutedFrom } : {}) }
}

/** A new chat's engine and model (POST /api/chats). */
export function newChatEngine(ctx: Ctx, p: Person, body: { engine?: EngineId; model?: string | null }, locale: Locale): EngineModel {
  checkModel(body.model)
  const mine = personalDefault(ctx, p)
  if (!canChooseEngine(ctx, p)) {
    if (body.engine !== undefined && body.engine !== mine.engine) notAllowed(locale)
    if (body.model !== undefined && (body.model ?? null) !== mine.model) notAllowed(locale)
    return mine
  }
  if (body.engine !== undefined && !engineOn(ctx, body.engine)) engineOff(locale)
  const engine = body.engine ?? mine.engine
  const model = body.model !== undefined ? body.model ?? null : body.engine !== undefined && body.engine !== mine.engine ? null : mine.model
  return { engine, model }
}

/** PATCH /api/chats/:id engine / model: refused for people who may not pick (unless unchanged) and for an engine that is off. */
export function checkChatEngineChange(ctx: Ctx, p: Person, chat: { engine: string; model: string | null }, body: { engine?: EngineId; model?: string | null }, locale: Locale): void {
  checkModel(body.model)
  if (body.engine === undefined && body.model === undefined) return
  if (!canChooseEngine(ctx, p)) {
    if (body.engine !== undefined && body.engine !== chat.engine) notAllowed(locale)
    if (body.model !== undefined && (body.model ?? null) !== chat.model) notAllowed(locale)
    return
  }
  if (body.engine !== undefined && body.engine !== chat.engine && !engineOn(ctx, body.engine)) engineOff(locale)
}

/** How long GET /api/engines waits for an engine's status check; a slower check goes on and is cached for next time. */
const READY_WAIT_MS = 3_000

/**
 * The engines of `ids` that can answer here: set up (chat/engines.ts problems: no engine program, no setup token, no
 * API settings) and not found signed out by the last status check (`claude auth status`, `codex login status`, the
 * engine account's Codex login, the API key). A check that fails or is still running does not hide an engine; when a
 * slow check later finds it signed out, onLateSignedOut is called (the caller tells open composers to ask again).
 */
export async function readyEngines(ids: EngineId[], problems: EngineConfs['problems'], statusOf: (id: EngineId) => Promise<EngineStatus['status']>, onLateSignedOut?: () => void): Promise<EngineId[]> {
  const signedOut = await Promise.all(ids.map((id) => {
    if (problems[id]) return true
    let late = false
    const check = statusOf(id).then((s) => s === 'not_logged_in', () => false)
    void check.then((out) => { if (late && out) onLateSignedOut?.() })
    return Promise.race([check, Bun.sleep(READY_WAIT_MS).then(() => { late = true; return false })])
  }))
  return ids.filter((_, i) => !signedOut[i])
}

/** GET /api/engines: what the composer may offer this person. */
export async function chatEnginesFor(ctx: AppContext, p: Person, problems: EngineConfs['problems'], locale: Locale) {
  const def = teamDefault(ctx)
  const canChoose = canChooseEngine(ctx, p)
  if (!canChoose) return { canChoose, defaultEngine: def.engine, defaultModel: def.model, engines: [] }
  const env = engineEnv(ctx)
  // the API engine has one model, the one the owner set (its display name is the label)
  const api = readApiEngine(ctx.config.dataDir)
  const of = (id: EngineId) => id === 'api' && api ? { label: api.label, models: [{ id: api.model, label: api.label }] }
    : { label: ENGINE_LABELS[id], models: id === 'claude-code' ? CLAUDE_MODELS : codexModels(env) }
  // the same cached checks as Admin > AI engines; managed: an engine this person has no usable AI connection for is
  // left out (an engine whose only connection is assigned to a group shows only for that group's members)
  const cache = engineStatusCache(ctx)
  const managed = isManaged(ctx.config)
  const allowed = allowedCredentialKinds(ctx.config)
  const ready = await readyEngines(choosableEngines(ctx, p), problems, async (id) => {
    if (managed && id !== 'api') return hasCredentialFor(ctx.db, p.id, id, allowed) ? 'ok' : 'not_logged_in'
    return (await cache.get(id, true, locale)).status
  }, () => ctx.services.realtime.publishEach(() => ENGINE_CHOICE_CHANGED))
  return { canChoose, defaultEngine: def.engine, defaultModel: def.model, engines: ready.map((id) => ({ id, ...of(id) })) }
}

/** Own default engine / model (PATCH /api/me prefs): only for people who may pick; null clears it. */
export function filterEnginePrefs(ctx: Pick<AppContext, 'db'>, p: Person, prefs: { engine?: EngineId | null; model?: string | null }): { engine?: EngineId | null; model?: string | null } {
  const out = { ...prefs }
  if (!canChooseEngine(ctx, p)) { delete out.engine; delete out.model; return out }
  if (out.model !== undefined && out.model !== null && !safeModel(out.model)) fail('validation', undefined, { fields: { 'body.prefs.model': 'not a model name' } })
  return out
}
