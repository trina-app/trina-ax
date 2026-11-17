// Voice input for a message box (the AI chat's Composer, a room's and a thread's RoomComposer, the ✦ side chat's box): the microphone
// (lib/recorder.ts), the upload (kind 'transcribe', with the chat when there is one) and its job, and the moves of
// lib/voiceInput.ts: hold Space in the box, click the mic, or press and hold it with a finger. The words go to the end
// of the box and are never sent by themselves. While the job runs, its own label shows (the first recording on a
// server that still downloads its speech model says so, with how far it is), else "받아쓰는 중…".
// A team whose voice input goes to OpenRouter (Me.team.voiceInputOutside) is live (lib/liveDictation.ts): pieces go to
// POST /api/transcribe/piece while recording and their words go to the end of the box as they come (`heard`: the host
// shows the box's text above the bar then); Stop waits for the last pieces; Esc puts the box back as it was.
// The host renders components/VoiceBar.tsx (the bar, the mic, the live region) with what this returns and calls
// onKeyDown from the box's own key handler after its "/", "#" or "@" list had its turn.
import { useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { ApiError, SMALL_UPLOAD_MAX, type TranscribeResult } from '@mycel/shared/api'
import type { PieceAnswer } from '@mycel/shared/speech-pieces'
import { api, API, errorText } from './api'
import { LiveDictation } from './liveDictation'
import { markBusy } from './busy'
import { RecorderError, useRecorder } from './recorder'
import type { TextEdit } from './textTokens'
import { uploadFile } from './upload'
import { recordingAsWav } from './wavRecording'
import { useSession } from '../store/session'
import { micDeniedKey } from './appWording'
import { canOpenAppSettings, mobileApp, openAppSettings } from './mobile'
import { CAP_MS, jobLabel, jobWaiting, VoiceInput, WARN_MS, type VoiceNote } from './voiceInput'
import { useLocale, useT } from '../i18n'
import { useJobs, waitForJob } from '../store/jobs'

/** this browser has held Space to talk once: the hint in a clicked recording stops */
export const HOLD_USED_KEY = 'mycel.voice.holdUsed'
/** a computer: a mouse or trackpad that hovers (never a touch screen, where a long Space moves the caret) */
export const HOLD_QUERY = '(hover: hover) and (pointer: fine)'

export interface VoiceInputOptions {
  input: RefObject<HTMLTextAreaElement | null>
  /** the whole message box (the box, its bar, its mic): Esc there cancels, and the focus comes back to the box only from
   * there or from nowhere (never away from another field the person went on typing in) */
  root: RefObject<HTMLElement | null>
  /** a room's or a thread's box: its "not here" note says it for rooms */
  room?: boolean
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
  /** the caret was put back in the box (a list that follows the caret reads it again) */
  afterFocus?: () => void
}

const storage = () => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
/** this browser has held Space once (every box on the page stops its hint at once) */
let holdUsedNow: boolean | null = null
const holdWatchers = new Set<() => void>()
const holdUsedBefore = () => {
  if (holdUsedNow === null) {
    try {
      holdUsedNow = storage()?.getItem(HOLD_USED_KEY) === '1'
    } catch {
      holdUsedNow = false
    }
  }
  return holdUsedNow
}
const watchHoldUsed = (f: () => void) => {
  holdWatchers.add(f)
  return () => void holdWatchers.delete(f)
}
const markHoldUsed = () => {
  try {
    storage()?.setItem(HOLD_USED_KEY, '1')
  } catch { /* storage blocked: the hint shows again after a reload */ }
  holdUsedNow = true
  holdWatchers.forEach((f) => f())
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

/** The one voice input that records or transcribes now: a room's box and its thread's box are on screen together, and
 * only one may use the microphone. The others' mics wait. */
let owner: VoiceInput | null = null
const ownerWatchers = new Set<() => void>()
const setOwner = (v: VoiceInput | null) => {
  if (owner === v) return
  owner = v
  ownerWatchers.forEach((f) => f())
}
const watchOwner = (f: () => void) => {
  ownerWatchers.add(f)
  return () => void ownerWatchers.delete(f)
}

/** Esc is for something else: aimed inside a menu, a list or a dialog, or while one is open anywhere (a menu opened by a
 * click: Safari and Firefox leave the focus on the page then), as Layout's own Esc asks */
const POPUP = '[role="dialog"],[role="alertdialog"],[role="menu"],[aria-haspopup][aria-expanded="true"]'
const inPopup = (t: EventTarget | null) =>
  !!(t as Element | null)?.closest?.(`${POPUP},[role="listbox"]`) || (typeof document !== 'undefined' && !!document.querySelector?.(POPUP))

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
  const holdUsed = useSyncExternalStore(watchHoldUsed, holdUsedBefore, () => true)
  const [jobId, setJobId] = useState<string | null>(null)
  /** the live recording now (null: none, or the whole file is transcribed) and the box's text before its first words
   * (taken then, not at the start: a hold of Space has just taken its typed Space back, and the box shows that by now) */
  const live = useRef<{ run: LiveDictation; before: string | null } | null>(null)
  /** abandon(): the recording goes without putting the box back (the box now shows another room's text) */
  const noRestore = useRef(false)
  /** the live recording's words went into the box */
  const [heard, setHeard] = useState(false)
  /** the "mic blocked" note while the phone app can open its Settings page (the host shows the button beside it) */
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  const holdCapable = useMatch(HOLD_QUERY)
  const self = useRef<VoiceInput | null>(null)
  /** a finger's listeners on the window, taken off when the finger lets go, the recording ends or the box goes away */
  const pressDone = useRef<(() => void) | null>(null)
  /** another box records or transcribes now */
  const elsewhere = () => owner !== null && owner !== self.current

  const noteText = (n: VoiceNote): string => {
    const { t, locale } = words.current
    if (n.kind === 'blocked') return t(opts.current.room ? 'voice.confidentialRoom' : 'voice.confidential')
    if (n.kind === 'empty') return t('voice.empty')
    // a blocked mic is allowed again in the browser's settings, or inside the phone app in the phone's Settings
    if (n.error instanceof RecorderError) return t(n.error.code === 'denied' ? micDeniedKey(mobileApp()) : 'voice.unsupported')
    return errorText(n.error, locale, t('error.network'))
  }

  /** drop the live recording; `restore`: its words go out of the box again (Esc, ✕) */
  const dropLive = (restore: boolean) => {
    const l = live.current
    live.current = null
    setHeard(false)
    if (!l) return
    l.run.cancel()
    const before = l.before
    if (!restore || noRestore.current || before === null) return
    // (always, even when the last render does not show the newest words yet: they are on their way to the box, and this
    // comes after them)
    const cur = opts.current.text
    let p = 0
    while (p < cur.length && p < before.length && cur[p] === before[p]) p++
    opts.current.replace(before, { from: p, removed: cur.length - p, inserted: before.length - p })
  }

  /** one piece to the server, its answer as the piece session reads it (a refusal's reason decides a second try) */
  const sendPiece = async (wav: Uint8Array, signal: AbortSignal): Promise<PieceAnswer> => {
    const chatId = opts.current.chatId
    try {
      const r = await api.call(API.transcribePiece, { body: { fields: chatId ? { chatId } : {}, file: new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), filename: 'piece.wav' }, signal })
      return { ok: true, lines: r.lines }
    } catch (e) {
      if (!(e instanceof ApiError) || signal.aborted) throw e
      const reason = e.body.params?.reason
      const { t, locale } = words.current
      return { ok: false, status: e.status, ...(typeof reason === 'string' ? { reason } : {}), ...(e.body.retryAfter ? { retryAfterSec: e.body.retryAfter } : {}), message: errorText(e, locale, t('error.network')) }
    }
  }

  const [voice] = useState(
    () =>
      new VoiceInput({
        start: () => {
          dropLive(false)
          const st = useSession.getState().status
          // a team whose voice input goes to OpenRouter: the words show while recording
          if (st.kind !== 'signed-in' || st.me.team?.voiceInputOutside !== true) return rec.current.start().then(() => {})
          const l: { run: LiveDictation; before: string | null } = {
            before: null,
            run: new LiveDictation({
              send: sendPiece,
              onWords: (said) => {
                if (live.current !== l) return
                if (l.before === null) l.before = opts.current.text
                opts.current.append(said)
                setHeard(true)
              },
              // free hours used up, a confidential chat, voice input turned off: the recording ends with the sentence
              onRefused: () => {
                if (live.current === l) void self.current?.finish()
              },
            }),
          }
          live.current = l
          return rec.current.start({ onSamples: (samples) => l.run.push(samples) }).then(
            (r) => {
              // the browser would not run the sound for live words (a phone that keeps it paused): the whole recording
              if (!r.live && live.current === l) dropLive(false)
            },
            (e) => {
              if (live.current === l) dropLive(false)
              throw e
            },
          )
        },
        stop: () => rec.current.stop(),
        cancel: () => {
          rec.current.cancel()
          dropLive(true)
        },
        settle: (signal) => {
          const l = live.current
          if (!l) return null
          return new Promise<boolean>((resolve, reject) => {
            const abort = () => {
              if (live.current === l) dropLive(true)
              reject(signal.reason ?? new Error('aborted'))
            }
            if (signal.aborted) return abort()
            signal.addEventListener('abort', abort, { once: true })
            l.run.finish().then(({ heard, refusal, lost }) => {
              signal.removeEventListener('abort', abort)
              if (live.current === l) {
                live.current = null
                setHeard(false)
              }
              // a piece that never got an answer: some words may be missing (those that came stay)
              if (refusal || lost) reject(new Error(refusal ?? words.current.t('error.network')))
              else resolve(heard)
            }, reject)
          })
        },
        transcribe: async (file, signal) => {
          const { t } = words.current
          // a server that decodes with macOS's own programs gets WAV (they do not open the webm browsers record)
          const st = useSession.getState().status
          if (st.kind === 'signed-in' && st.me.team?.voiceInputWav) file = await recordingAsWav(file)
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
          // (a Japanese IME types a full-width space)
          if (!el || !/^[ \u3000]$/.test(el.value[at] ?? '')) return
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
        note: (n) => {
          const text = n ? noteText(n) : null
          // the phone app can open its own page in the phone's Settings: the box shows a button beside this note
          setSettingsFor(n?.kind === 'error' && n.error instanceof RecorderError && n.error.code === 'denied' && canOpenAppSettings() ? text : null)
          opts.current.onError(text)
        },
        blocked: () => opts.current.blocked,
        canStart: () => !elsewhere(),
        granted: () => permission.current === 'granted',
        holdUsed: markHoldUsed,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        changed: () => {
          const v = self.current
          if (v?.busy) setOwner(v)
          else if (v && owner === v) setOwner(null)
          render()
        },
      }),
  )
  self.current = voice
  const busyElsewhere = useSyncExternalStore(watchOwner, elsewhere, () => false)

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
    // Esc is this box's when it is aimed at the page itself or at this box and its bar, never at a menu, a list or a
    // dialog (Esc closes those) or at another box
    const ours = (t: EventTarget | null) => {
      if (inPopup(t)) return false
      const root = opts.current.root.current
      return !t || t === document.body || t === document.documentElement || !!root?.contains(t as Node)
    }
    const down = (e: KeyboardEvent) => voice.windowKeyDown(e, { onControl: onControl(e.target), ours: ours(e.target) })
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
      dropLive(false)
      pressDone.current?.()
      if (owner === voice) setOwner(null)
    }
  }, [voice])

  const phase = voice.phase
  // a recording that ended without the finger's lift reaching us (the cap, a disabled mic under it): its listeners go
  useEffect(() => {
    if (phase !== 'starting' && phase !== 'recording') pressDone.current?.()
  }, [phase])
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

  // the focus goes back to the box once it is shown again: from the box's own parts or from nowhere, never away from a
  // field the person went on typing in while the words were on their way
  useLayoutEffect(() => {
    const want = focusWanted.current
    const el = o.input.current
    if (!want || !el) return
    focusWanted.current = null
    const active = document.activeElement
    if (active && active !== document.body && active !== el && !o.root.current?.contains(active)) return
    el.focus()
    const at = want.at === null ? el.value.length : Math.min(want.at, el.value.length)
    el.setSelectionRange(at, at)
    o.afterFocus?.()
  })

  const job = useJobs((s) => (jobId ? s.jobs[jobId] : undefined))
  /** the job's own words while it runs (a model download, a conversion), with how far it is; while it waits for its
   * turn, that it waits */
  const progressText = phase !== 'transcribing' ? null : jobWaiting(job) ? t('voice.waiting') : jobLabel(job)
  const leftMs = CAP_MS - recorder.seconds * 1000
  /** recording, and nothing was heard since it started (lib/recorder.ts), until the first sound */
  const nothingYet = phase === 'recording' && recorder.silent
  /** the bar says so where the wave was (a row of dots then), in place of the hint of a recording that ends with ✓. A
   * hold keeps its own hint, the only place that says how it ends; the live region says it for both. */
  const silent = nothingYet && voice.mode !== 'hold'
  // once said, "녹음 중" is not read out again when the first sound comes (the person is talking by then)
  const saidSilent = useRef(false)
  if (phase !== 'recording') saidSilent.current = false
  else if (nothingYet) saidSilent.current = true
  const hint =
    phase !== 'recording'
      ? null
      : silent
        ? t('voice.silent')
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
    /** a live recording put words into the box: the host shows the box's text above the bar while recording */
    heard: heard && phase === 'recording',
    level: recorder.level,
    seconds: recorder.seconds,
    /** seconds left before the cap, in its last WARN_MS */
    left: phase === 'recording' && leftMs <= WARN_MS ? Math.max(0, Math.ceil(leftMs / 1000)) : null,
    hint,
    /** the hint is the "no sound yet" line, and it stands where the wave was */
    silent,
    /** the note text that gets an "Open Settings" button (inside the phone app, a blocked mic), else null: the host
     * shows the button only while its note still says this */
    settingsFor,
    openSettings: () => void openAppSettings().catch(() => {}),
    holdCapable,
    /** another box (the room's, the thread's) records or transcribes now: this mic waits */
    busyElsewhere,
    /** the live region's words */
    live: nothingYet ? t('voice.silent') : voice.live === 'recording' ? (saidSilent.current ? '' : t('voice.recording')) : voice.live === 'transcribing' ? t('voice.liveTranscribing') : voice.live === 'inserted' ? t('voice.liveInserted') : '',
    progressText,
    /** the box's placeholder while transcribing */
    transcribingText: progressText ?? t('voice.transcribing'),
    /** from the box's key handler, after its lists: true when the key was taken */
    onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
      const el = e.currentTarget
      return voice.boxKeyDown(
        { key: e.key, repeat: e.repeat, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, preventDefault: () => e.preventDefault() },
        { value: el.value, selectionStart: el.selectionStart ?? el.value.length, selectionEnd: el.selectionEnd ?? el.value.length },
        { hold: holdCapable && opts.current.enabled && !el.readOnly && !elsewhere(), menuOpen: opts.current.menuOpen },
      )
    },
    /** the mic button's handlers: a click toggles; a finger pressed and held talks */
    mic: {
      onClick: () => {
        if (opts.current.enabled && !elsewhere()) voice.click()
      },
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if (e.pointerType !== 'touch' || !opts.current.enabled || elsewhere()) return
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
        // a long press over the bar opens no menu or selection (the browser would take the touch away)
        const noMenu = (ev: Event) => ev.preventDefault()
        const off = () => {
          for (const x of targets) {
            x.removeEventListener('pointermove', move)
            x.removeEventListener('pointerup', end)
            x.removeEventListener('pointercancel', end)
          }
          window.removeEventListener('contextmenu', noMenu, true)
          if (pressDone.current === off) pressDone.current = null
        }
        const end = (ev: Event) => {
          const p = ev as PointerEvent
          if (p.pointerId !== id || ev === last) return
          last = ev
          off()
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
        window.addEventListener('contextmenu', noMenu, true)
        pressDone.current?.()
        pressDone.current = off
      },
      // a long press opens no menu and selects nothing
      onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
    },
    finish: () => void voice.finish(),
    cancel: () => voice.cancel(),
    /** the box now belongs to another place (a room switched without a new box): the recording goes, and its words are
     * not taken out of the box that shows now */
    abandon: () => {
      noRestore.current = true
      try {
        voice.cancel()
      } finally {
        noRestore.current = false
      }
    },
  }
}

export type VoiceInputState = ReturnType<typeof useVoiceInput>
