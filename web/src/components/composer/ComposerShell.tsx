// THE message box (docs/decisions/20261126-one-composer.md): every box people type a message in is drawn here — the
// AI chat's (chat/Composer.tsx: private, shared and project chats, Home), the ✦ side chat's (rooms/SideChatPanel.tsx),
// a room's, a DM's and a room thread's (rooms/RoomComposer.tsx) and an AI answer's thread (chat/ChatThreadPanel.tsx).
// A box says what it allows with props; how a box looks and acts lives here and in its parts, so no box drifts again
// (web/test/unit/composer-single.test.ts fails when a new one is written outside this folder):
// - one frame (composerBox.ts: the corner, the quiet edge, the focus edge, the drop highlight);
// - the text on top and one row under it (chat/ComposerToolbar.tsx: attach and the box's own choices on the left; the
//   box's extra end (the AI picker), the mic, then Send, Send when ready or Stop on the right), or on a phone one line
//   (attach · text · mic · send) where the box has nothing more in its row (`line`);
// - the one text field (ComposerField.tsx: font, height, Enter, Esc to stop), the one attach button (AttachMenu.tsx),
//   the one set of buttons (ComposerButtons.tsx, chat/StopButton.tsx), voice input (lib/useVoiceInput.ts, VoiceBar.tsx:
//   while recording the bar stands in the row's place and the text stays on top, so the box keeps its size);
// - above it, the key or password warning (chat/SecretWarning.tsx, every send of every box) and "no usable AI"
//   (chat/AiAccessBanner.tsx, every AI box); under it the box's note (computers) and its notices (ComposerNotices.tsx).
import clsx from 'clsx'
import { createContext, useContext, useRef, type ReactNode, type Ref, type RefObject } from 'react'
import type { VoiceInputState } from '../../lib/useVoiceInput'
import type { MicState } from '../../lib/voice'
import AiAccessBanner from '../chat/AiAccessBanner'
import { ComposerToolbar } from '../chat/ComposerToolbar'
import { composerRadius } from '../chat/composerBox'
import { SecretWarning } from '../chat/SecretWarning'
import { StopButton } from '../chat/StopButton'
import { VoiceBar, VoiceHeld, VoiceLive, VoiceMic, VoiceProgress } from '../VoiceBar'
import { ROUND_BUTTON, SendButton, type SendKind } from './ComposerButtons'
import { ComposerNotices, type ComposerNoticesProps } from './ComposerNotices'

/** the text field's most on a computer, in every box: 240 px, less in a short window (a split layout, the viewer) */
export const FIELD_MAX = 'max-h-[min(240px,35dvh)]'
/** a phone: the whole box within about 35 % of what is in sight with the keyboard up (QA TC-252); the text gets that less
 * the box's other rows (about 5rem; 6rem with the files' row), at least one line */
export const phoneFieldMax = (files = false) => (files
  ? 'max-md:max-h-[min(240px,max(2.75rem,calc(var(--app-h,100dvh)*0.35-6rem)))]'
  : 'max-md:max-h-[min(240px,max(2.75rem,calc(var(--app-h,100dvh)*0.35-5rem)))]')
/** the text's padding: on top of the row (a computer, a stacked phone box), or in a phone's one line */
export const fieldPad = (line: boolean) => (line ? 'px-1.5 py-2' : 'px-4.5 pt-3 pb-1')

/** What the field (ComposerField.tsx) takes from the box around it: the height it had (the text shown while
 * recording starts at it, so the box does not move) and how Esc stops the running answer. */
interface ShellContext {
  heldHeight: { current: number | undefined }
  stop: (() => void) | null
  line: boolean
  files: boolean
}
const Ctx = createContext<ShellContext>({ heldHeight: { current: undefined }, stop: null, line: false, files: false })
export const useShell = () => useContext(Ctx)

export interface ShellSend {
  kind?: SendKind
  can: boolean
  sending?: boolean
  onSend: () => void
  testId: string
  label?: string
}

export interface ShellStop {
  onStop: () => Promise<void>
  onError?: (e: unknown) => void
  testId?: string
}

