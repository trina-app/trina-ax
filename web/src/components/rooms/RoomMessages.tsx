// The messages of a room, oldest first: one author's messages close together share one avatar, name and time
// (lib/rooms.ts groupRuns; on phones the time only when it differs from the one above), and a date line starts each
// day. Nobody is shown who has read what (docs/DECISIONS.md "스레드와 반응": no read receipts). A message's text is
// another member's words: plain text with its line breaks, never HTML or Markdown; the @names it mentions stand out.
// On a computer a message's hover row has a reaction, "reply in thread" and "…" (copy, edit and delete one's own); on a
// touch screen a long press opens the same as a sheet with the reactions on top. Under a message: its reactions
// (components/rooms/Reactions.tsx) and, for a root, its thread ("답글 3개 · 오후 2:10", up to 3 faces; a dot when a
// thread I follow has new replies), which opens the thread. A reply also sent to the room says so above it. The same
// list shows a thread's root and replies (variant). Images show as thumbnails that open in the side panel; other files
// are chips that download.
// The AI's answers (docs/DECISIONS.md "대화방의 트리나") are the one exception to plain text: written by the AI, shown
// like an answer in the AI chat (Markdown, the files it used) without its steps, with who asked ("○○ 님이 물어봄", a
// click goes to the question). A private preview, seen only by the person who asked, says so at the top ("나만 볼 수
// 있어요"), and above its one action (post it to the room, an outline button) who would see it then. An event line (a
// rename, people invited, someone left or taken out: RoomMessage.event) is one quiet line in the middle, nothing more:
// no avatar, menu, reaction or thread.
import clsx from 'clsx'
import { Copy, Download, FileText, Lock, MessageSquareText, Pencil, Sparkles, Trash2 } from 'lucide-react'
import { Fragment, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Locale, RoomAiRun, RoomFile, RoomMessage, RoomQuote, UserRef } from '@mycel/shared/api'
import { api, API, errorText, readBounded, startDownload } from '../../lib/api'
import { formatDateTime, formatSize, intlTag } from '../../lib/format'
import { aiMentionNames, ALL_MENTION_ID, allMentionNames, eventText, groupRuns, lineBreaks, localDayKey, mentionParts, runActive, type MessageRun } from '../../lib/rooms'
import { Markdown } from '../Markdown'
import SourcesList from '../chat/SourcesList'
import { openFilePreview } from '../../lib/sidePanel'
import { useLocale, useT } from '../../i18n'
import { useAvatarOf, useNameOf, usePeople } from '../../store/people'
import { useMe } from '../../store/session'
import { useRooms, type PendingSend } from '../../store/rooms'
import { toast } from '../../store/ui'
import { Avatar } from '../Avatar'
import { TokenTextarea } from '../TokenTextarea'
import { Button, confirmDialog, inputCls, useCopy } from '../ui'
import { MenuButton, useLongPress, type MenuItem } from './MenuButton'
import { MessageHoverBar } from './MessageHoverBar'
import { reactable, ReactionChips, ReactionStrip } from './Reactions'
import { EndedRun, PrivateAnswered } from './RoomAiStatus'
import { MENTION_ALL_WORDS, pickedInMessage, useMentionMenu } from './useMentionMenu'

const NO_RUNS: RoomAiRun[] = []
const timeOf = (iso: string, locale: Locale) => new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))
const dayOf = (iso: string, locale: Locale) => new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'full' }).format(new Date(iso))
export const messageDomId = (id: string) => `room-msg-${id}`

/** For each run: its time reads the same as the time shown above it on the same day (a date line starts a new day).
 * Phones show such a time once: the first run of that minute has it. An event line shows no time, so a run compares
 * with the nearest message run above it, never with an event line. */
export function sameTimeAsAbove(runs: readonly MessageRun[], time: (iso: string) => string): boolean[] {
  let shown: string | null = null
  return runs.map((run) => {
    if (run.newDay) shown = null
    const first = run.messages[0]!
    if (first.event) return false
    const t = time(first.createdAt)
    const same = shown === t
    shown = t
    return same
  })
}

