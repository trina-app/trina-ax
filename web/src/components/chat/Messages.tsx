// One message of the visible branch. User messages: bubble, attachments (image thumbnails), edit, "‹ 2/3 ›",
// "sending" / "not sent [send again]". Answers: steps, queue position, Markdown, artifact cards, ask_user cards,
// file summary, end state (error / stopped / paused at the per-answer limit with "continue"), the note that a long
// conversation reached the AI only in part, the files the AI looked at ("참고한 파일"), copy, "대화방에 보내기" (a finished
// answer to a room: ShareToRoom.tsx; in a room's side chat one click to the room or the asked message's thread:
// rooms/SendHere.tsx), regenerate, branch switch. A side chat's question shows without the thread its quote names
// (shared rooms.ts hideThreadRef), in copy and edit too (an edit keeps it while the quote's header stays).
// Like Claude: an answer is plain text in the column, with no picture beside it; its actions stay under the newest
// answer and show on older ones when the pointer or focus is on them. A phone has no hover: there a message's actions
// (copy, edit, retry) show once the message is tapped, the newest answer's always; until then they are hidden from
// sight only (screen readers and a keyboard still reach them), and the branch switch ("‹ 1 / 2 ›") always shows.
// A file sent with a message is a small card above the bubble: its name, its type and its size; a picture is its
// thumbnail, which opens the image viewer (components/ImageViewer.tsx), with the chat's other pictures by ← →.
// A shared project chat (docs/DECISIONS.md "Shared project chats"): every question, mine too, has its sender's picture
// and name above it, and edit, regenerate and "대화방에 보내기" are only on what I asked myself. An answer hidden from me
// there (Message.withheld: it used something I cannot open, and I did not see the chat then) is one faint line in its
// place, the rooms' words ("볼 수 없는 자료를 참고한 답이라 가려졌어요"), with only its branch switch.
import clsx from 'clsx'
import { AlertTriangle, BookmarkPlus, ChevronDown, ChevronLeft, ChevronRight, CirclePause, History, Info, Loader2, MessageSquareShare, Paperclip, Pencil, Play, RotateCcw, Shapes, Square } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { DECK_ARTIFACT_KEY, PROMO_ARTIFACT_KEY, chatErrorReason, ERROR_MESSAGES, hideThreadRef, isDefaultErrorMessage, sideQuoteOf, skillLabel, type Attachment, type EngineId, type SideQuote, type Step, type UserRef } from '@mycel/shared/api'
import { thumbnailUrl } from '../../lib/api'
import { answerHtml } from '../../lib/richCopy'
import { formAnswers } from '../../lib/skillForm'
import { skillByName, splitCommand, useSkillList } from '../../lib/skillTitles'
import { formatSize } from '../../lib/format'
import { openArtifact, openTeamFile, useSidePanel } from '../../lib/sidePanel'
import { TEAM_FILE_DRAG_TYPE } from '../../lib/teamAttach'
import { useChatArtifacts } from '../../lib/useArtifacts'
import { useLocale, useT } from '../../i18n'
import { useChats, useQueuePosition } from '../../store/chats'
import { useMessageBuild } from '../../store/deckBuilds'
import { readsForDeck } from '../../lib/deckProgress'
import { useAiAccess } from '../../store/aiAccess'
import { canChooseEngine, useMe } from '../../store/session'
import { useEngines } from '../../store/engines'
import { toast } from '../../store/ui'
import { useAvatarOf, useNameOf, usePeopleList } from '../../store/people'
import type { ViewMessage } from '../../store/thread'
import { TYPE_LABEL } from '../artifactLabels'
import { Avatar } from '../Avatar'
import { Markdown } from '../Markdown'
import AiAccessButton from './AiAccessButton'
import { isNoAiReason } from '../../lib/aiAccess'
import { adminPath, chatErrorText } from '../../lib/chatErrors'
import { Button, CopyButton, IconButton, inputCls, useMediaQuery } from '../ui'
import AskCard from './AskCard'
import ConnectCard from './ConnectCard'
import { SecretWarning, useSecretHold } from './SecretWarning'
import SuggestSkillDialog from '../SuggestSkillDialog'
import ShareToRoom from './ShareToRoom'
import { SendHere, SendHereNote, type SentHere } from '../rooms/SendHere'
import { keepThreadRef, type SendTarget } from '../../lib/sideChatSend'
import FileSummary from './FileSummary'
import SourcesList from './SourcesList'
import Steps, { StepPostView } from './Steps'
import DeckProgress from './DeckProgress'
import { SkillChip } from './SkillChip'
import { copyRoomIds, WithRoomNames } from '../RoomNames'
import { fromWire, toWire } from '../../lib/roomRefs'
import { ENGINE_LABEL, EngineOptions, type EnginePick } from './EngineMenu'
import { EngineSheet } from './EngineSheet'
import { Tooltip } from '../Tooltip'
import { useViewerItem } from '../ImageViewer'
import { attachmentItem } from '../../lib/imageViewer'

export { ENGINE_LABEL }

/** a message's actions on a screen with a mouse: shown while the pointer or focus is on the message */
const ON_HOVER = 'transition [@media(hover:hover)]:opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
/** a message's actions on a phone (a touch screen under 768px) until the message is tapped: out of sight and out of the
 * way of the finger (not an invisible button that takes the tap), but still read by a screen reader and shown once a
 * keyboard's focus is in them */
export const UNTIL_TAP = 'max-md:pointer-coarse:not-focus-within:sr-only'

/** "notes.txt" -> "TXT": the file's type on its card (none for a name without one) */
const typeOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  return ext && ext.length <= 5 ? ext.toUpperCase() : ''
}

