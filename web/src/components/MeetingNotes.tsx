// Meeting notes on the team page (plan 20261116-1903-live-meeting-notes, desktop app only). Lean on purpose:
// - MeetingNotesEntry: one button on My files ("Take meeting notes"); the app then asks in its own dialog.
// - MeetingNotesCard: while a meeting runs (on any page), one small card: the red dot and time, Stop, the consent line
//   with "Copy a message for the call's chat", and the words as they come (folds to the first row). After the meeting:
//   saved with Open, nothing said, or a failed save with Try again. Notes the app kept from a meeting the page could not
//   save (the window closed) are offered once with Save.
// The note is written to My files › Meetings every 2 minutes and when the meeting ends (the same file, replaced), as
// plain Markdown, by whatever ended it (Stop here, the menu bar, silence, a refusal).
// Not here on purpose: a meetings list (My files › Meetings is the list), a summary, speaker names, a language picker,
// a floating window over the call, settings.
import clsx from 'clsx'
import { ChevronDown, ChevronUp, Copy, Mic, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { create } from 'zustand'
import { MEETINGS_DIR, PRODUCT, type DesktopMeetingLine, type DesktopMeetingState } from '@mycel/shared'
import type { MeetingStatus } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { desktop } from '../lib/desktop'
import { intlTag } from '../lib/format'
import { isGuestMe } from '../lib/guests'
import { meetingBridge, mergeLines, noteMarkdown, notePath } from '../lib/meetingNotes'
import { uploadFile } from '../lib/upload'
import { useLocale, useT } from '../i18n'
import { useMeStrict } from '../store/session'
import { Button, IconButton } from './ui'
import { Tooltip } from './Tooltip'

/** while listening, the note is written again this often (a crash or a lost connection loses little) */
export const MEETING_SAVE_EVERY_MS = 2 * 60_000

type Done = 'saved' | 'empty' | 'failed' | 'unsaved'
interface MeetingStore {
  state: DesktopMeetingState
  lines: DesktopMeetingLine[]
  /** the meeting the lines belong to (its start) */
  startedAt: number | null
  done: Done | null
  set(p: Partial<Omit<MeetingStore, 'set'>>): void
}
const useMeeting = create<MeetingStore>((set) => ({ state: { state: 'idle' }, lines: [], startedAt: null, done: null, set: (p) => set(p) }))

/** The team's meeting status (GET /api/meetings/status); null on an older server or before it answered. Looked at once,
 * and again every 15 s only while the first-use model downloads. */
function useMeetingStatus(enabled: boolean): MeetingStatus | null {
  const [s, setS] = useState<MeetingStatus | null>(null)
  useEffect(() => {
    if (!enabled) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const look = () => api.call(API.meetingStatus, {}).then((r) => {
      if (stop) return
      setS(r)
      if (r.state === 'getting_ready') timer = setTimeout(look, 15_000)
    }, () => { if (!stop) setS(null) })
    void look()
    return () => { stop = true; if (timer) clearTimeout(timer) }
  }, [enabled])
  return s
}

/** the words of the note in the person's language: its file name, its title (a date in the app's language), who said it */
function useNoteWords() {
  const t = useT()
  const locale = useLocale()
  return (startedAt: number) => ({
    file: t('meeting.fileName'),
    title: t('meeting.noteTitle', { date: new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(startedAt)) }),
    you: t('meeting.you'),
    others: t('meeting.others'),
  })
}

/** Writes the note (the same file each time for one meeting) and tells the app it may forget the lines. */
async function saveNote(me: string, startedAt: number, lines: DesktopMeetingLine[], w: { file: string; title: string; you: string; others: string }) {
  const md = noteMarkdown({ title: w.title, startedAt, lines, you: w.you, others: w.others })
  await uploadFile(new File([md], 'note.md', { type: 'text/markdown' }), { kind: 'path', path: notePath(me, startedAt, w.file), onExists: 'replace' }, { client: api })
  meetingBridge(desktop())?.saved(startedAt)
}

