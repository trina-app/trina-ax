// A failed answer's words, by who reads it (docs/DECISIONS.md "Plain words in errors, cards and steps"). Everyone reads
// what happened and who to tell; the owner and admins, who can fix it, read where instead: the admin menu's own words
// (Admin › AI accounts, Admin › System › Health), so the path follows the menu when it is renamed. No engine, proxy, API
// or HTTP code in any of them; the provider's status stays in the error's params for diagnostics.
import type { ChatErrorReason } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'
import { noAiErrorKey } from './aiAccess'

type Role = 'owner' | 'admin' | 'member' | undefined
/** where the owner or an admin fixes it: the AI accounts (Admin › AI accounts, `admin.providers`), or the server's health (Admin › System ›
 * Health, the owner's page only) */
type Where = 'providers' | 'health'

const ADMIN_FIX: Partial<Record<ChatErrorReason, Where>> = {
  auth: 'providers',
  no_credential: 'providers',
  credential_unusable: 'providers',
  model_not_found: 'providers',
  endpoint_unreachable: 'providers',
  // the AI accounts page shows an engine version whose lockdown test failed (server/src/admin/engines.ts)
  lockdown: 'providers',
  trial_credit_used: 'providers',
  trial_ended: 'providers',
  proxy_down: 'health',
}

/** The admin menu's words for a place, in the language on screen: "관리자 › AI 계정". */
export function adminPath(t: (key: MessageKey) => string, where: Where): string {
  return (where === 'providers' ? [t('admin.title'), t('admin.providers')] : [t('admin.title'), t('admin.system'), t('system.health')]).join(' › ')
}

/**
 * The key of a failed answer's words and where it points: the "no AI" words with their button (aiAccess.ts
 * noAiErrorKey), else the admin's own words for the owner and admins (the health page only for the owner, who alone
 * sees it), else the words everyone reads. `where`: the place that fills {path} (adminPath), or null when the words name
 * none.
 */
export function chatErrorText(reason: ChatErrorReason, role: Role, noAi: boolean): { key: MessageKey; where: Where | null } {
  const noAiKey = noAiErrorKey(reason, role, noAi)
  if (noAiKey) return { key: noAiKey, where: reason === 'credential_unusable' ? 'providers' : null }
  // the AI cannot start (owner decision 2026-11-11): "Trina isn't ready yet" for a member with [Tell an admin], the
  // owner and admins' own words with [Connect AI] (components/chat/NotReadyButton.tsx); no menu path in either
  if (reason === 'engine_missing') return { key: role === 'owner' || role === 'admin' ? 'chat.error.admin.engine_missing' : 'chat.error.engine_missing', where: null }
  const where = ADMIN_FIX[reason]
  const fixes = where === 'health' ? role === 'owner' : role === 'owner' || role === 'admin'
  if (where && fixes) return { key: `chat.error.admin.${reason}` as MessageKey, where }
  return { key: `chat.error.${reason}`, where: null }
}