export function BranchNav({ m, onSelect, disabled }: { m: ViewMessage; onSelect: (id: string) => void; disabled?: boolean }) {
  const t = useT()
  const { index, count, siblingIds } = m.branch
  if (count < 2) return null
  return (
    <span className="inline-flex items-center text-xs text-faint" data-testid="branch-nav">
      <IconButton label={t('chat.prevBranch')} disabled={disabled || index === 0} onClick={() => onSelect(siblingIds[index - 1]!)}>
        <ChevronLeft size={14} />
      </IconButton>
      <span className="tabular-nums" data-testid="branch-label">
        {index + 1} / {count}
      </span>
      <IconButton label={t('chat.nextBranch')} disabled={disabled || index >= count - 1} onClick={() => onSelect(siblingIds[index + 1]!)}>
        <ChevronRight size={14} />
      </IconButton>
    </span>
  )
}

export function AttachmentView({ a, align = 'end' }: { a: Attachment; align?: 'start' | 'end' }) {
  const t = useT()
  const locale = useLocale()
  const [thumbFailed, setThumbFailed] = useState(false)
  // the soft box holds the place while the thumbnail loads; then a picture with transparency sits on the page itself
  const [thumbLoaded, setThumbLoaded] = useState(false)
  const team = a.source === 'team'
  // a picture opens the image viewer (the chat's other pictures by ← →), any other file the side panel
  const picture = a.kind === 'image' && !thumbFailed && !(team && a.unavailable)
  const viewer = useViewerItem(picture ? (meta) => attachmentItem(a, meta) : null)
  // a team file that was deleted or that the person can no longer open: the server sent nothing about it
  if (team && a.unavailable)
    return (
      <span className={clsx('inline-flex max-w-[80%] items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm text-faint', align === 'end' && 'self-end')} data-testid="attachment-unavailable">
        {t('attach.unavailable')}
      </span>
    )
  if (picture)
    return (
      // the same box as a file card, so a tiny or a large image keeps the row even; the image fills it (cropped)
      <Tooltip label={t('common.previewNamed', { name: a.name })}>
        <button type="button" ref={viewer.ref} onClick={viewer.open} className={clsx('h-24 w-36 max-w-full shrink-0 overflow-hidden rounded-xl border border-line sm:w-44', align === 'end' && 'self-end')} aria-label={t('common.previewNamed', { name: a.name })} data-testid="attachment-image">
          <img src={thumbnailUrl(a.id)} alt={a.name} loading="lazy" onLoad={() => setThumbLoaded(true)} onError={() => setThumbFailed(true)} className={clsx('block h-full w-full object-cover', !thumbLoaded && 'bg-subtle')} />
        </button>
      </Tooltip>
    )
  const ext = typeOf(a.name)
  const body = (
    <>
      <span className="line-clamp-2 font-medium [overflow-wrap:anywhere]">{a.name}</span>
      {team && <span className="sr-only">{t('composer.teamFile', { path: a.path })}</span>}
      <span className="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pt-2 text-micro text-faint">
        {ext && <span className="rounded border border-line px-1 leading-4 font-medium text-muted">{ext}</span>}
        {formatSize(a.size, locale)}
        {team && a.changed && <span className="text-warn">{t('attach.changed')}</span>}
        {team && a.moved && !a.changed && <span>{t('attach.moved')}</span>}
      </span>
    </>
  )
  const cls = clsx('flex min-h-24 w-36 max-w-full flex-col rounded-xl border p-3 text-sm sm:w-44', team ? 'border-accent/30 bg-accent-soft' : 'border-line bg-surface')
  // a team file can be dragged from the message into the message box again
  const drag = team
    ? {
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
          e.dataTransfer.setData(TEAM_FILE_DRAG_TYPE, a.path)
          e.dataTransfer.setData('text/plain', a.path)
          e.dataTransfer.effectAllowed = 'copy'
        },
      }
    : {}
  // every attachment opens the file panel; a format without a viewer shows the notice and a download button there
  return (
    <button type="button" className={clsx(cls, 'text-left hover:bg-hover')} onClick={() => openTeamFile(a.path)} title={team ? t('composer.teamFile', { path: a.path }) : t('common.preview')} data-source={a.source ?? 'upload'} {...drag}>
      {body}
    </button>
  )
}

/** A question as the person reads it: one that runs a skill shows the skill by its title as a chip ("할 일 정리") and
 * then the rest of the question, in place of "/meeting-tasks …" (the command is what was sent and what runs; copy and
 * edit keep it). A command no skill of the person's has stays as it was typed. In a room's side chat (`quotes`; also
 * opened as a full chat) a question about a message or a file (shared rooms.ts sideQuoteOf) shows that as a quote on top,
 * as the side chat's box showed it before it went (who, when, its lines; a file by its name), never its Markdown or the
 * thread it names; the question below it. Folded (`clamp`, a long question) the quote shows its first 3 lines and 전체
 * 보기 opens it too. Other chats show a quote typed by hand as it was typed. */