/** My files' header button, on the person's own folder only. Hidden in a browser, the store build, an older app or
 * server, for guests, and when the team has no voice input; greyed with the reason when the server cannot do it now. */
export function MeetingNotesEntry({ here }: { here: string }) {
  const t = useT()
  const me = useMeStrict()
  const m = meetingBridge(desktop())
  const ok = !!m && !isGuestMe(me) && here === `users/${me.user.id}`
  const status = useMeetingStatus(ok)
  const busy = useMeeting((s) => s.state.state !== 'idle')
  if (!ok || !status || status.state === 'off' || busy) return null
  const blocked = status.state === 'too_slow' || status.state === 'confidential'
  const preparing = status.state === 'getting_ready' && !status.failed
  const reason = preparing ? t('meeting.gettingReady', { mb: String(status.modelMb ?? '') }) : blocked ? t('meeting.unavailable') : null
  return (
    <>
      <Tooltip label={t('meeting.entry')}>
        <Button size="sm" variant="ghost" disabled={!!reason} onClick={() => { void m!.start() }} aria-label={t('meeting.entry')} aria-describedby={reason ? 'meeting-entry-why' : undefined} data-testid="meeting-entry">
          <Mic size={15} aria-hidden /> <span className="@max-2xl:hidden">{t('meeting.entry')}</span>
        </Button>
      </Tooltip>
      {/* the reason a greyed button can't say in a tooltip */}
      {reason && <span id="meeting-entry-why" className="text-xs text-muted max-md:hidden" data-testid="meeting-entry-why">{reason}</span>}
    </>
  )
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
/** a line's place in the meeting: m:ss, or h:mm:ss after an hour */
const intoMeeting = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  return h ? `${h}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : clock(ms)
}

/** The one card while a meeting runs (and its result after). Mounted once in the layout. */
export function MeetingNotesCard() {
  const t = useT()
  const navigate = useNavigate()
  const me = useMeStrict()
  const words = useNoteWords()
  const wordsRef = useRef(words)
  wordsRef.current = words
  const m = meetingBridge(desktop())
  const { state, lines, done, startedAt } = useMeeting()
  const [now, setNow] = useState(Date.now())
  const [copied, setCopied] = useState(false)
  const [folded, setFolded] = useState(false)
  const [working, setWorking] = useState(false)
  const saving = useRef<Promise<void> | null>(null)
  const card = useRef<HTMLElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const listening = state.state === 'listening'
  const meId = me.user.id

  // follow the app's meeting; offer notes it kept from a meeting no page could save
  useEffect(() => {
    if (!m) return
    /** the meeting ended (whatever ended it): every line, then the note */
    const finish = async (got: DesktopMeetingLine[]) => {
      const st = useMeeting.getState()
      const at = st.startedAt ?? st.state.startedAt ?? Date.now()
      const all = mergeLines(st.lines, got)
      st.set({ lines: all, startedAt: at })
      if (!all.length) { st.set({ done: 'empty' }); return }
      try {
        await saving.current
        await saveNote(meId, at, all, wordsRef.current(at))
        useMeeting.getState().set({ done: 'saved' })
      } catch { useMeeting.getState().set({ done: 'failed' }) }
    }
    const store = useMeeting.getState()
    void m.state().then((s) => {
      store.set({ state: s, ...(s.startedAt ? { startedAt: s.startedAt } : {}) })
      if (s.state === 'idle') void m.unsaved().then((u) => { if (u && !useMeeting.getState().done) useMeeting.getState().set({ lines: u.lines, startedAt: u.startedAt, done: 'unsaved' }) })
    })
    void m.lines().then((l) => store.set({ lines: mergeLines(useMeeting.getState().lines, l) }))
    const offL = m.onLines((l) => useMeeting.getState().set({ lines: mergeLines(useMeeting.getState().lines, l) }))
    const offS = m.onState((s) => {
      const st = useMeeting.getState()
      if (s.state === 'listening' && st.state.state === 'idle') st.set({ lines: [], done: null, startedAt: s.startedAt ?? Date.now() })
      const ended = s.state === 'idle' && st.state.state !== 'idle'
      st.set({ state: s })
      // ended here, from the menu bar, by silence or a refusal: the same save
      if (ended) void m.lines().then(finish)
    })
    return () => { offL(); offS() }
  }, [m, meId])

  // a checkpoint every 2 minutes while listening (one interval for the meeting, not one per render)
  useEffect(() => {
    if (!m || !listening) return
    const id = setInterval(() => {
      const { state: s, lines: l, startedAt: at } = useMeeting.getState()
      if (s.state !== 'listening' || !at || !l.length || saving.current) return
      saving.current = saveNote(meId, at, l, wordsRef.current(at)).catch(() => {}).finally(() => { saving.current = null })
    }, MEETING_SAVE_EVERY_MS)
    return () => clearInterval(id)
  }, [m, meId, listening])

  useEffect(() => {
    if (!listening) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [listening])
  // the newest words stay in view
  useEffect(() => { list.current?.lastElementChild?.scrollIntoView?.({ block: 'nearest' }) }, [lines.length])
  // when Stop goes away, the focus goes to what replaced it
  // (only when the focus was on the card or nowhere: the offer of unsaved notes on page load takes nothing)
  useEffect(() => {
    const a = document.activeElement
    if (done && done !== 'unsaved' && (!a || a === document.body || card.current?.contains(a))) card.current?.querySelector<HTMLButtonElement>('header button')?.focus({ preventScroll: true })
  }, [done])

  if (!m) return null
  if (state.state === 'idle' && !done) return null
  const copy = async () => {
    try { await navigator.clipboard.writeText(t('meeting.noteForCall', { app: PRODUCT.displayName })); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* no clipboard */ }
  }
  const close = () => useMeeting.getState().set({ done: null, lines: [], startedAt: null })
  const saveAgain = async () => {
    const at = startedAt
    if (!at) return
    setWorking(true)
    try { await saveNote(meId, at, lines, wordsRef.current(at)); useMeeting.getState().set({ done: 'saved' }) } catch { useMeeting.getState().set({ done: 'failed' }) } finally { setWorking(false) }
  }
  const headline = listening ? t('meeting.listening')
    : state.state === 'saving' ? t('meeting.saving')
    : done === 'saved' ? t('meeting.saved')
    : done === 'empty' ? t('meeting.empty')
    : done === 'failed' ? t('meeting.saveFailed')
    : done === 'unsaved' ? t('meeting.unsavedFound') : ''
  return (
    <section ref={card} role="region" aria-label={t('meeting.listening')} data-testid="meeting-card"
      className="fixed bottom-4 right-4 z-40 flex max-h-[min(20rem,60vh)] w-[min(22rem,calc(100vw-2rem))] flex-col rounded-xl border border-line bg-surface shadow-lg max-md:bottom-20">
      <header className="flex items-center gap-2 px-3 py-2">
        {listening && (
          <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
            <span className="absolute inline-flex h-full w-full rounded-full bg-danger opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
          </span>
        )}
        {/* one line while listening (the dot and the time say it is live); the results may wrap */}
        <span className={clsx('min-w-0 flex-1 text-sm font-medium', listening && 'truncate')} role="status" title={listening ? headline : undefined}>{headline}</span>
        {listening && <span className="shrink-0 text-sm tabular-nums text-muted" data-testid="meeting-time">{clock(now - (state.startedAt ?? now))}</span>}
        {listening && (
          <Button size="sm" variant="secondary" busy={working} onClick={async () => { setWorking(true); try { await m.stop() } finally { setWorking(false) } }} data-testid="meeting-stop">
            <Square size={13} aria-hidden /> {t('meeting.stop')}
          </Button>
        )}
        {done === 'saved' && <Button size="sm" variant="secondary" onClick={() => { close(); navigate(`/files?path=${encodeURIComponent(`users/${meId}/${MEETINGS_DIR}`)}`) }} data-testid="meeting-open">{t('meeting.open')}</Button>}
        {(done === 'failed' || done === 'unsaved') && <Button size="sm" variant="secondary" busy={working} onClick={saveAgain} data-testid="meeting-save-again">{done === 'failed' ? t('meeting.retry') : t('meeting.save')}</Button>}
        {listening && <IconButton label={folded ? t('meeting.showWords') : t('meeting.hideWords')} compact onClick={() => setFolded(!folded)}>{folded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</IconButton>}
        {/* closing the offer of unsaved notes lets the app forget them (else it comes back at every reload) */}
        {done === 'unsaved' && <Button size="sm" variant="ghost" onClick={() => { if (startedAt) m.saved(startedAt); close() }} data-testid="meeting-discard">{t('meeting.discard')}</Button>}
        {done && done !== 'unsaved' && <IconButton label={t('common.close')} compact onClick={close}><X size={16} /></IconButton>}
      </header>
      {listening && !folded && (
        <p className="border-t border-line px-3 py-2 text-xs text-muted">
          <span className="block">{t('meeting.consent')}</span>
          <button type="button" onClick={copy} className="mt-1 inline-flex items-center gap-1 text-accent-text hover:underline" data-testid="meeting-copy">
            <Copy size={12} aria-hidden /> {copied ? t('meeting.copied') : t('meeting.copyNote')}
          </button>
        </p>
      )}
      {listening && state.problem === 'no_call_sound' && (
        <p className="flex items-center gap-2 border-t border-line px-3 py-2 text-xs" role="status">
          <span className="min-w-0 flex-1">{t('meeting.noCallSound', { app: PRODUCT.displayName })}</span>
          <button type="button" className="shrink-0 text-accent-text hover:underline" onClick={() => m.openSoundSettings()}>{t('meeting.allow')}</button>
        </p>
      )}
      {!listening && (state.problem === 'silence' || state.problem === 'too_long') && <p className="border-t border-line px-3 py-2 text-xs text-muted" role="status">{state.problem === 'silence' ? t('meeting.endedSilence') : t('meeting.endedLong')}</p>}
      {!listening && state.problem === 'stopped' && state.message && <p className="border-t border-line px-3 py-2 text-xs text-danger" role="alert">{state.message}</p>}
      {listening && !folded && (
        // the words fade out under the consent line, so a line cut at the top reads as scrolled, not broken
        <ol ref={list} className="min-h-12 flex-1 space-y-2 overflow-y-auto border-t border-line px-3 pb-2 pt-3 text-sm [mask-image:linear-gradient(to_bottom,transparent,black_1rem)]" data-testid="meeting-lines">
          {!lines.length && <li className="text-muted">{t('meeting.listeningEmpty')}</li>}
          {lines.map((l) => (
            <li key={`${l.track}:${l.startMs}:${l.endMs}`} className="flex gap-2">
              {/* the time into the meeting (m:ss, h:mm:ss after an hour); the note keeps the clock time */}
              <span className="w-12 shrink-0 whitespace-nowrap pt-0.5 text-right tabular-nums text-xs text-muted">{intoMeeting(l.startMs)}</span>
              <span className="min-w-0"><span className={clsx('font-medium', l.track === 'others' && 'text-accent-text')}>{l.track === 'me' ? t('meeting.you') : t('meeting.others')}</span> {l.text}</span>
            </li>
          ))}
        </ol>
      )}
      {listening && !folded && (state.waiting ?? 0) > 4 && <p className="border-t border-line px-3 py-2 text-xs text-muted">{t('meeting.late')}</p>}
    </section>
  )
}
