// Meeting notes on the team page (plan 20261116-1903-live-meeting-notes, desktop app only). Lean on purpose:
// - MeetingNotesEntry: one button on My files ("Take meeting notes"); the app then asks in its own dialog.
// - MeetingNotesCard: while a meeting runs (on any page), one card: the red dot and time, Stop, the consent line with
//   "Copy a message for the call's chat", and the words as they come ("You" / "Others"). After Stop: saved, with Open.
// The note is written to My files › Meetings every 2 minutes and at Stop (the same file, replaced), as plain Markdown.
// Not here on purpose: a meetings list (My files › Meetings is the list), a summary, speaker names, a language picker,
// a floating window over the call, settings.
import clsx from 'clsx'
import { Copy, Mic, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { create } from 'zustand'
import { MEETINGS_DIR, PRODUCT, type DesktopMeetingLine, type DesktopMeetingState } from '@mycel/shared'
import type { MeetingStatus } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { desktop } from '../lib/desktop'
import { isGuestMe } from '../lib/guests'
import { lineClock, meetingBridge, mergeLines, noteMarkdown, notePath } from '../lib/meetingNotes'
import { uploadFile } from '../lib/upload'
import { useT } from '../i18n'
import { useMeStrict } from '../store/session'
import { Button, IconButton } from './ui'
import { Tooltip } from './Tooltip'

/** while listening, the note is written again this often (a crash or a lost connection loses little) */
export const MEETING_SAVE_EVERY_MS = 2 * 60_000

interface MeetingStore {
  state: DesktopMeetingState
  lines: DesktopMeetingLine[]
  /** the last meeting's end: saved (its folder), nothing said, or the save failed */
  done: 'saved' | 'empty' | 'failed' | null
  set(p: Partial<Omit<MeetingStore, 'set'>>): void
}
const useMeeting = create<MeetingStore>((set) => ({ state: { state: 'idle' }, lines: [], done: null, set: (p) => set(p) }))

/** The team's meeting status (GET /api/meetings/status); null on an older server or before it answered. */
function useMeetingStatus(enabled: boolean): MeetingStatus | null {
  const [s, setS] = useState<MeetingStatus | null>(null)
  useEffect(() => {
    if (!enabled) return
    let stop = false
    const look = () => api.call(API.meetingStatus, {}).then((r) => { if (!stop) setS(r) }, () => { if (!stop) setS(null) })
    void look()
    // a first-use model download: look again until it is ready
    const id = setInterval(() => { if (useMeeting.getState().state.state === 'idle') void look() }, 15_000)
    return () => { stop = true; clearInterval(id) }
  }, [enabled])
  return s
}

/** Writes the note (the same file each time). */
async function saveNote(me: string, startedAt: number, lines: DesktopMeetingLine[], words: { title: string; you: string; others: string }) {
  const md = noteMarkdown({ title: words.title, startedAt, lines, you: words.you, others: words.others })
  const file = new File([md], 'note.md', { type: 'text/markdown' })
  await uploadFile(file, { kind: 'path', path: notePath(me, startedAt, words.title), onExists: 'replace' }, { client: api })
}

/** Follows the app's meeting (state and lines) and saves the note; mounted once (MeetingNotesCard). */
function useMeetingFollow() {
  const t = useT()
  const me = useMeStrict()
  const m = meetingBridge(desktop())
  const saving = useRef<Promise<void> | null>(null)
  const words = (startedAt: number) => ({ title: t('meeting.noteTitle', { date: new Date(startedAt).toLocaleString() }), you: t('meeting.you'), others: t('meeting.others') })
  useEffect(() => {
    if (!m) return
    const store = useMeeting.getState()
    void m.state().then((s) => store.set({ state: s }))
    void m.lines().then((l) => store.set({ lines: mergeLines(useMeeting.getState().lines, l) }))
    const offL = m.onLines((l) => useMeeting.getState().set({ lines: mergeLines(useMeeting.getState().lines, l) }))
    const offS = m.onState((s) => {
      const prev = useMeeting.getState().state
      useMeeting.getState().set({ state: s, ...(s.state === 'listening' && prev.state === 'idle' ? { lines: [], done: null } : {}) })
    })
    return () => { offL(); offS() }
  }, [m])
  // a checkpoint every 2 minutes while listening
  useEffect(() => {
    if (!m) return
    const id = setInterval(() => {
      const { state, lines } = useMeeting.getState()
      if (state.state !== 'listening' || !state.startedAt || !lines.length || saving.current) return
      saving.current = saveNote(me.user.id, state.startedAt, lines, words(state.startedAt)).catch(() => {}).finally(() => { saving.current = null })
    }, MEETING_SAVE_EVERY_MS)
    return () => clearInterval(id)
  })
  /** Stop: the app gives every line once the last pieces have their words; then the note */
  return async () => {
    if (!m) return
    const startedAt = useMeeting.getState().state.startedAt ?? Date.now()
    const all = mergeLines(useMeeting.getState().lines, await m.stop())
    useMeeting.getState().set({ lines: all })
    if (!all.length) { useMeeting.getState().set({ done: 'empty' }); return }
    try {
      await saving.current
      await saveNote(me.user.id, startedAt, all, words(startedAt))
      useMeeting.getState().set({ done: 'saved' })
    } catch { useMeeting.getState().set({ done: 'failed' }) }
  }
}

/** My files' header button. Hidden in a browser, the store build, an older app or server, for guests, and when the team
 * has no voice input; greyed with the reason when the server cannot do it now. */
export function MeetingNotesEntry() {
  const t = useT()
  const me = useMeStrict()
  const m = meetingBridge(desktop())
  const ok = !!m && !isGuestMe(me)
  const status = useMeetingStatus(ok)
  const running = useMeeting((s) => s.state.state !== 'idle')
  if (!ok || !status || status.state === 'off' || running) return null
  const blocked = status.state === 'too_slow' || status.state === 'confidential'
  const label = status.state === 'getting_ready' && !status.failed ? t('meeting.gettingReady', { mb: String(status.modelMb ?? '') }) : blocked ? t('meeting.unavailable') : t('meeting.entry')
  return (
    <Tooltip label={label}>
      <Button size="sm" variant="ghost" disabled={blocked || status.state === 'getting_ready'} onClick={() => { void m!.start() }} aria-label={label} data-testid="meeting-entry">
        <Mic size={15} aria-hidden /> <span className="@max-2xl:hidden">{t('meeting.entry')}</span>
      </Button>
    </Tooltip>
  )
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The one card while a meeting runs (and its result after Stop). Mounted once in the layout. */
export function MeetingNotesCard() {
  const t = useT()
  const navigate = useNavigate()
  const me = useMeStrict()
  const stop = useMeetingFollow()
  const { state, lines, done } = useMeeting()
  const [now, setNow] = useState(Date.now())
  const [copied, setCopied] = useState(false)
  const [stopping, setStopping] = useState(false)
  const list = useRef<HTMLOListElement>(null)
  const listening = state.state === 'listening'
  useEffect(() => {
    if (!listening) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [listening])
  // the newest words stay in view
  useEffect(() => { list.current?.lastElementChild?.scrollIntoView?.({ block: 'nearest' }) }, [lines.length])
  if (!meetingBridge(desktop())) return null
  if (state.state === 'idle' && !done) return null
  const copy = async () => {
    try { await navigator.clipboard.writeText(t('meeting.noteForCall', { app: PRODUCT.displayName })); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* no clipboard */ }
  }
  const close = () => useMeeting.getState().set({ done: null, lines: [] })
  return (
    <section role="region" aria-label={t('meeting.listening')} data-testid="meeting-card"
      className="fixed bottom-4 right-4 z-40 flex max-h-[min(28rem,70vh)] w-[min(24rem,calc(100vw-2rem))] flex-col rounded-xl border border-line bg-panel shadow-lg">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        {listening && (
          <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
            <span className="absolute inline-flex h-full w-full rounded-full bg-danger opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {listening ? t('meeting.listening') : state.state === 'saving' || stopping ? t('meeting.saving') : done === 'saved' ? t('meeting.saved') : done === 'empty' ? t('meeting.empty') : done === 'failed' ? t('meeting.saveFailed') : ''}
        </span>
        {listening && <span className="shrink-0 text-sm tabular-nums text-muted" data-testid="meeting-time">{clock(now - (state.startedAt ?? now))}</span>}
        {listening && (
          <Button size="sm" variant="secondary" busy={stopping} onClick={async () => { setStopping(true); try { await stop() } finally { setStopping(false) } }} data-testid="meeting-stop">
            <Square size={13} aria-hidden /> {t('meeting.stop')}
          </Button>
        )}
        {done === 'saved' && <Button size="sm" variant="secondary" onClick={() => { close(); navigate(`/files?path=${encodeURIComponent(`users/${me.user.id}/${MEETINGS_DIR}`)}`) }} data-testid="meeting-open">{t('meeting.open')}</Button>}
        {done && <IconButton label={t('common.close')} compact onClick={close}><X size={16} /></IconButton>}
      </header>
      {listening && (
        <p className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs text-muted">
          <span className="min-w-0 flex-1">{t('meeting.consent')}</span>
          <button type="button" onClick={copy} className="inline-flex shrink-0 items-center gap-1 text-accent-text hover:underline" data-testid="meeting-copy">
            <Copy size={12} aria-hidden /> {copied ? t('meeting.copied') : t('meeting.copyNote')}
          </button>
        </p>
      )}
      {listening && state.problem === 'no_call_sound' && (
        <p className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs" role="status">
          <span className="min-w-0 flex-1">{t('meeting.noCallSound', { app: PRODUCT.displayName })}</span>
          <button type="button" className="shrink-0 text-accent-text hover:underline" onClick={() => meetingBridge(desktop())?.openSoundSettings()}>{t('meeting.allow')}</button>
        </p>
      )}
      {state.problem === 'stopped' && state.message && <p className="border-b border-line px-4 py-2 text-xs text-danger" role="alert">{state.message}</p>}
      {(listening || lines.length > 0) && (
        <ol ref={list} className="min-h-16 flex-1 space-y-2 overflow-y-auto px-4 py-3 text-sm" aria-live="off" data-testid="meeting-lines">
          {!lines.length && <li className="text-muted">{t('meeting.listeningEmpty')}</li>}
          {lines.map((l) => (
            <li key={`${l.track}:${l.startMs}`} className="flex gap-2">
              <span className="w-14 shrink-0 tabular-nums text-xs text-muted">{lineClock(state.startedAt ?? now, l.startMs)}</span>
              <span className="min-w-0"><span className={clsx('font-medium', l.track === 'others' && 'text-accent-text')}>{l.track === 'me' ? t('meeting.you') : t('meeting.others')}</span> {l.text}</span>
            </li>
          ))}
        </ol>
      )}
      {listening && (state.waiting ?? 0) > 4 && <p className="border-t border-line px-4 py-2 text-xs text-muted">{t('meeting.late')}</p>}
    </section>
  )
}

