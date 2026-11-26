// What every message box says under its frame (components/composer/ComposerShell.tsx), in one order and one look:
// the free-roam demo used up, the AI's usage limit reached (a known state: the calm notice, never red; QA TC-2491,
// TC-2895), the microphone blocked (a setting to change: MicBlockedNotice), a send that did not go for the connection
// with the text kept in the box ("보내지 못했어요 · 다시 시도"; while Trina updates it goes by itself once the server is back),
// and any other error in red. Test ids are the box's (`prefix`: composer-limit, side-chat-limit, …).
import { CirclePause, Loader2, WifiOff } from 'lucide-react'
import { useT } from '../../i18n'
import type { VoiceInputState } from '../../lib/useVoiceInput'
import { Button } from '../ui'
import { CalmNotice } from '../LoadError'
import { DemoLimitNotice } from '../demo/FreeRoam'
import { MicBlockedNotice } from '../MicBlockedNotice'

export type Unsent = false | 'connection' | 'updating'

export interface ComposerNoticesProps {
  prefix: string
  demoOut?: boolean
  /** the usage limit's words (the API's budget_exceeded) */
  limit?: string | null
  /** any other error of the box */
  error?: string | null
  unsent?: Unsent
  onRetry?: () => void
  canRetry?: boolean
  /** the box's voice input: an error that is the mic blocked shows as its notice */
  voice?: VoiceInputState
  voiceError?: string | null
}

export function ComposerNotices({ prefix, demoOut = false, limit, error, unsent = false, onRetry, canRetry = true, voice, voiceError }: ComposerNoticesProps) {
  const t = useT()
  const blocked = (e: string | null | undefined): e is string => !!e && !!voice && voice.blockedFor === e
  return (
    <>
      {demoOut && <DemoLimitNotice className="mt-2" testId={prefix === 'composer' ? undefined : `${prefix}-demo-out`} />}
      {limit && !demoOut && <CalmNotice className="mt-2" testId={`${prefix}-limit`} icon={<CirclePause size={16} />} title={limit} />}
      {[error, voiceError].map((e, i) => (e && blocked(e) ? (
        <MicBlockedNotice key={i} className="mt-2" text={e} onOpenSettings={voice!.settingsFor === e ? voice!.openSettings : undefined} testId={i ? `${prefix}-voice-error` : `${prefix}-mic-blocked`} />
      ) : e ? (
        <p key={i} role="alert" className="mt-2 px-2 text-sm text-danger" data-testid={i ? `${prefix}-voice-error` : `${prefix}-error`}>{e}</p>
      ) : null))}
      {unsent && !error && (
        <CalmNotice
          className="mt-2"
          testId={`${prefix}-unsent`}
          state={unsent}
          icon={unsent === 'updating' ? <Loader2 size={16} className="animate-spin" /> : <WifiOff size={16} />}
          title={t(unsent === 'updating' ? 'conn.updatingUnsent' : 'conn.unsent')}
          action={onRetry && <Button size="sm" variant="secondary" disabled={!canRetry} onClick={onRetry} data-testid={`${prefix}-unsent-retry`}>{t('common.retry')}</Button>}
        />
      )}
    </>
  )
}