export function UserText({ content: sent, clamp, quotes = false }: { content: string; clamp: boolean; quotes?: boolean }) {
  const quote = quotes ? sideQuoteOf(sent) : null
  const content = quote ? quote.question : hideThreadRef(sent)
  const cmd = splitCommand(content)
  const items = useSkillList(!!cmd)
  const skill = cmd && items ? skillByName(items, cmd.name) : null
  // "#" rooms the person picked (#[마케팅](room:<id>)) show as chips by their titles; a room named by its id alone (a
  // scheduled run's question is its instruction, "… room_id <id>") by its name for a viewer in it (components/RoomNames.tsx)
  const text = !cmd || !skill ? (
    content && <div className={clsx('whitespace-pre-wrap [overflow-wrap:anywhere]', clamp && 'line-clamp-[12]')} onCopy={copyRoomIds}><WithRoomNames text={content} tokenTitles /></div>
  ) : (
    <div data-testid="user-text-skill">
      <SkillChip title={skillLabel(skill)} name={skill.name} />
      {cmd.rest.trim() && <div className={clsx('mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]', clamp && 'line-clamp-[12]')} onCopy={copyRoomIds}><WithRoomNames text={cmd.rest} tokenTitles /></div>}
    </div>
  )
  if (!quote) return text
  return (
    <>
      <SideQuoteBlock quote={quote} clamp={clamp} />
      {text}
    </>
  )
}

/** The room's message or file a side chat question is about, as a quote at the top of the bubble; `clamp`: its first 3
 * lines (the message is folded: 전체 보기 shows the rest) */
function SideQuoteBlock({ quote, clamp }: { quote: SideQuote; clamp: boolean }) {
  return (
    <blockquote className="mb-1.5 border-l-2 border-line-strong pl-2 text-xs leading-5" data-testid="user-quote">
      {quote.kind === 'file' ? (
        <p className="flex min-w-0 items-center gap-1 text-muted" data-testid="user-quote-file">
          <Paperclip size={12} aria-hidden className="shrink-0" />
          <span className="truncate">{quote.name}</span>
        </p>
      ) : (
        <>
          <p className="font-medium text-ink" data-testid="user-quote-head">
            {quote.author} <span className="font-normal text-faint">{quote.at}</span>
          </p>
          <p className={clsx('break-words whitespace-pre-wrap text-muted', clamp && 'line-clamp-3')} data-testid="user-quote-text">{quote.text}</p>
        </>
      )}
    </blockquote>
  )
}

/** A form run (a skill's form sent its answers: "/card-news" and "어디에 올릴까요: 인스타그램"), or null: the skill's
 * chip and the answers. The person picked them, they did not write them, so they are not shown as a message they
 * typed (docs/DECISIONS.md "W3"). */
function useFormRun(content: string) {
  const cmd = splitCommand(content)
  const items = useSkillList(!!cmd)
  const skill = cmd && items ? skillByName(items, cmd.name) : null
  const answers = cmd && skill ? formAnswers(cmd.rest, skill.inputs) : null
  return skill && answers ? { skill, answers } : null
}

/** Answers this long or longer (as one line), or with a value of several lines, fold under "전체 보기". */
export const FORM_RUN_FOLD_CHARS = 140

/** The skill as a chip, the answers as one quiet line under it ("인스타그램 · 신제품 출시"; each answer's label is its
 * tooltip and is read out), right-aligned like the person's messages, with no bubble. Short answers show in full; long
 * ones (or a value of several lines) show two lines and "전체 보기", which lists every answer under its label as it was
 * sent ("접기" folds them again). */
