// The way out of "no AI" (chat error and the banner above the composer): which button fits the person.
// The server decides who is who (GET /api/me/ai-access, credentials/access.ts aiAccessFor); this only maps it to a button.
import type { AiAccessResponse, ChatErrorReason } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

export type AiAction = AiAccessResponse['action']
export type AiButton =
  | { kind: 'link'; to: string; label: MessageKey }
  | { kind: 'ask'; label: MessageKey; done: boolean }

export function aiButton(action: AiAction, requested: boolean): AiButton {
  switch (action) {
    case 'connect_team': return { kind: 'link', to: '/admin/credentials', label: 'aiAccess.connectTeam' }
    case 'connect_own': return { kind: 'link', to: '/settings/credentials', label: 'aiAccess.connectOwn' }
    case 'ask_owner': return { kind: 'ask', label: requested ? 'aiAccess.asked' : 'aiAccess.askOwner', done: requested }
  }
}

/** the sentence above the composer */
export function bannerText(action: AiAction, requested: boolean): MessageKey {
  return action === 'connect_team' ? 'aiAccess.banner.connectTeam' : action === 'connect_own' ? 'aiAccess.banner.connectOwn' : requested ? 'aiAccess.banner.asked' : 'aiAccess.banner.askOwner'
}

/** the first line above the composer when the hosting service's trial AI credit is used up or over */
export const trialLine = (trial: 'used' | 'ended'): MessageKey => trial === 'used' ? 'aiAccess.banner.trialUsed' : 'aiAccess.banner.trialEnded'

/** the chat errors that get the button: no AI connection, none usable, and the trial AI credit used up or over (stream
 * B: the same way out, the error text already says the credit is gone) */
export const isNoAiReason = (r: ChatErrorReason | null) =>
  r === 'no_credential' || r === 'credential_unusable' || r === 'trial_credit_used' || r === 'trial_ended'