/** the largest box a thumbnail takes, so the list does not jump while it loads */
export function thumbBox(f: { width?: number | null; height?: number | null }): { width: number; height: number } | undefined {
  if (!f.width || !f.height) return undefined
  const k = Math.min(1, 320 / f.width, 240 / f.height)
  return { width: Math.round(f.width * k), height: Math.round(f.height * k) }
}

/** A photo's thumbnail: in the box its stored size gives until it loads, then in its own shape when that differs. The
 * thumbnail is always upright; a photo sent before the server stored the upright size (a portrait phone photo stored
 * landscape with EXIF orientation 6) has a landscape size, which would crop it to its middle band. */
function RoomThumb({ f, src }: { f: RoomFile; src: string }) {
  const [own, setOwn] = useState<{ width: number; height: number } | null>(null)
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      style={thumbBox(own ?? f)}
      onLoad={(e) => {
        const { naturalWidth: width, naturalHeight: height } = e.currentTarget
        if (width && height && (!f.width || !f.height || Math.abs(width / height - f.width / f.height) > 0.05)) setOwn({ width, height })
      }}
      className="block max-h-60 max-w-full object-cover"
    />
  )
}

/** Where the list is: the room's timeline, or the thread panel's root, or its replies. */
export type ListVariant = 'timeline' | 'root' | 'reply'

/** `threadRootId`: the thread of a 'reply' list (my questions asked there that ended without an answer show under it).
 * `dayBefore`: the time of what is shown above the list (a thread's root): no second date line for that same day. */
