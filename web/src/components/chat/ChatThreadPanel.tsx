// A thread under an AI answer of a shared chat (docs/decisions/20261116-chat-answer-threads.md), at
// /c/:chatId/t/:messageId: a room's thread (components/rooms/ThreadPanel.tsx) in the column beside the chat on
// computers (components/rooms/RoomSideColumn.tsx, resizable), the whole screen on phones (a ‹ back to the chat; the
// tabs stay away as in the chat). It is drawn with the rooms' own parts (rooms/ThreadParts.tsx, rooms/MessageRun.tsx):
// the header, the answer on top as a run of the AI's (cut after the last whole block that fits, "Show more"), the
// hairline with how many replies, and the replies in runs (one person's replies close together under one face, name
// and time; a date line for a new day), each row with the hover bar (⋮: copy, delete) or, on a touch screen, a long
// press (the shared ones: components/messages/MessageActions.tsx); the answer on top has copy the same way and its steps. What differs from a room is only what is different: the root is the AI's answer; a reply is plain words with
// their links and mentions (never Markdown or HTML) and has no reactions, edits or files; and replies are people's
// only: the AI never reads them unless someone asks, and the grey line under the box says so (there is no "send to the
// AI" button).
// What I see is marked read while the window has the focus and the end is in sight.
// "@" in the box lists the people who see the thread now (the page's `people`, docs/decisions/20261118-chat-thread-
// mentions.md) with the rooms' mention box (components/TokenTextarea.tsx, rooms/useMentionMenu.tsx; no "@everyone");
// a reply shows its mentions as the rooms do (rooms/MessageText.tsx MentionedText).
import clsx from 'clsx'
import { Loader2 } from 'lucide-react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CHAT_THREAD_REPLY_MAX, type Chat, type ChatThreadReply, type Message, type UserRef } from '@mycel/shared/api'
import { errorText, isApiError } from '../../lib/api'
import { lookingAt, onWindowFocus } from '../../lib/attention'
import { useEndAfterRecording } from '../../lib/autoGrow'
import { useConfidentialChat } from '../../lib/confidential'
import { readDraft, writeDraft } from '../../lib/localData'
import { useVoiceInput } from '../../lib/useVoiceInput'
import { micState, voiceBlockedHere } from '../../lib/voice'
import { useServerUpdating } from '../../lib/serverUpdating'
import { groupRuns, localDayKey } from '../../lib/rooms'
import { aiName } from '../../lib/tabs'
import { formatNumber } from '../../lib/format'
import { holdPlace, ROOM_ROW, useStickToBottom } from '../../lib/stickToBottom'
import { useLocale, useT } from '../../i18n'
import { reloadAsked } from '../../store/live'
import { takeReturned, takeReturnedMentions, threadKey, useChatThreads, type PendingReply } from '../../store/chatThreads'
import { toast } from '../../store/ui'
import { useNameOf } from '../../store/people'
import { useMe } from '../../store/session'
import { answerHtml, Markdown } from '../LazyMarkdown'
import { MentionedText } from '../rooms/MessageText'
import { useMentionMenu } from '../rooms/useMentionMenu'
import { MessageActions, MessageActionSheet, ROOM_PRESS_SKIP, useMessagePress, type MessageAction } from '../messages/MessageActions'
import Steps from './Steps'
import { DayLine, messageRowClass, RunFace, RunName, RunShell, sameTimeAsAbove, timeOf, WORDS } from '../rooms/MessageRun'
import { ThreadCountLine, ThreadHead } from '../rooms/ThreadParts'
import { ErrorNote, Skeleton, confirmDialog, useMediaQuery } from '../ui'
import { composerInset } from './composerBox'
import { ComposerField } from '../composer/ComposerField'
import { ComposerShell } from '../composer/ComposerShell'
import { SharedReadOnly } from './SharedChat'
import { capBlankLines } from '../../lib/blankLines'

const NO_PEOPLE: UserRef[] = []

/** a thread's kept reply (`thread:<chat id>:<answer id>`): its words and the people it mentions */
function parseKeptReply(raw: string): { text: string; mentions: string[] } | null {
  try {
    const v = JSON.parse(raw) as { text?: unknown; mentions?: unknown }
    if (typeof v.text !== 'string' || !v.text) return null
    return { text: v.text, mentions: Array.isArray(v.mentions) ? v.mentions.filter((x): x is string => typeof x === 'string') : [] }
  } catch {
    return null
  }
}
const NO_PENDING: PendingReply[] = []

