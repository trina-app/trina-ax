// Status messages (docs/DECISIONS.md "상태 메시지"): an emoji after a person's name, with its words ("In a meeting ·
// until 3:30 PM") on hover, and on a tap where the emoji is a button of its own (a message's author line, the member
// list); the DM's one quiet line above the box; and "Set your status", one dialog (a bottom sheet on phones) opened from
// the account menu, my own status in the sidebar and the phone's drawer row.
//
// Every status is text only: React writes it as text, never as markup. Who sees it is the server's (the directory).
import clsx from 'clsx'
import { Smile, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { addDays, isStatusEmoji, STATUS_DAYS_AHEAD, STATUS_TEXT_MAX, statusTextOk } from '@mycel/shared'
import type { MyStatus, SetStatusBody, StatusMessage } from '@mycel/shared/api'
import { api, API, errorText } from '../lib/api'
import { CLEAR_CHOICES, CLEAR_LABEL, dayIn, formatDay, STATUS_EMOJI, SUGGESTIONS, untilWords, type ClearChoice } from '../lib/statusMessage'
import { useLocale, useT } from '../i18n'
import { useMe, useMeStrict } from '../store/session'
import { applyMyStatus, useStatusOf } from '../store/statusMessages'
import { toast } from '../store/ui'
import { EmojiPicker } from './EmojiPicker'
import { placeTip, Tooltip } from './Tooltip'
import { Button, Field, IconButton, inputCls, Modal } from './ui'

/** A status in words: "In a meeting · until 3:30 PM"; an emoji alone: "Until 3:30 PM", or the emoji. */
export function useStatusWords(): (s: StatusMessage) => string {
  const t = useT()
  const locale = useLocale()
  const tz = useMe()?.server?.timeZone
  return (s) => {
    const when = untilWords(s, locale, t, tz)
    if (!s.text) return when ? t('status.untilCap', { when }) : s.emoji
    return when ? `${s.text} · ${t('status.until', { when })}` : s.text
  }
}

/**
 * The emoji after a person's name, when they have a status now. Decorative for screen readers, which hear the words
 * after the name instead (", status: …"). `tap`: a button of its own (not inside a link or a button) that shows the
 * words on a tap too, for touch screens.
 */
export function StatusEmoji({ userId, tap = false, className }: { userId: string | null | undefined; tap?: boolean; className?: string }) {
  const t = useT()
  const s = useStatusOf(userId)
  const words = useStatusWords()
  if (!s) return null
  const label = words(s)
  if (tap) return <TapTip label={label} emoji={s.emoji} className={className} />
  return (
    <>
      {/* title="": the row's own title (a long name in full) is not shown over the emoji's words too */}
      <Tooltip label={label}>
        <span aria-hidden title="" className={clsx('inline-block shrink-0 leading-none', className)} data-testid="status-emoji" data-emoji={s.emoji}>
          {s.emoji}
        </span>
      </Tooltip>
      <span className="sr-only">{`, ${t('status.sr', { text: label })}`}</span>
    </>
  )
}

/** The emoji as a button: the words on hover (a mouse) and on a tap or a click, in the tooltip's look. */
function TapTip({ label, emoji, className }: { label: string; emoji: string; className?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (!open || !button.current || !tip.current) return
    setPos(placeTip(button.current.getBoundingClientRect(), tip.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }))
  }, [open, label])
  useEffect(() => {
    if (!open) return
    const away = (e: Event) => { if (!button.current?.contains(e.target as Node)) setOpen(false) }
    // Esc closes the words only, not the dialog the emoji is in (the member list)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    const hide = () => setOpen(false)
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('scroll', hide, true)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('scroll', hide, true)
    }
  }, [open])
  return (
    <>
      <Tooltip label={label} disabled={open}>
        <button
          ref={button}
          type="button"
          aria-label={t('status.sr', { text: label })}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={clsx('touch-hit inline-flex shrink-0 items-center rounded leading-none', className)}
          data-testid="status-emoji"
          data-emoji={emoji}
        >
          <span aria-hidden>{emoji}</span>
        </button>
      </Tooltip>
      {open && typeof document !== 'undefined' &&
        createPortal(
          <div ref={tip} role="status" className={clsx('pointer-events-none fixed z-[200] max-w-64 rounded-md bg-ink px-2 py-1 text-xs leading-snug font-medium break-words break-keep text-surface shadow-md', !pos && 'opacity-0')} style={pos ?? { top: 0, left: 0 }} data-testid="status-tip">
            {label}
          </div>,
          document.body,
        )}
    </>
  )
}