export function RoomMessages({ roomId, messages, pending, meId, members, onThread, variant = 'timeline', threadRootId = null, dayBefore = null }: { roomId: string; messages: RoomMessage[]; pending: PendingSend[]; meId: string | null; members: UserRef[]; onThread?: (rootId: string, focus?: boolean) => void; variant?: ListVariant; threadRootId?: string | null; dayBefore?: string | null }) {
  const t = useT()
  const locale = useLocale()
  const runs = useMemo(() => groupRuns(messages), [messages])
  const [editing, setEditing] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const loaded = useMemo(() => new Set(messages.map((m) => m.id)), [messages])
  const byId = usePeople((s) => s.byId)
  /** a mentioned person's name: the room's member list, else the directory */
  const names = useMemo(() => {
    const map = new Map<string, string>()
    // the directory last: it has a name changed since the member list was read
    for (const m of members) map.set(m.id, m.name)
    for (const p of Object.values(byId)) map.set(p.id, p.name)
    return map
  }, [byId, members])
  const nameOf = useNameOf()
  const jump = (id: string) => {
    document.getElementById(messageDomId(id))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlash(id)
    setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600)
  }
  const lastMine = runs.at(-1)?.messages[0]?.author?.id === meId && meId !== null && !runs.at(-1)?.messages[0]?.event
  // what the AI did with a question, under that question: my answer that stopped or failed, someone else's answer that
  // stayed theirs only (the question says so, also after a reload)
  const ended = useRooms(useShallow((s) => (s.ai[roomId]?.runs ?? NO_RUNS).filter((r) => !runActive(r))))
  const after = (m: RoomMessage) => [
    ...ended.filter((r) => r.questionId === m.id).map((r) => <EndedRun key={r.turnId} roomId={roomId} run={r} />),
    ...(m.answeredPrivately ? [<PrivateAnswered key={`private-${m.id}`} name={nameOf(m.author) ?? t('rooms.goneUser')} />] : []),
  ]
  // my ended questions not on this list: under the timeline the timeline's, under a thread's replies that thread's
  const place = variant === 'reply' ? threadRootId : null
  const orphans = variant === 'root' ? [] : ended.filter((r) => !loaded.has(r.questionId) && (r.threadRootId ?? null) === place).map((r) => <EndedRun key={r.turnId} roomId={roomId} run={r} />)
  // phones: a run's time only when it differs from the run above it ("오전 11:56" once for four messages of that minute)
  const repeats = useMemo(() => sameTimeAsAbove(runs, (iso) => timeOf(iso, locale)), [runs, locale])

  return (
    <div data-testid="room-messages">
      {runs.map((run, i) => {
        const first = run.messages[0]!
        return (
          <Fragment key={run.key}>
            {run.newDay && !(i === 0 && dayBefore && localDayKey(dayBefore) === localDayKey(first.createdAt)) && (
              <div role="separator" className="flex items-center gap-3 py-3 text-micro font-medium text-faint">
                <span className="h-px flex-1 bg-line" aria-hidden />
                {dayOf(first.createdAt, locale)}
                <span className="h-px flex-1 bg-line" aria-hidden />
              </div>
            )}
            {first.event ? <EventLine m={first} /> : (
            <div className="flex gap-3 pt-2" data-testid="room-run">
              <RunAvatar m={first} />
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium text-ink">{first.authorKind === 'ai' ? t('rooms.aiName') : (nameOf(first.author) ?? t('rooms.goneUser'))}</span>
                  <time dateTime={first.createdAt} title={formatDateTime(first.createdAt, locale)} className={clsx('shrink-0 text-xs text-faint', repeats[i] && 'max-md:hidden')} data-repeat={repeats[i] ? '' : undefined}>
                    {timeOf(first.createdAt, locale)}
                  </time>
                </p>
                {run.messages.map((m) => (
                  <Fragment key={m.id}>
                    <MessageRow
                      roomId={roomId}
                      m={m}
                      mine={!!meId && m.author?.id === meId}
                      names={names}
                      members={members}
                      meId={meId}
                      editing={editing === m.id}
                      flash={flash === m.id}
                      onEdit={() => setEditing(m.id)}
                      onEditDone={() => setEditing(null)}
                      onThread={onThread}
                      variant={variant}
                      // the list's first message (the top of the room, a thread's root): its bar goes under it, where the
                      // header above cannot cut it
                      barBelow={variant !== 'reply' && m.id === messages[0]?.id}
                      onJump={m.replyTo && loaded.has(m.replyTo.id) ? () => jump(m.replyTo!.id) : undefined}
                    />
                    {after(m)}
                  </Fragment>
                ))}
              </div>
            </div>
            )}
          </Fragment>
        )
      })}
      {orphans.length > 0 && <div className="pl-11">{orphans}</div>}
      {pending.length > 0 && (
        <div className={clsx('pl-11', !lastMine && 'pt-2')} data-testid="room-pending">
          {pending.map((p) => (
            <PendingRow key={p.clientMessageId} roomId={roomId} p={p} />
          ))}
        </div>
      )}
    </div>
  )
}

/** "가나님이 방 이름을 '주간 회의'로 바꿨어요": the names as the directory has them now, the room name as plain text. */
function EventLine({ m }: { m: RoomMessage }) {
  const t = useT()
  const locale = useLocale()
  const nameOf = useNameOf()
  if (!m.event) return null
  const text = eventText(m.event, m.author, { t, nameOf: (u) => nameOf(u) ?? t('rooms.goneUser') })
  return (
    <p id={messageDomId(m.id)} className="px-6 pt-3 pb-1 text-center text-xs break-words text-faint" title={formatDateTime(m.createdAt, locale)} data-testid="room-event">
      {text}
    </p>
  )
}

function RunAvatar({ m }: { m: RoomMessage }) {
  const user = useAvatarOf(m.author)
  if (m.authorKind === 'ai')
    return (
      <span aria-hidden className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text">
        <Sparkles size={15} />
      </span>
    )
  return user ? <Avatar user={user} size={32} className="mt-0.5" /> : <span aria-hidden className="mt-0.5 size-8 shrink-0 rounded-full bg-hover" />
}

/** A root's thread under it: up to 3 faces, "답글 3개", the last reply's time; a dot when a thread I follow has replies I
 * have not read. One tap opens the thread. */
