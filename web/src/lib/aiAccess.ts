// The way out of "no AI" (chat error and the banner above the composer): which button fits the person.
// The server decides who is who (GET /api/me/ai-access, credentials/access.ts aiAccessFor); this only maps it to a button.
import type { AiAccessResponse, ChatErrorReason } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

export type AiAction = AiAccessResponse['action']
/** connect: the simple "AI 연결" dialog in place (components/onboarding/ConnectAi.tsx), the team's or one's own */
export type AiButton =
  | { kind: 'connect'; personal: boolean; label: MessageKey }
  | { kind: 'ask'; label: MessageKey; done: boolean }

export function aiButton(action: AiAction, requested: boolean): AiButton {
  switch (action) {
    case 'connect_team': return { kind: 'connect', personal: false, label: 'aiAccess.connectTeam' }
    case 'connect_own': return { kind: 'connect', personal: true, label: 'aiAccess.connectOwn' }
    case 'ask_owner': return { kind: 'ask', label: requested ? 'aiAccess.asked' : 'aiAccess.askOwner', done: requested }
  }
}

/** the sentence above the composer */
export function bannerText(action: AiAction, requested: boolean): MessageKey {
  return action === 'connect_team' ? 'aiAccess.banner.connectTeam' : action === 'connect_own' ? 'aiAccess.banner.connectOwn' : requested ? 'aiAccess.banner.asked' : 'aiAccess.banner.askOwner'
}

/** the first line above the composer when the hosting service's trial AI credit is used up or over */
export const trialLine = (trial: 'used' | 'ended'): MessageKey => trial === 'used' ? 'aiAccess.banner.trialUsed' : 'aiAccess.banner.trialEnded'

/** A failed answer's words for "no AI", by who reads it: the owner, who can connect, hears that (with "AI 연결하기"
 * beside it); an admin, who cannot add the team's connections (owner-reauth), is told to tell the owner; null: the
 * server's words for a member ("관리자에게 알려 주세요"), or an error that is not about AI access. */
export function noAiErrorKey(reason: ChatErrorReason | null, role: 'owner' | 'admin' | 'member' | undefined): MessageKey | null {
  if (!reason || !isNoAiReason(reason)) return null
  if (role === 'owner') return `aiConnect.error.${reason as 'no_credential' | 'credential_unusable' | 'trial_credit_used' | 'trial_ended'}`
  if (role === 'admin' && (reason === 'no_credential' || reason === 'credential_unusable')) return `aiConnect.error.admin.${reason}`
  return null
}

/** the chat errors that get the button: no AI connection, none usable, and the trial AI credit used up or over (stream
 * B: the same way out, the error text already says the credit is gone) */
export const isNoAiReason = (r: ChatErrorReason | null) =>
  r === 'no_credential' || r === 'credential_unusable' || r === 'trial_credit_used' || r === 'trial_ended'
