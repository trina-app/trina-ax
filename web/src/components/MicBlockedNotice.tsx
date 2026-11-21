// Under a message box (the AI chat's, a room's, the side chat's) when the microphone is blocked: not an error the app
// made but a setting the person can change, so it is the calm notice (LoadError.tsx CalmNotice: neutral, never red),
// with the mic-off icon and the sentence that says where to allow it (lib/appWording.ts micDeniedKey). Inside the phone
// app the way to the phone's Settings (phone/SettingsLink.tsx) is on its own line under the words, which keep the
// notice's width; never an outlined button inside the sentence.
import { MicOff } from 'lucide-react'
import { useT } from '../i18n'
import { CalmNotice } from './LoadError'
import { SettingsLink } from './phone/SettingsLink'

export function MicBlockedNotice({ text, onOpenSettings, className, testId }: { text: string; onOpenSettings?: () => void; className?: string; testId?: string }) {
  const t = useT()
  return (
    <CalmNotice className={className} testId={testId} what="mic-blocked" icon={<MicOff size={16} />}
      title={<>{text}{onOpenSettings && <span className="mt-1.5 block"><SettingsLink under label={t('voice.openSettings')} onClick={onOpenSettings} testId="voice-open-settings" /></span>}</>} />
  )
}