/** The names a reply's mentions are looked for by: each person's name now (the directory) and as the thread's list has
 * it (a mention is the name as it was typed); mine as my account has it (I am never on the list). */
function useMentioned(ids: readonly string[] | undefined, people: UserRef[]): { id: string; name: string }[] {
  const nameOf = useNameOf()
  const me = useMe()?.user
  return useMemo(() => (ids ?? []).flatMap((id) => [...new Set([nameOf({ id, name: '' }) ?? '', people.find((p) => p.id === id)?.name ?? '', me?.id === id ? me.name : ''])].filter(Boolean).map((name) => ({ id, name }))), [ids, people, nameOf, me])
}

/** the box counts down from here (CHAT_THREAD_REPLY_MAX is 10,000) */
const COUNT_FROM = 9500

/** `onShownBranch`: the answer is on the version the chat shows (the page knows: its messages). */
export function ChatThreadPanel({ chat, rootId, meId, onClose, onShownBranch, focusBox = false }: { chat: Chat; rootId: string; meId: string; onClose: () => void; onShownBranch: boolean; focusBox?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const chatId = chat.id
  const key = threadKey(chatId, rootId)
  const view = useChatThreads((s) => s.views[key])
  const pending = useChatThreads((s) => s.pending[key])
  // replies waiting out the sending budget: one line under the box (QA TC-3887)
  const slow = useChatThreads((s) => !!s.slowUntil[key])
  const replies = view?.replies ?? []
  const root = view?.root ?? null
  const list = useStickToBottom()
  const { scroller, content, stick } = list
  const last = replies.at(-1)

  useEffect(() => {
    stick.current = true
    void useChatThreads.getState().load(chatId, rootId)
    // the server could not resume the socket: the thread is read again over REST (its access checked again)
    return reloadAsked.on(() => void useChatThreads.getState().load(chatId, rootId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, rootId])
  useLayoutEffect(() => {
    list.follow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, replies.length, pending?.length, root?.id])

  // Esc closes it, as ✕ does (not while a menu or a dialog of its own is open: they take the key first)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"][aria-modal="true"]')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tryRead = useCallback(() => {
    const el = scroller.current
    const v = useChatThreads.getState().views[key]
    if (!el || !v || v.loading || !v.root?.thread?.newReplies || !v.replies.length) return
    if (!lookingAt()) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 80) return
    void useChatThreads.getState().markRead(chatId, rootId, v.replies.at(-1)!.id)
  }, [key, chatId, rootId, scroller])
  useEffect(() => { tryRead() }, [tryRead, last?.id, root?.thread?.newReplies, view?.loading])
  useEffect(() => {
    window.addEventListener('focus', tryRead)
    document.addEventListener('visibilitychange', tryRead)
    const off = onWindowFocus(tryRead)
    return () => { window.removeEventListener('focus', tryRead); document.removeEventListener('visibilitychange', tryRead); off() }
  }, [tryRead])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    list.onScroll()
    const v = useChatThreads.getState().views[key]
    if (el.scrollTop < 200 && v?.nextCursor && !v.loading) {
      const keep = holdPlace(el, ROOM_ROW, list.reanchor)
      void useChatThreads.getState().loadOlder(chatId, rootId).finally(() => requestAnimationFrame(keep))
    }
    tryRead()
  }

  const notFound = !!view?.error && (isApiError(view.error, 'not_found') || isApiError(view.error, 'forbidden'))
  const count = root?.thread?.replyCount ?? replies.length
  // who "@" may pick: the people who see the thread now (the server sends them while I may reply)
  const people = view?.people ?? NO_PEOPLE
  const readOnly = view?.readOnlyReason
  const versionLine = !onShownBranch && view?.version ? t('chat.thread.otherVersion', { index: view.version.index, count: view.version.count }) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-thread">
      <ThreadHead where={chat.title || t('chat.untitled')} onClose={onClose} testIds="chat-thread" whereTestId="chat-thread-chat" />
      <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="chat-thread-scroller">
        <div ref={content} className="px-4 pt-3 pb-6">
          {notFound ? (
            <div className="py-12 text-center" data-testid="chat-thread-not-found">
              <p className="text-sm text-muted">{t('chat.thread.notFound')}</p>
            </div>
          ) : (
            <>
              {!root && view?.loading !== false && <Skeleton lines={4} className="pt-2" />}
              {!!view?.error && !notFound && <ErrorNote onRetry={() => void useChatThreads.getState().load(chatId, rootId)}>{errorText(view.error, locale, t('error.network'))}</ErrorNote>}
              {root && <ThreadAnswer root={root} />}
              {versionLine && <p role="note" className="mt-2 rounded-lg bg-subtle px-3 py-2 text-xs leading-5 text-muted" data-testid="chat-thread-version">{versionLine}</p>}
              {root && <ThreadCountLine count={count} testId="chat-thread-count" />}
              {view?.loading && root && !replies.length && <Loader2 size={16} className="mx-auto my-2 animate-spin text-faint" aria-label={t('common.loading')} />}
              <Replies chatId={chatId} rootId={rootId} replies={replies} pending={pending ?? NO_PENDING} meId={meId} people={people} readOnly={readOnly === 'trash' || readOnly === 'safe_ops'} dayBefore={root?.createdAt ?? null} />
            </>
          )}
        </div>
      </div>
      {!notFound && root && (
        // the box as a room thread's (RoomComposer: no hairline above it, the same inset and bottom gap)
        <div className={clsx('shrink-0 pb-[var(--box-bottom)]', composerInset)} data-testid="chat-thread-foot">
          {readOnly === 'safe_ops' ? <SharedReadOnly />
            : readOnly ? <p role="status" className="px-1 py-2 text-center text-sm text-muted" data-testid="chat-thread-read-only">{t(readOnly === 'trash' ? 'chat.thread.inTrash' : 'chat.thread.notShared')}</p>
            : view?.full ? <p role="status" className="px-1 py-2 text-center text-sm text-muted" data-testid="chat-thread-full">{t('chat.thread.full')}</p>
            : <ReplyBox chatId={chatId} rootId={rootId} people={people} meId={meId} autoFocus={focusBox || count === 0} onSent={() => { stick.current = true }} />}
          <ThreadWaitLine slow={slow} />
          <p className="px-1 pt-1.5 text-micro leading-4 text-faint" data-testid="chat-thread-people-only">{t('chat.thread.peopleOnly', { name: aiName(t) })}</p>
        </div>
      )}
    </div>
  )
}

