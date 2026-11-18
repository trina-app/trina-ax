// A thread under an AI answer of a shared chat (docs/decisions/20261116-chat-answer-threads.md), at
// /c/:chatId/t/:messageId: the rooms' thread look (components/rooms/ThreadPanel.tsx) in the column beside the chat on
// computers (components/rooms/RoomSideColumn.tsx, resizable), the whole screen on phones (a ‹ back to the chat; the
// tabs stay away as in the chat). The answer on top (clamped, "Show more"), a hairline with how many replies, the
// replies (face, name, time, the words with their links: never Markdown or HTML) and a box. People only: the AI never
// reads replies, and the grey line under the box says so. "Send to Trina" puts the thread in the chat's box as a quote
// (shared chats.ts chatThreadDraft) for the presser to edit and send as their own question; it shows only where that
// box can send it (M8 of the review): a chat that can be continued, my AI on, replies there, and the answer on the
// version the chat shows. What I see is marked read while the window has the focus and the end is in sight.
// "@" in the box lists the people who see the thread now (the page's `people`, docs/decisions/20261118-chat-thread-
// mentions.md) with the rooms' mention box (components/TokenTextarea.tsx, rooms/useMentionMenu.tsx; no "@everyone");
// a reply shows its mentions as the rooms do (rooms/MessageText.tsx MentionedText).
import clsx from 'clsx'
import { ArrowUp, ChevronLeft, Copy, Loader2, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CHAT_THREAD_REPLY_MAX, chatThreadDraft, type Chat, type ChatThreadReply, type UserRef } from '@mycel/shared/api'
import { errorText, isApiError } from '../../lib/api'
import { lookingAt, onWindowFocus } from '../../lib/attention'
import { useAutoGrow } from '../../lib/autoGrow'
import { useServerUpdating } from '../../lib/serverUpdating'
import { intlTag } from '../../lib/format'
import { aiName } from '../../lib/tabs'
import { holdPlace, ROOM_ROW, useStickToBottom } from '../../lib/stickToBottom'
import { useLocale, useT } from '../../i18n'
import { reloadAsked } from '../../store/live'
import { takeReturned, takeReturnedMentions, threadKey, useChatThreads, type PendingReply } from '../../store/chatThreads'
import { toast } from '../../store/ui'
import { useAvatarOf, useNameOf } from '../../store/people'
import { useMe } from '../../store/session'
import { Avatar } from '../Avatar'
import { Markdown } from '../LazyMarkdown'
import { MentionedText } from '../rooms/MessageText'
import { useMentionMenu } from '../rooms/useMentionMenu'
import { TokenTextarea } from '../TokenTextarea'
import { MenuButton, type MenuItem } from '../rooms/MenuButton'
import { Tooltip } from '../Tooltip'
import { Button, ErrorNote, IconButton, Skeleton, confirmDialog, useCopy } from '../ui'
import { ComposerToolbar } from './ComposerToolbar'
import { composerRadius } from './composerBox'
import { SharedReadOnly } from './SharedChat'

const NO_PEOPLE: UserRef[] = []

/** The names a reply's mentions are looked for by: each person's name now (the directory) and as the thread's list has
 * it (a mention is the name as it was typed); mine as my account has it (I am never on the list). */
function useMentioned(ids: readonly string[] | undefined, people: UserRef[]): { id: string; name: string }[] {
  const nameOf = useNameOf()
  const me = useMe()?.user
  return useMemo(() => (ids ?? []).flatMap((id) => [...new Set([nameOf({ id, name: '' }) ?? '', people.find((p) => p.id === id)?.name ?? '', me?.id === id ? me.name : ''])].filter(Boolean).map((name) => ({ id, name }))), [ids, people, nameOf, me])
}

/** the box counts down from here (CHAT_THREAD_REPLY_MAX is 10,000) */
const COUNT_FROM = 9500
/** the answer on top is clamped to about 12 lines until "Show more" */
const CLAMP = 'max-h-[18rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]'

const timeOf = (iso: string, locale: Parameters<typeof intlTag>[0]) => new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))

/** `onSendToTrina`: puts the draft in the chat's box (absent: the box cannot send it now, so there is no button).
 * `onShownBranch`: the answer is on the version the chat shows (the page knows: its messages). */
