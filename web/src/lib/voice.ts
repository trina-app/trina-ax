// Whether the composer shows the mic (docs/DECISIONS.md "Voice input through OpenRouter"): voice input is off until an
// admin picks OpenRouter (with a key) or this server in Admin > Team settings. The server says so in
// Me.team.voiceInput; an older server leaves it out, which means on (it always had whisper.cpp). In a confidential chat a
// recording never goes to OpenRouter (voiceBlockedHere; the server is the gate).
import type { Me } from '@mycel/shared/api'

export type MicState = 'on' | 'adminHint' | 'hidden'
/** where the admin hint leads */
export const SPEECH_SETTINGS_PATH = '/admin/settings#speech'

export function micState(me: Pick<Me, 'team'> & { user: Pick<Me['user'], 'role'> } | null | undefined): MicState {
  if (!me || me.team.voiceInput !== false) return 'on'
  return me.user.role === 'owner' || me.user.role === 'admin' ? 'adminHint' : 'hidden'
}

/** Voice input is not used in this chat: it is confidential (Chat.confidential, or every chat while 1A is on) and the
 * team's voice input goes to an outside service (Me.team.voiceInputOutside). The composer says so instead of recording;
 * the server refuses such a recording either way (and transcribes it when the provider is this server). */
export function voiceBlockedHere(me: Pick<Me, 'team'> | null | undefined, confidential: boolean | null): boolean {
  return confidential === true && me?.team.voiceInputOutside === true
}