function ThreadLine({ m, onOpen }: { m: RoomMessage; onOpen: () => void }) {
  const t = useT()
  const locale = useLocale()
  const th = m.thread
  if (!th || th.replyCount <= 0) return null
  return (
    <button type="button" onClick={onOpen} className="touch-hit group/thread mt-1 -ml-1 flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs hover:bg-hover" data-testid="room-thread-line" data-new={th.newReplies ? '' : undefined}>
      {th.repliers.length > 0 && (
        <span className="flex shrink-0 gap-0.5" aria-hidden>
          {th.repliers.map((u) => <ReplierFace key={u.id} user={u} />)}
        </span>
      )}
      {th.newReplies && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}
      <span className="shrink-0 font-medium text-accent-text group-hover/thread:underline">{t('rooms.threadReplies', { n: th.replyCount })}</span>
      {th.newReplies && <span className="sr-only">{t('rooms.threadNew')}</span>}
      {th.lastReplyAt && <span className="truncate text-faint">· {t('rooms.threadLast', { time: timeOf(th.lastReplyAt, locale) })}</span>}
    </button>
  )
}

function ReplierFace({ user }: { user: UserRef }) {
  const u = useAvatarOf(user)
  return u ? <Avatar user={u} size={18} /> : <span className="size-[18px] rounded-full bg-hover" />
}

