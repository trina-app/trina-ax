// Whether the composer shows the mic (docs/DECISIONS.md "Voice input through OpenRouter"): voice input is off until an
// admin picks OpenRouter (with a key) or this server in Admin > Team settings. The server says so in
// Me.team.voiceInput; an older server leaves it out, which means on (it always had whisper.cpp).
import type { Me } from '@mycel/shared/api'

export type MicState = 'on' | 'adminHint' | 'hidden'
/** where the admin hint leads */
export const SPEECH_SETTINGS_PATH = '/admin/settings#speech'

export function micState(me: Pick<Me, 'team'> & { user: Pick<Me['user'], 'role'> } | null | undefined): MicState {
  if (!me || me.team.voiceInput !== false) return 'on'
  return me.user.role === 'owner' || me.user.role === 'admin' ? 'adminHint' : 'hidden'
}
