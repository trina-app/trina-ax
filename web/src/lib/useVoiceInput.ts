// Voice input for a message box (the AI chat's Composer, a room's and a thread's RoomComposer): the microphone
// (lib/recorder.ts), the upload (kind 'transcribe', with the chat when there is one) and its job, and the moves of
// lib/voiceInput.ts: hold Space in the box, click the mic, or press and hold it with a finger. The words go to the end
// of the box and are never sent by themselves. While the job runs, its own label shows (the first recording on a
// server that still downloads its speech model says so, with how far it is), else "받아쓰는 중…".
// The host renders components/VoiceBar.tsx (the bar, the mic, the live region) with what this returns and calls
// onKeyDown from the box's own key handler after its "/", "#" or "@" list had its turn.
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { SMALL_UPLOAD_MAX, type TranscribeResult } from '@mycel/shared/api'
import { api, API, errorText } from './api'
import { markBusy } from './busy'
import { RecorderError, useRecorder } from './recorder'
import type { TextEdit } from './textTokens'
import { uploadFile } from './upload'
import { CAP_MS, jobLabel, VoiceInput, WARN_MS, type VoiceNote } from './voiceInput'
import { useLocale, useT } from '../i18n'
import { useJobs, waitForJob } from '../store/jobs'

/** this browser has held Space to talk once: the hint in a clicked recording stops */
export const HOLD_USED_KEY = 'mycel.voice.holdUsed'
/** a computer: a mouse or trackpad that hovers (never a touch screen, where a long Space moves the caret) */
export const HOLD_QUERY = '(hover: hover) and (pointer: fine)'

export interface VoiceInputOptions {
  input: RefObject<HTMLTextAreaElement | null>
  /** the box's text now */
  text: string
  /** set the box's text: an edit the browser's own editing could not make */
  replace: (next: string, edit: TextEdit) => void
  /** the words heard, for the end of the box */
  append: (said: string) => void
  /** the chat the recording is for (a room's names none: the server then answers as for a new chat) */
  chatId?: string | null
  /** this place takes no voice input (lib/voice.ts voiceBlockedHere, voiceBlockedInRoom): the note instead */
  blocked: boolean
  /** the mic shows and may be used now */
  enabled: boolean
  /** a "/", "#" or "@" list is open (Space is for it) */
  menuOpen: boolean
  onError: (message: string | null) => void
}

const storage = () => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
const holdUsedBefore = () => {
  try {
    return storage()?.getItem(HOLD_USED_KEY) === '1'
  } catch {
    return false
  }
}

function useMatch(query: string) {
  const get = () => {
    try {
      return typeof window !== 'undefined' && !!window.matchMedia?.(query).matches
    } catch {
      return false
    }
  }
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    const mq = typeof window === 'undefined' ? null : window.matchMedia?.(query)
    if (!mq) return
    const on = () => setMatches(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [query])
  return matches
}

