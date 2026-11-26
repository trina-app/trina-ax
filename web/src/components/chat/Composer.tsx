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
// Files from this computer dropped anywhere on the chat's page, Home or a project's page go into the box (components/FileDropZone.tsx).
// "/" at the start lists the team skills (SkillMenu); "#" lists my team chat rooms and puts the one picked in the message
// as a token that carries its id (RoomRefMenu, docs/DECISIONS.md "내 AI 채팅에서 대화방 읽기").
// The box is one frame, as AI apps have it (QA TC-1400): the text on top and one row under it inside the frame
// (ComposerToolbar: + · the box's choices … the engine picker · mic · send). Nothing of it sits under the frame but the
// computer's note. The engine picker is for people who may choose one, when two or more engines are switched on or the
// one engine has two or more models (EngineMenu showsEnginePicker, AP-032). Below 768px a box with nothing more than + and send (no picker, no choices, not Home's
// `card`, QA TC-391) is a room's box in one line (rooms/RoomComposer.tsx): + on the left, the mic and a round send on the
// right.
// Voice input (lib/useVoiceInput.ts, components/VoiceBar.tsx): the mic in the box right before send (as in ChatGPT's
// box), holding Space in the box on a computer, or a finger held on the mic; the words go to the end of the box, never
// sent by themselves.
// Text that looks like a key or password waits for "Send anyway" (SecretWarning): a message goes to the AI provider
// and stays in the chat; a service's key belongs in the connect card the AI shows.
// A shared project chat (docs/DECISIONS.md "Shared project chats"): while someone else's question is answered a line
// above the text says whose (`note`) and what is sent now waits for it (`later`: the clock button, as while my own answer
// runs; docs/decisions/20261118-shared-chat-queued-sends.md); `hold` keeps the text unsent with its line; a file from
// this computer is saved in the project folder and a line under the chips says so (`sharedUploads`; offered only to
// someone who may write that folder, else team files only: no computer or camera, no pasted or dropped files).
// Every chat's box says who sees the chat (`who`, components/chat/WhoSees.tsx, docs/DECISIONS.md "Who sees it, always"):
// on a computer after the note in the row under the box, on a phone as the one line under it.
// Text put in the box for the person (a chosen suggestion, 자연스러운 글's request, a recovery draft) is focused with the
// caret at its end, so what they type or paste next follows it (a caret left at the start put a pasted text before
// "/humanizer …" and broke the command). A request that needs the person's own text after it (`waitsFor`) is not sent
// alone: send waits and a quiet line under the box says what to add.
import clsx from 'clsx'
import { Hourglass, ChevronDown } from 'lucide-react'
import { useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import { isUuid7, MESSAGE_ATTACHMENTS_MAX, MESSAGE_TEXT_MAX, type Attachment, type Effort, type EngineId } from '@mycel/shared/api'
import { errorText, isApiError, isConnectionError } from '../../lib/api'
import { textOverLimit } from '../../lib/longPaste'
import { waitForUpdate, waitsForUpdate } from '../../lib/serverUpdating'
import { markBusy } from '../../lib/busy'
import { readDraft, writeDraft } from '../../lib/localData'
import { mergeDraft } from '../../lib/composerDraft'
import { useVoiceInput } from '../../lib/useVoiceInput'
import { useEndAfterRecording } from '../../lib/autoGrow'
import { micState, voiceBlockedHere } from '../../lib/voice'
import { useConfidentialChat } from '../../lib/confidential'
import { registerComposer } from '../../lib/teamAttach'
import { useLocale, useT } from '../../i18n'
import { useMe } from '../../store/session'
import { ComposerFileList, SharedUploadLine, useComposerFiles, useFileDrop } from './ComposerFiles'
import { useDropTarget } from '../FileDropZone'
import { EFFORT_KEY, ENGINE_LABEL, EffortRow, EngineOptions, onlyModels, showsEnginePicker, type EnginePick } from './EngineMenu'
import { useEngines } from '../../store/engines'
import { useMediaQuery } from '../ui'
import { useSaysConnection } from '../LoadError'
import { useSkillMenu } from './SkillMenu'
import { EngineSheet } from './EngineSheet'
import { useSecretHold } from './SecretWarning'
import { SkillChip } from './SkillChip'
import { TokenLayer, useRoomRefMenu } from './RoomRefMenu'
import { fromWire } from '../../lib/roomRefs'
import { AttachMenu } from '../composer/AttachMenu'
import { ComposerField } from '../composer/ComposerField'
import { ComposerShell, fieldPad } from '../composer/ComposerShell'
import { composerHint } from '../composer/hint'
import type { Unsent } from '../composer/ComposerNotices'
import { AutoModePill } from './AutoModePill'
import { useDemoOut } from '../../store/demo'

/** effort: the depth (빠르게 · 보통 · 꼼꼼하게); undefined / null = not chosen (the person's or the team's default) */
export interface EngineChoice { engine: EngineId | undefined; model: string | null | undefined; effort?: Effort | null }
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
  focusKey,
  placeholder,
  footer,
  who,
  skill,
  hold,
  note,
  later = false,
  sharedUploads,
  projectId,
  waitsFor,
  blocked,
  card,
  tools,
  aiBand = false,
}: {
  ref?: Ref<ComposerHandle>
  /** chat id, or "new" / "project:<id>" for a chat not created yet */
  draftId: string
  /** the chat to upload attachments into (creates it on the first attachment of a new chat) */
  ensureChat: () => Promise<string>
  running: boolean
  /** the box of an AI chat has no "@" people, also when it is shared or a project's: a person is mentioned in a
   * thread under an AI answer (docs/decisions/20261122-ai-session-no-main-mention.md) */
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
  /** a new value takes the focus again while `autoFocus` is on (Home asked for once more while it is on show) */
  focusKey?: string
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
  /** this line above the text, and nothing is sent until it goes (the text stays): the earlier answer is still ending */
  hold?: string
  /** a line above the text that does not stop a send (a shared chat: whose question is being answered) */
  note?: string
  /** what is sent now waits under the conversation although no answer of mine runs (a shared chat: someone else's turn,
   * or their messages wait): the clock button and placeholder, as while an answer runs, without Stop */
  later?: boolean
  /** a shared project chat: a file from this computer is saved in its project folder (the server's doing), and a line
   * under the chips says so and how many people see it there (`audience`). `allowed` false: the person may not write
   * that folder (Project.chatUploads, Chat.shared.canUpload), so files come from the team folder only */
  sharedUploads?: { audience: number; allowed?: boolean; kind?: 'project' | 'people' }
  /** the chat's project: its own skills are in the "/" menu (docs/DECISIONS.md "Project skills") */
  projectId?: string | null
  /** the box was filled with a request that needs the person's own text after it (자연스러운 글's "/humanizer 아래 글을
   * …:"): while the box holds only `text` (and no file), nothing is sent and `hint` shows under the box */
  waitsFor?: { text: string; hint: string }
  /** nothing can answer yet (Home without AI, QA TC-5447): the text stays unsent, and once something is typed this line
   * under the box says why */
  blocked?: string
  /** phones: one card (Home's new chat, QA TC-391), the text on top and a row under it inside the box with + · the
   * engine picker · mic · send; no row under the box. Computers and the other boxes keep their layout */
  card?: boolean
  /** quiet choices of this box in its bottom row right after +: who sees a team project's new chat (NewChatComposer) */
  tools?: ReactNode
  /** "no usable AI" above the box (chat/AiAccessBanner.tsx) */
  aiBand?: boolean
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
  // the error that is the AI limit used up: a known state, shown as a calm notice, never in red (owner rule; QA TC-2491)
  const [limitText, setLimitText] = useState<string | null>(null)
  // the send failed for the connection (lib/api.ts isConnectionError): the calm line under the box, the text kept in it
  // and [다시 시도], never red and never sent by itself (docs/DECISIONS.md "How we show errors"). 'updating': Trina is
  // updating (lib/serverUpdating.ts): the line says so and the box sends it once by itself when the server is back
  const [unsent, setUnsent] = useState<Unsent>(false)
  // it says the connection is down: a notice of the same page (Home's 「팀에 준비된 것」) does not say it again
  useSaysConnection(!!unsent && !error)
  // files from this computer: everywhere but a shared chat whose project folder the person may not write
  const computer = sharedUploads?.allowed !== false
  // the chips live outside the component too (components/chat/ComposerFiles.tsx, lib/teamAttach stash): leaving the
  // page and coming back, or adding files one at a time from the file screen, keeps what was attached for this draft
  // until it is sent or removed
  const { files, live, uploading, ready, attachments, addFiles, addTeamFiles, removeFile, clearSent, onPaste } = useComposerFiles({ userId, draftId, ensureChat, onError: setError, computer })
  // a shared chat: when someone else's turn starts or ends, the line above the text says so; a refusal shown before
  // ("○○님의 질문에 답하는 중이에요") would only repeat it or go stale
  useEffect(() => { setError(null) }, [hold, note])
  const [sending, setSending] = useState(false)
  /** the text looks like a key: sending waits for "Send anyway" or "Edit" (a changed text asks again) */
  const secret = useSecretHold(text)
  // files from this computer dropped anywhere on the chat's page, Home or a project's page (their FileDropZone) come here,
  // with the box's own checks: none for someone who may not write a shared chat's project folder, no more in a full box.
  // Outside such a page the box takes them on itself, and refuses them in the same case (the not-allowed cursor, no
  // highlight).
  // A team file dragged from the file screen, a preview or a message goes on the box only.
  const noComputer = computer ? null : t('drop.noComputer')
  const inZone = useDropTarget({ files: (all, folders) => void addFiles(all, folders), refusal: () => noComputer ?? (live.length >= MESSAGE_ATTACHMENTS_MAX ? t('composer.tooMany', { n: MESSAGE_ATTACHMENTS_MAX }) : null) })
  const { drag: dragOver, refusal: dropRefused, dropProps } = useFileDrop({ files: inZone ? undefined : (all, folders) => void addFiles(all, folders), teamPath: (path) => void addTeamFiles([{ path }]), refusal: (kind) => (kind === 'files' ? noComputer : null) })
  const drag = dragOver && !dropRefused
  const [engineMenu, setEngineMenu] = useState(false)
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

  // below 768px (the phone top bar and tabs): attach and voice go inside the box, as in a room's box
  const phone = useMediaQuery('(max-width: 767.98px)')
  const hint = composerHint(t, { transcribing: transcribing ? voice.transcribingText : null, answering: !!answering, waiting: running || later, choice: choiceWaiting, own: placeholder ?? t('composer.placeholder'), phone })
  // back after a recording: the newest words in sight, as they were while recording
  useEndAfterRecording(taRef, voice.recording, voice.busy, text)

  // a box opened with text in it (a chosen suggestion): the caret after the text, never before it
  useEffect(() => {
    if (autoFocus && window.matchMedia?.('(pointer: fine)').matches && !document.querySelector('[role="dialog"]')) focusAtEnd(taRef.current)
  }, [autoFocus, focusKey])

  const addTeamRef = useRef(addTeamFiles)
  addTeamRef.current = addTeamFiles
  useEffect(() => registerComposer(draftId, (paths) => addTeamRef.current(paths.map((path) => ({ path })))), [draftId])

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
  // the request alone, nothing of the person's own after it yet (a file attached is their text: it can go, but not one
  // whose upload failed, which is not sent)
  const waiting = !!waitsFor && !answering && !ready.length && text.trim() === waitsFor.text.trim()
  // typed (or attached) while nothing can answer: held, with its line under the box
  const held = !!blocked && !answering && (text.trim().length > 0 || ready.length > 0)
  // also while an answer runs: the chat keeps the message waiting and sends it when the answer is done. An answer to
  // the AI's question is the text alone (an upload in progress does not hold it up).
  // a free-roam demo whose AI is used up (store/demo.ts): nothing goes to the AI any more; one line under the box says so
  const demoOut = useDemoOut()
  const canSend = demoOut ? false : answering
    ? !sending && !voice.busy && text.trim().length > 0
    : !hold && !blocked && !waiting && !sending && !uploading && !voice.busy && (text.trim().length > 0 || ready.length > 0 || !!chosen)

  // onClick hands submit the click event: "Send anyway" goes through send(true)
  const submit = () => send(false)
  const showError = (e: unknown) => {
    const text = errorText(e, locale, t('error.network'))
    setError(text)
    setLimitText(isApiError(e, 'budget_exceeded') ? text : null)
  }
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
        if (isConnectionError(e)) setUnsent(waitsForUpdate(e) ? 'updating' : 'connection')
        else showError(e)
      } finally {
        setSending(false)
      }
      return
    }
    // the chip is the command: "/<name> question" (the space after the name keeps it a command, as the "/" menu writes it)
    // a "#" room goes as its token (its id), so the AI reads exactly that room
    const body = chosen ? `/${chosen.name} ${wired}`.trimEnd() : wired
    // longer than a message holds (typed or dictated; a long paste went in as a file): said here, the text kept
    if (textOverLimit(body)) {
      setSending(false)
      return setError(t('composer.textTooLong', { max: MESSAGE_TEXT_MAX.toLocaleString(locale) }))
    }
    const atts = attachments()
    try {
      await onSend(body, atts)
      setText('')
      roomMenu.reset()
      setChosen(null)
      writeDraft(userId, draftId, '')
      clearSent()
    } catch (e) {
      if (isConnectionError(e)) setUnsent(waitsForUpdate(e) ? 'updating' : 'connection')
      else showError(e)
    } finally {
      setSending(false)
    }
  }

  // Trina was updating: once the server is back the box's text goes, once (an emptied box, or a send meanwhile, ends the
  // wait: the line is gone then)
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    if (unsent !== 'updating') return
    let live = true
    void waitForUpdate().then(() => { if (live) void sendRef.current(false) })
    return () => { live = false }
  }, [unsent])

  const stop = async () => {
    setError(null)
    await onStop()
  }

  // the API engine has one model (the owner's): its name shows even when none was picked
  const shownModel = engine.engine && (engine.model ? models?.[engine.engine]?.find((m) => m.id === engine.model)?.label ?? engine.model : engine.engine === 'api' ? models?.api?.[0]?.label : undefined)
  // the picker: for people who may choose, with two or more engines or one engine with two or more models (AP-032);
  // with one engine it lists that engine's models only
  const pick = onEngine && showsEnginePicker(engines ?? [], models) ? onEngine : undefined
  const modelsOnly = onlyModels(engines ?? [])
  // the depth (빠르게 · 보통 · 꼼꼼하게): a row under the models when the engine takes one; the button names it only when it
  // is not 보통 ("Claude · Opus · 꼼꼼하게")
  const takesEffort = useEngines((s) => s.effort)
  const billing = useEngines((s) => s.billing)
  const teamEffort = useEngines((s) => s.defaultEffort)
  const teamEngine = useEngines((s) => s.defaultEngine)
  const effortOn = !!takesEffort[engine.engine ?? teamEngine]
  const effortNow: Effort = engine.effort ?? teamEffort ?? 'normal'
  const pickModel = pick && ((p: EnginePick) => pick({ ...p, ...(engine.effort !== undefined ? { effort: engine.effort } : {}) }))
  const pickEffort = pick && ((e: Effort) => pick({ engine: engine.engine, model: engine.model, effort: e }))
  const effortWord = effortOn && effortNow !== 'normal' ? t(EFFORT_KEY[effortNow]) : null
  const engineLabel = (engine.engine ? ENGINE_LABEL[engine.engine] + (shownModel ? ` · ${shownModel}` : '') : t('composer.defaultEngine')) + (effortWord ? ` · ${effortWord}` : '')
  // the text on top and one row under it inside the box (ComposerToolbar: + and the box's choices on the left, the
  // engine, the mic and send on the right), as in the AI apps' boxes (QA TC-1400): every computer, and a phone whenever the box has more
  // than + and send (Home's card, the engine picker, a team project's who-sees chip). A phone's plain chat box keeps
  // one line (+ · text · mic · send), with nothing under or beside it either
  // the auto mode pill (AutoModePill): while the team lets this person use it, never in a confidential chat
  const autoPill = me?.team?.autoMode && confidential !== true ? <AutoModePill /> : null
  const stacked = !phone || !!card || !!pick || !!tools || !!autoPill

  // attach: the + every message box has (composer/AttachMenu.tsx: its small menu on a computer, the attach sheet on a
  // phone); team files go on by reference
  const attachControls = (
    <AttachMenu
      key={draftId}
      onFiles={(all) => void addFiles(all)}
      computer={computer}
      onTeamFiles={(picked) => void addTeamFiles(picked.map((f) => ({ path: f.path, name: f.name, size: f.size })))}
      teamAttached={new Set(live.filter((f) => f.source === 'team').map((f) => f.attachment?.path ?? f.path!))}
      room={MESSAGE_ATTACHMENTS_MAX - live.length}
      max={MESSAGE_ATTACHMENTS_MAX}
      testId="attach-button"
      filesTestId="file-input"
      round={phone && stacked}
      onPicked={() => taRef.current?.focus()}
    />
  )
  // the text's padding (the "#" layer behind it has the same): a line above the text (the AI's question, whose turn it
  // is) leaves less space on top
  const pad = stacked ? clsx('px-4.5 pb-1', answering || hold || note ? 'pt-2' : 'pt-3') : fieldPad(true)

  // the engine picker in the box's row: on a phone the choices as a sheet (a tap outside, Escape or Back closes it),
  // named for what it does and what is chosen ("AI 고르기, 지금: 기본 AI"); on a computer the small list
  const enginePicker = pick && (phone ? (
    <EngineSheet engines={engines ?? []} models={models} current={engine} onPick={pickModel!} label={engineLabel} name={t('composer.engineNow', { engine: engineLabel })} title={t('composer.engine')} testId="engine-picker" look="pill" modelsOnly={modelsOnly}
      billing={billing} effort={effortOn && pickEffort ? { value: effortNow, onPick: pickEffort } : undefined} />
  ) : (
    <div className="relative">
      <button ref={engineButtonRef} type="button" aria-haspopup="listbox" aria-expanded={engineMenu} onClick={() => setEngineMenu((v) => !v)} className="touch-hit flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-hover hover:text-ink" data-testid="engine-picker">
        {engineLabel} <ChevronDown size={13} aria-hidden />
      </button>
      {engineMenu && (
        <ul ref={engineListRef} role="listbox" aria-label={t('composer.engine')} className="absolute right-0 bottom-full z-30 mb-1 max-h-96 w-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg" onMouseLeave={() => setEngineMenu(false)}>
          <EngineOptions
            engines={engines ?? []}
            models={models}
            current={engine}
            modelsOnly={modelsOnly}
            billing={billing}
            onPick={(p) => {
              setEngineMenu(false)
              pickModel!(p)
            }}
          />
          {effortOn && pickEffort && <li role="presentation"><EffortRow value={effortNow} onPick={pickEffort} /></li>}
        </ul>
      )}
    </div>
  ))

  // under the box: what a request still waits for, or why nothing is sent, as a status line (every width); else the
  // computer's note (the chat's "AI can make mistakes" and who sees it), and on a phone who sees the chat
  const status = held ? blocked : waiting ? waitsFor?.hint : null
  return (
    <ComposerShell
      rootRef={rootRef}
      testId="composer"
      toolsTestId="composer-tools"
      line={!stacked}
      drag={drag}
      dropProps={dropProps}
      aiBand={aiBand}
      secret={{
        held: secret.held,
        onSendAnyway: () => void send(true),
        onEdit: () => {
          secret.release()
          taRef.current?.focus()
        },
      }}
      files={files.length > 0}
      text={text}
      hint={hint}
      heldTestId="composer-text-held"
      voice={voice}
      mic={mic}
      micDisabled={sending}
      top={<>
        <ComposerFileList files={files} onRemove={removeFile} className="px-4 pt-3" />
        {sharedUploads && <SharedUploadLine files={files} audience={sharedUploads.audience} kind={sharedUploads.kind} className="px-4 pt-2" />}
        {!voice.recording && <>
          {skillMenu.menu}
          {roomMenu.list}
          {/* answering the AI's open question: the placeholder says so and the card is right above, so no line naming
              the question again (QA TC-ask1-18); the typed answer goes to the AI */}
          {answering && (
            <p id={`${answeringId}-secrets`} className="px-5 pt-3 text-xs text-faint" data-testid="composer-no-secrets">
              {t('ask.noSecrets')}
            </p>
          )}
          {/* a shared chat: someone else's question is being answered (or its card waits for them); the text stays */}
          {(hold || note) && !answering && (
            <p id={`${answeringId}-hold`} role="status" className={clsx('flex items-start gap-1.5 pt-3 text-xs leading-5 break-keep text-muted', phone ? 'px-3' : 'px-5')} data-testid="composer-hold">
              <Hourglass size={13} className="mt-1 shrink-0 text-faint" aria-hidden />
              <span className="min-w-0">{hold ?? note}</span>
            </p>
          )}
          {chosen && !answering && (
            <div className="px-4 pt-3" data-testid="composer-skill">
              <SkillChip title={chosen.title} name={chosen.name} onRemove={() => { setChosen(null); taRef.current?.focus() }} />
            </div>
          )}
        </>}
      </>}
      field={
        <ComposerField
          ref={taRef}
          value={text}
          onText={(v) => {
            setText(v)
            roomMenu.track()
          }}
          keys={(e) => skillMenu.onKeyDown(e) || roomMenu.onKeyDown(e)}
          voice={voice}
          onSend={submit}
          pad={pad}
          // the "#" tokens are drawn by a layer behind the box (its own text is transparent then): the native text box
          // keeps Korean input, selection and spell check
          overlay={tokens && <TokenLayer text={text} ranges={roomMenu.ranges} scrollTop={scrollTop} className={clsx('text-reading leading-reading', pad)} />}
          aria-label={t('composer.label')}
          aria-describedby={answering ? `${answeringId}-secrets` : hold || note ? `${answeringId}-hold` : undefined}
          {...roomMenu.inputProps}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onPaste={onPaste}
          placeholder={hint}
          // not disabled: the focus stays in the box while the words are on their way. A free-roam demo whose AI is used
          // up: nothing more to type for the AI (the line under the box says so), what was typed stays
          readOnly={voice.busy || demoOut}
          aria-disabled={demoOut || undefined}
          aria-busy={transcribing || undefined}
          className={clsx(tokens && 'room-ref-field [scrollbar-gutter:stable]', demoOut && 'cursor-not-allowed text-muted')}
          data-testid="composer-input"
        />
      }
      start={<>{attachControls}{tools}{autoPill}</>}
      end={enginePicker}
      send={answering
        ? { kind: 'answer', can: canSend, sending, onSend: submit, testId: 'send-answer' }
        : running || later
          ? { kind: 'later', can: canSend, onSend: submit, testId: 'send-later' }
          : { kind: 'send', can: canSend, sending, onSend: submit, testId: 'send' }}
      stop={running ? { onStop: stop, onError: (e) => setError(errorText(e, locale, t('error.network'))), testId: 'stop' } : null}
      footer={!status && (footer || who) ? <>{footer}{footer && who ? ' ' : null}{who}</> : null}
      below={status ? (
        <p role="status" className="px-2 pt-1.5 text-center text-micro break-keep text-muted" data-testid={held ? 'composer-blocked' : 'composer-waits'}>{status}</p>
      ) : phone && who ? (
        // with the keyboard up a chat only I see ("나만 봐요") gives the room to the box; a shared one keeps saying who
        // reads what I type (docs/DECISIONS.md "Who sees it, always")
        <p className={clsx('px-2 pt-1.5 text-center text-micro break-keep text-faint', !sharedUploads && 'in-[.keyboard-open]:hidden')} data-testid="composer-phone-footer">{who}</p>
      ) : null}
      notices={{
        prefix: 'composer',
        demoOut,
        limit: error && error === limitText && !demoOut ? error : null,
        error: error && error !== limitText ? error : null,
        unsent,
        onRetry: submit,
        canRetry: canSend,
      }}
    />
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