export function ChatThreadPanel({ chat, rootId, meId, onClose, onSendToTrina, onShownBranch, focusBox = false }: { chat: Chat; rootId: string; meId: string; onClose: () => void; onSendToTrina?: (draft: string) => void; onShownBranch: boolean; focusBox?: boolean }) {
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
      const keep = holdPlace(el, ROOM_ROW)
      void useChatThreads.getState().loadOlder(chatId, rootId).finally(() => requestAnimationFrame(keep))
    }
    tryRead()
  }

  const notFound = !!view?.error && (isApiError(view.error, 'not_found') || isApiError(view.error, 'forbidden'))
  const count = root?.thread?.replyCount ?? replies.length
  const nameOf = useNameOf()
  // who "@" may pick: the people who see the thread now (the server sends them while I may reply)
  const people = view?.people ?? NO_PEOPLE
  const readOnly = view?.readOnlyReason
  const versionLine = !onShownBranch && view?.version ? t('chat.thread.otherVersion', { index: view.version.index, count: view.version.count }) : null
  const canSendToTrina = !!onSendToTrina && onShownBranch && replies.length > 0 && !readOnly
  const sendToTrina = () => {
    if (!onSendToTrina || !root) return
    const head = t('chat.thread.draftHead', { name: aiName(t), time: timeOf(root.createdAt, locale), n: count })
    onSendToTrina(chatThreadDraft(replies.map((r) => ({ name: nameOf(r.author) ?? r.author?.name ?? t('rooms.goneUser'), at: r.createdAt, text: r.content })), { head, cut: t('chat.thread.draftCut'), time: (iso) => timeOf(iso, locale) }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-thread">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2 max-md:pl-0.5 md:px-4">
        <IconButton tip label={t('rooms.closeThread')} onClick={onClose} className="touch-hit p-3 md:hidden" data-testid="chat-thread-back">
          <ChevronLeft size={20} aria-hidden />
        </IconButton>
        <h2 className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-title-sm font-semibold text-ink">{t('rooms.thread')}</span>
          <span className="truncate text-xs text-faint" data-testid="chat-thread-chat">{chat.title || t('chat.untitled')}</span>
        </h2>
        <IconButton tip label={t('rooms.closeThread')} onClick={onClose} className="touch-hit max-md:hidden" data-testid="chat-thread-close">
          <X size={16} aria-hidden />
        </IconButton>
      </div>
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
              {root && <ThreadAnswer text={root.content} at={root.createdAt} />}
              {versionLine && <p role="note" className="mt-2 rounded-lg bg-subtle px-3 py-2 text-xs leading-5 text-muted" data-testid="chat-thread-version">{versionLine}</p>}
              {root && (
                <div role="separator" className="flex items-center gap-3 pt-3 pb-1 text-xs text-faint" data-testid="chat-thread-count">
                  {count > 0 ? t('rooms.threadReplies', { n: count }) : t('rooms.threadNone')}
                  <span className="h-px flex-1 bg-line" aria-hidden />
                </div>
              )}
              {view?.loading && root && !replies.length && <Loader2 size={16} className="mx-auto my-2 animate-spin text-faint" aria-label={t('common.loading')} />}
              <ul className="space-y-3 pt-2" data-testid="chat-thread-replies">
                {replies.map((r) => <ReplyRow key={r.id} chatId={chatId} rootId={rootId} r={r} meId={meId} people={people} readOnly={readOnly === 'trash' || readOnly === 'safe_ops'} />)}
                {(pending ?? []).map((p) => <PendingRow key={p.clientId} chatId={chatId} rootId={rootId} p={p} people={people} meId={meId} />)}
              </ul>
            </>
          )}
        </div>
      </div>
      {!notFound && root && (
        <div className="shrink-0 border-t border-line px-3 pt-2 pb-[max(0.5rem,var(--safe-bottom,0px))]" data-testid="chat-thread-foot">
          {readOnly === 'safe_ops' ? <SharedReadOnly />
            : readOnly ? <p role="status" className="px-1 py-2 text-center text-sm text-muted" data-testid="chat-thread-read-only">{t(readOnly === 'trash' ? 'chat.thread.inTrash' : 'chat.thread.notShared')}</p>
            : view?.full ? <p role="status" className="px-1 py-2 text-center text-sm text-muted" data-testid="chat-thread-full">{t('chat.thread.full')}</p>
            : <ReplyBox chatId={chatId} rootId={rootId} people={people} meId={meId} autoFocus={focusBox || count === 0} onSent={() => { stick.current = true }} />}
          <ThreadWaitLine slow={slow} />
          <p className="px-1 pt-1.5 text-micro leading-4 text-faint" data-testid="chat-thread-people-only">{t('chat.thread.peopleOnly', { name: aiName(t) })}</p>
          {canSendToTrina && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1.5">
              <Button size="sm" variant="ghost" onClick={sendToTrina} className="-ml-1.5" data-testid="chat-thread-send-to-ai">{t('chat.thread.sendToAi', { name: aiName(t) })}</Button>
              <span className="text-micro text-faint">{t('chat.thread.editBefore')}</span>
            </div>
          )}
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

/** The answer the thread is under: its text as the chat shows it, clamped to about 12 lines until "Show more". */
function ThreadAnswer({ text, at }: { text: string; at: string }) {
  const t = useT()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (el) setLong(el.scrollHeight > el.clientHeight + 4)
  }, [text])
  return (
    <div data-testid="chat-thread-answer">
      <p className="mb-1 text-xs text-faint">{t('chat.thread.answerAt', { name: aiName(t), time: timeOf(at, locale) })}</p>
      <div ref={box} className={clsx(!open && CLAMP)}>
        <Markdown text={text} />
      </div>
      {(long || open) && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="touch-hit mt-1 text-xs font-medium text-accent-text hover:underline" data-testid="chat-thread-more">
          {open ? t('chat.thread.showLess') : t('chat.thread.showMore')}
        </button>
      )}
    </div>
  )
}

