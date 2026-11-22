// "Share" for a chat outside projects (docs/DECISIONS.md "Chats shared with people and groups", QA TC-1405; plan
// docs/AGENTS/plan/20261114-shared-chats-everywhere.md UX 1): Google Drive's dialog shape and save model. Its creator
// adds people and groups (the people-and-groups search of the project dialogs, components/ProjectParticipants.tsx; no
// whole-team option) and takes them out with ✕ (a 44 px box on a phone); the creator's row says "Started this chat" and
// has no ✕. Nothing is saved until Save (Share while the chat is not shared yet), which is off with no change; a picked
// row says "new", a saved row taken out is struck through with Undo. ✕, Esc, the scrim and a phone's Back with unsaved
// changes ask "Discard changes?" first ([Keep editing] [Discard]). A failed or offline save keeps the picks and says so
// above the button. Copy link at the bottom left (components/ShareCopyLink.tsx; docs/decisions/
// 20261116-chat-share-copy-link.md): the chat's /c/<id> with the chat menu's toast, a line while picks are not saved, and
// Copy link again on the toast after the save.
//
// One press (docs/DECISIONS.md "Share in one press", QA TC-3092): while the picks bring someone new in, the dialog asks
// the server what they would see (POST /api/chats/:id/audience/preview) 400 ms after the last change of the list, any
// change, removals too; Share is off from the first change until the answer for exactly these picks is here. What is
// really at stake shows in place (components/ShareWarning.tsx: "2 answers may have used your personal memories",
// "3 answers used files Mina can't open", "Show answers ›" for the list, components/WideningList.tsx); nothing at stake
// or only answers nobody could check: at most one grey line. The button keeps its colour and words: Share sends the
// preview's key, and the server saves only with the key of what they would see now. A failed preview says so in grey
// and Share still works: the server answers with the check instead of saving (never a silent share), it shows in place
// with "Check this, then press Share again", as it does when something changed since the preview. Taking everyone out
// says the chat and its files become mine alone again, and then nothing else: no fixed note, no Copy link (QA TC-6951).
// One short line under the people list says what sharing means (added people see the whole chat and ask its AI); the ✕
// on each row already says they can be taken out.
//
// "Share the files too" (docs/decisions/20261121-share-chat-files.md; lean look docs/AGENTS/plan/
// 20261122-0300-share-dialog-lean.md): when the chat made files in my own folder that the people in it can't open (the
// check's madeFiles while adding people; the audience's madeFiles on a chat already shared), one checkbox row lists them
// in place, unticked: a file leaves My files only when its owner ticks it and presses Share (Save on a chat already
// shared, which then saves the files alone). Ticked, the server reads them again at the press and copies them into the
// chat (the originals stay in My files; the copies go with the chat: the hint's tooltip); anything changed since: the
// list again, "Check the list, then press again". One box for all of them: the made-here files go together.
//
// Someone else's shared chat: who it is shared with, read only, "Only {name} can change who sees this chat." A chat of
// mine in a personal project: why it can't be shared and Move; once moved out, this dialog opens again on it.
// On a phone the dialog is the app's bottom sheet (ui.tsx Modal); an answer of the widening list opens on the same
// screen, the draft kept first (store/wideningDraft.ts), and "‹ Back to sharing" reopens this dialog on the list with
// the picks (components/WideningDraftHost.tsx).
import { AlertCircle, ChevronLeft, FileText, FolderInput, Info, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { create } from 'zustand'
import type { Chat, ChatAudience, ChatMadeFile, ProjectParticipant, ShareCheck, WideningAnswer } from '@mycel/shared/api'
import { useT, useLocale } from '../../i18n'
import { api, API, ApiError, errorText, isConnectionError } from '../../lib/api'
import { isOverlayEntry } from '../../lib/backCloses'
import { waitForUpdate, waitsForUpdate } from '../../lib/serverUpdating'
import { isTeamProject, keepFaces, type ShareKind } from '../../lib/sharedChat'
import { useProjects } from '../../store/projects'
import { useChats } from '../../store/chats'
import { usePeopleList } from '../../store/people'
import { useMe } from '../../store/session'
import { toast } from '../../store/ui'
import { freshDraft, useWideningDraft, type WideningDraft } from '../../store/wideningDraft'
import { MembersField, ParticipantPicker, participantKey, sameParticipants, useParticipantOptions, type ParticipantOption } from '../ProjectParticipants'
import { answerHref, WideningList } from '../WideningList'
import { Button, ErrorNote, IconButton, Modal, Skeleton, confirmDialog, menuOpener, useMediaQuery } from '../ui'
import { CalmNotice } from '../LoadError'
import { MoveToProjectDialog } from './ChatProject'
import { GreyLine, ShareWarning, shareAtStake, shareFilesLine, shareGreyLine, shareWarningSummary, whoNames } from '../ShareWarning'
import { openShareChat } from './ShareChat'
import { useCopyChatLink } from './copyChatLink'
import { useChatActions } from './chatActions'
import { ShareCopyLink } from '../ShareCopyLink'

/** The check for one list of picks (`for`: its audienceKey): asking, answered (with the key a save carries), or failed.
 * `again`: the save answered with the check instead of saving (no key: the preview failed; or something changed). */
type Preview =
  | { for: string; state: 'loading' }
  // `list`: the people and groups as sent, which ShareCheck.warnPicks counts in
  | { for: string; state: 'ready'; check: ShareCheck; key: string; again?: 'changed' | 'unchecked'; list: readonly ProjectParticipant[] }
  | { for: string; state: 'failed' }

/** How long the preview waits after the last change of the picks (as the project dialogs' count). */
export const SHARE_PREVIEW_DEBOUNCE_MS = 400

/** Who a chat is shared with, as one key: a draft made on another list is dropped (store/wideningDraft.ts). */
export const audienceKey = (subjects: readonly ProjectParticipant[]) => subjects.map(participantKey).sort().join(',')
const subjectsOf = (a: ChatAudience): ProjectParticipant[] => a.subjects.map(({ subjectType, subjectId }) => ({ subjectType, subjectId }))

export function ChatShareDialog({ chat, onClose, initial, personal = false, returnTo }: {
  chat: Pick<Chat, 'id' | 'title'> & Partial<Pick<Chat, 'projectId' | 'shared'>>
  onClose: () => void
  /** where focus goes when it closes (the control that opened it: a menu's trigger once the menu item is gone; QA
   * TC-2271) */
  returnTo?: HTMLElement | null
  /** a phone's way back from an answer of the widening list: the picks and the list as they were */
  initial?: WideningDraft
  /** a chat of mine in a personal project: the dialog explains and offers Move */
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
  const [preview, setPreview] = useState<Preview | null>(null)
  // the grey "Checking…" line only once asking takes a moment (no flicker on a quick answer)
  const [slow, setSlow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Trina is updating (lib/serverUpdating.ts): the picks stay, a calm line says so, and it saves again by itself once
  // the server is back (or Save again now)
  const [updating, setUpdating] = useState(false)
  // the widening list in place of the body (the picks stay)
  const [listing, setListing] = useState(false)
  const listScroll = useRef(initial?.scroll ?? 0)
  const restore = useRef(initial)
  // the sheet made again after a phone's Back was answered "Keep editing": its Back entry is back (lib/backCloses.ts)
  const [sheet, setSheet] = useState(0)
  const [moving, setMoving] = useState(false)
  const reopened = useRef(false)
  // the already-shared step asked again (the files changed since): its list and key
  const [filesAgain, setFilesAgain] = useState<{ files: ChatMadeFile[]; key: string } | null>(null)
  // "Share the files too": unticked until its owner ticks it (a file leaves My files only by a press that names files)
  const [withFiles, setWithFiles] = useState(false)
  // Copy link (components/ShareCopyLink.tsx): the chat as this window knows it now (shared or not, how many), its toast says who opens it
  const copyLink = useCopyChatLink()
  const known = useChats((s) => s.chats.find((c) => c.id === chat.id))
  const actions = useChatActions()

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
  // not offered: me and the creator (always in it); their row is found by key. A guest is never added (a chat shared with
  // people is no place of theirs, the server refuses them too): a search that finds one shows them greyed out with why,
  // not "No matches" (QA TC-7284)
  const people = usePeopleList()
  const exclude = useMemo(() => new Set([me ? `user:${me.user.id}` : '', creator ? `user:${creator.id}` : ''].filter(Boolean)), [me, creator])
  const guests = useMemo(() => new Map((people ?? []).filter((p) => p.guest).map((p) => [`user:${p.id}`, { text: t('chat.share.guestNo') }])), [people, t])
  const fixed = useMemo(() => new Map(creator ? [[`user:${creator.id}`, t('chat.share.started')]] : []), [creator, t])
  // a phone: my own row says "You" (the whole tag in its tooltip and name), someone else's "Started this chat"
  const phoneTags = useMemo(() => new Map(creator && creator.id === me?.user.id ? [[`user:${creator.id}`, t('projects.youTag')]] : []), [creator, me, t])
  const dirty = editable && !sameParticipants(picks, saved)
  const savedKeys = useMemo(() => new Set(saved.map(participantKey)), [saved])
  const adding = useMemo(() => picks.filter((x) => !savedKeys.has(participantKey(x))), [picks, savedKeys])
  const nameOf = useCallback((x: ProjectParticipant) => options.find((o) => participantKey(o) === participantKey(x))?.name ?? '', [options])
  // as the share lines name them: a person "Bob 님", a group "Sales 부서 사람들" (components/ShareWarning.tsx whoNames)
  const addedNames = useMemo(() => whoNames(t, adding.map((x) => ({ subjectType: x.subjectType, name: nameOf(x) }))), [adding, nameOf, t])
  const groupAdded = adding.some((x) => x.subjectType === 'group')
  const removesAll = saved.length > 0 && picks.length === 0
  // someone taken out by name who stays in a group still picked keeps the chat through it (QA TC-2264): the server says
  // which of the listed groups each person is in (ChatAudienceRow.inGroups: only groups I am in, admins any)
  const pickedKeys = useMemo(() => new Set(picks.map(participantKey)), [picks])
  const keepsThrough = useMemo(() => (audience?.subjects ?? []).flatMap((row) => {
    if (row.subjectType !== 'user' || pickedKeys.has(`user:${row.subjectId}`) || !row.inGroups?.length) return []
    const groups = row.inGroups.filter((g) => pickedKeys.has(`group:${g}`)).map((g) => nameOf({ subjectType: 'group', subjectId: g })).filter(Boolean)
    return groups.length ? [{ id: row.subjectId, text: t('chat.share.keepsThrough', { name: row.name, groups: groups.join(t('rooms.nameSep')) }) }] : []
  }), [audience, pickedKeys, nameOf, t])
  // the check of what the people being added would see, again after every change of the list while anyone is being
  // added (an add, a removal, a group): a newer list drops the answer of an older one
  const picksKey = audienceKey(picks)
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current
    setSlow(false)
    if (!editable || !audience || !adding.length) { setPreview(null); return }
    setPreview({ for: picksKey, state: 'loading' })
    const shown = setTimeout(() => { if (seq.current === n) setSlow(true) }, 300)
    const asked = setTimeout(() => {
      api.call(API.previewChatAudience, { params: { id: chat.id }, body: { subjects: picks } }).then((r) => {
        if (seq.current !== n) return
        setPreview({ for: picksKey, state: 'ready', check: r.check, key: r.previewKey, list: picks })
      }, (e) => {
        if (seq.current !== n) return
        setPreview({ for: picksKey, state: 'failed' })
        // a refusal says why in the server's words (someone who can't be added, a busy chat); no answer: a grey line
        if (e instanceof ApiError && !isConnectionError(e) && e.status < 500 && e.status !== 429) setError(errorText(e, locale, t('chat.share.saveFailed')))
      })
    }, SHARE_PREVIEW_DEBOUNCE_MS)
    return () => { clearTimeout(shown); clearTimeout(asked) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picksKey, editable, audience, adding.length, chat.id])
  // a new list of people: the files box unticked again (the tick was for the people it was ticked for)
  useEffect(() => { setWithFiles(false) }, [picksKey])
  const current = preview?.for === picksKey ? preview : null
  // Share waits for the check of exactly these picks (from the first change, the 400 ms wait included)
  const checking = adding.length > 0 && (!current || current.state === 'loading')
  // nothing to list any more (the picks changed): back to them
  useEffect(() => { if (listing && audience && !adding.length) setListing(false) }, [listing, audience, adding.length])

  const close = async () => {
    if (!dirty) return onClose()
    // a phone's Back took the sheet's own history entry already (it is no longer the one we stand on)
    const viaBack = phone && !isOverlayEntry(window.history.state)
    if (await confirmDialog({ title: t('chat.share.discardTitle'), body: t('chat.share.discardBody'), confirm: t('chat.share.discard'), cancel: t('chat.share.keepEditing'), danger: true })) return onClose()
    if (viaBack) setSheet((n) => n + 1)
  }

  const save = async (withFiles = false) => {
    // (the already-shared step saves the files alone: nothing else to change)
    if ((!dirty && !withFiles) || busy || checking) return
    setBusy(true)
    setError(null)
    setUpdating(false)
    const key = picksKey
    // the key of what the step showed: the check's while adding people, else the audience's files key
    const sent = adding.length ? (current?.state === 'ready' ? current.key : undefined) : withFiles ? (filesAgain?.key ?? audience?.madeFilesKey) : undefined
    try {
      const r = await api.call(API.putChatAudience, { params: { id: chat.id }, body: { subjects: dirty ? picks : saved, ...(sent ? { confirmKey: sent } : {}), ...(withFiles ? { withFiles: true } : {}) } })
      if (r.status === 'confirm') {
        // not saved: what they would see now, in place; the same Share again saves it
        if (!adding.length) setFilesAgain({ files: r.check.madeFiles ?? [], key: r.confirmKey })
        else if (audienceKey(picks) === key) setPreview({ for: key, state: 'ready', check: r.check, key: r.confirmKey, again: r.reason ?? 'unchecked', list: dirty ? picks : saved })
        return
      }
      const before = useChats.getState().chats.find((c) => c.id === r.chat.id)
      useChats.getState().upsertChat(keepFaces(before, r.chat))
      // the first share says with how many (when I may know it); any other save says it is saved
      const others = r.audience.count !== undefined ? r.audience.count - 1 : null
      // with Copy link: share, then send the link, in one go
      const text = r.filesAdded
        ? (!saved.length && others ? t('chat.shareFiles.doneWith', { n: others, files: r.filesAdded }) : t('chat.shareFiles.added', { n: r.filesAdded }))
        : !saved.length && others ? t('chat.share.done', { n: others }) : t('chat.share.saved')
      // a chat that became mine alone again: no link to send (QA TC-6951)
      const alone = removesAll && !r.filesAdded
      toast({ level: 'success', text, ms: 10_000, ...(alone ? {} : { action: { label: t('rooms.menu.copyLink'), run: () => void copyLink(r.chat) } }) })
      // the copies are on their answers now: the chat read again, so its links open them (one file, not two)
      if (r.filesAdded && useChats.getState().threads[chat.id]) void useChats.getState().loadThread(chat.id).catch(() => {})
      // a first share: my earlier files from the computer that could not go with it (too large, no room, changed since)
      if (r.filesNotCopied) toast({ level: 'warn', text: t('chat.share.filesNotCopied', { n: r.filesNotCopied }) })
      // someone taken out by name who still sees it through a group (QA TC-2264)
      for (const k of r.keptThrough ?? []) toast({ level: 'info', text: t('chat.share.keepsThrough', { name: k.name, groups: k.groups.join(t('rooms.nameSep')) }) })
      setAudience(r.audience)
      onClose()
    } catch (e) {
      if (waitsForUpdate(e)) { setUpdating(true); return }
      // a refusal says why in the server's words; no answer (offline) or a failure: the picks stay, try again
      setError(e instanceof ApiError && !isConnectionError(e) && e.status < 500 ? errorText(e, locale, t('chat.share.saveFailed')) : t('chat.share.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (!updating) return
    let live = true
    void waitForUpdate().then(() => { if (live) void saveRef.current() })
    return () => { live = false }
  }, [updating])

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

  const check = current?.state === 'ready' ? current.check : null
  const stake = !!check && shareAtStake(check)
  // the warning names only the picks that bring in someone it is about (ShareCheck.warnPicks: their places in the list
  // the check was asked for, QA TC-7042: not a person already in the chat through a group); an older server: everyone
  // being added
  const warnNames = check?.warnPicks?.length && current?.state === 'ready' ? warnNamesOf(t, current.list, check.warnPicks, nameOf) || addedNames : addedNames
  // the box's one line, and the answers nobody could check as its second line (read out as shown)
  const warningText = check && stake ? [shareWarningSummary(t, check, warnNames), check.unchecked ? t('share.grey.unchecked', { n: check.unchecked }) : ''].filter(Boolean).join(' ') : ''
  // the one grey line when there is no warning to read first: asking (after a moment), the check failed, or the check's
  // (answers nobody could check: in the box when there is one)
  const futureGroup = groupAdded ? t('chat.share.futureGroup') : null
  const grey = checking ? (slow ? t('share.grey.checking') : null)
    : current?.state === 'failed' ? t('share.grey.failed')
      : stake ? futureGroup : shareGreyLine(t, check, futureGroup)
  // my earlier files from the computer a first share copies: a line of its own whenever there are any
  const filesLine = shareFilesLine(t, check)
  const label = saved.length ? t('common.save') : t('chat.share.share')
  // the files step: while adding people, the check's list; on a chat already shared, the audience's (or the list asked
  // again). Only its creator ever gets one
  const stepFiles: ChatMadeFile[] = !editable ? [] : adding.length ? (check?.madeFiles ?? []) : (filesAgain?.files ?? audience?.madeFiles ?? [])
  // nobody in it (a chat never shared, nobody picked, or everyone taken out): no files box, nothing to share them with
  const filesStep = stepFiles.length > 0 && picks.length > 0 && !removesAll
  const filesChanged = adding.length ? current?.state === 'ready' && current.again === 'changed' : !!filesAgain
  // the files go only when ticked (and there are files to go)
  const sendFiles = filesStep && withFiles
  const copyButton = <ShareCopyLink onCopy={() => void copyLink(known ?? chat, { inDialog: true })} testId="chat-share-copy-link" />
  return (
    <Modal
      key={sheet}
      open
      onClose={() => void close()}
      returnTo={returnTo}
      width={480}
      title={listing ? (
        <span className="flex min-w-0 items-center gap-1">
          <IconButton label={t('tabs.back')} onClick={() => setListing(false)} className="-ml-2 shrink-0 touch-hit" data-testid="widening-list-back">
            <ChevronLeft size={18} aria-hidden />
          </IconButton>
          <span className="min-w-0 break-keep" data-testid="widening-list-title">{t('share.widenList.title', { names: warnNames })}</span>
        </span>
      ) : <span className="block min-w-0 truncate" data-testid="chat-share-title">{title}</span>}
      footer={listing ? undefined : personal || !editable ? (
        <>
          {/* someone it was shared with by name: "Leave this chat" (QA TC-7651; asks first, chatActions.leave) */}
          {!personal && audience && !editable && audience.subjects.some((x) => x.subjectType === 'user' && x.subjectId === me?.user.id) && <Button variant="ghost" className="mr-auto text-danger" onClick={() => { onClose(); void actions.leave(known ?? chat, undefined, audience.by.name) }} data-testid="chat-share-leave">{t('chat.leave')}</Button>}
          {copyButton}
          <Button variant="ghost" onClick={onClose} data-testid="chat-share-close">{t('common.close')}</Button>
        </>
      ) : (
        <>
          {error && <p role="alert" className="mr-auto w-full text-sm break-keep text-danger" data-testid="chat-share-error">{error}</p>}
          {updating && !error && <CalmNotice className="mr-auto w-full" testId="chat-share-updating" state="updating" icon={<Loader2 size={16} className="animate-spin" />} title={t('chat.share.updating')} />}
          {/* no link for a chat that becomes mine alone (QA TC-6951) */}
          {!removesAll && copyButton}
          {/* a visible way out besides ✕ (asks first with unsaved changes, as ✕ does); a phone: Cancel as wide as its
              word, the main button the rest. The files checkbox decides whether the files go with the save */}
          <Button variant="ghost" disabled={busy} onClick={() => void close()} className="max-sm:shrink-0" data-testid="chat-share-cancel">{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={!(dirty || sendFiles) || checking} onClick={() => void save(sendFiles)} className="max-sm:min-w-0 max-sm:flex-1" data-testid="chat-share-save">{label}</Button>
        </>
      )}
    >
      {listing && audience ? (
        <div ref={body}>
          <WideningList target={{ kind: 'chat', chatId: chat.id }} add={picks} names={warnNames} phone={phone} oneChat onOpen={phone ? openOnPhone : undefined}
            scroller={scroller} initialScroll={listScroll.current} onScroll={(top) => { listScroll.current = top }} />
        </div>
      ) : personal ? (
        <div className="space-y-3" data-testid="chat-share-personal">
          <p className="text-sm leading-6 break-keep text-ink">{t('chat.share.personalProject')}</p>
          <Button onClick={() => setMoving(true)} data-testid="chat-share-move"><FolderInput size={14} aria-hidden />{t('chat.share.move')}</Button>
        </div>
      ) : (
        <div className="space-y-3" data-testid="chat-share-dialog">
          {/* what the check found and who keeps access, read out when it appears (the lines below are shown; QA TC-2271) */}
          <p className="sr-only" role="status" aria-live="polite" data-testid="chat-share-live">{editable ? [warningText, filesLine, grey, ...keepsThrough.map((k) => k.text)].filter(Boolean).join(' ') : ''}</p>
          {loadError ? <ErrorNote onRetry={() => void load()}>{errorText(loadError, locale, t('error.network'))}</ErrorNote> : null}
          {!audience && !loadError && <Skeleton lines={3} />}
          {audience && (
            <MembersField label={t('chat.share.withAccess')}>
              {editable ? (
                <ParticipantPicker options={options} value={picks} onChange={(v) => { setPicks(v); setError(null) }} fixed={fixed} current={saved}
                  placeholder={t('chat.share.add')} exclude={exclude} unavailable={guests} phoneTags={phoneTags} removeTip={t('chat.share.removeTip')} testId="chat-share-picker" />
              ) : (
                <ParticipantPicker options={options} value={saved} onChange={() => {}} fixed={fixed} readOnly testId="chat-share-picker" />
              )}
            </MembersField>
          )}
          {/* what sharing means, in one line (none for a chat that becomes mine alone, whose line says it all: QA TC-6951) */}
          {audience && editable && !removesAll && <p className="text-xs leading-5 break-keep text-muted" data-testid="chat-share-note">{t('chat.share.note')}</p>}
          {audience && !editable && creator && <p className="text-sm break-keep text-muted" data-testid="chat-share-read-only">{t('chat.share.readOnly', { name: creator.name })}</p>}
          {editable && (
            <>
              {current?.state === 'ready' && current.again && (
                <p role="status" className="flex items-start gap-2 text-sm leading-6 break-keep text-warn" data-testid="chat-share-changed">
                  <AlertCircle size={16} className="mt-1 shrink-0" aria-hidden />
                  {current.again === 'changed' ? t('chat.shareChat.changed') : t('share.again')}
                </p>
              )}
              {check && stake && <ShareWarning check={check} names={warnNames} onShow={() => setListing(true)} grey={false} compact testId="chat-share-warning" />}
              {filesLine && <GreyLine text={filesLine} testId="chat-share-files" />}
              {filesStep && <FilesStep files={stepFiles} already={!adding.length} who={adding.length ? addedNames : null} changed={!!filesChanged} checked={withFiles} onChange={setWithFiles} />}
              {grey && <GreyLine text={grey} testId="chat-share-grey" />}
              {keepsThrough.map((k) => (
                <p key={k.id} className="flex items-start gap-2 text-sm leading-6 break-keep text-muted" data-testid="chat-share-keeps-through">
                  <Info size={16} className="mt-1 shrink-0 text-faint" aria-hidden />
                  <span>{k.text}</span>
                </p>
              ))}
              {removesAll && <p className="text-sm leading-6 break-keep text-warn" data-testid="chat-share-only-you">{t('chat.share.onlyYou')}</p>}
            </>
          )}
        </div>
      )}
    </Modal>
  )
}

/** "Share the files too (n)": one checkbox for the files the chat made in my own folder (they go together), each file
 * with its place under it, and one small hint (the copies going with the chat in its tooltip). `already`: a chat
 * already shared (no one being added). `who`: the people being added, for a file made from files they can't open. */
function FilesStep({ files, already, who, changed, checked, onChange }: { files: readonly ChatMadeFile[]; already: boolean; who: string | null; changed: boolean; checked: boolean; onChange: (v: boolean) => void }) {
  const t = useT()
  return (
    <section className="space-y-2 rounded-lg border border-line px-3 py-2.5" aria-labelledby="chat-share-files-title" data-testid="chat-share-files-step" data-already={already ? '' : undefined}>
      <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium break-keep text-ink">
        <input type="checkbox" className="size-4 shrink-0 accent-[var(--c-accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby="chat-share-files-hint" data-testid="chat-share-files-check" />
        <span id="chat-share-files-title">{t('chat.shareFiles.include', { n: files.length })}</span>
      </label>
      {changed && (
        <p role="status" className="flex items-start gap-2 text-sm leading-6 break-keep text-warn" data-testid="chat-share-files-changed">
          <AlertCircle size={16} className="mt-1 shrink-0" aria-hidden />{t('chat.shareFiles.changed')}
        </p>
      )}
      <ul className="space-y-1 pl-[26px]" aria-label={t('chat.shareFiles.list')}>
        {files.map((f, i) => (
          <li key={`${f.place}/${f.name}/${i}`} className="flex min-w-0 items-start gap-2 text-sm leading-5" data-testid="chat-share-files-item">
            <FileText size={14} className="mt-0.5 shrink-0 text-faint" aria-hidden />
            <span className="min-w-0">
              <span className="block break-all text-ink">{f.name}</span>
              <span className="block truncate text-xs text-muted" title={f.place}>{f.place}</span>
              {f.private && who && <span className="block text-xs leading-5 break-keep text-warn" data-testid="chat-share-files-private">{t('chat.shareFiles.private', { names: who })}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p id="chat-share-files-hint" className="pl-[26px] text-xs leading-5 break-keep text-muted" title={t('chat.shareFiles.keep')} data-testid="chat-share-files-hint">{t('chat.shareFiles.hint')}</p>
    </section>
  )
}

/** Share again on a chat that just moved (out of a personal project): the Share dialog outside projects, the project
 * members' share in a team project, nothing in another personal one. */
function shareAgain(c: Chat) {
  if (!c.projectId) return openChatShare(c)
  const p = useProjects.getState().byId[c.projectId]
  if (p && isTeamProject(p)) openShareChat(c.id)
}

/** What a Share item opens (lib/sharedChat.ts shareKindOf): the project members' share for my private chat in a team
 * project, this dialog for the rest. */
export function startShare(chat: Target['chat'], kind: ShareKind) {
  if (kind === 'project') openShareChat(chat.id)
  else openChatShare(chat, { personal: kind === 'personal' })
}

/** What the Share items open, from anywhere (the title menu, every row's "⋯", the line under the box, the move dialog
 * after a move): one dialog for the app (ChatShareHost, App.tsx). */
type Target = { chat: Pick<Chat, 'id' | 'title'> & Partial<Pick<Chat, 'projectId' | 'shared'>>; personal: boolean; seq: number; returnTo: HTMLElement | null }
const useChatShareHost = create<{ open: Target | null; seq: number }>(() => ({ open: null, seq: 0 }))
export const openChatShare = (chat: Target['chat'], o: { personal?: boolean } = {}) => {
  // the control that opened it, found now: a menu item goes with its menu, so focus returns to the menu's trigger
  // (QA TC-2271); else whatever had focus (the line under the box)
  const active = typeof document === 'undefined' ? null : document.activeElement
  const returnTo = menuOpener() ?? (active instanceof HTMLElement && active !== document.body ? active : null)
  useChatShareHost.setState((s) => ({ open: { chat, personal: !!o.personal, seq: s.seq + 1, returnTo }, seq: s.seq + 1 }))
}

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
  return <ChatShareDialog key={open.seq} chat={open.chat} personal={open.personal} returnTo={open.returnTo} onClose={() => useChatShareHost.setState({ open: null })} />
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

/** The names a warning line says (whoNames): the picks at the places `warn` lists, in the list the check was asked for. */
export function warnNamesOf(t: ReturnType<typeof useT>, list: readonly ProjectParticipant[], warn: readonly number[], nameOf: (x: ProjectParticipant) => string): string {
  return whoNames(t, warn.flatMap((i) => (list[i] ? [{ subjectType: list[i]!.subjectType, name: nameOf(list[i]!) }] : [])))
}