export function FormRun({ run, sending = false }: { run: NonNullable<ReturnType<typeof useFormRun>>; sending?: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const line = run.answers.map((a) => a.value.replace(/\s+/g, ' ')).join(' · ')
  const long = line.length >= FORM_RUN_FOLD_CHARS || run.answers.some((a) => a.value.includes('\n'))
  return (
    <div className={clsx('flex max-w-[85%] min-w-0 flex-col items-end gap-1 sm:max-w-[80%]', sending && 'opacity-70')} data-testid="user-form-run">
      <SkillChip title={skillLabel(run.skill)} name={run.skill.name} />
      {open ? (
        <dl className="space-y-1 text-right text-[0.8125rem] leading-5 [overflow-wrap:anywhere]" data-testid="user-form-answers" data-open="true">
          {run.answers.map((a, i) => (
            <div key={i}>
              <dt className="text-faint">{a.label}</dt>
              <dd className="whitespace-pre-wrap text-muted">{a.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className={clsx('text-right text-[0.8125rem] leading-5 text-muted [overflow-wrap:anywhere]', long && 'line-clamp-2')} data-testid="user-form-answers">
          {run.answers.map((a, i) => (
            <span key={i} title={a.label}>
              {i > 0 && <span aria-hidden> · </span>}
              <span className="sr-only">{a.label}: </span>
              {a.value.replace(/\s+/g, ' ')}
            </span>
          ))}
        </p>
      )}
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs font-medium text-muted hover:text-ink" aria-expanded={open} data-testid="user-form-answers-toggle">
          {open ? t('chat.showLess') : t('chat.showAll')}
        </button>
      )}
    </div>
  )
}

/** Who asked, above a question of a shared chat: one quiet line on the right like the bubble, their name as it is (no
 * "님" added, and mine is my name, not "나": a screenshot passed around still says who asked) and their picture at the
 * edge. The picture is the people directory's (as in rooms; every role may read it), read here once a shared chat
 * shows; without a photo, or while the directory is not there, the letter. It is decorative: a screen reader reads the
 * name once, then the question. A question without an author (the server sends none only for a message with no author
 * id) gets an empty tile and "알 수 없는 사용자", so it never reads as the previous person's or as mine. */
export function MessageAuthor({ author }: { author: UserRef | null }) {
  const t = useT()
  const me = useMe()
  usePeopleList()
  const listed = useAvatarOf(author)
  const nameOf = useNameOf()
  // the name as it is now (a rename shows at once, as in rooms); my own photo from /api/me while the directory has none
  // for me (not read yet, or it failed)
  const user = listed && { ...listed, name: nameOf(listed) ?? listed.name, avatarVersion: listed.avatarVersion ?? (listed.id === me?.user.id ? me.user.avatarVersion : undefined) }
  return (
    <div className="-mb-1 flex max-w-[85%] min-w-0 items-center gap-1.5 sm:max-w-[80%]" data-testid="message-author-row">
      <span className="min-w-0 truncate text-xs font-medium text-muted" data-testid="message-author">
        {user ? user.name : t('rooms.goneUser')}
      </span>
      {user ? <Avatar user={user} size={20} /> : <span aria-hidden className="size-5 shrink-0 rounded-full bg-hover" data-testid="message-author-unknown" />}
    </div>
  )
}

/** `showAuthor`: a shared chat, every question shows who asked (MessageAuthor); `canEdit` false: not mine to edit (a
 * shared chat); `sideChat`: a room's side chat, whose questions may quote a room message or file (UserText) */
export function UserMessage({ m, chatId, busy, onEdit, onSelectBranch, showAuthor = false, canEdit = true, sideChat = false }: { m: ViewMessage; chatId: string; busy: boolean; onEdit: (m: ViewMessage, text: string) => void; onSelectBranch: (id: string) => void; showAuthor?: boolean; canEdit?: boolean; sideChat?: boolean }) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  // the box shows a "#" room token as "#<title>"; what is sent again keeps its room (lib/roomRefs.ts); a side chat's
  // quote shows without its thread, which goes back on while the quote's header line stays (lib/sideChatSend.ts)
  const shown = hideThreadRef(m.content)
  const [draft, setDraft] = useState(() => fromWire(shown).text)
  /** the edited text looks like a key: it waits for "Send anyway" (SecretWarning) */
  const secret = useSecretHold(draft)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const sendEdit = () => {
    setEditing(false)
    onEdit(m, keepThreadRef(toWire(draft, fromWire(shown).picked), m.content))
  }
  const resend = useChats((s) => s.resend)
  const discard = useChats((s) => s.discardLocal)
  const long = m.content.length > 1200 || m.content.split('\n').length > 18
  const [open, setOpen] = useState(!long)
  const run = useFormRun(m.content)
  // phones: the actions show once the message is tapped
  const [tapped, setTapped] = useState(false)
  const branched = m.branch.count > 1
  return (
    <div className="group flex min-w-0 flex-col items-end gap-2" data-testid="user-message" data-message-id={m.id} onClick={() => setTapped(true)}>
      {showAuthor && <MessageAuthor author={m.author} />}
      {m.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap items-end justify-end gap-2">
          {m.attachments.map((a) => (
            <AttachmentView key={a.id} a={a} />
          ))}
        </div>
      )}
      {editing ? (
        <form
          className="w-full max-w-[85%] rounded-2xl border border-field-border bg-surface p-2 has-[textarea:focus]:border-accent has-[textarea:focus]:ring-1 has-[textarea:focus]:ring-accent"
          onSubmit={(e) => {
            e.preventDefault()
            if (!draft.trim() || !secret.pass()) return
            sendEdit()
          }}
        >
          {/* the form draws the field's edge and focus; `!`: inputCls's own focus ring is emitted after ring-0 and would win */}
          <textarea ref={editRef} aria-label={t('chat.editMessage')} className={clsx(inputCls, 'h-auto min-h-24 resize-y border-0 py-2 focus:ring-0!')} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus data-testid="edit-input" />
          <p className="px-1 pb-1 text-xs text-faint">{t('chat.editNote')}</p>
          {secret.held && (
            <SecretWarning
              onSendAnyway={() => {
                secret.release()
                sendEdit()
              }}
              onEdit={() => {
                secret.release()
                editRef.current?.focus()
              }}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                secret.release()
                setEditing(false)
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={!draft.trim()} data-testid="edit-send">
              {t('chat.send')}
            </Button>
          </div>
        </form>
      ) : run ? (
        <FormRun run={run} sending={!!m.local} />
      ) : (
        m.content && (
          <div className={clsx('max-w-[85%] min-w-0 rounded-3xl bg-subtle px-4 py-2.5 text-reading leading-7 max-md:leading-reading sm:max-w-[80%]', m.local && 'opacity-70')} data-testid="user-text">
            <UserText content={m.content} clamp={!open} quotes={sideChat} />
            {long && (
              <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 text-xs font-medium text-muted select-none hover:text-ink">
                {open ? t('chat.showLess') : t('chat.showAll')}
              </button>
            )}
          </div>
        )
      )}
      {m.local?.state === 'sending' && (
        <span className="flex items-center gap-1 text-xs text-faint" role="status">
          <Loader2 size={12} className="animate-spin" aria-hidden /> {t('chat.sending')}
        </span>
      )}
      {m.local?.state === 'failed' && (
        <span className="flex flex-wrap items-center justify-end gap-2 text-xs text-danger" role="alert" data-testid="send-failed">
          <AlertTriangle size={13} aria-hidden /> {t('chat.notSent')}
          {m.local.error && <span className="basis-full text-right">{m.local.error}</span>}
          <button type="button" className="font-medium underline" onClick={() => void resend(chatId, m.id)}>
            {t('chat.sendAgain')}
          </button>
          <button type="button" className="text-faint underline" onClick={() => discard(chatId, m.id)}>
            {t('common.delete')}
          </button>
        </span>
      )}
      {!m.local && !editing && (
        // phones: the branch switch stays in sight; without one the row takes no room until the tap
        <div className={clsx('flex items-center gap-1 select-none', ON_HOVER, !tapped && !branched && UNTIL_TAP)} data-testid="message-actions">
          <BranchNav m={m} onSelect={onSelectBranch} disabled={busy} />
          <span className={clsx('flex items-center gap-1 md:contents', !tapped && UNTIL_TAP)} data-testid="message-actions-tap">
            <CopyButton text={shown} />
            {canEdit && (
              <IconButton
                label={t('chat.edit')}
                onClick={() => {
                  setDraft(fromWire(shown).text)
                  setEditing(true)
                }}
                data-testid="edit-message"
              >
                <Pencil size={13} />
              </IconButton>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

/** `className`: the spacing around the cards (default: a gap above, after the answer's text) */
function ArtifactCards({ chatId, messageId, className = 'mt-3' }: { chatId: string; messageId: string; className?: string }) {
  const t = useT()
  const groups = useChatArtifacts(chatId)
  const live = useChats((s) => s.liveArtifacts[chatId])
  const panel = useSidePanel()
  const cards = useMemo(() => {
    const out = new Map<string, { key: string; title: string | null; type: keyof typeof TYPE_LABEL; version: number | null; writing: boolean }>()
    for (const g of groups ?? []) {
      const here = g.versions.filter((v) => v.messageId === messageId)
      const latest = here.sort((a, b) => b.version - a.version)[0]
      if (latest) out.set(g.key, { key: g.key, title: latest.title, type: latest.type, version: latest.version, writing: false })
    }
    for (const a of Object.values(live ?? {})) {
      if (a.messageId !== messageId) continue
      if (a.status === 'writing') out.set(a.key, { key: a.key, title: a.title, type: a.type, version: out.get(a.key)?.version ?? null, writing: true })
      else if (!out.has(a.key)) out.set(a.key, { key: a.key, title: a.title, type: a.type, version: a.version, writing: false })
    }
    return [...out.values()]
  }, [groups, live, messageId])
  if (!cards.length) return null
  return (
    <div className={clsx('flex flex-col gap-2', className)} data-testid="artifact-cards">
      {cards.map((a) => {
        const open = panel?.kind === 'artifact' && panel.artifactKey === a.key && panel.chatId === chatId
        return (
          <button
            key={a.key}
            type="button"
            onClick={() => openArtifact(chatId, a.key)}
            data-testid="artifact-card"
            data-state={a.writing ? 'writing' : 'done'}
            className={clsx('flex max-w-md items-center gap-3 rounded-xl border bg-surface px-3 py-2.5 text-left shadow-sm transition hover:bg-hover', open ? 'border-accent' : 'border-line')}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">{a.writing ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Shapes size={18} aria-hidden />}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{a.title || a.key}</span>
              <span className="block text-xs text-muted">
                {/* a promo video (docs/DECISIONS.md "V") is a video to people and an intro deck ("D2") a deck, whatever
                    page shows it */}
                {a.key === PROMO_ARTIFACT_KEY ? t('promo.kind') : a.key === DECK_ARTIFACT_KEY ? t('deck.kind') : t(TYPE_LABEL[a.type])}
                {a.version ? ` · v${a.version}` : ''} · {a.writing ? t('artifact.writing') : t('artifact.clickToOpen')}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Where the answer's artifact cards go: at the point of the text where the AI made the first one (Step.textAt), so
 * "caption → preview → options" reads in that order; null (after the text, as before) for steps from before that field
 * or when the cut would fall inside a code block. The cut never splits a block: a point inside a paragraph, list or
 * quote moves back to the blank line before that block (or stays when the block ends right there); with no blank line
 * before it, the cards go after the text. */
export function artifactSplit(content: string, steps: readonly Step[]): number | null {
  const at = steps.filter((s) => s.kind === 'artifact' && !s.parentId && s.textAt !== undefined).reduce<number | null>((min, s) => (min === null ? s.textAt! : Math.min(min, s.textAt!)), null)
  if (at === null) return null
  const raw = Math.min(at, content.length)
  if (raw >= content.length) return null
  // made before any text: the cards first
  if (raw === 0) return 0
  const before = content.slice(0, raw)
  // already between blocks: a blank line right before the point, or the block ends at it (a blank line follows)
  let cut: number | null = /\n[ \t]*\n[ \t]*$/.test(before) || /^[ \t]*\n[ \t]*\n/.test(content.slice(raw)) ? raw : null
  if (cut === null) {
    const blank = [...before.matchAll(/\n[ \t]*\n/g)].pop()
    cut = blank ? blank.index! + blank[0].length : null
  }
  if (cut === null) return null
  // a heading stays with the block under it ("### 1안" above its quote): go back before a heading right above the cut
  for (;;) {
    const head = /(^|\n[ \t]*\n)(#{1,6} [^\n]*\n[ \t]*\n)$/.exec(content.slice(0, cut))
    if (!head) break
    cut -= head[2]!.length
  }
  if (cut === 0) return 0
  // an odd number of ``` fences before the cut: it is inside a code block
  if ((content.slice(0, cut).match(/```/g)?.length ?? 0) % 2 === 1) return null
  return cut
}

/** The text before and after the cards (null: none there). While the answer streams, the part still being written is
 * the last one with text: after the cards, or before them while nothing follows yet. */
export function answerParts(content: string, cut: number, streaming: boolean) {
  const before = content.slice(0, cut), after = content.slice(cut)
  const tail = !!after.trim()
  return {
    before: before.trim() ? { text: before, streaming: streaming && !tail } : null,
    after: tail ? { text: after, streaming } : null,
  }
}

/** The answer's text and its artifact cards, the cards where the AI made them. Top-level quotes copy on their own. */
function AnswerBody({ m, chatId, streaming }: { m: ViewMessage; chatId: string; streaming: boolean }) {
  const cut = artifactSplit(m.content, m.steps)
  if (cut === null)
    return (
      <>
        {m.content && <Markdown text={m.content} streaming={streaming} copyQuotes />}
        <ArtifactCards chatId={chatId} messageId={m.id} />
      </>
    )
  const p = answerParts(m.content, cut, streaming)
  return (
    <>
      {p.before && <Markdown text={p.before.text} streaming={p.before.streaming} copyQuotes />}
      <ArtifactCards chatId={chatId} messageId={m.id} className={clsx(p.before && 'mt-3', p.after && 'mb-3')} />
      {p.after && <Markdown text={p.after.text} streaming={p.after.streaming} copyQuotes />}
    </>
  )
}

export function AssistantMessage({
  m,
  chatId,
  isLast,
  busy,
  switchedFrom,
  onRegenerate,
  retryWith,
  onSelectBranch,
  onAskOwnFolder,
  onContinue,
  shareable = false,
  shareRoomId,
  sendHere,
  canRegenerate = true,
  canSuggest = true,
}: {
  m: ViewMessage
  chatId: string
  isLast: boolean
  busy: boolean
  switchedFrom: EngineId | null
  onRegenerate: (m: ViewMessage, with_?: EnginePick) => void
  /** "continue" after an answer that paused at the per-answer limit (the newest answer only) */
  onContinue?: () => void
  /** people who may pick the engine: "retry with another model" next to "retry" on a failed answer */
  retryWith?: { engines: EngineId[]; models: Partial<Record<EngineId, { id: string; label: string }[]>> }
  onSelectBranch: (id: string) => void
  onAskOwnFolder: (path: string) => void
  /** its answers may go to a room ("대화방에 보내기"): a chat known not to be confidential (Safe operations 1A keeps
   * those to themselves; the server refuses them) */
  shareable?: boolean
  /** the room "대화방에 보내기" starts with picked (a side chat opened as a full chat: its room) */
  shareRoomId?: string
  /** a room's side chat (components/rooms/SideChatPanel.tsx): one click to the room or the asked message's thread
   * (rooms/SendHere.tsx) in place of the dialog; `target`: that thread (lib/sideChatSend.ts), null for the room;
   * `onView`: its 보기 */
  sendHere?: { roomId: string; target: SendTarget | null; onView: (sent: SentHere) => void }
  /** false: someone else asked this in a shared chat, so no new answer from me ("retry", "regenerate") */
  canRegenerate?: boolean
  /** false: "스킬로 제안" is not offered (a shared chat, phase 1: the server refuses it) */
  canSuggest?: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const streaming = m.status === 'streaming'
  const queuePos = useQueuePosition(streaming ? m.id : undefined)
  const requests = useChats(useShallow((s) => Object.values(s.requests).filter((r) => r.messageId === m.id)))
  // while a card asks the person (a question or a connection), the AI is not thinking: it waits for them
  const waitingForYou = streaming && requests.length > 0
  // an intro deck being made (docs/DECISIONS.md "D2", round 2): one block in place of its steps, from the click (the
  // question ran the deck skill) or once the server has its build
  const build = useMessageBuild(chatId, m.id)
  const question = useChats((s) => (streaming && m.parentId ? s.threads[chatId]?.messages.find((x) => x.id === m.parentId)?.content : undefined))
  const deck = !!build || readsForDeck(m, question)
  const thinking = streaming && !m.content && !waitingForYou && !deck
  const known = m.error ? ERROR_MESSAGES[m.error.code] : undefined
  const reason = m.error ? chatErrorReason(m.error) : null
  // by who reads it (lib/chatErrors.ts): "no AI" with its button for the owner and admins while no AI answers them
  // (another engine's connection, or one added since, keeps the per-engine words); where to fix it for the owner and
  // admins; what happened and who to tell for everyone else. Never the provider's HTTP status (params.status)
  const role = useMe()?.user.role
  const noAi = useAiAccess((s) => s.loaded && !s.usable)
  const said = reason ? chatErrorText(reason, role, noAi) : null
  const errText = m.error
    ? said ? t(said.key, said.where ? { path: adminPath(t, said.where) } : undefined)
      : m.error.params?.reason === undefined && known && isDefaultErrorMessage(m.error.code, m.error.message) ? known[locale] : m.error.message
    : null
  const [suggesting, setSuggesting] = useState(false)
  const [sharing, setSharing] = useState(false)
  // phones: an older answer's actions show once it is tapped
  const [tapped, setTapped] = useState(false)
  const untilTap = !isLast && !tapped
  const branched = m.branch.count > 1

  if (m.withheld) {
    return (
      <div className="group" data-testid="assistant-message" data-message-id={m.id} data-status={m.status} data-withheld="">
        <p className="text-reading leading-reading text-faint" data-testid="answer-withheld">{t('rooms.withheldAnswer')}</p>
        {branched && (
          <div className="mt-1.5 -ml-1.5 flex items-center" data-testid="withheld-branch">
            <BranchNav m={m} onSelect={onSelectBranch} disabled={busy} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="group" data-testid="assistant-message" data-message-id={m.id} data-status={m.status} aria-busy={streaming} onClick={() => setTapped(true)}>
      <div className="min-w-0 text-reading">
        {switchedFrom && m.engine && (
          <div className="mb-3 flex items-center gap-2 text-xs text-faint">
            <span className="h-px flex-1 bg-line" />
            {t('chat.engineSwitched', { engine: ENGINE_LABEL[m.engine] })}
            <span className="h-px flex-1 bg-line" />
          </div>
        )}
        {streaming && queuePos !== undefined && queuePos > 0 && (
          <p className="mb-2 text-sm text-muted" role="status" data-testid="queue-position">
            {t('chat.queued', { n: queuePos })} <span className="text-faint">{t('chat.queueHint')}</span>
          </p>
        )}
        {deck ? <DeckProgress build={build} steps={m.steps} streaming={streaming} start={Date.parse(m.createdAt)} chatId={chatId} /> : (
          // a side chat: a post's 보기 goes the way its sent line's does (the panel's onView)
          <StepPostView.Provider value={sendHere ? (p) => sendHere.onView({ to: p.threadRootId ? 'thread' : 'room', roomId: p.roomId, rootId: p.threadRootId ?? null, messageId: p.messageId, cut: false }) : null}>
            <Steps steps={m.steps} streaming={streaming} failed={m.status === 'error'} receipt={m.receipt} />
          </StepPostView.Provider>
        )}
        {thinking && (queuePos === undefined || queuePos === 0) && (
          <div className="flex h-7 items-center gap-1" aria-label={t('chat.thinking')} role="status">
            <span className="dot h-1.5 w-1.5 rounded-full bg-faint" />
            <span className="dot h-1.5 w-1.5 rounded-full bg-faint" />
            <span className="dot h-1.5 w-1.5 rounded-full bg-faint" />
            {!m.steps.length && <span className="ml-2 text-sm text-faint">{t('chat.thinking')}</span>}
          </div>
        )}
        <AnswerBody m={m} chatId={chatId} streaming={streaming} />
        {waitingForYou && (
          <p className="mb-2 text-sm text-muted" role="status" data-testid="waiting-for-you">
            {t('chatux.waitingForYou')}
          </p>
        )}
        {requests.map((r) => (r.request.kind === 'connect_service' ? <ConnectCard key={r.request.requestId} request={r.request} /> : <AskCard key={r.request.requestId} req={r} />))}
        {m.files && <FileSummary files={m.files} onAskOwnFolder={onAskOwnFolder} disabled={busy} />}
        {!streaming && m.sourceCount ? <SourcesList chatId={chatId} messageId={m.id} count={m.sourceCount} /> : null}
        {m.status === 'error' && (
          <div role="alert" className="mt-3 flex flex-wrap items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger" data-testid="answer-error">
            <AlertTriangle size={16} className="mt-2 shrink-0" aria-hidden />
            {/* at least ~12rem for the text: on a phone the buttons go to their own line instead of squeezing it; one
                line of text is as tall as the buttons, so text, icon and buttons share a centre line */}
            <span className="min-w-0 flex-[1_1_12rem] py-1 leading-6">{errText ?? t('chat.answerFailed')}</span>
            {isLast && canRegenerate && (
              <span className="ml-auto flex flex-wrap justify-end gap-2">
                {isNoAiReason(reason) && <AiAccessButton />}
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => onRegenerate(m)} data-testid="retry">
                  <RotateCcw size={13} aria-hidden /> {t('common.retry')}
                </Button>
                {retryWith && retryWith.engines.length > 0 && <RetryWithModel m={m} busy={busy} retryWith={retryWith} onPick={(p) => onRegenerate(m, p)} />}
              </span>
            )}
          </div>
        )}
        {m.status === 'stopped' && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-faint">
            <Square size={11} className="fill-current" aria-hidden /> {t('chat.stopped')}
          </p>
        )}
        {m.status === 'done' && m.stopReason && (
          // not an error and not a stop by the person: the answer so far stands, the work can go on from here
          <div role="status" className="mt-3 flex flex-wrap items-start gap-2 rounded-xl border border-line bg-subtle px-3 py-2 text-sm" data-testid="answer-paused" data-reason={m.stopReason}>
            <CirclePause size={16} className="mt-1.5 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-[1_1_12rem] py-1 leading-6">
              <span className="font-medium text-ink">{t('chat.limit.title')}</span> <span className="text-muted">{t(m.stopReason === 'time_limit' ? 'chat.limit.time_limit' : 'chat.limit.tool_limit')}</span>
            </span>
            {isLast && onContinue && (
              <Button size="sm" variant="primary" className="ml-auto" disabled={busy} onClick={onContinue} data-testid="continue">
                <Play size={13} aria-hidden /> {t('chat.limit.continue')}
              </Button>
            )}
          </div>
        )}
        {m.historyTrimmed && isLast && (m.status === 'done' || m.status === 'stopped') && (
          // the newest answer only: it says what the AI has now, not a warning about the past (no summary yet)
          <p role="note" className="mt-3 flex items-start gap-1.5 text-xs leading-5 text-muted" data-testid="memory-note">
            <History size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              {t('chat.memory.note')} <span className="text-faint">{t('chat.memory.tip')}</span>
            </span>
          </p>
        )}
        {!streaming && (
          // phones: an older answer's actions and model name wait for a tap, its branch switch stays in sight; without
          // one the row takes no room until then
          <div className={clsx('mt-1.5 -ml-1.5 flex flex-wrap items-center gap-1 select-none max-md:gap-3', !isLast && ON_HOVER, untilTap && !branched && UNTIL_TAP)} data-testid="answer-actions">
            <span className={clsx('flex items-center gap-1 max-md:gap-3 md:contents', untilTap && UNTIL_TAP)} data-testid="answer-actions-tap">
              {m.content && <CopyButton text={m.content} html={() => answerHtml(m.content)} label={t('chat.copyAnswer')} className="touch-hit" />}
              {/* send to a room: a finished answer to a room I am in, as my message (ShareToRoom); a room's side chat sends it
                  to its room or the asked message's thread with one click (SendHere) */}
              {shareable && m.content && m.status === 'done' && (sendHere ? (
                <SendHere chatId={chatId} answerId={m.id} roomId={sendHere.roomId} target={sendHere.target} onView={sendHere.onView} />
              ) : (
                <IconButton label={t('chat.shareToRoom')} onClick={() => setSharing(true)} className="touch-hit" data-testid="share-to-room">
                  <MessageSquareShare size={13} />
                </IconButton>
              ))}
              {/* the newest failed answer has "Try again" in its error box: one control for one action */}
              {!(m.status === 'error' && isLast) && canRegenerate && (
                <IconButton label={t('chat.regenerate')} disabled={busy} onClick={() => onRegenerate(m)} className="touch-hit" data-testid="regenerate">
                  <RotateCcw size={13} />
                </IconButton>
              )}
              {canSuggest && m.content && m.status === 'done' && (
                <IconButton label={t('suggest.button')} onClick={() => setSuggesting(true)} className="touch-hit" data-testid="suggest-skill">
                  <BookmarkPlus size={13} />
                </IconButton>
              )}
            </span>
            <BranchNav m={m} onSelect={onSelectBranch} disabled={busy} />
            {(m.model || m.engine) && <AnsweredBy m={m} className={clsx(untilTap && UNTIL_TAP)} />}
          </div>
        )}
        {sendHere && shareable && !streaming && <SendHereNote answerId={m.id} />}
        {suggesting && (
          <SuggestSkillDialog source={{ kind: 'message', chatId, messageId: m.id }} initialContent={m.content} onClose={() => setSuggesting(false)} />
        )}
        {sharing && <ShareToRoom chatId={chatId} messageId={m.id} answer={m.content} roomId={shareRoomId} onClose={() => setSharing(false)} />}
      </div>
    </div>
  )
}

/** The plain name of the AI that wrote an answer: the model's name from the list the person may pick from ("Claude
 * Sonnet"), else the AI's ("Claude"), the raw model id only when nothing else is known. */
export function answeredByName(m: Pick<ViewMessage, 'engine' | 'model'>, models: Partial<Record<EngineId, { id: string; label: string }[]>>): string | null {
  const engine = m.engine as EngineId | null
  const list = engine ? models[engine] ?? [] : []
  // the server keeps the id the AI reported: an alias ("sonnet") or a full id ("claude-sonnet-4-5-…")
  const hit = m.model ? list.find((x) => x.id === m.model) ?? (engine === 'claude-code' ? list.find((x) => m.model!.includes(x.id)) : undefined) : undefined
  const ai = engine ? ENGINE_LABEL[engine] : undefined
  // (a gateway's model has no display name: its label is the id, and "Claude claude-…" would say it twice)
  if (hit) return ai && engine === 'claude-code' && hit.label !== hit.id && !hit.label.startsWith(ai) ? `${ai} ${hit.label}` : hit.label
  return ai ?? m.model ?? null
}

/** Which AI answered, for the people who choose the AI (owner, admins, people the admin allowed): a quiet info button
 * with the plain name in its tooltip, and a toast on touch (no tooltips there). Everyone else sees nothing: a model id
 * under each answer reads like an error code to them, and ChatGPT and Claude do not stamp one either. */
function AnsweredBy({ m, className }: { m: ViewMessage; className?: string }) {
  const t = useT()
  const me = useMe()
  const chooser = canChooseEngine(me)
  const models = useEngines((s) => s.models)
  const load = useEngines((s) => s.load)
  // the list the plain names come from (a chat page loads it already; a room's side chat may not have)
  useEffect(() => { if (chooser) void load() }, [chooser, load])
  if (!chooser) return null
  const name = answeredByName(m, models)
  if (!name) return null
  const label = t('chat.answeredBy', { ai: name })
  return (
    <IconButton label={label} onClick={() => toast({ level: 'info', text: label })} className={clsx('touch-hit', className)} data-testid="answer-model">
      <Info size={13} />
    </IconButton>
  )
}

/** "다른 모델로 다시 시도": the engines and models the person may pick, for a new answer to the same question. A phone: the
 * choices as a sheet (EngineSheet; a tap outside, Escape or Back closes it); a computer: the small list, which a click
 * outside or Escape closes too. */
function RetryWithModel({ m, busy, retryWith, onPick }: { m: ViewMessage; busy: boolean; retryWith: NonNullable<Parameters<typeof AssistantMessage>[0]['retryWith']>; onPick: (p: EnginePick) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const phone = useMediaQuery('(max-width: 767.98px)')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setOpen(false)
      box.current?.querySelector<HTMLElement>('[data-testid="retry-other-model"]')?.focus()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  const current = { engine: (m.engine ?? undefined) as EngineId | undefined, model: m.model }
  if (phone && !busy) return <EngineSheet engines={retryWith.engines} models={retryWith.models} current={current} onPick={onPick} label={t('chat.retryOtherModel')} title={t('chat.retryOtherModel')} look="secondary" testId="retry-other-model" />
  return (
    <div ref={box} className="relative">
      <Button size="sm" variant="secondary" disabled={busy} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="retry-other-model">
        {t('chat.retryOtherModel')} <ChevronDown size={13} aria-hidden />
      </Button>
      {open && (
        <ul role="listbox" aria-label={t('chat.retryOtherModel')} className="absolute top-full right-0 z-30 mt-1 max-h-72 w-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 text-ink shadow-lg" onMouseLeave={() => setOpen(false)}>
          <EngineOptions
            engines={retryWith.engines}
            models={retryWith.models}
            current={current}
            onPick={(p) => {
              setOpen(false)
              onPick(p)
            }}
          />
        </ul>
      )}
    </div>
  )
}