/** The one line under the box that says why replies wait, or nothing: Trina is updating (lib/serverUpdating.ts, the
 * window's signal the chat's box also follows; the replies go by themselves once it is back, QA TC-3886), else the
 * sending budget (`slow`, QA TC-3887). One slot: the update is said first, as it is what holds everything. */
export function ThreadWaitLine({ slow }: { slow: boolean }) {
  const t = useT()
  const updating = useServerUpdating((s) => s.updating)
  if (!updating && !slow) return null
  return (
    <p role="status" className="px-1 pt-1.5 text-xs text-muted" data-testid={updating ? 'chat-thread-updating' : 'chat-thread-slow'}>
      {t(updating ? 'chat.thread.updating' : 'chat.thread.fast')}
    </p>
  )
}

/** about 12 lines of an answer: the answer on top is cut after the last whole block that ends above this */
const CLAMP_PX = 288
/** an answer at most this much longer than the cut shows whole: no "Show more" for a line or two */
const CLAMP_SLACK = 56
/** the plain text's line height (LazyMarkdown.tsx "answer" size, leading-7) while the formatting code loads */
const PLAIN_LINE_PX = 28

/** Where to cut the answer (its height in px), or null to show all of it. Only on a block's edge, never through one: after
 * the last top-level block (a paragraph, a table, a list, a code block) that ends within CLAMP_PX; when the first block is
 * already taller, after its last table row or list item that fits; failing that, the whole first block. Plain text
 * (the formatting code still loading) is cut between lines. */
export function answerCut(el: HTMLElement): number | null {
  const total = el.scrollHeight
  if (total <= CLAMP_PX + CLAMP_SLACK) return null
  const top = el.getBoundingClientRect().top
  const bottom = (x: Element) => x.getBoundingClientRect().bottom - top
  const inner = el.firstElementChild
  const blocks = inner ? [...inner.children] : []
  if (!blocks.length) return Math.floor(CLAMP_PX / PLAIN_LINE_PX) * PLAIN_LINE_PX
  let cut = 0
  for (const b of blocks) {
    const end = bottom(b)
    if (end > CLAMP_PX) break
    cut = end
  }
  if (cut === 0) {
    const first = blocks[0]!
    for (const row of first.querySelectorAll('tr, li')) {
      const end = bottom(row)
      if (end > CLAMP_PX) break
      cut = end
    }
    if (cut === 0) cut = bottom(first)
  }
  return cut >= total - 4 ? null : Math.ceil(cut)
}

