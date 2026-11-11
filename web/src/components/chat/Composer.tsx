// The message box: auto-growing text, Enter sends (Shift+Enter new line, IME-safe), attachments (button, drag and
// drop, paste, camera on phones) uploaded right away (chunked when large; components/chat/ComposerFiles.tsx, which the
// Trina side chat's box uses too), voice input → transcription job → text,
// engine / model choice, stop while an answer runs. The draft text is kept per chat across reloads.
// While an answer runs the box stays usable: Enter (or the clock button next to Stop) hands the message to the chat,
// which keeps it waiting and sends it when the answer is done (store/sendQueue.ts). While the AI waits for an answer
// to its question (an ask_user card), sending answers that question instead (lib/askAnswer.ts): text only, attached
// files stay in the box for the next message.
// The attach button opens a small menu (on a phone the attach sheet every message box has: AttachSheet.tsx): upload from
// this computer, or add files of the team folder (TeamFilePicker), which are attached as references (POST /api/attachments/team-file) and shown as chips with a folder icon. Team
// files also arrive from the file screen / preview ("Ask AI about this", "Add to current chat", drag from the preview).
// Files from this computer dropped anywhere on the chat's page go into the box (components/FileDropZone.tsx).
// "/" at the start lists the team skills (SkillMenu); "#" lists my team chat rooms and puts the one picked in the message
// as a token that carries its id (RoomRefMenu, docs/DECISIONS.md "내 AI 채팅에서 대화방 읽기").
// Below 768px the box is a room's box (rooms/RoomComposer.tsx): attach inside it on the left, the mic and a round send
// on the right; the row under it keeps only the engine picker, for people who may choose one.
// Voice input (lib/useVoiceInput.ts, components/VoiceBar.tsx): the mic in the box right before send (as in ChatGPT's
// box), holding Space in the box on a computer, or a finger held on the mic; the words go to the end of the box, never
// sent by themselves.
// Text that looks like a key or password waits for "Send anyway" (SecretWarning): a message goes to the AI provider
// and stays in the chat; a service's key belongs in the connect card the AI shows.
// A shared project chat (docs/DECISIONS.md "Shared project chats"): nothing waits to be sent while an answer runs
// (`queueing` off), someone else's turn holds the send with a line above the text (`hold`, the text stays), a file from
// this computer is saved in the project folder and a line under the chips says so (`sharedUploads`; offered only to
// someone who may write that folder, else team files only: no computer or camera, no pasted or dropped files).
// Every chat's box says who sees the chat (`who`, components/chat/WhoSees.tsx, docs/DECISIONS.md "Who sees it, always"):
// on a computer after the note in the row under the box, on a phone as the one line under it.
// Text put in the box for the person (a chosen suggestion, 자연스러운 글's request, a recovery draft) is focused with the
// caret at its end, so what they type or paste next follows it (a caret left at the start put a pasted text before
// "/humanizer …" and broke the command). A request that needs the person's own text after it (`waitsFor`) is not sent
// alone: send waits and a quiet line under the box says what to add.
import clsx from 'clsx'
import { ArrowUp, Camera, Clock, CornerDownLeft, FolderOpen, Hourglass, Loader2, MessageCircleQuestion, Monitor, Plus, Smartphone, Square, ChevronDown, WifiOff } from 'lucide-react'
import { useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import { isUuid7, MESSAGE_ATTACHMENTS_MAX, type Attachment, type EngineId, type FileEntry } from '@mycel/shared/api'
import { errorText, isConnectionError } from '../../lib/api'
import { markBusy } from '../../lib/busy'
import { readDraft, writeDraft } from '../../lib/localData'
import { mergeDraft } from '../../lib/composerDraft'
import { useVoiceInput } from '../../lib/useVoiceInput'
import { micState, voiceBlockedHere } from '../../lib/voice'
import { useConfidentialChat } from '../../lib/confidential'
import { usePanelExpanded } from '../../lib/sidePanel'
import { registerComposer } from '../../lib/teamAttach'
import { VoiceBar, VoiceLive, VoiceMic, VoiceProgress } from '../VoiceBar'
import { useLocale, useT } from '../../i18n'
import { useMe } from '../../store/session'
import { ComposerFileList, SharedUploadLine, useComposerFiles, useFileDrop } from './ComposerFiles'
import { useDropTarget } from '../FileDropZone'
import { ENGINE_LABEL, EngineOptions } from './EngineMenu'
import { Button, IconButton, useMediaQuery } from '../ui'
import { CalmNotice, useSaysConnection } from '../LoadError'
import { useSkillMenu } from './SkillMenu'
import TeamFilePicker from './TeamFilePicker'
import { AttachSheet } from './AttachSheet'
import { EngineSheet } from './EngineSheet'
import { SecretWarning, useSecretHold } from './SecretWarning'
import { SkillChip } from './SkillChip'
import { TokenLayer, useRoomRefMenu } from './RoomRefMenu'
import { fromWire } from '../../lib/roomRefs'
import { useTextSize } from '../../lib/textSize'
import { Tooltip } from '../Tooltip'

export interface EngineChoice { engine: EngineId | undefined; model: string | null | undefined }
export interface ComposerHandle { prepareDraft: (request: string) => void; focus: () => void }


export default function Composer({
  ref,
  draftId,
  ensureChat,
  running,
  onSend,
  answering,
  choiceWaiting,
  onStop,
  engine,
  onEngine,
  engines,
  models,
  initialText,
  autoFocus,
  placeholder,
  footer,
  who,
  skill,
  hold,
  queueing = true,
  sharedUploads,
  projectId,
  waitsFor,
}: {
  ref?: Ref<ComposerHandle>
  /** chat id, or "new" / "project:<id>" for a chat not created yet */
  draftId: string
  /** the chat to upload attachments into (creates it on the first attachment of a new chat) */
  ensureChat: () => Promise<string>
  running: boolean
  onSend: (text: string, attachments: Attachment[]) => Promise<void>
  /** the AI waits for the answer to its question in this chat: sending answers it with the text */
  answering?: { question: string; onAnswer: (text: string) => Promise<void> }
  /** a card in this chat waits for a choice only its own buttons make (a server safety check, a browser site,
   * connecting a service) */
  choiceWaiting?: boolean
  onStop: () => Promise<void>
  engine: EngineChoice
  /** only for people who may pick the engine (store/session canChooseEngine): without it there is no picker */
  onEngine?: (e: EngineChoice) => void
  /** the engines this person may pick (switched on) */
  engines?: EngineId[]
  /** models per engine */
  models?: Partial<Record<EngineId, { id: string; label: string }[]>>
  initialText?: string
  autoFocus?: boolean
  /** the empty box's hint, when it is not the usual one (a project's page) */
  placeholder?: string
  /** a short note in the row under the box (the chat's "AI can make mistakes"); computers only */
  footer?: string
  /** who sees the chat (components/chat/WhoSees.tsx): after `footer` in the row under the box on a computer, the one line
   * under the box on a phone */
  who?: ReactNode
  /** a skill chosen for the message (a member's first question from a team link): shown as a chip by its title, the
   * box holding only the question; sending puts "/<name> " in front, so the skill runs as from the "/" menu */
  skill?: { name: string; title: string } | null
  /** someone else's question is being answered in this shared chat: this line above the text, and nothing is sent until
   * it is done (the text stays) */
  hold?: string
  /** false: a message typed while an answer runs does not wait to be sent (a shared chat) */
  queueing?: boolean
  /** a shared project chat: a file from this computer is saved in its project folder (the server's doing), and a line
   * under the chips says so and how many people see it there (`audience`). `allowed` false: the person may not write
   * that folder (Project.chatUploads, Chat.shared.canUpload), so files come from the team folder only */
  sharedUploads?: { audience: number; allowed?: boolean }
  /** the chat's project: its own skills are in the "/" menu (docs/DECISIONS.md "Project skills") */
  projectId?: string | null
  /** the box was filled with a request that needs the person's own text after it (자연스러운 글's "/humanizer 아래 글을
   * …:"): while the box holds only `text` (and no file), nothing is sent and `hint` shows under the box */
  waitsFor?: { text: string; hint: string }
}) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const userId = me?.user.id ?? '-'
  // voice input off (Admin > Team settings): no mic for members, a hint to the setting for admins
  const mic = micState(me)
  // the chat voice input is for (a new chat has none yet: the server then answers for a new chat); a confidential
  // chat's recording never goes to an outside speech service
  const voiceChatId = isUuid7(draftId) ? draftId : null
  const confidential = useConfidentialChat(voiceChatId)
  // the draft is kept as it is sent: "#" tokens with their rooms' ids, shown in the box as "#<title>" (lib/roomRefs.ts)
  const [initial] = useState(() => fromWire(initialText ?? readDraft(userId, draftId)))
  const [text, setText] = useState(initial.text)
  // the chosen skill's chip (taken out with its X: the question then goes without the skill)
  const [chosen, setChosen] = useState(skill ?? null)
  const skillMenu = useSkillMenu(text, setText, projectId)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // a confidential chat keeps to its local tools: no room is read there, so "#" lists none (closed while not known);
  // nor while the box answers the AI's question (that answer is plain text, it carries no room)
  const roomMenu = useRoomRefMenu({ text, setText, input: taRef, initial: initial.picked, enabled: confidential === false && !answering })
  const wired = roomMenu.wire(text)
  const tokens = roomMenu.ranges.length > 0
  const [scrollTop, setScrollTop] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // the send failed for the connection (lib/api.ts isConnectionError): the calm line under the box, the text kept in it
  // and [다시 시도], never red and never sent by itself (docs/DECISIONS.md "How we show errors")
  const [unsent, setUnsent] = useState(false)
  // it says the connection is down: a notice of the same page (Home's 「팀에 준비된 것」) does not say it again
  useSaysConnection(unsent && !error)
  // files from this computer: everywhere but a shared chat whose project folder the person may not write
  const computer = sharedUploads?.allowed !== false
  // the chips live outside the component too (components/chat/ComposerFiles.tsx, lib/teamAttach stash): leaving the
  // page and coming back, or adding files one at a time from the file screen, keeps what was attached for this draft
  // until it is sent or removed
  const { files, live, uploading, ready, attachments, addFiles, addTeamFiles, removeFile, clearSent, onPaste, onPicked } = useComposerFiles({ userId, draftId, ensureChat, onError: setError, computer })
  // a shared chat: when someone else's turn starts or ends, the line above the text says so; a refusal shown before
  // ("○○님의 질문에 답하는 중이에요") would only repeat it or go stale
  useEffect(() => { setError(null) }, [hold])
  const [sending, setSending] = useState(false)
  /** the text looks like a key: sending waits for "Send anyway" or "Edit" (a changed text asks again) */
  const secret = useSecretHold(text)
  const [stopping, setStopping] = useState(false)
  // files from this computer dropped anywhere on the chat's page (pages/Chat.tsx: FileDropZone) come here, with the box's
  // own checks: none for someone who may not write a shared chat's project folder, no more in a full box. Outside such a
  // page (Home) the box takes them on itself, and refuses them in the same case (the not-allowed cursor, no highlight).
  // A team file dragged from the file screen, a preview or a message goes on the box only.
  const noComputer = computer ? null : t('drop.noComputer')
  const inZone = useDropTarget({ files: (all) => void addFiles(all), refusal: () => noComputer ?? (live.length >= MESSAGE_ATTACHMENTS_MAX ? t('composer.tooMany', { n: MESSAGE_ATTACHMENTS_MAX }) : null) })
  const { drag: dragOver, refusal: dropRefused, dropProps } = useFileDrop({ files: inZone ? undefined : (all) => void addFiles(all), teamPath: (path) => void addTeamFiles([{ path }]), refusal: (kind) => (kind === 'files' ? noComputer : null) })
  const drag = dragOver && !dropRefused
  const [engineMenu, setEngineMenu] = useState(false)
  const [attachMenu, setAttachMenu] = useState(false)
  const [picker, setPicker] = useState(false)
  const attachMenuRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // a computer's engine list: a click outside it or Escape closes it (a phone's is a sheet: EngineSheet)
  const engineButtonRef = useRef<HTMLButtonElement>(null)
  const engineListRef = useRef<HTMLUListElement>(null)
  const voice = useVoiceInput({
    input: taRef,
    root: rootRef,
    text,
    replace: (next) => {
      setText(next)
      roomMenu.track()
    },
    append: (said) => setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${said}` : said)),
    chatId: voiceChatId,
    blocked: voiceBlockedHere(me, confidential),
    enabled: mic === 'on' && !sending,
    menuOpen: skillMenu.open || roomMenu.open,
    onError: setError,
    afterFocus: roomMenu.track,
  })
  const transcribing = voice.transcribing
  const answeringId = useId()

  useImperativeHandle(ref, () => ({
    prepareDraft(request) {
      // Recovery is a draft edit, never a send. Keep text and all attachment states intact.
      // Do not race a send or voice transcription that will replace the current text.
      if (running || sending || voice.busy) return
      setText((current) => mergeDraft(current, request))
      // once the merged text is in the box: the caret after it
      requestAnimationFrame(() => focusAtEnd(taRef.current))
    },
    focus() {
      taRef.current?.focus()
    },
  }), [running, sending, voice.busy])

  useEffect(() => writeDraft(userId, draftId, wired), [userId, wired, draftId])
  // "the message is still here" no longer holds once the box is emptied
  useEffect(() => { if (!text.trim()) setUnsent(false) }, [text])
  // a non-empty draft (or an upload: useComposerFiles) means "don't reload the page by yourself" after an update
  useEffect(() => (text.trim() ? markBusy('draft') : undefined), [text])

  const hint = transcribing ? voice.transcribingText : answering ? t('composer.answerPlaceholder') : running && queueing ? t(choiceWaiting ? 'outbox.placeholderChoice' : 'outbox.placeholder') : (placeholder ?? t('composer.placeholder'))
  // the box grows with its text, and also with a long placeholder (an empty box measures its placeholder), so a hint
  // that needs 2 lines on a phone is not cut in half when it changes while the text stays the same; and again when the
  // person's text size changes (Settings > Profile, over this page). Behind a big side panel (lib/sidePanel.ts) the box
  // is not drawn and measures 0: it keeps its height, and is measured again when the page shows
  const textSize = useTextSize()
  const behindPanel = usePanelExpanded()
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    const was = ta.style.height
    ta.style.height = 'auto'
    ta.style.height = ta.scrollHeight ? Math.min(ta.scrollHeight, 240) + 'px' : was
    // (and again when the box comes back after a recording: the bar stood in its place)
  }, [text, hint, textSize, voice.recording, behindPanel])

  // a box opened with text in it (a chosen suggestion): the caret after the text, never before it
  useEffect(() => {
    if (autoFocus && window.matchMedia?.('(pointer: fine)').matches && !document.querySelector('[role="dialog"]')) focusAtEnd(taRef.current)
  }, [autoFocus])

  const addTeamRef = useRef(addTeamFiles)
  addTeamRef.current = addTeamFiles
  useEffect(() => registerComposer(draftId, (paths) => addTeamRef.current(paths.map((path) => ({ path })))), [draftId])

  useEffect(() => {
    if (!attachMenu) return
    const close = (e: MouseEvent) => {
      if (!attachMenuRef.current?.contains(e.target as Node)) setAttachMenu(false)
    }
    // Escape anywhere closes the menu (focus back on the button)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setAttachMenu(false)
      attachButton()?.focus()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [attachMenu])
  useEffect(() => {
    if (!engineMenu) return
    const close = (e: PointerEvent) => {
      const at = e.target as Node
      if (!engineListRef.current?.contains(at) && !engineButtonRef.current?.contains(at)) setEngineMenu(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setEngineMenu(false)
      engineButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', key)
    }
  }, [engineMenu])
  const attachButton = () => attachMenuRef.current?.querySelector<HTMLElement>('[data-testid="attach-button"]') ?? null
  const menuItems = () => [...(attachMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].filter((x) => x.offsetParent !== null)
  const openMenu = (focusFirst: boolean) => {
    setAttachMenu(true)
    if (focusFirst) requestAnimationFrame(() => menuItems()[0]?.focus())
  }
  // phones and tablets: "from this device", else "from this computer"
  const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
  // below 768px (the phone top bar and tabs): attach and voice go inside the box, as in a room's box
  const phone = useMediaQuery('(max-width: 767.98px)')

  // the request alone, nothing of the person's own after it yet (a file attached is their text: it can go, but not one
  // whose upload failed, which is not sent)
  const waiting = !!waitsFor && !answering && !ready.length && text.trim() === waitsFor.text.trim()
  // also while an answer runs: the chat keeps the message waiting and sends it when the answer is done. An answer to
  // the AI's question is the text alone (an upload in progress does not hold it up).
  const canSend = answering
    ? !sending && !voice.busy && text.trim().length > 0
    : !hold && !waiting && !(running && !queueing) && !sending && !uploading && !voice.busy && (text.trim().length > 0 || ready.length > 0 || !!chosen)

  // onClick hands submit the click event: "Send anyway" goes through send(true)
  const submit = () => send(false)
  const send = async (anyway: boolean) => {
    if (!canSend) return
    if (!secret.pass(anyway)) return
    setSending(true)
    setError(null)
    setUnsent(false)
    if (answering) {
      // a failure (the question was answered in another window or closed meanwhile) keeps the text and says why
      try {
        await answering.onAnswer(text)
        setText('')
        roomMenu.reset()
        writeDraft(userId, draftId, '')
      } catch (e) {
        if (isConnectionError(e)) setUnsent(true)
        else setError(errorText(e, locale, t('error.network')))
      } finally {
        setSending(false)
      }
      return
    }
    // the chip is the command: "/<name> question" (the space after the name keeps it a command, as the "/" menu writes it)
    // a "#" room goes as its token (its id), so the AI reads exactly that room
    const body = chosen ? `/${chosen.name} ${wired}`.trimEnd() : wired
    const atts = attachments()
    try {
      await onSend(body, atts)
      setText('')
      roomMenu.reset()
      setChosen(null)
      writeDraft(userId, draftId, '')
      clearSent()
    } catch (e) {
      if (isConnectionError(e)) setUnsent(true)
      else setError(errorText(e, locale, t('error.network')))
    } finally {
      setSending(false)
    }
  }

  const stop = async () => {
    setStopping(true)
    setError(null)
    try {
      await onStop()
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setStopping(false)
    }
  }

  // the API engine has one model (the owner's): its name shows even when none was picked
  const shownModel = engine.engine && (engine.model ? models?.[engine.engine]?.find((m) => m.id === engine.model)?.label ?? engine.model : engine.engine === 'api' ? models?.api?.[0]?.label : undefined)
  const engineLabel = engine.engine ? ENGINE_LABEL[engine.engine] + (shownModel ? ` · ${shownModel}` : '') : t('composer.defaultEngine')

  // attach: under the box with its small menu on a computer; inside the box on a phone, as the attach sheet every
  // message box has there (AttachSheet: 사진 보관함, 사진 찍기, 파일, 팀 파일; one picker each)
  const attachControls = phone ? (
    <AttachSheet onFiles={(all) => void addFiles(all)} onTeam={() => setPicker(true)} computer={computer} icon={<Plus size={19} />} testId="attach-button" filesTestId="file-input" />
  ) : (
    <>
      <div
        // flex: the button itself is what a phone's slot centres (not a line box around it)
        className="relative flex"
        ref={attachMenuRef}
        onBlur={(e) => {
          // focus moving out of the button and its menu (Tab, Shift+Tab) closes the menu; no new target (Safari
          // does not focus a clicked button) is left to the click-outside handler
          if (attachMenu && e.relatedTarget && !attachMenuRef.current?.contains(e.relatedTarget as Node)) setAttachMenu(false)
        }}
      >
        <IconButton
          label={t('composer.attach')}
          aria-haspopup="menu"
          aria-expanded={attachMenu}
          // a click opens the menu; Enter / Space (detail 0) and the arrow keys also put focus on its first item
          onClick={(e) => (attachMenu ? setAttachMenu(false) : openMenu(e.detail === 0))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              openMenu(true)
            }
          }}
          className="touch-hit"
          data-testid="attach-button"
        >
          <Plus size={19} />
        </IconButton>
        {attachMenu && (
          <div className="absolute bottom-full left-0 z-30 mb-1 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-1 shadow-lg">
          <div
            role="menu"
            aria-label={t('composer.attach')}
            onKeyDown={(e) => {
              const items = menuItems()
              const i = items.indexOf(document.activeElement as HTMLElement)
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
              } else if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault()
                items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
              } else if (e.key === 'Tab') setAttachMenu(false)
            }}
          >
            {/* a shared chat whose project folder the person may not write: the team folder only */}
            {computer && (
            <>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-sm hover:bg-hover focus-visible:bg-hover sm:py-2"
              onClick={() => {
                setAttachMenu(false)
                fileRef.current?.click()
              }}
              data-testid="attach-computer"
            >
              {coarse ? <Smartphone size={16} className="text-muted" aria-hidden /> : <Monitor size={16} className="text-muted" aria-hidden />} {t(coarse ? 'composer.fromDevice' : 'composer.fromComputer')}
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-sm hover:bg-hover focus-visible:bg-hover sm:hidden"
              onClick={() => {
                setAttachMenu(false)
                camRef.current?.click()
              }}
              data-testid="attach-camera"
            >
              <Camera size={16} className="text-muted" aria-hidden /> {t('composer.camera')}
            </button>
            </>
            )}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-sm hover:bg-hover focus-visible:bg-hover sm:py-2"
              onClick={() => {
                // focus on the attach button first: closing the picker without picking brings it back there
                attachButton()?.focus()
                setAttachMenu(false)
                setPicker(true)
              }}
              data-testid="attach-team"
            >
              <FolderOpen size={16} className="text-accent-text" aria-hidden /> {t('composer.fromTeam')}
            </button>
          </div>
          </div>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        onChange={onPicked}
      />
      <input
        ref={camRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={onPicked}
      />
    </>
  )

  return (
    // a phone with the keyboard up (lib/viewport.ts .keyboard-open): the row under the box (the engine picker) goes, so
    // the box and send keep the room above the keyboard; it comes back with the keyboard down
    <div ref={rootRef} className="max-md:in-[.keyboard-open]:[&>[data-testid=composer-controls]]:hidden">
      <VoiceLive voice={voice} />
      {secret.held && (
        <SecretWarning
          onSendAnyway={() => void send(true)}
          onEdit={() => {
            secret.release()
            taRef.current?.focus()
          }}
        />
      )}
      {/* The one field that is focused most of the time: a quiet edge, as in Claude, not the 2px accent edge of other
          fields. At rest --c-field-border (3:1); focused a darker 1px edge (--c-faint, >= 5.5:1) and the caret. */}
      <div
        className={clsx('rounded-2xl border bg-surface shadow-[var(--c-shadow)] transition', drag ? 'border-accent ring-2 ring-accent/30' : 'border-field-border focus-within:border-faint')}
        {...dropProps}
        data-testid="composer"
      >
        <ComposerFileList files={files} onRemove={removeFile} className="px-4 pt-3" />
        {sharedUploads && <SharedUploadLine files={files} audience={sharedUploads.audience} className="px-4 pt-2" />}

        {voice.recording ? (
          // as tall as the box's row (one slot and the row's padding), ✕ and ✓ where "+" (phones) and send were
          <VoiceBar voice={voice} className={clsx('box-content min-h-composer-line py-1 pr-2', phone ? 'pl-1.5' : 'pl-3')} />
        ) : (
          <>
            {skillMenu.menu}
            {roomMenu.list}
            {answering && (
              <div className="space-y-0.5 px-5 pt-3 text-xs">
                <p id={answeringId} className="flex items-center gap-1.5 text-muted" data-testid="composer-answering">
                  <MessageCircleQuestion size={13} className="shrink-0 text-accent-text" aria-hidden />
                  <span className="min-w-0 truncate">{t('composer.answering', { question: answering.question.slice(0, 300) })}</span>
                </p>
                {/* like under the card's own text box (tab 5 "확인 카드"): the typed answer goes to the AI */}
                <p id={`${answeringId}-secrets`} className="text-faint" data-testid="composer-no-secrets">
                  {t('ask.noSecrets')}
                </p>
              </div>
            )}
            {/* a shared chat: someone else's question is being answered (or its card waits for them); the text stays */}
            {hold && !answering && (
              <p id={`${answeringId}-hold`} role="status" className={clsx('flex items-start gap-1.5 pt-3 text-xs leading-5 break-keep text-muted', phone ? 'px-3' : 'px-5')} data-testid="composer-hold">
                <Hourglass size={13} className="mt-1 shrink-0 text-faint" aria-hidden />
                <span className="min-w-0">{hold}</span>
              </p>
            )}
            {chosen && !answering && (
              <div className="px-4 pt-3" data-testid="composer-skill">
                <SkillChip title={chosen.title} name={chosen.name} onRemove={() => { setChosen(null); taRef.current?.focus() }} />
              </div>
            )}
            <VoiceProgress voice={voice} text={text} className={clsx('pt-3', phone ? 'px-3' : 'px-5')} />
            {/* bottom-aligned; each control centred in a slot as tall as one text line's box (index.css
                --spacing-composer-line: the text box's 8px bottom padding, its line and 8px above): one line, one
                centre; more lines, the buttons stay on the last. The rest of the space under the text is the row's. */}
            <div className={clsx('flex items-end gap-1 pr-2 pb-1', phone && 'pl-1.5')}>
              {phone && <div className="flex h-composer-line shrink-0 items-center">{attachControls}</div>}
              {/* the "#" tokens are drawn by a layer behind the box (its own text is transparent then): the native
                  text box keeps Korean input, selection and spell check */}
              <div className="relative min-w-0 flex-1">
                {tokens && <TokenLayer text={text} ranges={roomMenu.ranges} scrollTop={scrollTop} className={clsx('pb-2 text-reading leading-reading', phone ? 'pl-1' : 'pl-5', answering || hold ? 'pt-2' : 'pt-3')} />}
                <textarea
                  ref={taRef}
                  rows={1}
                  value={text}
                  aria-label={t('composer.label')}
                  aria-describedby={answering ? `${answeringId} ${answeringId}-secrets` : hold ? `${answeringId}-hold` : undefined}
                  {...roomMenu.inputProps}
                  onChange={(e) => {
                    setText(e.target.value)
                    roomMenu.track()
                  }}
                  onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
                  onPaste={onPaste}
                  onKeyDown={(e) => {
                    if (skillMenu.onKeyDown(e)) return
                    if (roomMenu.onKeyDown(e)) return
                    if (voice.onKeyDown(e)) return
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                      // phones: Enter makes a new line (send with the button)
                      if (window.matchMedia?.('(pointer: coarse)').matches) return
                      e.preventDefault()
                      void submit()
                    }
                  }}
                  placeholder={hint}
                  // not disabled: the focus stays in the box while the words are on their way
                  readOnly={voice.busy}
                  aria-busy={transcribing || undefined}
                  className={clsx('relative block max-h-[240px] w-full max-md:max-h-[min(240px,calc(var(--app-h,100dvh)*0.3))] min-w-0 resize-none bg-transparent pb-2 text-reading leading-reading outline-none placeholder:text-faint', phone ? 'pl-1' : 'pl-5', answering || hold ? 'pt-2' : 'pt-3', tokens && 'room-ref-field [scrollbar-gutter:stable]')}
                  data-testid="composer-input"
                />
              </div>
              <div className="flex h-composer-line shrink-0 items-center gap-1">
                {/* the mic right before send, as in ChatGPT's box ("+" and the engine stay where they are) */}
                <VoiceMic voice={voice} mic={mic} disabled={sending} />
                {answering
                  ? canSend && (
                      // the AI's question: also how phones (Enter makes a new line there) answer from the box
                      <Tooltip label={t('composer.sendAnswer')}>
                        <button type="button" onClick={submit} aria-label={t('composer.sendAnswer')} className="touch-hit flex h-8 w-8 items-center justify-center rounded-lg text-ink transition hover:bg-hover" data-testid="send-answer">
                          {sending ? <Loader2 size={17} className="animate-spin" /> : <CornerDownLeft size={18} />}
                        </button>
                      </Tooltip>
                    )
                  : running &&
                    canSend && (
                      // phones make a new line with Enter: this button is how a message waits for the answer there
                      <Tooltip label={t('outbox.sendLater')}>
                        <button type="button" onClick={submit} aria-label={t('outbox.sendLater')} className="touch-hit flex h-8 w-8 items-center justify-center rounded-lg text-ink transition hover:bg-hover" data-testid="send-later">
                          <Clock size={17} aria-hidden />
                        </button>
                      </Tooltip>
                    )}
                {running ? (
                  <Tooltip label={t('composer.stop')}>
                    <button type="button" onClick={stop} disabled={stopping} aria-label={t('composer.stop')} className="touch-hit flex h-8 w-8 items-center justify-center rounded-full bg-ink text-canvas transition hover:opacity-80 disabled:opacity-40" data-testid="stop">
                      {stopping ? <Loader2 size={17} className="animate-spin" /> : <Square size={14} className="fill-current" />}
                    </button>
                  </Tooltip>
                ) : (
                  !answering && (
                    <Tooltip label={t('chat.send')}>
                      <button
                        type="button"
                        onClick={submit}
                        disabled={!canSend}
                        aria-label={t('chat.send')}
                        // phones: Enter makes a new line there, so not the quiet return key but the room box's round send
                        className={clsx('touch-hit flex items-center justify-center transition', phone
                          ? clsx('size-10 rounded-full', canSend ? 'bg-accent text-accent-ink hover:bg-accent-hover' : 'bg-subtle text-faint')
                          : clsx('h-8 w-8 rounded-lg', canSend ? 'text-ink hover:bg-hover' : 'text-faint'))}
                        data-testid="send"
                      >
                        {sending ? <Loader2 size={17} className="animate-spin" /> : phone ? <ArrowUp size={18} aria-hidden /> : <CornerDownLeft size={18} />}
                      </button>
                    </Tooltip>
                  )
                )}
              </div>
            </div>
          </>
        )}
      </div>
      {/* under the box, like Claude's: attach on the left, the engine on the right, the note between (the mic is in the
          box, before send). Phones: attach sits inside the box, as in a room's box, and this row is only there for the
          engine. */}
      {(!phone || onEngine) && (
      <div className="flex items-center gap-2 px-1 pt-1.5 max-md:pt-1" data-testid="composer-controls">
        <div className="flex flex-1 basis-0 items-center gap-0.5">
          {!phone && attachControls}
        </div>
        {/* the note under the box: computers only (a phone keeps the bottom for the box and the keyboard) */}
        {waiting ? (
          <p role="status" className="hidden min-w-0 text-center text-micro break-keep text-muted md:block" data-testid="composer-waits">{waitsFor?.hint}</p>
        ) : (footer || who) && (
          <p className="hidden min-w-0 text-center text-micro break-keep text-faint md:block" data-testid="composer-footer">
            {footer}
            {footer && who ? ' ' : null}
            {who}
          </p>
        )}
        <div className="flex flex-1 basis-0 items-center justify-end">
          {onEngine && (
            <div className="relative">
              {/* a phone: the choices as a sheet (a tap outside, Escape or Back closes it); a computer: the small list */}
              {phone ? (
                <EngineSheet engines={engines ?? []} models={models} current={engine} onPick={(p) => onEngine?.(p)} label={engineLabel} title={t('composer.engine')} testId="engine-picker" />
              ) : (<>
              <button ref={engineButtonRef} type="button" aria-haspopup="listbox" aria-expanded={engineMenu} onClick={() => setEngineMenu((v) => !v)} className="touch-hit flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-hover hover:text-ink" data-testid="engine-picker">
                {engineLabel} <ChevronDown size={13} aria-hidden />
              </button>
              {engineMenu && (
                <ul ref={engineListRef} role="listbox" aria-label={t('composer.engine')} className="absolute right-0 bottom-full z-30 mb-1 max-h-72 w-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg" onMouseLeave={() => setEngineMenu(false)}>
                  <EngineOptions
                    engines={engines ?? []}
                    models={models}
                    current={engine}
                    onPick={(p) => {
                      setEngineMenu(false)
                      onEngine(p)
                    }}
                  />
                </ul>
              )}
              </>)}
            </div>
          )}
        </div>
      </div>
      )}
      {/* phones: of the note a computer has in the row above, who sees the chat (one line; the bottom is for the box) */}
      {phone && waiting ? (
        <p role="status" className="px-2 pt-1.5 text-center text-micro break-keep text-muted" data-testid="composer-waits">
          {waitsFor?.hint}
        </p>
      ) : phone && who && (
        // with the keyboard up a chat only I see ("나만 봐요") gives the room to the box; a shared one keeps saying who
        // reads what I type (docs/DECISIONS.md "Who sees it, always")
        <p className={clsx('px-2 pt-1.5 text-center text-micro break-keep text-faint', !sharedUploads && 'in-[.keyboard-open]:hidden')} data-testid="composer-phone-footer">
          {who}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 px-2 text-sm text-danger">
          {error}
        </p>
      )}
      {unsent && !error && (
        <CalmNotice
          className="mt-2"
          testId="composer-unsent"
          icon={<WifiOff size={16} />}
          title={t('conn.unsent')}
          action={<Button size="sm" variant="secondary" disabled={!canSend} onClick={submit} data-testid="composer-unsent-retry">{t('common.retry')}</Button>}
        />
      )}
      <TeamFilePicker
        open={picker}
        onClose={() => setPicker(false)}
        room={Math.max(0, MESSAGE_ATTACHMENTS_MAX - live.length)}
        max={MESSAGE_ATTACHMENTS_MAX}
        attached={new Set(live.filter((f) => f.source === 'team').map((f) => f.attachment?.path ?? f.path!))}
        onPick={(picked: FileEntry[]) => {
          setPicker(false)
          void addTeamFiles(picked.map((f) => ({ path: f.path, name: f.name, size: f.size })))
          // after the dialog has handed focus back (to the attach button): on to the message
          setTimeout(() => taRef.current?.focus(), 0)
        }}
      />
    </div>
  )
}

/** Focus the box with the caret after its text (and the end in view): text put there for the person is added to, never
 * typed or pasted in front of. */
export function focusAtEnd(ta: HTMLTextAreaElement | null) {
  if (!ta) return
  ta.focus()
  const end = ta.value.length
  ta.setSelectionRange(end, end)
  ta.scrollTop = ta.scrollHeight
}