function MessageRow({ roomId, m, mine, names, members, meId, editing, flash, onEdit, onEditDone, onThread, variant, onJump, barBelow = false }: { roomId: string; m: RoomMessage; mine: boolean; names: Map<string, string>; members: UserRef[]; meId: string | null; editing: boolean; flash: boolean; onEdit: () => void; onEditDone: () => void; onThread?: (rootId: string, focus?: boolean) => void; variant: ListVariant; onJump?: () => void; barBelow?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const deleted = !!m.deletedAt
  const ai = m.authorKind === 'ai'
  const me = useMe()
  // an AI answer: the person who asked puts it (or their preview) away; an owner or admin any answer they see
  const removable = mine || (ai && !!meId && (m.askedBy?.id === meId || me?.user.role === 'owner' || me?.user.role === 'admin'))
  const openable = useMemo(() => (ai ? new Set(m.openable ?? []) : undefined), [ai, m.openable])
  // a mention is the name as it was typed: the person's name now (the directory) and as the member list has it, so
  // "@Ben" still stands out after Ben renamed himself
  const mentioned = useMemo(() => m.mentions.flatMap((id) => [...new Set([names.get(id) ?? '', members.find((x) => x.id === id)?.name ?? ''])].map((name) => ({ id, name }))), [m.mentions, names, members])
  // "@트리나" stands out like a person's name (the server asked the AI for it), "@전체" too (it mentions everyone)
  const parts = useMemo(() => mentionParts(m.body, ai ? mentioned : [...mentioned, ...allMentionNames(m, MENTION_ALL_WORDS), ...aiMentionNames(m.body, mentioned)]), [m, mentioned, ai])
  const [press, setPress] = useState(0)
  const pressedAt = useRef(0)
  const menuOn = !deleted && !editing && (m.visibility === 'room' || removable)
  // a thread under it: only a message of the timeline for everyone, and only from the timeline (no thread in a thread)
  const threadOn = variant === 'timeline' && !!onThread && !m.threadRootId && m.visibility === 'room' && !deleted
  const reactOn = reactable(m) && !editing
  // a touch screen: no hover row on every message; a long press opens its menu (with the reactions on top)
  const longPress = useLongPress(() => {
    pressedAt.current = Date.now()
    setPress((n) => n + 1)
  })
  const { copy } = useCopy()
  const copyText = async () => {
    await copy(m.body)
    toast({ level: 'success', text: t('rooms.copied') })
  }
  const del = async () => {
    const ok = await confirmDialog({ title: t('rooms.deleteTitle'), body: t('rooms.deleteBody'), confirm: t('common.delete'), danger: true })
    if (!ok) return
    await useRooms
      .getState()
      .remove(roomId, m.id)
      .catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))
  }
  const meta = m.editedAt && !deleted ? <span className="ml-1 text-xs text-faint">{t('rooms.edited')}</span> : null
  // ⋮ 더 보기 (the hover bar) and the end of the long-press sheet: copy; my own message's edit; delete what I may (my own,
  // an AI answer I asked for, any AI answer for an owner or admin), with the confirm
  const moreItems: MenuItem[] = [
    ...(m.body ? [{ label: t('common.copy'), icon: <Copy size={14} aria-hidden />, onSelect: () => void copyText(), testId: 'message-copy' }] : []),
    ...(mine && !ai ? [{ label: t('common.edit'), icon: <Pencil size={14} aria-hidden />, onSelect: onEdit, testId: 'message-edit' }] : []),
    ...(removable ? [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => void del(), danger: true, testId: 'message-delete' }] : []),
  ]
  return (
    <div
      id={messageDomId(m.id)}
      className={clsx('group relative -mx-2 rounded-lg px-2 py-0.5 transition pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none]', flash ? 'bg-accent-soft' : 'hover:bg-subtle has-[[role=menu]]:bg-subtle has-[[aria-expanded=true]]:bg-subtle has-[:focus-visible]:bg-subtle')}
      data-testid="room-message"
      data-ai={ai ? '' : undefined}
      data-visibility={m.visibility}
      {...(menuOn ? longPress : {})}
    >
      {/* a reply sent to the room too: in the timeline it says it belongs to a thread (a tap opens it); in the thread it
          says it went to the room as well */}
      {m.alsoInRoom && m.threadRootId && (variant === 'timeline' && onThread ? (
        <button type="button" onClick={() => onThread(m.threadRootId!)} className="mb-0.5 flex items-center gap-1 text-xs text-faint hover:text-ink hover:underline" data-testid="room-thread-reply-mark">
          <MessageSquareText size={12} aria-hidden />
          {t('rooms.threadReplyMark')}
        </button>
      ) : variant === 'reply' ? (
        <p className="mb-0.5 text-xs text-faint" data-testid="room-also-sent">{t('rooms.alsoSent')}</p>
      ) : null)}
      {ai ? <AskedBy roomId={roomId} m={m} onJump={onJump} /> : m.replyTo && <Quote q={m.replyTo} onJump={onJump} />}
      {ai && !deleted ? (
        <>
          <Markdown text={m.body} className="min-w-0" openable={openable} />
          {!!m.sourceCount && (
            <SourcesList chatId={roomId} messageId={m.id} count={m.sourceCount} load={(signal) => api.call(API.roomMessageSources, { params: { id: roomId, messageId: m.id }, signal })} />
          )}
        </>
      ) : editing ? (
        <EditForm roomId={roomId} m={m} initial={mentioned.filter((x) => x.name)} members={members} meId={meId} onDone={onEditDone} />
      ) : deleted ? (
        <p className="text-reading leading-reading text-faint">{t('rooms.deleted')}</p>
      ) : (
        <>
          {m.body && (
            <p className="text-reading leading-reading break-words whitespace-pre-wrap text-ink">
              {parts.map((p, i) =>
                p.userId ? (
                  <span key={i} className={clsx('font-medium text-accent-text', (p.userId === meId || (p.userId === ALL_MENTION_ID && m.author?.id !== meId)) && 'rounded bg-accent-soft px-0.5')} data-mention={p.userId === ALL_MENTION_ID ? 'all' : undefined}>
                    {p.text}
                  </span>
                ) : (
                  <Fragment key={i}>{p.text}</Fragment>
                ),
              )}
              {meta}
            </p>
          )}
          {m.files.length > 0 && <Files roomId={roomId} files={m.files} />}
          {!m.body && m.editedAt && <p className="leading-5">{meta}</p>}
        </>
      )}
      {!deleted && <ReactionChips roomId={roomId} m={m} />}
      {variant === 'timeline' && onThread && !m.threadRootId && <ThreadLine m={m} onOpen={() => onThread(m.id)} />}
      {/* computers: the hover bar (reactions, reply in thread, ⋮); touch screens and phones: a long press opens the same
          as a sheet, with the eight emoji on top (its own button never shows) */}
      {menuOn && (
        <>
          <MessageHoverBar roomId={roomId} m={m} below={barBelow} reactOn={reactOn} onThread={threadOn ? () => onThread!(m.id, true) : undefined} more={moreItems} />
          <MenuButton
            label={t('rooms.messageMenu')}
            className="absolute top-0 right-0"
            buttonClassName="hidden!"
            testId="message-menu"
            openSignal={press}
            header={reactOn ? (close) => (
              <ReactionStrip
                className="justify-between"
                mine={(m.reactions ?? []).filter((r) => r.mine).map((r) => r.emoji)}
                onPick={(e) => {
                  // the finger lifting after the long press is no pick
                  if (Date.now() - pressedAt.current < 400) return
                  close()
                  void useRooms.getState().react(roomId, m.id, e, !(m.reactions ?? []).some((r) => r.emoji === e && r.mine))
                }}
              />
            ) : undefined}
            items={[...(threadOn ? [{ label: t('rooms.replyInThread'), icon: <MessageSquareText size={14} aria-hidden />, onSelect: () => onThread!(m.id, true), testId: 'message-reply-thread' }] : []), ...moreItems]}
          />
        </>
      )}
    </div>
  )
}