/** A DM with someone who has a status: one quiet line above the box ("🏖️ Minji: On leave · until Nov 14"). */
export function StatusDmLine({ userId, name }: { userId: string | null; name: string }) {
  const t = useT()
  const locale = useLocale()
  const tz = useMe()?.server?.timeZone
  const s = useStatusOf(userId)
  if (!s || !userId) return null
  const when = untilWords(s, locale, t, tz)
  const words = s.text ? t('status.dmLine', { name, text: s.text }) : t('status.dmLineName', { name })
  return (
    <p className="mx-auto flex max-w-[780px] min-w-0 items-baseline gap-1.5 px-1 pb-1.5 text-xs text-muted max-sm:px-3 max-sm:pt-1 max-sm:pb-0.5" data-testid="room-status-line">
      <span aria-hidden className="shrink-0">{s.emoji}</span>
      <span className="truncate">{when ? `${words} · ${t('status.until', { when })}` : words}</span>
    </p>
  )
}

// ---------------- the dialog ----------------
const useDialog = create<{ open: boolean; returnTo: HTMLElement | null }>(() => ({ open: false, returnTo: null }))
/** Open "Set your status"; focus goes back to `from` (or what had it) when it closes. */
export function openStatusDialog(from?: HTMLElement | null) {
  useDialog.setState({ open: true, returnTo: from ?? (document.activeElement as HTMLElement | null) })
}

/** Where the dialog lives (App.tsx, signed in): one for the whole app. */
export function StatusDialogHost() {
  const { open, returnTo } = useDialog()
  const me = useMe()
  if (!open || !me) return null
  return <StatusDialog returnTo={returnTo} onClose={() => useDialog.setState({ open: false, returnTo: null })} />
}

type Choice = ClearChoice | 'keep'

