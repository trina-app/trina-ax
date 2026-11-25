// A failed answer's words, by who reads it (docs/DECISIONS.md "Plain words in errors, cards and steps"). Everyone reads
// what happened and who to tell; the owner and admins, who can fix it, read where instead: the admin menu's own words
// (Admin › AI providers, Admin › System › Health), so the path follows the menu when it is renamed. No engine, proxy, API
// or HTTP code in any of them; the provider's status stays in the error's params for diagnostics.
import { chatErrorReason, DEMO_LIMIT_REASON, DEMO_REST_REASON, type ApiErrorBody, type ChatErrorReason } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'
import { noAiErrorKey } from './aiAccess'

type Role = 'owner' | 'admin' | 'member' | 'guest' | undefined
/** where the owner or an admin fixes it: the AI accounts (Admin › AI providers, `admin.providers`), the server's health (Admin › System ›
 * Health, the owner's page only), or the server page with its storage card (Admin › System, which admins see too) */
type Where = 'providers' | 'health' | 'system'

const ADMIN_FIX: Partial<Record<ChatErrorReason, Where>> = {
  auth: 'providers',
  no_credential: 'providers',
  credential_unusable: 'providers',
  model_not_found: 'providers',
  endpoint_unreachable: 'providers',
  // the AI accounts page shows an engine version whose lockdown test failed (server/src/admin/engines.ts)
  lockdown: 'providers',
  proxy_down: 'health',
  // the server's disk is full: the storage card shows what uses the space
  storage_full: 'system',
  // the engine firewall is not in effect on the server: the health page's firewall line says why (QA TC-310)
  network_protection_off: 'health',
}

/** The admin menu's words for a place, in the language on screen: "관리자 › AI 제공사". */
export function adminPath(t: (key: MessageKey) => string, where: Where): string {
  return (where === 'providers' ? [t('admin.title'), t('admin.providers')] : where === 'system' ? [t('admin.title'), t('admin.system')] : [t('admin.title'), t('admin.system'), t('system.health')]).join(' › ')
}

/**
 * The key of a failed answer's words and where it points: the "no AI" words with their button (aiAccess.ts
 * noAiErrorKey), else the admin's own words for the owner and admins (the health page only for the owner, who alone
 * sees it), else the words everyone reads. `where`: the place that fills {path} (adminPath), or null when the words name
 * none.
 */
export function chatErrorText(reason: ChatErrorReason, role: Role, noAi: boolean, until = false): { key: MessageKey; where: Where | null } {
  // the AI account at its provider's limit for longer than an hour: by who reads it (usageLimitText)
  if (reason === 'usage_used_up') return usageLimitText({ cause: 'provider', until: until ? 'known' : null }, role)!
  const noAiKey = noAiErrorKey(reason, role, noAi)
  if (noAiKey) return { key: noAiKey, where: reason === 'credential_unusable' ? 'providers' : null }
  // the AI cannot start (owner decision 2026-11-11): "Trina isn't ready yet" for a member with [Tell an admin], the
  // owner and admins' own words with [Connect AI] (components/chat/NotReadyButton.tsx); no menu path in either
  if (reason === 'engine_missing') return { key: role === 'owner' || role === 'admin' ? 'chat.error.admin.engine_missing' : 'chat.error.engine_missing', where: null }
  // the AI could not start on the server (QA TC-3521): the owner and admins read that a retry won't help and who fixes
  // it; no menu path, the health page does not show it
  if (reason === 'engine_start_failed' && (role === 'owner' || role === 'admin')) return { key: 'chat.error.admin.engine_start_failed', where: null }
  const where = ADMIN_FIX[reason]
  const fixes = where === 'health' ? role === 'owner' : role === 'owner' || role === 'admin'
  if (where && fixes) return { key: `chat.error.admin.${reason}` as MessageKey, where }
  return { key: `chat.error.${reason}`, where: null }
}

/**
 * Why the AI usage is used up, the one place that tells (docs/decisions/20261125-usage-limit-cause.md):
 * - `budget`: a limit an admin set (Admin › Usage: the team's, a group's or the person's own; code budget_exceeded,
 *   server/src/admin/budgets.ts budgetBlock), which an admin can raise. `until`: when its period starts again
 *   (params.resetsAt). Not a free-roam demo's limit or pause (lib/freeRoam.ts has its own words).
 * - `provider`: the AI account itself is at its provider's limit for longer than an hour (a Claude subscription used up
 *   until its reset, the model proxy's 403 subscription_limited; server/src/chat/turn.ts limitError, reason
 *   usage_used_up), which no admin can raise: it comes back by itself at `until` (params.until, when known), or another
 *   AI account goes on now.
 * null for any other answer.
 */
export type UsageLimit = { cause: 'budget' | 'provider'; until: string | null }
const when = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null)
export function usageLimitOf(error: ApiErrorBody | null | undefined): UsageLimit | null {
  if (!error) return null
  if (error.code === 'budget_exceeded') {
    const r = error.params?.reason
    return r === DEMO_LIMIT_REASON || r === DEMO_REST_REASON ? null : { cause: 'budget', until: when(error.params?.resetsAt) }
  }
  return chatErrorReason(error) === 'usage_used_up' ? { cause: 'provider', until: when(error.params?.until) } : null
}

/**
 * The words of a used-up limit by its cause and who reads it. `budget`: null, the server's own words stand (they say
 * when it starts again and to ask an admin, or a guest the person who invited them). `provider`: when it comes back
 * (when known); the owner and admins, that another AI account in Admin › AI providers goes on now; a member, to wait or
 * tell an admin; a guest, to wait or tell the person who invited them (never "ask your admin to add more": no admin can raise a provider's limit; owner report 2026-11-25).
 */
export function usageLimitText(limit: UsageLimit, role: Role): { key: MessageKey; where: Where | null } | null {
  if (limit.cause === 'budget') return null
  const until = limit.until !== null
  if (role === 'owner' || role === 'admin') return { key: until ? 'chat.error.admin.usage_used_up_until' : 'chat.error.admin.usage_used_up', where: 'providers' }
  // a guest does not know the team's admins: the person who invited them (docs/DECISIONS.md "Guests: only what they
  // were invited to")
  if (role === 'guest') return { key: until ? 'chat.error.guest.usage_used_up_until' : 'chat.error.guest.usage_used_up', where: null }
  return { key: until ? 'chat.error.usage_used_up_until' : 'chat.error.usage_used_up', where: null }
}