/** The answer the thread is under, as a run of the AI's (its face, name and time, as a room thread's root): its steps
 * folded as the chat shows them, its text as the chat shows it, cut on a block's edge (answerCut) until "Show more".
 * Copy (with its formatting, as the chat's) on the hover bar and in the long-press sheet (components/messages). */
function ThreadAnswer({ root }: { root: Message }) {
  const text = root.content, at = root.createdAt
  const t = useT()
  const actions: MessageAction[] = text ? [{ id: 'copy', label: t('chat.copyAnswer'), copy: { text: () => text, html: () => answerHtml(text) }, menuTestId: 'chat-thread-answer-copy' }] : []
  const press = useMessagePress(actions.length > 0)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [cut, setCut] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setCut(answerCut(el))
    measure()
    // the formatting code arriving (the plain text becomes the formatted one), pictures and fonts loading: again
    if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return
    const sizes = new ResizeObserver(measure)
    const watch = () => { sizes.disconnect(); for (const c of el.children) sizes.observe(c) }
    watch()
    const swaps = new MutationObserver(() => { watch(); measure() })
    swaps.observe(el, { childList: true })
    return () => { sizes.disconnect(); swaps.disconnect() }
  }, [text])
  return (
    <div className={clsx('group', press.box)} data-testid="chat-thread-answer" {...press.bind}>
      <MessageActions layout="float" actions={actions} below />
      <MessageActionSheet signal={press.signal} actions={actions.length ? [...actions, { id: 'selectText', label: t('messages.selectText'), run: press.selectText, menuTestId: 'message-select-text' }] : []} testId="chat-thread-answer-menu" />
      <RunShell face={<RunFace user={null} ai />} name={<RunName user={null} ai />} at={at}>
        {root.steps.length > 0 && <div className="mb-2" data-testid="chat-thread-answer-steps"><Steps steps={root.steps} streaming={false} failed={root.status === 'error'} /></div>}
        <div ref={box} className={clsx('relative', !open && cut !== null && 'overflow-hidden')} style={!open && cut !== null ? { maxHeight: cut } : undefined} data-cut={!open && cut !== null ? '' : undefined}>
          <Markdown text={text} className={clsx('min-w-0', WORDS)} />
        </div>
        {cut !== null && (
          <button type="button" onClick={() => setOpen((o) => !o)} className="touch-hit mt-1 text-xs font-medium text-accent-text hover:underline" aria-expanded={open} data-testid="chat-thread-more">
            {open ? t('chat.thread.showLess') : t('chat.thread.showMore')}
          </button>
        )}
      </RunShell>
    </div>
  )
}

/** The replies in runs (lib/rooms.ts groupRuns, as a room thread's), a date line for a new day (none for the answer's
 * own day), then mine on their way under them. */
function Replies({ chatId, rootId, replies, pending, meId, people, readOnly, dayBefore }: { chatId: string; rootId: string; replies: ChatThreadReply[]; pending: PendingReply[]; meId: string; people: UserRef[]; readOnly: boolean; dayBefore: string | null }) {
  const locale = useLocale()
  const runs = useMemo(() => groupRuns(replies), [replies])
  // phones: a run's time only when it differs from the run above it
  const repeats = useMemo(() => sameTimeAsAbove(runs, (iso) => timeOf(iso, locale)), [runs, locale])
  const lastMine = runs.at(-1)?.messages[0]?.author?.id === meId
  return (
    <div data-testid="chat-thread-replies">
      {runs.map((run, i) => {
        const first = run.messages[0]!
        return (
          <Fragment key={run.key}>
            {run.newDay && !(i === 0 && dayBefore && localDayKey(dayBefore) === localDayKey(first.createdAt)) && <DayLine at={first.createdAt} />}
            <RunShell face={<RunFace user={first.author} />} name={<RunName user={first.author} />} at={first.createdAt} repeat={repeats[i]}>
              {run.messages.map((r) => <ReplyRow key={r.id} chatId={chatId} rootId={rootId} r={r} meId={meId} people={people} readOnly={readOnly} />)}
            </RunShell>
          </Fragment>
        )
      })}
      {pending.length > 0 && (
        <div className={clsx('pl-11', !lastMine && 'pt-2')}>
          {pending.map((p) => <PendingRow key={p.clientId} chatId={chatId} rootId={rootId} p={p} people={people} meId={meId} />)}
        </div>
      )}
    </div>
  )
}