function Face({ r }: { r: ChatThreadReply }) {
  const u = useAvatarOf(r.author ?? undefined)
  return u ? <Avatar user={u} size={28} /> : <span className="size-7 shrink-0 rounded-full bg-hover" aria-hidden />
}

/** `readOnly`: the chat is in the trash or safe operations are on: nothing can be deleted (QA TC-3783, TC-3784) */
function ReplyRow({ chatId, rootId, r, meId, people, readOnly }: { chatId: string; rootId: string; r: ChatThreadReply; meId: string; people: UserRef[]; readOnly: boolean }) {
  const t = useT()
  const mentioned = useMentioned(r.mentions, people)
  const locale = useLocale()
  const nameOf = useNameOf()
  const { copy } = useCopy()
  const items: MenuItem[] = [
    { label: t('common.copy'), icon: <Copy size={14} aria-hidden />, onSelect: () => void copy(r.content).then((ok) => ok && toast({ level: 'info', text: t('common.copied') })), testId: 'chat-thread-copy' },
    ...(r.canDelete && !readOnly ? [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, danger: true, testId: 'chat-thread-delete', onSelect: () => void (async () => {
      const ok = await confirmDialog({ title: t('chat.thread.deleteTitle'), body: t('chat.thread.deleteBody'), confirm: t('common.delete'), danger: true })
      if (!ok) return
      try { await useChatThreads.getState().remove(chatId, rootId, r.id) }
      catch (e) { toast({ level: 'error', text: errorText(e, locale, t('error.network')) }) }
    })() }] : []),
  ]
  return (
    <li className="group flex gap-2.5" data-testid="chat-thread-reply" data-mine={r.author?.id === meId ? '' : undefined}>
      <Face r={r} />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-sm">
          <bdi className="min-w-0 truncate font-medium text-ink">{nameOf(r.author) ?? r.author?.name ?? t('rooms.goneUser')}</bdi>
          <time dateTime={r.createdAt} className="shrink-0 text-xs text-faint">{timeOf(r.createdAt, locale)}</time>
        </p>
        <p className="text-sm leading-6 break-words whitespace-pre-wrap text-ink" data-testid="chat-thread-reply-text"><MentionedText text={r.content} mentioned={mentioned} meId={meId} /></p>
      </div>
      <MenuButton label={t('rooms.messageActions')} items={items} compact className="shrink-0 self-start opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100" testId="chat-thread-reply-menu" />
    </li>
  )
}

