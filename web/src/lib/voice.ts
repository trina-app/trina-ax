// Whether the composer shows the mic (docs/DECISIONS.md "Voice input through OpenRouter"): voice input is off until an
// admin picks OpenRouter (with a key) or this server in Admin > Team settings. The server says so in
// Me.team.voiceInput; an older server leaves it out, which means on (it always had whisper.cpp). In a confidential chat a
// recording never goes to OpenRouter (voiceBlockedHere; the server is the gate). Rooms and threads take voice input too
// (lib/useVoiceInput.ts), under the same switch; a room names no chat, so it is blocked while every chat is confidential
// (voiceBlockedInRoom).
import type { Me } from '@mycel/shared/api'

export type MicState = 'on' | 'adminHint' | 'hidden'
/** where the admin hint leads */
export const SPEECH_SETTINGS_PATH = '/admin/settings#speech'

export function micState(me: Pick<Me, 'team'> & { user: Pick<Me['user'], 'role'> } | null | undefined): MicState {
  if (!me?.team || me.team.voiceInput !== false) return 'on'
  return me.user.role === 'owner' || me.user.role === 'admin' ? 'adminHint' : 'hidden'
}

/** Voice input is not used in this chat: it is confidential (Chat.confidential, or every chat while 1A is on) and the
 * team's voice input goes to an outside service (Me.team.voiceInputOutside). The composer says so instead of recording;
 * the server refuses such a recording either way (and transcribes it when the provider is this server). */
export function voiceBlockedHere(me: Pick<Me, 'team'> | null | undefined, confidential: boolean | null): boolean {
  return confidential === true && me?.team?.voiceInputOutside === true
}

/** Voice input is not used in a room or a thread: a room's recording names no chat, so the server treats it as a new
 * chat's, confidential while Safe operations 1A is on (Me.server.allChatsConfidential); with voice input going to an
 * outside service (Me.team.voiceInputOutside) the mic says so instead of recording, as in a confidential chat. */
export function voiceBlockedInRoom(me: Pick<Me, 'team' | 'server'> | null | undefined): boolean {
  return me?.server?.allChatsConfidential === true && me.team?.voiceInputOutside === true
}
