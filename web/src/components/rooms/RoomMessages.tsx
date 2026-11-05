// The messages of a room, oldest first: one author's messages close together share one avatar, name and time
// (lib/rooms.ts groupRuns), a date line starts each day, and each message shows how many members have not read it yet
// (only when some have not, like KakaoTalk's number). A message's text is another member's words: plain text with its
// line breaks, never HTML or Markdown; the @names it mentions stand out. "…" on a message (always shown on touch
// screens) answers it, and edits or deletes one's own. Images show as thumbnails that open in the side panel; other
// files are chips that download.
// The AI's answers (docs/DECISIONS.md "대화방의 트리나") are the one exception to plain text: written by the AI, shown
// like an answer in the AI chat (Markdown, the files it used) without its steps, with who asked ("○○ 님이 물어봄", a
// click goes to the question). A private preview, seen only by the person who asked, says why it is private and has
// one action: post it to the room.
import clsx from 'clsx'
import { CornerUpLeft, Download, FileText, Lock, Pencil, Sparkles, Trash2 } from 'lucide-react'
import { Fragment, useMemo, useRef, useState } from 'react'
import type { Locale, RoomFile, RoomMessage, RoomQuote, UserRef } from '@mycel/shared/api'
import { api, API, errorText, readBounded, startDownload } from '../../lib/api'
import { formatDateTime, formatSize, intlTag } from '../../lib/format'
import { aiMentionNames, groupRuns, mentionParts } from '../../lib/rooms'
import { Markdown } from '../Markdown'
import SourcesList from '../chat/SourcesList'
import { openFilePreview } from '../../lib/sidePanel'
import { useLocale, useT } from '../../i18n'
import { useAvatarOf, usePeople } from '../../store/people'
import { useMe } from '../../store/session'
import { quoteOf, useRooms, type PendingSend } from '../../store/rooms'
import { toast } from '../../store/ui'
import { Avatar } from '../Avatar'
import { Button, confirmDialog, inputCls } from '../ui'
import { MenuButton } from './MenuButton'
import { useMentionMenu } from './useMentionMenu'

const timeOf = (iso: string, locale: Locale) => new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))
const dayOf = (iso: string, locale: Locale) => new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'full' }).format(new Date(iso))
export const messageDomId = (id: string) => `room-msg-${id}`

/** the largest box a thumbnail takes, so the list does not jump while it loads */
function thumbBox(f: RoomFile): { width: number; height: number } | undefined {
  if (!f.width || !f.height) return undefined
  const k = Math.min(1, 320 / f.width, 240 / f.height)
  return { width: Math.round(f.width * k), height: Math.round(f.height * k) }
}