export function ComposerShell({
  rootRef, rootAttrs, frameAttrs, testId, toolsTestId, className, frameClassName, line = false, drag = false, dropProps,
  above, aiBand = false, secret, top, field, files = false, text, hint, heldTestId, voice, mic, micDisabled = false,
  start, end, send, stop, replaceEnd, footer, footerTestId = 'composer-footer', below, notices, children,
}: {
  /** the box's root (voice input listens for Space held in it) */
  rootRef?: Ref<HTMLDivElement> | RefObject<HTMLDivElement | null>
  /** the frame's test id (composer, side-chat-box, room-composer, chat-thread-box) and its row's */
  testId: string
  toolsTestId?: string
  /** data attributes of the root and the frame (a room's data-bottom-bar, data-editing) */
  rootAttrs?: Record<string, string | undefined>
  frameAttrs?: Record<string, string | undefined>
  className?: string
  frameClassName?: string
  /** a phone's one line: attach · text · mic · send */
  line?: boolean
  drag?: boolean
  dropProps?: Record<string, unknown>
  /** above the frame (a quoted message, a room's typing line) */
  above?: ReactNode
  /** "no usable AI" with its button, above the frame (every AI box) */
  aiBand?: boolean
  /** the box's key or password hold (a box whose text reaches the AI: docs/DECISIONS.md "every box whose text reaches
   * the AI"; rooms and answer threads have none) */
  secret?: { held: boolean; onSendAnyway: () => void; onEdit: () => void }
  /** in the frame, above the text: chips, files, the lines that say why a send waits, a menu */
  top?: ReactNode
  /** the text field (ComposerField) */
  field: ReactNode
  /** the box has files on it (a phone gives the text less height) */
  files?: boolean
  /** the box's text and its empty line: what stands in the field's place while recording */
  text: string
  hint: string
  heldTestId: string
  voice?: VoiceInputState
  mic?: MicState
  micDisabled?: boolean
  /** the row's start: attach and the box's own quiet choices */
  start?: ReactNode
  /** the row's end before the mic (the AI picker) */
  end?: ReactNode
  /** send (a box without it has its own buttons: replaceEnd) */
  send?: ShellSend
  /** my answer runs: Stop (and Esc), with Send when ready beside it while there is something to send */
  stop?: ShellStop | null
  /** in place of the mic and the buttons (a phone's room edit: ✕ ✓) */
  replaceEnd?: ReactNode
  /** the quiet note under the box, on a computer ("AI can make mistakes", who sees it, why a send waits) */
  footer?: ReactNode
  footerTestId?: string
  /** under the note (a phone's own line, the thread's "also send to the room") */
  below?: ReactNode
  notices?: ComposerNoticesProps
  /** after everything (a dialog the box opens) */
  children?: ReactNode
}) {
  const heldHeight = useRef<number | undefined>(undefined)
  const stopNow = stop ? () => void stop.onStop().catch((e) => stop.onError?.(e)) : null
  const recording = !!voice?.recording
  const micButton = voice && mic && !replaceEnd && <VoiceMic voice={voice} mic={mic} disabled={micDisabled} tip />
  const buttons = replaceEnd ?? (
    <>
      {/* while my answer runs: Send when ready (or Answer) only when there is something to send, beside Stop */}
      {send && (stop || send.kind === 'later' ? send.can && <SendButton {...send} kind={send.kind === 'answer' ? 'answer' : 'later'} /> : <SendButton {...send} />)}
      {stop && <StopButton onStop={stop.onStop} onError={stop.onError} className={ROUND_BUTTON} testId={stop.testId} />}
    </>
  )
  return (
    <Ctx.Provider value={{ heldHeight, stop: stopNow, line, files }}>
      <div ref={rootRef as Ref<HTMLDivElement>} className={className} {...rootAttrs}>
        {voice && <VoiceLive voice={voice} />}
        {secret?.held && <SecretWarning onSendAnyway={secret.onSendAnyway} onEdit={secret.onEdit} />}
        {aiBand && <AiAccessBanner />}
        {above}
        {/* The one field that is focused most of the time: a quiet edge, as in Claude, not the 2px accent edge of
            other fields. At rest --c-field-border (3:1); focused a darker 1px edge (--c-faint) and the caret. */}
        <div
          className={clsx('relative', composerRadius, 'border bg-surface shadow-[var(--c-shadow)] transition', drag ? 'border-accent ring-2 ring-accent/30' : 'border-field-border focus-within:border-faint', frameClassName)}
          {...dropProps}
          {...frameAttrs}
          data-testid={testId}
        >
          {top}
          {recording && voice ? (
            line ? (
              // as tall as the line (one slot and its padding), ✕ and ✓ where attach and send were; once a live
              // recording put words in, the text shows above it
              <>
                {voice.heard && <VoiceHeld text={text} className={clsx(FIELD_MAX, phoneFieldMax(files), 'px-4 pt-2.5 text-ink')} testId={heldTestId} />}
                <VoiceBar voice={voice} className="box-content min-h-composer-line py-1.5 pr-3 pl-2" />
              </>
            ) : (
              // the text on top (it cannot be typed in while recording), growing with a live recording's words as the
              // field does; the bar in the row's place (as tall as ComposerToolbar), ✕ and ✓ where attach and send were
              <>
                <VoiceHeld text={text || hint} style={{ minHeight: heldHeight.current }} className={clsx(FIELD_MAX, phoneFieldMax(files), fieldPad(false), text ? 'text-ink' : 'text-faint')} testId={heldTestId} />
                <VoiceBar voice={voice} className="box-content min-h-9 px-3 pt-1 pb-2.5" />
              </>
            )
          ) : (
            <>
              {voice && <VoiceProgress voice={voice} text={text} className="px-4.5 pt-2.5 max-md:px-4" />}
              {line ? (
                // bottom-aligned; each control centred in a slot as tall as one text line's box (index.css
                // --spacing-composer-line): one line, one centre; more lines, the buttons stay on the last
                <div className="flex items-end gap-1 py-1.5 pr-3 pl-2">
                  {start && <div className="flex h-composer-line shrink-0 items-center">{start}</div>}
                  {field}
                  <div className="flex h-composer-line shrink-0 items-center gap-1">{micButton}{buttons}</div>
                </div>
              ) : (
                <>
                  {field}
                  <ComposerToolbar testId={toolsTestId} start={start} end={<>{end}{micButton}{buttons}</>} />
                </>
              )}
            </>
          )}
        </div>
        {footer && (
          <p className="px-1 pt-1.5 text-center text-micro break-keep text-faint max-md:hidden" data-testid={footerTestId}>{footer}</p>
        )}
        {below}
        {notices && <ComposerNotices {...notices} voice={notices.voice ?? voice} />}
        {children}
      </div>
    </Ctx.Provider>
  )
}