/** One reply: its words with their links and mentions (no Markdown), the hover bar's ⋮ (copy; delete what I may) on a
 * computer, a long press for the same on a touch screen. `readOnly`: the chat is in the trash or safe operations are
 * on: nothing can be deleted (QA TC-3783, TC-3784) */
function ReplyRow({ chatId, rootId, r, meId, people, readOnly }: { chatId: string; rootId: string; r: ChatThreadReply; meId: string; people: UserRef[]; readOnly: boolean }) {
  const t = useT()
  const mentioned = useMentioned(r.mentions, people)
  const locale = useLocale()
  const press = useMessagePress(true, ROOM_PRESS_SKIP)
  const actions: MessageAction[] = [
    { id: 'copy', label: t('common.copy'), copy: { text: () => r.content }, menuTestId: 'chat-thread-copy' },
    ...(r.canDelete && !readOnly ? [{ id: 'delete' as const, label: t('common.delete'), danger: true, menuTestId: 'chat-thread-delete', run: () => void (async () => {
      const ok = await confirmDialog({ title: t('chat.thread.deleteTitle'), body: t('chat.thread.deleteBody'), confirm: t('common.delete'), danger: true })
      if (!ok) return
      try { await useChatThreads.getState().remove(chatId, rootId, r.id) }
      catch (e) { toast({ level: 'error', text: errorText(e, locale, t('error.network')) }) }
    })() }] : []),
  ]
  return (
    <div className={messageRowClass(false)} data-testid="chat-thread-reply" data-mine={r.author?.id === meId ? '' : undefined} {...press.bind}>
      <p className={clsx('text-reading leading-reading break-words whitespace-pre-wrap text-ink', WORDS)} data-testid="chat-thread-reply-text"><MentionedText text={capBlankLines(r.content)} mentioned={mentioned} meId={meId} /></p>
      <MessageActions layout="float" actions={actions} />
      <MessageActionSheet signal={press.signal} actions={actions} testId="chat-thread-reply-menu" />
    </div>
  )
}

/** A reply on its way: faint while it goes (and while Trina updates), as a room's; a lost one says so, with Send again. */
function PendingRow({ chatId, rootId, p, people, meId }: { chatId: string; rootId: string; p: PendingReply; people: UserRef[]; meId: string }) {
  const t = useT()
  const mentioned = useMentioned(p.mentions, people)
  return (
    <div className="py-0.5" data-testid="chat-thread-pending" data-state={p.state}>
      <p className="text-reading leading-reading break-words whitespace-pre-wrap text-muted"><MentionedText text={capBlankLines(p.text)} mentioned={mentioned} meId={meId} /></p>
      {p.state === 'failed' && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-danger" role="status">
          {t('chat.notSent')}
          <button type="button" className="touch-hit font-medium underline" onClick={() => void useChatThreads.getState().sendAgain(chatId, rootId, p.clientId)} data-testid="chat-thread-send-again">{t('chat.sendAgain')}</button>
        </p>
      )}
    </div>
  )
}

/** The reply box (the composer shell every message box has: composer/ComposerShell.tsx): words and "@" mentions of
 * the people who see the thread (`people`; no files: a reply has none), voice input as in every box (the recording names
 * the chat: the server takes a shared chat I see), Enter sends on a keyboard (a touch screen: a new line), off while
 * empty or past the length; it counts down near the end. What is typed is kept on this device with its mentions
 * (`thread:<chat id>:<answer id>`) until it is sent, also after closing the thread or a reload. */
