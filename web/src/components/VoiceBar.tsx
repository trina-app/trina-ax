// Voice input's pieces in a message box (lib/useVoiceInput.ts), the same in the AI chat's Composer and a room's or
// thread's RoomComposer:
// - VoiceBar: stands where the box was while recording: ✕ (cancel), the red dot, a short line (how a hold ends; once,
//   for a clicked recording on a computer, that Space can be held), the input level, the time (the time left in the
//   last 30 seconds), ✓ (the words go to the box).
// - VoiceMic: the mic (a click toggles; on touch screens a finger held on it talks), a spinner on it while
//   transcribing; for admins while voice input is off, the way to Admin › Team settings; nothing for members then.
// - VoiceLive: the polite live region (녹음 중, 텍스트로 바꾸는 중, 텍스트를 넣었어요). Always there, so a change is read.
// - VoiceProgress: the job's own label (a model download, a conversion) over a box that has text; an empty box shows it
//   as its placeholder.
// Ping and level movement only without reduced motion.
import clsx from 'clsx'
import { Check, Loader2, Mic, MicOff, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useT } from '../i18n'
import { fmtDuration } from '../lib/format'
import { navigateTo } from '../lib/nav'
import type { VoiceInputState } from '../lib/useVoiceInput'
import { SPEECH_SETTINGS_PATH, type MicState } from '../lib/voice'
import { IconButton } from './ui'

/** `className`: the bar's padding where the box has other padding (default px-3 py-3) */
export function VoiceBar({ voice, className }: { voice: VoiceInputState; className?: string }) {
  const t = useT()
  const done = useRef<HTMLButtonElement>(null)
  // a recording that ends with ✓ (started with the mic, from the keyboard too): the focus waits on ✓, not on the page
  const toggle = voice.mode === 'toggle' && voice.via !== 'touch'
  useEffect(() => {
    if (toggle) done.current?.focus({ preventScroll: true })
  }, [toggle])
  return (
    // nothing in it is selected or opens a callout under a finger held where the mic was
    <div className={clsx('flex min-w-0 items-center gap-3 select-none [-webkit-touch-callout:none]', className ?? 'px-3 py-3')} role="group" aria-label={t('voice.recording')} data-testid="voice-bar" data-mode={voice.mode ?? undefined}>
      <IconButton label={t('voice.cancel')} onClick={voice.cancel} className="touch-hit shrink-0" data-testid="voice-cancel">
        <X size={18} />
      </IconButton>
      <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full rounded-full bg-danger opacity-60 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
      </span>
      {voice.hint && (
        <span className="min-w-0 shrink text-xs leading-snug break-keep text-muted" data-testid="voice-hint">
          {voice.hint}
        </span>
      )}
      <div className="flex h-8 min-w-8 flex-1 items-center gap-[3px] overflow-hidden" aria-hidden>
        {Array.from({ length: 32 }, (_, i) => (
          <span key={i} className="w-[3px] shrink-0 rounded-full bg-ink motion-safe:transition-[height] motion-safe:duration-100" style={{ height: `${Math.max(3, voice.level * 32 * (0.4 + 0.6 * Math.abs(Math.sin((i + voice.seconds) * 1.7))))}px` }} />
        ))}
      </div>
      <span className={clsx('shrink-0 text-sm tabular-nums', voice.left !== null ? 'font-medium text-danger' : 'text-muted')} data-testid="voice-time">
        {voice.left !== null ? t('voice.left', { time: fmtDuration(voice.left) }) : fmtDuration(voice.seconds)}
      </span>
      <button ref={done} type="button" onClick={voice.finish} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink hover:bg-accent-hover sm:h-9 sm:w-9" aria-label={t('voice.done')} data-testid="voice-done">
        <Check size={18} />
      </button>
    </div>
  )
}

export function VoiceMic({ voice, mic, disabled = false, tip = false, className }: { voice: VoiceInputState; mic: MicState; disabled?: boolean; tip?: boolean; className?: string }) {
  const t = useT()
  if (mic === 'hidden') return null
  if (mic === 'adminHint')
    return (
      <IconButton tip={tip} label={t('voice.offAdmin')} onClick={() => navigateTo(SPEECH_SETTINGS_PATH)} className={clsx('text-faint max-md:hidden', className)} data-testid="voice-off-hint">
        <MicOff size={18} />
      </IconButton>
    )
  return (
    <IconButton
      tip={tip}
      // computers: how to talk without the mouse
      label={t(voice.holdCapable ? 'voice.startHold' : 'voice.start')}
      onClick={voice.mic.onClick}
      onPointerDown={voice.mic.onPointerDown}
      onContextMenu={voice.mic.onContextMenu}
      // while recording only marked: a finger held on it (a tablet keeps the mic in sight) must keep its events
      disabled={disabled || voice.transcribing || voice.busyElsewhere}
      aria-disabled={voice.recording || undefined}
      aria-busy={voice.transcribing || undefined}
      className={clsx('touch-hit touch-none select-none [-webkit-touch-callout:none] aria-disabled:opacity-40 aria-disabled:hover:bg-transparent', className)}
      data-testid="voice-button"
    >
      {voice.transcribing ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Mic size={18} aria-hidden />}
    </IconButton>
  )
}

export function VoiceLive({ voice }: { voice: VoiceInputState }) {
  return (
    <p className="sr-only" role="status" aria-live="polite" data-testid="voice-live">
      {voice.live}
    </p>
  )
}

export function VoiceProgress({ voice, text, className }: { voice: VoiceInputState; text: string; className?: string }) {
  if (!voice.progressText || !text.trim()) return null
  return (
    <p className={clsx('flex items-center gap-1.5 text-xs text-muted', className)} data-testid="voice-progress">
      <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden />
      <span className="min-w-0 truncate">{voice.progressText}</span>
    </p>
  )
}