/** "○○ 님이 물어봄" above an AI answer; a click goes to the question when it is loaded. My private preview says
 * "나만 볼 수 있어요" there instead: whose question it answers is clear, who sees it is not (PreviewLine). */
function AskedBy({ roomId, m, onJump }: { roomId: string; m: RoomMessage; onJump?: () => void }) {
  const t = useT()
  const nameOf = useNameOf()
  if (m.visibility === 'private') return <PreviewLine roomId={roomId} m={m} />
  const text = t('rooms.aiAskedBy', { name: nameOf(m.askedBy) ?? t('rooms.goneUser') })
  return onJump ? (
    <button type="button" onClick={onJump} className="mb-0.5 block max-w-full truncate text-left text-xs text-faint hover:text-ink hover:underline" data-testid="room-ai-asked-by">
      {text}
    </button>
  ) : (
    <p className="mb-0.5 truncate text-xs text-faint" data-testid="room-ai-asked-by">
      {text}
    </p>
  )
}

/** The folders of a private preview as people know them: the last part of each path ("마케팅팀", not
 * "shared/경영/팀별/마케팅팀/"), the top of the team folder in words; never the skills folders (the team rules and
 * skills the AI was given: how it works, not what it found). */
export function previewFolderNames(p: NonNullable<RoomMessage['preview']>, words: { root: string }): string[] {
  const names = p.folders.filter((f) => f !== 'skills' && !f.startsWith('skills/')).map((f) => (f === '' ? words.root : f.split('/').filter(Boolean).at(-1) ?? f))
  return [...new Set(names)]
}

/** Why a private preview did not go to the room, one short sentence per reason (the folders it read that some members
 * cannot open, named when the person may open them; their own folder; messages from before someone joined; the web or
 * a connected service). Without a reason (an older preview): that everyone would see it. `dm`: a 1:1 room, where "some
 * people in this room" is the other person. */
export function previewWhy(p: RoomMessage['preview'], t: ReturnType<typeof useT>, dm = false): string {
  if (!p) return t(dm ? 'rooms.aiPrivateAllDm' : 'rooms.aiPrivateAll')
  const why: string[] = []
  const folders = previewFolderNames(p, { root: t('rooms.aiRootFolder') })
  // folders the person cannot open themselves, and the skills folders, are never named
  if (folders.length) why.push(t(dm ? 'rooms.aiWhyFoldersDm' : 'rooms.aiWhyFolders', { folders: folders.join(', ') }))
  else if (p.folders.length || p.otherFolders) why.push(t(dm ? 'rooms.aiWhySomeFoldersDm' : 'rooms.aiWhySomeFolders'))
  if (p.personal) why.push(t('rooms.aiWhyMine'))
  if (p.joinedLater?.length) why.push(t('rooms.aiWhyJoined', { names: p.joinedLater.join(', ') }))
  if (p.outside) why.push(t('rooms.aiWhyOutside'))
  return why.length ? why.join(' ') : t(dm ? 'rooms.aiPrivateAllDm' : 'rooms.aiPrivateAll')
}