/** a key aimed at a control of the page, where Space does that control's thing */
const onControl = (t: EventTarget | null) => {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null
  return !!el && (el.isContentEditable === true || ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A', 'SUMMARY'].includes(el.tagName ?? ''))
}

export function useVoiceInput(o: VoiceInputOptions) {
  const t = useT()
  const locale = useLocale()
  const recorder = useRecorder()
  const [, render] = useReducer((n: number) => n + 1, 0)
  const opts = useRef(o)
  opts.current = o
  const rec = useRef(recorder)
  rec.current = recorder
  const words = useRef({ t, locale })
  words.current = { t, locale }
  const permission = useRef<PermissionState | null>(null)
  const focusWanted = useRef<{ at: number | null } | null>(null)
  const [holdUsed, setHoldUsed] = useState(holdUsedBefore)
  const [jobId, setJobId] = useState<string | null>(null)
  const holdCapable = useMatch(HOLD_QUERY)

  const noteText = (n: VoiceNote): string => {
    const { t, locale } = words.current
    if (n.kind === 'blocked') return t('voice.confidential')
    if (n.kind === 'empty') return t('voice.empty')
    if (n.error instanceof RecorderError) return t(n.error.code === 'denied' ? 'voice.denied' : 'voice.unsupported')
    return errorText(n.error, locale, t('error.network'))
  }

  const [voice] = useState(
    () =>
      new VoiceInput({
        start: () => rec.current.start(),
        stop: () => rec.current.stop(),
        cancel: () => rec.current.cancel(),
        transcribe: async (file, signal) => {
          const { t } = words.current
          if (file.size > SMALL_UPLOAD_MAX) throw new Error(t('voice.tooLong'))
          const chatId = opts.current.chatId
          const r = await uploadFile(file, { kind: 'transcribe', name: file.name, ...(chatId ? { chatId } : {}) }, { client: api, signal })
          if (r.kind !== 'transcribe') throw new Error('unexpected upload result')
          setJobId(r.jobId)
          try {
            const job = await waitForJob(r.jobId, { signal })
            if (job.status !== 'done' || !job.result) throw new Error(job.error?.message ?? t('voice.failed'))
            return (job.result as TranscribeResult).text ?? ''
          } catch (e) {
            // Esc while the job runs: the server stops it too
            if (signal.aborted) void api.call(API.cancelJob, { params: { id: r.jobId } }).catch(() => {})
            throw e
          } finally {
            setJobId(null)
          }
        },
        append: (said) => opts.current.append(said),
        typeSpace: () => {
          const el = opts.current.input.current
          try {
            // the browser's own typing: at the caret, with undo, through the box's input events
            if (el && document.activeElement === el && document.execCommand('insertText', false, ' ')) return
          } catch { /* no execCommand: below */ }
          if (!opts.current.text) opts.current.replace(' ', { from: 0, removed: 0, inserted: 1 })
        },
        removeSpace: (at) => {
          const el = opts.current.input.current
          if (!el || el.value[at] !== ' ') return
          const next = el.value.slice(0, at) + el.value.slice(at + 1)
          try {
            if (document.activeElement === el) {
              el.setSelectionRange(at, at + 1)
              if (document.execCommand('delete', false) && el.value === next) return
            }
          } catch { /* below */ }
          if (el.value !== next) opts.current.replace(next, { from: at, removed: 1, inserted: 0 })
        },
        focusBox: (at) => {
          focusWanted.current = { at }
        },
        note: (n) => opts.current.onError(n ? noteText(n) : null),
        blocked: () => opts.current.blocked,
        granted: () => permission.current === 'granted',
        holdUsed: () => {
          try {
            storage()?.setItem(HOLD_USED_KEY, '1')
          } catch { /* storage blocked: the hint shows again next time */ }
          setHoldUsed(true)
        },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        changed: render,
      }),
  )

  // whether the browser would ask for the microphone (a Space let go during that question keeps it recording)
  useEffect(() => {
    let live = true
    let status: PermissionStatus | null = null
    const read = () => {
      permission.current = status?.state ?? null
    }
    try {
      navigator.permissions
        ?.query({ name: 'microphone' as PermissionName })
        .then((s) => {
          if (!live) return
          status = s
          read()
          s.addEventListener?.('change', read)
        })
        .catch(() => {})
    } catch { /* no Permissions API: it may ask */ }
    return () => {
      live = false
      status?.removeEventListener?.('change', read)
    }
  }, [])

  // the keys while Space waits, while recording (the bar stands where the box was) and while transcribing; a hold
  // never stays on when the window loses the focus or the tab is hidden
  useEffect(() => {
    const down = (e: KeyboardEvent) => voice.windowKeyDown(e, onControl(e.target))
    const up = (e: KeyboardEvent) => voice.windowKeyUp(e)
    const away = () => voice.away()
    const hidden = () => document.visibilityState === 'hidden' && voice.away()
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', away)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', away)
      document.removeEventListener('visibilitychange', hidden)
      voice.dispose()
    }
  }, [voice])

  const phase = voice.phase
  // a recording, or its words on their way, is only in this tab: no reload by itself, and a question before leaving
  useEffect(() => (phase === 'transcribing' ? markBusy('recording') : undefined), [phase])
  useEffect(() => {
    if (phase !== 'recording') return
    const release = markBusy('recording')
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => {
      release()
      window.removeEventListener('beforeunload', h)
    }
  }, [phase])

  // the focus goes back to the box once it is shown again
  useLayoutEffect(() => {
    const want = focusWanted.current
    const el = o.input.current
    if (!want || !el) return
    focusWanted.current = null
    el.focus()
    const at = want.at === null ? el.value.length : Math.min(want.at, el.value.length)
    el.setSelectionRange(at, at)
  })

  const job = useJobs((s) => (jobId ? s.jobs[jobId] : undefined))
  /** the job's own words while it runs (a model download, a conversion), with how far it is */
  const progressText = phase === 'transcribing' ? jobLabel(job) : null
  const leftMs = CAP_MS - recorder.seconds * 1000
  const hint =
    phase !== 'recording'
      ? null
      : voice.mode === 'hold'
        ? t(voice.via === 'touch' ? 'voice.holdTouch' : 'voice.holdSpace')
        : voice.via === 'click' && holdCapable && !holdUsed
          ? t('voice.tryHold')
          : null

  return {
    phase,
    mode: voice.mode,
    via: voice.via,
    recording: phase === 'recording',
    transcribing: phase === 'transcribing',
    /** recording or its words on their way: the box is read-only, nothing is sent */
    busy: voice.busy,
    level: recorder.level,
    seconds: recorder.seconds,
    /** seconds left before the cap, in its last WARN_MS */
    left: phase === 'recording' && leftMs <= WARN_MS ? Math.max(0, Math.ceil(leftMs / 1000)) : null,
    hint,
    holdCapable,
    /** the live region's words */
    live: voice.live === 'recording' ? t('voice.recording') : voice.live === 'transcribing' ? t('voice.liveTranscribing') : voice.live === 'inserted' ? t('voice.liveInserted') : '',
    progressText,
    /** the box's placeholder while transcribing */
    transcribingText: progressText ?? t('voice.transcribing'),
    /** from the box's key handler, after its lists: true when the key was taken */
    onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
      const el = e.currentTarget
      return voice.boxKeyDown(
        { key: e.key, repeat: e.repeat, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, preventDefault: () => e.preventDefault() },
        { value: el.value, selectionStart: el.selectionStart ?? el.value.length, selectionEnd: el.selectionEnd ?? el.value.length },
        { hold: holdCapable && opts.current.enabled && !el.readOnly, menuOpen: opts.current.menuOpen },
      )
    },
    /** the mic button's handlers: a click toggles; a finger pressed and held talks */
    mic: {
      onClick: () => {
        if (opts.current.enabled) voice.click()
      },
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if (e.pointerType !== 'touch' || !opts.current.enabled) return
        const el = e.currentTarget
        const id = e.pointerId
        if (!voice.pressStart(e.clientX, e.clientY)) return
        // the mic gives way to the bar while the finger is down: its events then reach the window, or (WebKit) only
        // the mic itself; one event reaches both, so each is read once
        let last: Event | null = null
        const targets: EventTarget[] = [el, window]
        const move = (ev: Event) => {
          const p = ev as PointerEvent
          if (p.pointerId !== id || ev === last) return
          last = ev
          voice.pressMove(p.clientX, p.clientY)
        }
        const end = (ev: Event) => {
          const p = ev as PointerEvent
          if (p.pointerId !== id || ev === last) return
          last = ev
          for (const x of targets) {
            x.removeEventListener('pointermove', move)
            x.removeEventListener('pointerup', end)
            x.removeEventListener('pointercancel', end)
          }
          voice.pressEnd()
          // the click the browser makes of the tap must not reach the bar's ✕ or ✓ under the finger, or the mic
          const swallow = (c: Event) => {
            c.preventDefault()
            c.stopPropagation()
          }
          window.addEventListener('click', swallow, true)
          setTimeout(() => window.removeEventListener('click', swallow, true), 600)
        }
        for (const x of targets) {
          x.addEventListener('pointermove', move)
          x.addEventListener('pointerup', end)
          x.addEventListener('pointercancel', end)
        }
      },
      // a long press opens no menu and selects nothing
      onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
    },
    finish: () => void voice.finish(),
    cancel: () => voice.cancel(),
  }
}

export type VoiceInputState = ReturnType<typeof useVoiceInput>