/** A reply on its way: faint while it goes (and while Trina updates); a lost one says so, with Send again. */
function PendingRow({ chatId, rootId, p, people, meId }: { chatId: string; rootId: string; p: PendingReply; people: UserRef[]; meId: string }) {
  const t = useT()
  const mentioned = useMentioned(p.mentions, people)
  return (
    <li className="flex gap-2.5 opacity-60" data-testid="chat-thread-pending" data-state={p.state}>
      <span className="size-7 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-6 break-words whitespace-pre-wrap text-ink"><MentionedText text={p.text} mentioned={mentioned} meId={meId} /></p>
        {p.state === 'failed' && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-danger" role="status">
            {t('chat.notSent')}
            <button type="button" className="touch-hit font-medium underline" onClick={() => void useChatThreads.getState().sendAgain(chatId, rootId, p.clientId)} data-testid="chat-thread-send-again">{t('chat.sendAgain')}</button>
          </p>
        )}
      </div>
    </li>
  )
}

/** The reply box: words and "@" mentions of the people who see the thread (`people`; no files), Enter sends on a
 * keyboard (a touch screen: a new line), off while empty or past the length; it counts down near the end. */
function ReplyBox({ chatId, rootId, people, meId, autoFocus, onSent }: { chatId: string; rootId: string; people: UserRef[]; meId: string; autoFocus: boolean; onSent: () => void }) {
  const t = useT()
  const [text, setText] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(ta, [text], 200)
  useEffect(() => { if (autoFocus) ta.current?.focus() }, [autoFocus])
  const mention = useMentionMenu({ text, setText, input: ta, members: people, meId, everyone: null })
  const mentionNow = useRef(mention)
  mentionNow.current = mention
  // a reply the server refused (too long, full, read-only now): its words come back here, with the people it mentioned
  const returned = useChatThreads((s) => s.returned[threadKey(chatId, rootId)])
  useEffect(() => {
    if (returned === undefined) return
    const back = takeReturned(chatId, rootId)
    const ids = takeReturnedMentions(chatId, rootId)
    if (back) mentionNow.current.putBack(back, ids)
  }, [returned, chatId, rootId])
  const tooLong = text.length > CHAT_THREAD_REPLY_MAX
  const canSend = text.trim().length > 0 && !tooLong
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
  return (
    <div className={clsx('relative', composerRadius, 'border border-field-border bg-surface transition focus-within:border-faint')} data-testid="chat-thread-box">
      {/* a phone: the "@" list floats over the newest replies, right above the box, as in a room's box */}
      {mention.list && <div className="max-md:absolute max-md:inset-x-0 max-md:bottom-full max-md:z-10 max-md:border-t max-md:border-line max-md:bg-canvas max-md:pb-1 max-md:shadow-[0_-4px_12px_rgb(0_0_0/0.06)]">{mention.list}</div>}
      <TokenTextarea
        ref={ta}
        rows={1}
        value={text}
        {...mention.inputProps}
        placeholder={t('rooms.threadPlaceholder')}
        aria-label={t('rooms.threadPlaceholder')}
        aria-invalid={tooLong || undefined}
        className="block max-h-[200px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-reading leading-reading text-ink outline-none placeholder:text-faint max-md:max-h-[min(200px,max(2.75rem,calc(var(--app-h,100dvh)*0.35-5rem)))]"
        onKeyDown={(e) => {
          if (mention.onKeyDown(e)) return
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            if (window.matchMedia?.('(pointer: coarse)').matches) return
            e.preventDefault()
            send()
          }
        }}
        data-testid="chat-thread-input"
      />
      <ComposerToolbar
        start={text.length >= COUNT_FROM ? <span role="status" className={clsx('px-1 text-xs tabular-nums', tooLong ? 'text-danger' : 'text-faint')} data-testid="chat-thread-count-left">{tooLong ? t('chat.thread.tooLong') : left.toLocaleString()}</span> : undefined}
        end={
          <Tooltip label={t('chat.send')}>
            <button type="button" onClick={send} disabled={!canSend} aria-label={t('chat.send')} className={clsx('touch-hit flex size-9 shrink-0 items-center justify-center rounded-full transition max-sm:size-10', canSend ? 'bg-accent text-accent-ink hover:bg-accent-hover' : 'bg-subtle text-faint')} data-testid="chat-thread-send">
              <ArrowUp size={18} aria-hidden />
            </button>
          </Tooltip>
        }
      />
    </div>
  )
}