/** My private preview of an AI answer, at its top and nowhere else: one line, "🔒 나만 볼 수 있어요 · 올리기" (a text
 * action: not posting is the default), and under it, small, why it stayed with me. Posting leaves out the sources some
 * member cannot read; the server decides that again. Putting it away is in the message's "…" menu. */
function PreviewLine({ roomId, m }: { roomId: string; m: RoomMessage }) {
  const t = useT()
  const locale = useLocale()
  const dm = useRooms((s) => s.rooms.find((r) => r.id === roomId)?.kind === 'dm')
  const [busy, setBusy] = useState(false)
  const share = async () => {
    setBusy(true)
    try {
      await useRooms.getState().shareAi(roomId, m.id)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setBusy(false)
    }
  }
  // put away (deleted): only the lock line, nothing to post
  if (m.deletedAt)
    return (
      <p className="mb-0.5 flex items-center gap-1 text-xs text-faint" data-testid="room-ai-private">
        <Lock size={12} className="shrink-0" aria-hidden />
        {t('rooms.aiPrivate')}
      </p>
    )
  return (
    <div className="mb-1 text-xs text-faint" role="note">
      <p className="flex flex-wrap items-center gap-x-1" data-testid="room-ai-private">
        <Lock size={12} className="shrink-0" aria-hidden />
        {t('rooms.aiPrivate')}
        <span aria-hidden>·</span>
        <button type="button" disabled={busy} onClick={() => void share()} className="touch-hit rounded font-medium text-accent-text hover:underline disabled:opacity-50" data-testid="room-ai-share">
          {t('rooms.aiPost')}
        </button>
      </p>
      <p className="mt-0.5" data-testid="room-ai-preview">{previewWhy(m.preview, t, dm)}</p>
    </div>
  )
}

function Quote({ q, onJump }: { q: RoomQuote; onJump?: () => void }) {
  const t = useT()
  const nameOf = useNameOf()
  const what = q.deleted ? t('rooms.deleted') : q.excerpt || (q.fileCount ? t('rooms.lastFiles', { n: q.fileCount }) : '')
  const inner = (
    <>
      <span className="block truncate font-medium text-muted">{nameOf(q.author) ?? t('rooms.goneUser')}</span>
      <span className="block truncate text-faint">{what}</span>
    </>
  )
  const cls = 'mt-0.5 mb-1 block max-w-full border-l-2 border-line-strong pl-2 text-left text-xs'
  return onJump ? (
    <button type="button" onClick={onJump} className={clsx(cls, 'hover:border-ink')} data-testid="message-quote">
      {inner}
    </button>
  ) : (
    <div className={cls} data-testid="message-quote">
      {inner}
    </div>
  )
}