function StatusDialog({ onClose, returnTo }: { onClose: () => void; returnTo: HTMLElement | null }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const tz = me.server?.timeZone
  const now = Date.now()
  const today = dayIn(now, tz)
  const last = addDays(today, STATUS_DAYS_AHEAD)
  // what I have now (also one that starts later); an ended one is no status
  const cur: MyStatus | null = me.user.statusMessage && (!me.user.statusMessage.until || Date.parse(me.user.statusMessage.until) > now) ? me.user.statusMessage : null
  const keepable = !!cur && cur.clear !== 'never' && cur.clear !== 'dates'
  const [emoji, setEmoji] = useState(cur?.emoji ?? '')
  const [text, setText] = useState(cur?.text ?? '')
  const [clear, setClear] = useState<Choice>(cur ? (cur.clear === 'never' || cur.clear === 'dates' ? cur.clear : 'keep') : 'today')
  const [from, setFrom] = useState(cur?.fromDay ?? today)
  const [to, setTo] = useState(cur?.clear === 'dates' && cur.untilDay ? cur.untilDay : today)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const labelId = useId()

  const empty = !emoji && !text.trim()
  const textOk = statusTextOk(text.trim())
  const datesOk = clear !== 'dates' || (!!to && to >= (from > today ? from : today) && to <= last && (!from || from <= last))
  const canSave = !empty && textOk && datesOk && !busy

  const pick = (s: (typeof SUGGESTIONS)[number]) => {
    setEmoji(s.emoji)
    setText(t(s.text))
    setClear(s.clear)
    if (s.clear === 'dates') { setFrom(today); setTo(today) }
    input.current?.focus()
  }
  const startOver = () => {
    setEmoji('')
    setText('')
    setClear('today')
    setPicking(false)
    input.current?.focus()
  }
  const save = async () => {
    if (!canSave) return
    setBusy('save')
    const body: SetStatusBody = {
      ...(emoji && isStatusEmoji(emoji) ? { emoji } : {}),
      text: text.trim(),
      clear,
      ...(clear === 'dates' ? { from: from > today ? from : today, to } : {}),
    }
    try {
      applyMyStatus(await api.call(API.setMyStatus, { body }))
      onClose()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setBusy(null)
    }
  }
  const remove = async () => {
    setBusy('clear')
    try {
      await api.call(API.clearMyStatus)
      applyMyStatus(null)
      onClose()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setBusy(null)
    }
  }

  const chip = (on: boolean) => clsx('h-8 rounded-lg border px-2.5 text-sm max-sm:h-9', on ? 'border-accent bg-accent-soft font-medium text-ink' : 'border-line text-ink hover:bg-hover')
  const keepWords = cur && keepable ? untilWords(cur, locale, t, tz) : null
  const footer = (
    <>
      {cur && (
        <Button variant="ghost" className="mr-auto" busy={busy === 'clear'} disabled={!!busy} onClick={() => void remove()} data-testid="status-clear">
          {t('status.clear')}
        </Button>
      )}
      <Button onClick={onClose} disabled={!!busy} data-testid="status-cancel">{t('common.cancel')}</Button>
      <Button variant="primary" disabled={!canSave} busy={busy === 'save'} onClick={() => void save()} data-testid="status-save">{t('common.save')}</Button>
    </>
  )
  return (
    <Modal open onClose={onClose} title={t('status.title')} width={440} footer={footer} returnTo={returnTo}>
      <form onSubmit={(e) => { e.preventDefault(); void save() }} data-testid="status-dialog">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPicking((v) => !v)}
            aria-expanded={picking}
            aria-label={emoji ? t('status.emojiChange', { emoji }) : t('status.emoji')}
            className={clsx('flex size-9 shrink-0 items-center justify-center rounded-lg border text-lg leading-none max-sm:size-10', picking ? 'border-accent bg-accent-soft' : 'border-field-border hover:bg-hover')}
            data-testid="status-emoji-button"
          >
            {emoji ? <span aria-hidden>{emoji}</span> : <Smile size={18} className="text-faint" aria-hidden />}
          </button>
          <div className="relative min-w-0 flex-1">
            <input
              ref={input}
              data-autofocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={STATUS_TEXT_MAX}
              placeholder={t('status.placeholder')}
              aria-label={t('status.placeholder')}
              aria-invalid={!textOk || undefined}
              className={clsx(inputCls, !empty && 'pr-9')}
              data-testid="status-text"
            />
            {!empty && (
              <span className="absolute inset-y-0 right-0.5 flex items-center">
                <IconButton label={t('status.startOver')} onClick={startOver} className="size-8" data-testid="status-start-over">
                  <X size={14} />
                </IconButton>
              </span>
            )}
          </div>
        </div>
        {!textOk && <p role="alert" className="mt-1.5 text-xs text-danger">{t('status.badText')}</p>}

        {picking ? (
          // the emoji picker (EmojiPicker.tsx): the 32 status emoji first, then a search and every emoji
          <EmojiPicker
            className="mt-3"
            gridClassName="h-60"
            first={{ label: t('status.emojiGrid'), emoji: STATUS_EMOJI, testId: 'status-emoji-grid', itemTestId: 'status-emoji-pick' }}
            selected={emoji ? [emoji] : []}
            onPick={(e) => { setEmoji(e); setPicking(false); input.current?.focus() }}
            onDismiss={() => { setPicking(false); input.current?.focus() }}
          />
        ) : empty ? (
          <ul aria-label={t('status.suggestions')} className="-mx-2 mt-3" data-testid="status-suggestions">
            {SUGGESTIONS.map((s) => (
              <li key={s.text}>
                <button type="button" onClick={() => pick(s)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-hover max-sm:min-h-11" data-testid="status-suggestion">
                  <span aria-hidden className="w-6 shrink-0 text-center text-lg leading-none">{s.emoji}</span>
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-ink">{t(s.text)}</span>
                    <span className="text-muted"> — {t(CLEAR_LABEL[s.clear])}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4">
            <p id={labelId} className="mb-1.5 text-label font-medium text-ink">{t('status.clears')}</p>
            <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-1.5" data-testid="status-clears">
              {keepWords && (
                <button type="button" role="radio" aria-checked={clear === 'keep'} onClick={() => setClear('keep')} className={chip(clear === 'keep')} data-testid="status-clear-keep">
                  {t('status.untilCap', { when: keepWords })}
                </button>
              )}
              {CLEAR_CHOICES.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={clear === c} onClick={() => setClear(c)} className={chip(clear === c)} data-testid={`status-clear-${c}`}>
                  {t(CLEAR_LABEL[c])}
                </button>
              ))}
            </div>
            {clear === 'dates' && (
              <div className="mt-3 grid grid-cols-2 gap-3" data-testid="status-dates">
                <Field label={t('status.firstDay')}>
                  <input type="date" value={from} min={today} max={last} onChange={(e) => { setFrom(e.target.value); if (to && e.target.value > to) setTo(e.target.value) }} className={inputCls} data-testid="status-from" />
                </Field>
                <Field label={t('status.lastDay')}>
                  <input type="date" value={to} min={from > today ? from : today} max={last} onChange={(e) => setTo(e.target.value)} className={inputCls} data-testid="status-to" />
                </Field>
                {from > today && <p className="col-span-2 text-xs text-muted" data-testid="status-later">{t('status.later', { date: formatDay(from, locale) })}</p>}
              </div>
            )}
          </div>
        )}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  )
}

/** The phone's drawer: one row with my status (or "Set your status") that opens the dialog. */
export function MyStatusRow({ className, onOpen }: { className?: string; onOpen?: () => void }) {
  const t = useT()
  const mine = useMyStatusWords()
  return (
    <button
      type="button"
      onClick={(e) => { onOpen?.(); openStatusDialog(e.currentTarget) }}
      className={clsx('flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 text-left text-sm text-ink hover:bg-hover', className)}
      data-testid="my-status-row"
    >
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center leading-none">
        {mine ? mine.emoji : <Smile size={16} className="text-muted" />}
      </span>
      <span className="truncate">{mine ? mine.words : t('status.set')}</span>
    </button>
  )
}

/** For the account menu's item and the phone's drawer row: my status in words, one that starts later with its first
 * day ("On leave from Nov 14"), or null. */
export function useMyStatusWords(): { emoji: string; words: string } | null {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const s = useStatusOf(me?.user.id)
  const words = useStatusWords()
  const later = me?.user.statusMessage?.fromDay ? me.user.statusMessage : null
  if (s) return { emoji: s.emoji, words: words(s) }
  if (later) return { emoji: later.emoji, words: t('status.fromDay', { text: later.text || later.emoji, date: formatDay(later.fromDay!, locale) }) }
  return null
}