export function RoomMessages({ roomId, messages, pending, meId, members, onReply }: { roomId: string; messages: RoomMessage[]; pending: PendingSend[]; meId: string | null; members: UserRef[]; onReply: (q: RoomQuote) => void }) {
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
    for (const p of Object.values(byId)) map.set(p.id, p.name)
    for (const m of members) map.set(m.id, m.name)
    return map
  }, [byId, members])
  const jump = (id: string) => {
    document.getElementById(messageDomId(id))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlash(id)
    setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600)
  }
  const lastMine = runs.at(-1)?.messages[0]?.author?.id === meId && meId !== null

  return (
    <div data-testid="room-messages">
      {runs.map((run) => {
        const first = run.messages[0]!
        return (
          <Fragment key={run.key}>
            {run.newDay && (
              <div role="separator" className="flex items-center gap-3 py-3 text-[11px] font-medium text-faint">
                <span className="h-px flex-1 bg-line" aria-hidden />
                {dayOf(first.createdAt, locale)}
                <span className="h-px flex-1 bg-line" aria-hidden />
              </div>
            )}
            <div className="flex gap-3 pt-2" data-testid="room-run">
              <RunAvatar m={first} />
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium text-ink">{first.authorKind === 'ai' ? t('rooms.aiName') : (first.author?.name ?? t('rooms.goneUser'))}</span>
                  <time dateTime={first.createdAt} title={formatDateTime(first.createdAt, locale)} className="shrink-0 text-xs text-faint">
                    {timeOf(first.createdAt, locale)}
                  </time>
                </p>
                {run.messages.map((m) => (
                  <MessageRow
                    key={m.id}
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
                    onReply={() => onReply(quoteOf(m))}
                    onJump={m.replyTo && loaded.has(m.replyTo.id) ? () => jump(m.replyTo!.id) : undefined}
                  />
                ))}
              </div>
            </div>
          </Fragment>
        )
      })}
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

function MessageRow({ roomId, m, mine, names, members, meId, editing, flash, onEdit, onEditDone, onReply, onJump }: { roomId: string; m: RoomMessage; mine: boolean; names: Map<string, string>; members: UserRef[]; meId: string | null; editing: boolean; flash: boolean; onEdit: () => void; onEditDone: () => void; onReply: () => void; onJump?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const deleted = !!m.deletedAt
  const ai = m.authorKind === 'ai'
  const me = useMe()
  // an AI answer: the person who asked puts it (or their preview) away; an owner or admin any answer they see
  const removable = mine || (ai && !!meId && (m.askedBy?.id === meId || me?.user.role === 'owner' || me?.user.role === 'admin'))
  const openable = useMemo(() => (ai ? new Set(m.openable ?? []) : undefined), [ai, m.openable])
  const mentioned = useMemo(() => m.mentions.map((id) => ({ id, name: names.get(id) ?? '' })), [m.mentions, names])
  // "@트리나" stands out like a person's name (the server asked the AI for it)
  const parts = useMemo(() => mentionParts(m.body, ai ? mentioned : [...mentioned, ...aiMentionNames(m.body, mentioned)]), [m.body, mentioned, ai])
  const del = async () => {
    const ok = await confirmDialog({ title: t('rooms.deleteTitle'), body: t('rooms.deleteBody'), confirm: t('common.delete'), danger: true })
    if (!ok) return
    await useRooms
      .getState()
      .remove(roomId, m.id)
      .catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))
  }
  const meta = (
    <>
      {m.editedAt && !deleted && <span className="ml-1 text-xs text-faint">{t('rooms.edited')}</span>}
      {m.unread > 0 && !deleted && (
        <span className="ml-1.5 text-[11px] font-medium text-accent-text tabular-nums" data-testid="message-unread">
          <span aria-hidden>{m.unread}</span>
          <span className="sr-only">{t('rooms.unreadBy', { n: m.unread })}</span>
        </span>
      )}
    </>
  )
  return (
    <div id={messageDomId(m.id)} className={clsx('group relative -mx-2 rounded-lg px-2 py-0.5 pr-10 transition', flash ? 'bg-accent-soft' : 'hover:bg-subtle')} data-testid="room-message" data-ai={ai ? '' : undefined} data-visibility={m.visibility}>
      {ai ? <AskedBy m={m} onJump={onJump} /> : m.replyTo && <Quote q={m.replyTo} onJump={onJump} />}
      {ai && !deleted ? (
        <>
          <Markdown text={m.body} className="min-w-0" openable={openable} />
          {(m.unread > 0 || m.editedAt) && <p className="leading-5">{meta}</p>}
          {!!m.sourceCount && (
            <SourcesList chatId={roomId} messageId={m.id} count={m.sourceCount} load={(signal) => api.call(API.roomMessageSources, { params: { id: roomId, messageId: m.id }, signal })} />
          )}
          {m.visibility === 'private' && <PreviewNote roomId={roomId} m={m} />}
        </>
      ) : editing ? (
        <EditForm roomId={roomId} m={m} initial={mentioned.filter((x) => x.name)} members={members} meId={meId} onDone={onEditDone} />
      ) : deleted ? (
        <p className="text-[15px] leading-6 text-faint">{t('rooms.deleted')}</p>
      ) : (
        <>
          {m.body && (
            <p className="text-[15px] leading-6 break-words whitespace-pre-wrap text-ink">
              {parts.map((p, i) =>
                p.userId ? (
                  <span key={i} className={clsx('font-medium text-accent-text', p.userId === meId && 'rounded bg-accent-soft px-0.5')}>
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
          {!m.body && (m.unread > 0 || m.editedAt) && <p className="leading-5">{meta}</p>}
        </>
      )}
      {!deleted && !editing && (m.visibility === 'room' || removable) && (
        <MenuButton
          label={t('rooms.messageMenu')}
          className="absolute top-0 right-1"
          buttonClassName="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 max-sm:opacity-100 aria-expanded:opacity-100"
          testId="message-menu"
          items={[
            // a private preview has one action on it (post it); putting it away is in this menu, like any message
            ...(m.visibility === 'room' ? [{ label: t('rooms.reply'), icon: <CornerUpLeft size={14} aria-hidden />, onSelect: onReply, testId: 'message-reply' }] : []),
            ...(mine && !ai ? [{ label: t('common.edit'), icon: <Pencil size={14} aria-hidden />, onSelect: onEdit, testId: 'message-edit' }] : []),
            ...(removable ? [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => void del(), danger: true, testId: 'message-delete' }] : []),
          ]}
        />
      )}
    </div>
  )
}

/** "○○ 님이 물어봄" above an AI answer; a click goes to the question when it is loaded. */
function AskedBy({ m, onJump }: { m: RoomMessage; onJump?: () => void }) {
  const t = useT()
  const text = t('rooms.aiAskedBy', { name: m.askedBy?.name ?? t('rooms.goneUser') })
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

/** My private preview of an AI answer: why only I see it (the folders some member cannot open, named to me only), and
 * its one action. Posting leaves out the sources some member cannot read; the server decides that again. */
function PreviewNote({ roomId, m }: { roomId: string; m: RoomMessage }) {
  const t = useT()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const p = m.preview
  const folders = p?.folders.length ? p.folders.map((f) => (f === '' ? t('rooms.aiRootFolder') : `${f}/`)).join(', ') : ''
  const share = async () => {
    setBusy(true)
    try {
      await useRooms.getState().shareAi(roomId, m.id)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      setBusy(false)
    }
  }
  return (
    <div className="mt-2 mb-1 border-l-2 border-accent pl-3 text-sm" role="note" data-testid="room-ai-preview">
      <p className="flex items-center gap-1.5 font-medium text-ink">
        <Lock size={13} className="shrink-0 text-faint" aria-hidden />
        {t('rooms.aiPrivate')}
      </p>
      {folders && <p className="mt-0.5 text-muted">{t('rooms.aiPrivateFolders', { folders })}</p>}
      {p?.personal && <p className="mt-0.5 text-muted">{t('rooms.aiPrivatePersonal')}</p>}
      {p?.outside && <p className="mt-0.5 text-muted">{t('rooms.aiPrivateOutside')}</p>}
      {!!p?.joinedLater?.length && <p className="mt-0.5 text-muted">{t('rooms.aiPrivateJoined', { names: p.joinedLater.join(', ') })}</p>}
      <Button size="sm" variant="primary" className="mt-2" busy={busy} onClick={() => void share()} data-testid="room-ai-share">
        {t('rooms.aiShare')}
      </Button>
    </div>
  )
}

function Quote({ q, onJump }: { q: RoomQuote; onJump?: () => void }) {
  const t = useT()
  const what = q.deleted ? t('rooms.deleted') : q.excerpt || (q.fileCount ? t('rooms.lastFiles', { n: q.fileCount }) : '')
  const inner = (
    <>
      <span className="block truncate font-medium text-muted">{q.author?.name ?? t('rooms.goneUser')}</span>
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
            <img src={url(f, { thumb: '1' })} alt="" loading="lazy" style={thumbBox(f)} className="block max-h-60 max-w-full object-cover" />
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
  const [draft, setDraft] = useState(m.body)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const mention = useMentionMenu({ text: draft, setText: setDraft, input, members, meId, initial })
  const save = async () => {
    const body = draft.trim()
    if (!body || busy) return
    if (body === m.body) return onDone()
    setBusy(true)
    try {
      await useRooms.getState().edit(roomId, m.id, body, mention.mentions())
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
      <textarea
        ref={input}
        autoFocus
        aria-label={t('rooms.editLabel')}
        value={draft}
        {...mention.inputProps}
        onChange={(e) => {
          setDraft(e.target.value)
          mention.track()
        }}
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
      {p.body && <p className="text-[15px] leading-6 break-words whitespace-pre-wrap text-muted">{p.body}</p>}
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