function Files({ roomId, files }: { roomId: string; files: RoomFile[] }) {
  const t = useT()
  const locale = useLocale()
  const url = (f: RoomFile, query: Record<string, string>) => api.url(API.roomFile, { params: { id: roomId, fileId: f.id }, query })
  const preview = async (f: RoomFile) => {
    try {
      const res = await api.call(API.roomFile, { params: { id: roomId, fileId: f.id } })
      openFilePreview({ source: 'local', name: f.name, blob: await readBounded(res, 60 * 1024 * 1024) })
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  return (
    <div className="mt-1 mb-0.5 flex flex-wrap items-start gap-2">
      {files.map((f) =>
        f.kind === 'image' && f.thumb ? (
          <button key={f.id} type="button" onClick={() => void preview(f)} aria-label={t('rooms.openImage', { name: f.name })} title={f.name} className="overflow-hidden rounded-lg border border-line bg-subtle" data-testid="room-image">
            <RoomThumb f={f} src={url(f, { thumb: '1' })} />
          </button>
        ) : (
          <button key={f.id} type="button" onClick={() => startDownload(url(f, { download: '1' }), f.name)} aria-label={t('rooms.download', { name: f.name })} className="inline-flex max-w-full items-center gap-2 rounded-xl border border-line bg-surface py-1.5 pr-2.5 pl-2.5 text-xs hover:bg-hover" data-testid="room-file">
            <FileText size={15} className="shrink-0 text-muted" aria-hidden />
            <span className="max-w-[220px] truncate font-medium text-ink">{f.name}</span>
            <span className="shrink-0 text-faint">{formatSize(f.size, locale)}</span>
            <Download size={13} className="shrink-0 text-faint" aria-hidden />
          </button>
        ),
      )}
    </div>
  )
}

function EditForm({ roomId, m, initial, members, meId, onDone }: { roomId: string; m: RoomMessage; initial: UserRef[]; members: UserRef[]; meId: string | null; onDone: () => void }) {
  const t = useT()
  const locale = useLocale()
  // the box gives line breaks back as "\n" (a message from another app may have "\r\n"): the mentions' places are counted
  // in the same text
  const body0 = useMemo(() => lineBreaks(m.body), [m.body])
  const [draft, setDraft] = useState(body0)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  // the mentions it has stand out as they do on the message (its "@전체" too), and stay mentions while they are whole
  const [picked] = useState(() => pickedInMessage(body0, [...initial, ...allMentionNames(m, MENTION_ALL_WORDS)]))
  // "@전체" only kept or taken out: an edit notifies nobody, so it cannot add one (the server refuses it)
  const everyone = m.mentionsAll ? { count: members.filter((x) => x.id !== meId).length } : null
  const mention = useMentionMenu({ text: draft, setText: setDraft, input, members, meId, initial: picked, everyone })
  const save = async () => {
    const body = draft.trim()
    if (!body || busy) return
    if (body === body0) return onDone()
    setBusy(true)
    try {
      await useRooms.getState().edit(roomId, m.id, body, mention.mentions(), mention.mentionsAll())
      onDone()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setBusy(false)
    }
  }
  return (
    <form
      className="my-1 rounded-2xl border border-field-border bg-surface p-2 has-[textarea:focus]:border-accent has-[textarea:focus]:ring-1 has-[textarea:focus]:ring-accent"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {mention.list}
      <TokenTextarea
        ref={input}
        autoFocus
        aria-label={t('rooms.editLabel')}
        value={draft}
        {...mention.inputProps}
        onKeyDown={(e) => {
          if (mention.onKeyDown(e)) return
          if (e.key === 'Escape') {
            e.preventDefault()
            onDone()
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && !window.matchMedia?.('(pointer: coarse)').matches) {
            e.preventDefault()
            void save()
          }
        }}
        className={clsx(inputCls, 'h-auto min-h-16 resize-y border-0 py-2 focus:ring-0!')}
        data-testid="room-edit-input"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" type="submit" busy={busy} disabled={!draft.trim()} data-testid="room-edit-save">
          {t('common.save')}
        </Button>
      </div>
    </form>
  )
}

function PendingRow({ roomId, p }: { roomId: string; p: PendingSend }) {
  const t = useT()
  return (
    <div className="py-0.5" data-testid="room-pending-message" data-state={p.state}>
      {p.body && <p className="text-reading leading-reading break-words whitespace-pre-wrap text-muted">{p.body}</p>}
      {p.files.length > 0 && <p className="truncate text-xs text-muted">{p.files.map((f) => f.name).join(', ')}</p>}
      {p.state === 'sending' ? (
        <p className="text-xs text-faint" role="status">
          {t('rooms.sending')}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs" role="alert">
          <span className="text-danger">
            {t('rooms.sendFailed')}
            {p.error && ` · ${p.error}`}
          </span>
          <Button size="sm" variant="ghost" onClick={() => useRooms.getState().retry(roomId, p.clientMessageId)}>
            {t('common.retry')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => useRooms.getState().discard(roomId, p.clientMessageId)}>
            {t('rooms.discard')}
          </Button>
        </div>
      )}
    </div>
  )
}
