// "Share…" for a chat outside projects (docs/DECISIONS.md "Chats shared with people and groups", QA TC-1405; plan
// docs/AGENTS/plan/20261114-shared-chats-everywhere.md UX 1): Google Drive's dialog shape and save model. Its creator
// adds people and groups (the people-and-groups search of the project dialogs, components/ProjectParticipants.tsx; no
// whole-team option) and takes them out with ✕ (a 44 px box on a phone); the creator's row says "Started this chat" and
// has no ✕. Nothing is saved until Save (Share while the chat is not shared yet), which is off with no change; a picked
// row says "new", a saved row taken out is struck through with Undo. ✕, Esc, the scrim and a phone's Back with unsaved
// changes ask "Discard changes?" first ([Keep editing] [Discard]). A failed or offline save keeps the picks and says so
// above the button.
//
// The server checks what the new people would start to see (PUT /api/chats/:id/audience): when its answers used places
// some of them can't open, may have used my memories, or nothing is known, it answers "confirm"; those lines show here
// in place (with "Show answers ›" for the answers the new people would see: the widening list, components/
// WideningList.tsx, with this chat as its target) and the button reads "Share anyway", which sends the key back.
// Changing the picks after that asks again. A group picked adds the line that whoever joins it later sees the chat too;
// taking everyone out says the chat becomes mine alone again. The fixed note under it all says what sharing means.
//
// Someone else's shared chat: who it is shared with, read only, "Only {name} can change who sees this chat." A chat of
// mine in a personal project: why it can't be shared and Move…; once moved out, this dialog opens again on it.
// On a phone the dialog is the app's bottom sheet (ui.tsx Modal); an answer of the widening list opens on the same
// screen, the draft kept first (store/wideningDraft.ts), and "‹ Back to sharing" reopens this dialog on the list with
// the picks (components/WideningDraftHost.tsx).
import { AlertCircle, AlertTriangle, ChevronLeft, ChevronRight, FolderInput, Info } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { create } from 'zustand'
import type { Chat, ChatAudience, ProjectParticipant, PutChatAudienceResult, WideningAnswer } from '@mycel/shared/api'
import { useT, useLocale } from '../../i18n'
import { api, API, ApiError, errorText, isConnectionError } from '../../lib/api'
import { isOverlayEntry } from '../../lib/backCloses'
import { isTeamProject, keepFaces, type ShareKind } from '../../lib/sharedChat'
import { useProjects } from '../../store/projects'
import { useChats } from '../../store/chats'
import { useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { freshDraft, useWideningDraft, type WideningDraft } from '../../store/wideningDraft'
import { MembersField, ParticipantPicker, participantKey, sameParticipants, useParticipantOptions, type ParticipantOption } from '../ProjectParticipants'
import { answerHref, WideningList } from '../WideningList'
import { Button, ErrorNote, IconButton, Modal, Skeleton, confirmDialog, useMediaQuery } from '../ui'
import { MoveToProjectDialog } from './ChatProject'
import { placeName } from './ShareToRoom'
import { openShareChat } from './ShareChat'

type Ask = Extract<PutChatAudienceResult, { status: 'confirm' }> & { seq: number }

/** Who a chat is shared with, as one key: a draft made on another list is dropped (store/wideningDraft.ts). */
export const audienceKey = (subjects: readonly ProjectParticipant[]) => subjects.map(participantKey).sort().join(',')
const subjectsOf = (a: ChatAudience): ProjectParticipant[] => a.subjects.map(({ subjectType, subjectId }) => ({ subjectType, subjectId }))

export function ChatShareDialog({ chat, onClose, initial, personal = false }: {
  chat: Pick<Chat, 'id' | 'title'> & Partial<Pick<Chat, 'projectId' | 'shared'>>
  onClose: () => void
  /** a phone's way back from an answer of the widening list: the picks and the list as they were */
  initial?: WideningDraft
  /** a chat of mine in a personal project: the dialog explains and offers Move… */
  personal?: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const navigate = useNavigate()
  const location = useLocation()
  const title = t('chat.share.title', { title: chat.title || t('chat.untitled') })
  const [audience, setAudience] = useState<ChatAudience | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [picks, setPicks] = useState<ProjectParticipant[]>([])
  const [ask, setAsk] = useState<Ask | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // the widening list in place of the body (the picks stay)
  const [listing, setListing] = useState(false)
  const listScroll = useRef(initial?.scroll ?? 0)
  const restore = useRef(initial)
  // the sheet made again after a phone's Back was answered "Keep editing": its Back entry is back (lib/backCloses.ts)
  const [sheet, setSheet] = useState(0)
  const [moving, setMoving] = useState(false)
  const reopened = useRef(false)

  const shown = (a: ChatAudience) => {
    setAudience(a)
    const saved = subjectsOf(a)
    // back from an answer on a phone: the picks and the list, unless who sees it changed meanwhile or it is too old
    const d = restore.current
    restore.current = undefined
    if (d && freshDraft(d) && d.chatId === chat.id && d.rulesHash === audienceKey(saved)) { setPicks(d.participants); setListing(true) }
    else { setPicks(saved); listScroll.current = 0 }
    if (d) useWideningDraft.getState().drop()
  }
  const load = useCallback(() => {
    setLoadError(null)
    return api.call(API.getChatAudience, { params: { id: chat.id } }).then(shown, (e) => setLoadError(e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id])
  useEffect(() => { if (!personal) void load() }, [load, personal])

  const saved = useMemo(() => (audience ? subjectsOf(audience) : []), [audience])
  const editable = !!audience?.canEdit
  const creator = audience?.by ?? chat.shared?.by ?? null
  // the names the server sent (a group I am not in, a person no longer in the directory) and the creator, for the rows
  const extra = useMemo<ParticipantOption[]>(() => [
    ...(creator ? [{ subjectType: 'user' as const, subjectId: creator.id, name: creator.name }] : []),
    ...(audience?.subjects ?? []).map((s) => ({ subjectType: s.subjectType, subjectId: s.subjectId, name: s.name, ...(s.title ? { title: s.title } : {}), ...(s.avatarVersion ? { avatarVersion: s.avatarVersion } : {}), ...(s.mine ? { mine: true } : {}) })),
  ], [audience, creator])
  const options = useParticipantOptions(extra)
  // not offered: me and the creator (always in it); their row is found by key
  const exclude = useMemo(() => new Set([me ? `user:${me.user.id}` : '', creator ? `user:${creator.id}` : ''].filter(Boolean)), [me, creator])
  const fixed = useMemo(() => new Map(creator ? [[`user:${creator.id}`, t('chat.share.started')]] : []), [creator, t])
  // a phone: my own row says "You" (the whole tag in its tooltip and name), someone else's "Started this chat"
  const phoneTags = useMemo(() => new Map(creator && creator.id === me?.user.id ? [[`user:${creator.id}`, t('projects.youTag')]] : []), [creator, me, t])
  const dirty = editable && !sameParticipants(picks, saved)
  const savedKeys = useMemo(() => new Set(saved.map(participantKey)), [saved])
  const adding = useMemo(() => picks.filter((x) => !savedKeys.has(participantKey(x))), [picks, savedKeys])
  const nameOf = useCallback((x: ProjectParticipant) => options.find((o) => participantKey(o) === participantKey(x))?.name ?? '', [options])
  const addedNames = useMemo(() => adding.map(nameOf).filter(Boolean).join(t('rooms.nameSep')), [adding, nameOf, t])
  const groupAdded = adding.some((x) => x.subjectType === 'group')
  const removesAll = saved.length > 0 && picks.length === 0
  // a confirm is about the picks it was asked for: another pick asks again
  const askedFor = useRef('')
  useEffect(() => { if (ask && askedFor.current !== audienceKey(picks)) setAsk(null) }, [picks, ask])
  // nothing to list any more (the picks changed): back to them
  useEffect(() => { if (listing && audience && !adding.length) setListing(false) }, [listing, audience, adding.length])

  const close = async () => {
    if (!dirty) return onClose()
    // a phone's Back took the sheet's own history entry already (it is no longer the one we stand on)
    const viaBack = phone && !isOverlayEntry(window.history.state)
    if (await confirmDialog({ title: t('chat.share.discardTitle'), body: t('chat.share.discardBody'), confirm: t('chat.share.discard'), cancel: t('chat.share.keepEditing'), danger: true })) return onClose()
    if (viaBack) setSheet((n) => n + 1)
  }

  const save = async () => {
    if (!dirty || busy) return
    setBusy(true)
    setError(null)
    const key = audienceKey(picks)
    try {
      const r = await api.call(API.putChatAudience, { params: { id: chat.id }, body: { subjects: picks, ...(ask ? { confirmKey: ask.confirmKey } : {}) } })
      if (r.status === 'confirm') {
        askedFor.current = key
        setAsk((a) => ({ ...r, seq: (a?.seq ?? 0) + 1 }))
        return
      }
      const before = useChats.getState().chats.find((c) => c.id === r.chat.id)
      useChats.getState().upsertChat(keepFaces(before, r.chat))
      // the first share says with how many (when I may know it); any other save says it is saved
      const others = r.audience.count !== undefined ? r.audience.count - 1 : null
      toast({ level: 'success', text: !saved.length && others ? t('chat.share.done', { n: others }) : t('chat.share.saved') })
      // a first share: my earlier files from the computer that could not go with it (too large, no room, changed since)
      if (r.filesNotCopied) toast({ level: 'warn', text: t('chat.share.filesNotCopied', { n: r.filesNotCopied }) })
      setAudience(r.audience)
      onClose()
    } catch (e) {
      // a refusal says why in the server's words; no answer (offline) or a failure: the picks stay, try again
      setError(e instanceof ApiError && !isConnectionError(e) && e.status < 500 ? errorText(e, locale, t('chat.share.saveFailed')) : t('chat.share.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const body = useRef<HTMLDivElement>(null)
  const scroller = useCallback(() => body.current?.closest<HTMLElement>('.overflow-y-auto') ?? null, [])
  /** a phone: the answer opens on this screen; the draft first, so Back brings the dialog and its picks back */
  const openOnPhone = (a: WideningAnswer) => {
    useWideningDraft.getState().keep({ projectId: '', chatId: chat.id, participants: picks, removeRules: [], rulesHash: audienceKey(saved), scroll: listScroll.current, from: location.pathname + location.search, at: Date.now(), left: true })
    // the answer's page takes the sheet's history entry (lib/backCloses.ts); this dialog, kept by the app and not by a
    // page, goes once the address changed (its host; the draft brings it back)
    navigate(answerHref(a))
  }

  if (moving) return (
    <MoveToProjectDialog
      chat={chat as Chat}
      onClose={() => { setMoving(false); onClose() }}
      // moved out of the personal project: Share again, on the moved chat (once: the move tells it again when confirmed)
      onMoved={(c) => { if (c.projectId !== chat.projectId && !reopened.current) { reopened.current = true; queueMicrotask(() => shareAgain(c)) } }}
    />
  )

  const p = ask?.provenance
  const places = p?.places.map((x) => placeName(t, x)) ?? []
  // one warning for what the new people would start seeing: the answers that used places they can't open (the places by
  // name where I may open them), with "Show answers ›"; without such answers the check's own line (content from places
  // some of them can't open, or "not all known")
  const hidden = ask?.hiddenAnswers && addedNames ? ask.hiddenAnswers : 0
  const unknown = p?.unknown ? t('chat.shareChat.unknown') : null
  const warning = hidden
    ? [places.length && !p?.unknown ? t('chat.share.warnPlaces', { n: hidden, names: addedNames, places: places.join(', ') }) : t('chat.share.warn', { n: hidden, names: addedNames }), unknown].filter(Boolean).join(' ')
    : !p ? null : unknown ?? (places.length ? t('chat.shareChat.provenance', { m: p.people, places: places.join(', ') }) : t('chat.shareChat.provenanceNoPlace', { m: p.people }))
  const label = ask ? t('chat.share.shareAnyway') : saved.length ? t('common.save') : t('chat.share.share')
  return (
    <Modal
      key={sheet}
      open
      onClose={() => void close()}
      width={480}
      title={listing ? (
        <span className="flex min-w-0 items-center gap-1">
          <IconButton label={t('tabs.back')} onClick={() => setListing(false)} className="-ml-2 shrink-0 touch-hit" data-testid="widening-list-back">
            <ChevronLeft size={18} aria-hidden />
          </IconButton>
          <span className="min-w-0 break-keep" data-testid="widening-list-title">{t('share.widenList.title', { names: addedNames })}</span>
        </span>
      ) : <span className="block min-w-0 truncate" data-testid="chat-share-title">{title}</span>}
      footer={listing ? undefined : personal || !editable ? (
        <Button variant="ghost" onClick={onClose} data-testid="chat-share-close">{t('common.close')}</Button>
      ) : (
        <>
          {error && <p role="alert" className="mr-auto w-full text-sm break-keep text-danger" data-testid="chat-share-error">{error}</p>}
          {/* a visible way out besides ✕ (asks first with unsaved changes, as ✕ does) */}
          <Button variant="ghost" disabled={busy} onClick={() => void close()} className="max-sm:flex-1" data-testid="chat-share-cancel">{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => void save()} className="max-sm:flex-1" data-testid="chat-share-save">{label}</Button>
        </>
      )}
    >
      {listing && audience ? (
        <div ref={body}>
          <WideningList target={{ kind: 'chat', chatId: chat.id }} add={picks} names={addedNames} phone={phone} oneChat onOpen={phone ? openOnPhone : undefined}
            scroller={scroller} initialScroll={listScroll.current} onScroll={(top) => { listScroll.current = top }} />
        </div>
      ) : personal ? (
        <div className="space-y-3" data-testid="chat-share-personal">
          <p className="text-sm leading-6 break-keep text-ink">{t('chat.share.personalProject')}</p>
          <Button onClick={() => setMoving(true)} data-testid="chat-share-move"><FolderInput size={14} aria-hidden />{t('chat.share.move')}</Button>
        </div>
      ) : (
        <div className="space-y-3" data-testid="chat-share-dialog">
          {loadError ? <ErrorNote onRetry={() => void load()}>{errorText(loadError, locale, t('error.network'))}</ErrorNote> : null}
          {!audience && !loadError && <Skeleton lines={3} />}
          {audience && (
            <MembersField label={t('chat.share.withAccess')}>
              {editable ? (
                <ParticipantPicker options={options} value={picks} onChange={(v) => { setPicks(v); setError(null) }} fixed={fixed} current={saved}
                  placeholder={t('chat.share.add')} exclude={exclude} phoneTags={phoneTags} testId="chat-share-picker" />
              ) : (
                <ParticipantPicker options={options} value={saved} onChange={() => {}} fixed={fixed} readOnly testId="chat-share-picker" />
              )}
            </MembersField>
          )}
          {audience && !editable && creator && <p className="text-sm break-keep text-muted" data-testid="chat-share-read-only">{t('chat.share.readOnly', { name: creator.name })}</p>}
          {editable && (
            <>
              {groupAdded && <p className="text-sm leading-6 break-keep text-muted" data-testid="chat-share-future-group">{t('chat.share.futureGroup')}</p>}
              {ask?.reason === 'changed' && (
                <p role="status" className="flex items-start gap-2 text-sm leading-6 break-keep text-warn" data-testid="chat-share-changed">
                  <AlertCircle size={16} className="mt-1 shrink-0" aria-hidden />
                  {t('chat.shareChat.changed')}
                </p>
              )}
              {warning && (
                <p className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm leading-6 break-keep text-warn" data-testid="chat-share-warning">
                  <AlertTriangle size={16} className="mt-1 shrink-0" aria-hidden />
                  <span>
                    {warning}
                    {hidden > 0 && (
                      <>
                        {' '}
                        <button type="button" onClick={() => setListing(true)} className="touch-hit inline-flex items-center font-medium text-accent-text hover:underline" data-testid="chat-share-widen-show">
                          {t('share.widenList.show')}<ChevronRight size={14} aria-hidden />
                        </button>
                      </>
                    )}
                  </span>
                </p>
              )}
              {/* a quiet line of its own: a first share shows them the files I attached from my computer */}
              {!!ask?.earlierFiles && (
                <p className="flex items-start gap-2 text-sm leading-6 break-keep text-muted" data-testid="chat-share-earlier-files">
                  <Info size={16} className="mt-1 shrink-0 text-faint" aria-hidden />
                  <span>{t('chat.share.earlierFiles', { n: ask.earlierFiles })}</span>
                </p>
              )}
              {/* a quiet line of its own: not about the people, about my memories */}
              {ask?.memories && (
                <p className="flex items-start gap-2 text-sm leading-6 break-keep text-muted" data-testid="chat-share-memories">
                  <Info size={16} className="mt-1 shrink-0 text-faint" aria-hidden />
                  <span>{t('chat.shareChat.memories')}</span>
                </p>
              )}
              {removesAll && <p className="text-sm leading-6 break-keep text-warn" data-testid="chat-share-only-you">{t('chat.share.onlyYou')}</p>}
              {/* the fixed note; shorter while a warning says the rest */}
              <p className="text-sm leading-6 break-keep text-faint" data-testid="chat-share-note">{t(warning ? 'chat.share.noteShort' : 'chat.share.note')}</p>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}

/** Share… again on a chat that just moved (out of a personal project): the Share dialog outside projects, the project
 * members' share in a team project, nothing in another personal one. */
function shareAgain(c: Chat) {
  if (!c.projectId) return openChatShare(c)
  const p = useProjects.getState().byId[c.projectId]
  if (p && isTeamProject(p)) openShareChat(c.id)
}

/** What a Share… item opens (lib/sharedChat.ts shareKindOf): the project members' share for my private chat in a team
 * project, this dialog for the rest. */
export function startShare(chat: Target['chat'], kind: ShareKind) {
  if (kind === 'project') openShareChat(chat.id)
  else openChatShare(chat, { personal: kind === 'personal' })
}

/** What the Share… items open, from anywhere (the title menu, every row's "⋯", the line under the box, the move dialog
 * after a move): one dialog for the app (ChatShareHost, App.tsx). */
type Target = { chat: Pick<Chat, 'id' | 'title'> & Partial<Pick<Chat, 'projectId' | 'shared'>>; personal: boolean; seq: number }
const useChatShareHost = create<{ open: Target | null; seq: number }>(() => ({ open: null, seq: 0 }))
export const openChatShare = (chat: Target['chat'], o: { personal?: boolean } = {}) =>
  useChatShareHost.setState((s) => ({ open: { chat, personal: !!o.personal, seq: s.seq + 1 }, seq: s.seq + 1 }))

export function ChatShareHost() {
  const open = useChatShareHost((s) => s.open)
  // a page opened from inside it (an answer of the widening list on a phone) closes it, after the address changed: the
  // page took its history entry by then (lib/backCloses.ts)
  const here = useLocation()
  const at = useRef<{ seq: number; key: string } | null>(null)
  useEffect(() => {
    if (!open) { at.current = null; return }
    if (at.current?.seq !== open.seq) at.current = { seq: open.seq, key: here.key }
    else if (at.current.key !== here.key) useChatShareHost.setState({ open: null })
  }, [open, here.key])
  if (!open) return null
  return <ChatShareDialog key={open.seq} chat={open.chat} personal={open.personal} onClose={() => useChatShareHost.setState({ open: null })} />
}

/** The names a chat shared with people and groups is shared with ("Sam, Sales"), for someone not told how many see it
 * (a group in it: Chat.shared.audienceHidden): its creator first, then each person and group listed, never me. Null
 * while it is read, or with `chatId` null. */
export function useSharedWithNames(chatId: string | null, by: { id: string; name: string } | undefined, me: string): string | null {
  const t = useT()
  const [names, setNames] = useState<string | null>(null)
  useEffect(() => {
    setNames(null)
    if (!chatId) return
    let live = true
    api.call(API.getChatAudience, { params: { id: chatId } }).then((a) => {
      if (!live) return
      const list = [...(by && by.id !== me ? [by.name] : []), ...a.subjects.filter((s) => !(s.subjectType === 'user' && s.subjectId === me)).map((s) => s.name)]
      setNames(list.join(t('rooms.nameSep')) || null)
    }, () => {})
    return () => { live = false }
  }, [chatId, by?.id, by?.name, me, t])
  return names
}