function ReplyBox({ chatId, rootId, people, meId, autoFocus, onSent }: { chatId: string; rootId: string; people: UserRef[]; meId: string; autoFocus: boolean; onSent: () => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const [text, setText] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const phone = useMediaQuery('(max-width: 767.98px)')
  useEffect(() => { if (autoFocus) ta.current?.focus() }, [autoFocus])
  const mention = useMentionMenu({ text, setText, input: ta, members: people, meId, everyone: null })
  const mentionNow = useRef(mention)
  mentionNow.current = mention
  // voice input as in every message box, under the team's switch (no mic for a guest); a confidential chat's recording
  // never goes to an outside speech service (the note instead)
  const mic = micState(me)
  const confidential = useConfidentialChat(chatId)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const voice = useVoiceInput({
    input: ta,
    root,
    text,
    replace: mention.inputProps.onTextChange,
    append: (said) => setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${said}` : said)),
    chatId,
    blocked: voiceBlockedHere(me, confidential),
    enabled: mic === 'on',
    menuOpen: mention.open,
    onError: setVoiceError,
    afterFocus: mention.inputProps.onSelect,
  })
  useEndAfterRecording(ta, voice.recording, voice.busy, text)
  // the kept draft: read once for this thread, written as it changes (with the people it mentions)
  const userId = me?.user.id ?? '-'
  const keptKey = `thread:${chatId}:${rootId}`
  const keptRead = useRef<string | null>(null)
  useEffect(() => {
    if (keptRead.current === keptKey) return
    keptRead.current = keptKey
    const kept = parseKeptReply(readDraft(userId, keptKey))
    if (kept) mentionNow.current.putBack(kept.text, kept.mentions)
  }, [userId, keptKey])
  useEffect(() => {
    if (keptRead.current !== keptKey) return
    writeDraft(userId, keptKey, text.trim() ? JSON.stringify({ text, mentions: mentionNow.current.mentions() }) : '')
  }, [userId, keptKey, text, mention.picked])
  // a reply the server refused (too long, full, read-only now): its words come back here, with the people it mentioned
  const returned = useChatThreads((s) => s.returned[threadKey(chatId, rootId)])
  useEffect(() => {
    if (returned === undefined) return
    const back = takeReturned(chatId, rootId)
    const ids = takeReturnedMentions(chatId, rootId)
    if (back) mentionNow.current.putBack(back, ids)
  }, [returned, chatId, rootId])
  const tooLong = text.length > CHAT_THREAD_REPLY_MAX
  const canSend = text.trim().length > 0 && !tooLong && !voice.busy
  const send = () => {
    if (!canSend) return
    const body = text
    const mentions = mention.mentions()
    setText('')
    mention.reset()
    onSent()
    void useChatThreads.getState().send(chatId, rootId, body, mentions)
  }
  const left = CHAT_THREAD_REPLY_MAX - text.length
  const count = text.length >= COUNT_FROM ? <span role="status" className={clsx('px-1 text-xs tabular-nums', tooLong ? 'text-danger' : 'text-faint')} data-testid="chat-thread-count-left">{tooLong ? t('chat.thread.tooLong') : formatNumber(left, locale)}</span> : null
  const hint = voice.transcribing ? voice.transcribingText : t('rooms.threadPlaceholder')
  return (
    <ComposerShell
      rootRef={root}
      testId="chat-thread-box"
      line={phone}
      text={text}
      hint={hint}
      heldTestId="chat-thread-text-held"
      voice={voice}
      mic={mic}
      // a phone: the "@" list floats over the newest replies, right above the box, as in a room's box
      top={!voice.recording && mention.list && <div className="max-md:absolute max-md:inset-x-0 max-md:bottom-full max-md:z-10 max-md:border-t max-md:border-line max-md:bg-canvas max-md:pb-1 max-md:shadow-[0_-4px_12px_rgb(0_0_0/0.06)]">{mention.list}</div>}
      field={
        <ComposerField
          ref={ta}
          value={text}
          tokens={mention.inputProps}
          keys={mention.onKeyDown}
          voice={voice}
          onSend={send}
          placeholder={hint}
          aria-label={t('rooms.threadPlaceholder')}
          aria-invalid={tooLong || undefined}
          readOnly={voice.busy}
          aria-busy={voice.transcribing || undefined}
          data-testid="chat-thread-input"
        />
      }
      // the countdown in the row on a computer; under the box in a phone's one line
      start={phone ? undefined : count ?? undefined}
      send={{ can: canSend, onSend: send, testId: 'chat-thread-send' }}
      below={phone && count ? <p className="px-2 pt-1 text-right">{count}</p> : null}
      notices={{ prefix: 'chat-thread', voiceError }}
    />
  )
}
