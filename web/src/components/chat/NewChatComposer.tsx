// The box that starts a chat: on the new-chat page (pages/Home.tsx) and on a project's page (pages/Projects.tsx). The
// first message creates the chat, in the project when there is one, and opens it. A draft and its attachments are kept
// per place ("new", "project:<id>"), so a project's page and "/?project=<id>" share one.
// In a team project (docs/DECISIONS.md "Team project chats shared by default") the new chat is shared with the project's
// members, and a file from this computer is saved in the project folder (a line under the chips says so), unless the
// person turns on "Only me" before the first message (ChatVisibilityChip, in the box's row after +): then the chat
// is theirs alone, with their memories and apps, until they share it; the next new chat starts shared again. While safe
// operations are on, the chip says new chats are only theirs for now, with no switch. Any other project's box says who
// will see the new chat as before (components/chat/WhoSees.tsx, docs/DECISIONS.md "Who sees it, always").
import { Lock, Users } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Attachment, Project } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { RAIL_STATE_KEY, useRailHere } from '../../lib/rail'
import { isTeamProject, sharesNewChats, whoSees } from '../../lib/sharedChat'
import { useT } from '../../i18n'
import { draftChat, draftChatIfAny, draftChatShared, dropDraft, forgetDraftChat, isDraftChat, rememberChat, rememberDraftShared } from '../../lib/teamAttach'
import { useChats } from '../../store/chats'
import { useEngines } from '../../store/engines'
import { fileChat } from '../../store/navFolders'
import { canChooseEngine, useMeStrict } from '../../store/session'
import AiAccessBanner from './AiAccessBanner'
import Composer, { type EngineChoice } from './Composer'
import { WhoSeesLine, whoSeesText } from './WhoSees'
import { Tooltip } from '../Tooltip'

export function NewChatComposer({ projectId, folderId = null, project, onMembers, initialText, startPrivate = false, resetKey = 0, autoFocus, focusKey, placeholder, onSent, skill, aiLine = true, waitsFor, card }: {
  projectId: string | null
  /** one of my chat folders the new chat goes in (a folder's +; docs/DECISIONS.md "List folders on
   * screen"): filed once it is made, before it opens */
  folderId?: string | null
  /** the project, when known: who will see its new chat (whether it is shared, and with how many people) */
  project?: Project | null
  /** opens the project's members dialog (the project page's): the line under the box does, while the new chat will be
   * shared and the person may change the members (Project.membersEditable) */
  onMembers?: () => void
  initialText?: string
  /** a team project's new chat starts "Only me" (pages/Projects.tsx: "Continue in a chat only you see") */
  startPrivate?: boolean
  /** a new value starts the box again with `initialText` (a chosen example or question) */
  resetKey?: number
  autoFocus?: boolean
  /** a new value takes the focus again (Composer `focusKey`) */
  focusKey?: string
  placeholder?: string
  /** the first message went out (its chat opens next) */
  onSent?: (chatId: string) => void
  /** a skill chosen for the first message, shown by its title (Composer `skill`) */
  skill?: { name: string; title: string } | null
  /** the "no AI" line above the box (false: Home shows its own card instead) */
  aiLine?: boolean
  /** `initialText` needs the person's own text after it: not sent alone, this line under the box (Composer `waitsFor`) */
  waitsFor?: { text: string; hint: string }
  /** phones: the box as one card, its tools in a row inside it (Home, QA TC-391; Composer `card`) */
  card?: boolean
}) {
  const me = useMeStrict()
  const t = useT()
  const navigate = useNavigate()
  const known = !!project && project.id === projectId
  const safeOps = !!me.server?.allChatsConfidential
  // a team project in place: its new chats are shared unless "Only me" (never sticks: a new box starts shared again)
  const team = known && isTeamProject(project) && !project.inTrash
  const draftId = projectId ? `project:${projectId}` : 'new'
  // "Only me" asked (Continue in a chat only you see) while this box holds a chat made shared for its attachments: that
  // chat and its chips go, before the box shows them, so the question can never be sent into the shared chat (security
  // review M1). Once per ask (resetKey), in this render: the box below mounts after it
  const dropped = useRef<string | null>(null)
  const ask = `${draftId}:${resetKey}`
  if (startPrivate && dropped.current !== ask) {
    dropped.current = ask
    if (draftChatShared(me.user.id, draftId) === true) dropDraft(me.user.id, draftId)
  }
  const [onlyMe, setOnlyMe] = useState(startPrivate)
  useEffect(() => setOnlyMe(startPrivate), [startPrivate, resetKey, projectId])
  // a chat already made for this box's attachments (lib/teamAttach): its sharing was set when it was made, and the
  // switch shows that (fixed) state, never the one the person would like
  const draftState = () => draftChatShared(me.user.id, draftId)
  const [drafted, setDrafted] = useState<boolean | null>(draftState)
  useEffect(() => setDrafted(draftState()), [me.user.id, draftId, resetKey])
  // what the new chat will be: the draft chat's own state when there is one, else the switch
  const privateNow = team && (drafted === null ? onlyMe : !drafted)
  const shared = known && sharesNewChats(project, safeOps) && !privateNow
  const who = known && !team ? <WhoSeesLine shared={shared ? project : null} place="new" onOpen={shared && project.membersEditable ? onMembers : undefined} /> : undefined
  const send = useChats((s) => s.send)
  const upsertChat = useChats((s) => s.upsertChat)
  const models = useEngines((s) => s.models)
  const engines = useEngines((s) => s.engines)
  const loadEngines = useEngines((s) => s.load)
  // the engine / model are the admin's choice: only people allowed to pick see a picker and send a choice (starting
  // from their own default, Settings); everyone else sends none and gets the team default
  const choose = canChooseEngine(me)
  const [picked, setEngine] = useState<EngineChoice>({ engine: me.user.prefs.engine, model: me.user.prefs.model ?? null })
  const engine: EngineChoice = choose ? picked : { engine: undefined, model: undefined }

  useEffect(() => {
    if (choose) void loadEngines()
  }, [choose, loadEngines])

  // the chat a draft's attachments go into: kept with the draft (lib/teamAttach), so chips kept while the person was
  // on another page are still sent into the chat they were attached to
  const ensureChat = () => {
    const wantPrivate = team && onlyMe
    // (the switch is fixed while the chat is being made; a failure frees it again)
    if (drafted === null) setDrafted(!wantPrivate)
    let shared: boolean | null = null
    const made = draftChat(me.user.id, draftId, () =>
      api.call(API.createChat, { body: { projectId, engine: engine.engine, model: engine.model ?? undefined, ...(wantPrivate ? { private: true } : {}) } }).then((c) => {
        upsertChat(c)
        shared = !!c.shared
        return c.id
      }),
    )
    // its state is kept only while it is still this box's draft (a draft dropped meanwhile, by "Continue in a chat only
    // you see", stays dropped: re-review L1)
    made.then(() => {
      if (shared === null || !isDraftChat(me.user.id, draftId, made)) return
      rememberDraftShared(me.user.id, draftId, shared)
      setDrafted(shared)
    }, () => setDrafted(draftState()))
    return made
  }

  const fromProjects = useRailHere() === 'projects'
  const onSend = async (text: string, attachments: Attachment[]) => {
    const pending = draftChatIfAny(me.user.id, draftId)
    const chatId = pending ? await pending : null
    // never a private question into a shared draft chat: the switch shows the draft's state, and this checks it again
    if (chatId && team && onlyMe && draftChatShared(me.user.id, draftId) !== false) throw new Error('draft chat is shared')
    const r = await send({ chatId, content: text, attachments, author: { id: me.user.id, name: me.user.name }, projectId, engine: engine.engine, model: engine.model, ...(privateNow ? { private: true } : {}) })
    forgetDraftChat(me.user.id, draftId)
    // the next new chat here starts shared again
    setOnlyMe(false)
    setDrafted(null)
    // into the folder asked for (a refusal leaves it in the list's other chats: nothing is lost)
    if (folderId && !projectId) await fileChat(r.chatId, folderId).catch(() => {})
    onSent?.(r.chatId)
    // the current chat from now on, before the (lazily loaded) chat page mounts and says so itself: "Add to …" on the
    // file screen was missing when the person went there that quickly (e2e team-files, flaky)
    rememberChat(me.user.id, r.chatId)
    // started on a project's page: the chat opens with 프로젝트 still lit (lib/rail.ts railState)
    navigate(`/c/${r.chatId}`, fromProjects ? { state: { [RAIL_STATE_KEY]: 'projects' } } : undefined)
  }

  return (
    <>
    {aiLine && <AiAccessBanner />}
    <Composer
      key={`${draftId}-${resetKey}`}
      draftId={draftId}
      ensureChat={ensureChat}
      running={false}
      onSend={onSend}
      onStop={async () => {}}
      engine={engine}
      onEngine={choose ? setEngine : undefined}
      engines={engines}
      models={models}
      initialText={initialText}
      skill={skill}
      autoFocus={autoFocus}
      focusKey={focusKey}
      placeholder={placeholder}
      who={who}
      sharedUploads={shared ? { audience: project!.audience ?? 0, allowed: project!.chatUploads !== false } : undefined}
      // a project's box (Home's ?project=) sends only once the project is known: before, nothing says who will see the
      // chat, and a team project would share it (security review S3)
      hold={projectId && !known ? t('common.loading') : undefined}
      projectId={projectId}
      waitsFor={waitsFor}
      card={card}
      tools={team ? (
        <ChatVisibilityChip
          project={project}
          // the project shares its new chats (a team project on this server; not one an older build left off)
          shares={sharesNewChats(project, false)}
          safeOps={safeOps}
          onlyMe={privateNow}
          // a chat made already (for attachments) keeps how it was made
          locked={drafted !== null}
          onToggle={() => setOnlyMe((v) => !v)}
          t={t}
        />
      ) : undefined}
    />
    </>
  )
}

/** In a team project's box, right after + in its bottom row (QA TC-1401): who will see the chat being started, as one
 * quiet chip that is also the "Only me" switch. Shared: "👥 5 people" (on a phone "👥 5"); pressed: "🔒 Only me". The
 * whole sentence ("The chat you're starting will be seen and continued by 5 people in this project." / "Only you will
 * see the chat you're starting …") is its tooltip and its description for screen readers (the name stays the words in
 * sight). Safe operations, or a project an older build left unshared: a fixed "🔒 Only me" saying why, with no switch.
 * A chat made already for attachments keeps how it was made (disabled). */
function ChatVisibilityChip({ project, shares, safeOps, onlyMe, locked, onToggle, t }: { project: Project; shares: boolean; safeOps: boolean; onlyMe: boolean; locked: boolean; onToggle: () => void; t: ReturnType<typeof useT> }) {
  const whyId = useId()
  const mine = safeOps || onlyMe || !shares
  // shared: how many members (alone, or with only the owner and admins: the box's words as before, WhoSees.tsx)
  const who = whoSees(project)
  const sentence = safeOps ? t('projects.newChatSafeOps') : !shares ? t('projects.newChatMe') : onlyMe ? t('projects.onlyMeOn') : who.kind === 'people' ? t('projects.newChatShared', { n: who.n }) : whoSeesText(t, project, 'new')
  const Icon = mine || who.kind === 'me' ? Lock : Users
  const label = mine ? (
    t('projects.onlyMe')
  ) : who.kind === 'people' ? (
    // a phone: the icon and the number only, so the row keeps room for the picker, the mic and send
    <>
      <span className="sm:hidden">{who.n}</span>
      <span className="max-sm:hidden">{t('projects.visibilityPeople', { n: who.n })}</span>
    </>
  ) : who.kind === 'admins' ? t('chat.whoMeAdmins') : t('chat.whoMe')
  const look = 'touch-hit inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs whitespace-nowrap'
  const why = <span id={whyId} className="sr-only" data-testid="chat-visibility-why">{sentence}</span>
  if (safeOps || !shares)
    return (
      <>
        <Tooltip label={sentence} description>
          <span role="note" tabIndex={0} aria-describedby={whyId} className={`${look} text-muted`} data-testid="chat-visibility" data-who="me">
            <Lock size={13} aria-hidden />
            {label}
          </span>
        </Tooltip>
        {why}
      </>
    )
  return (
    <>
      <Tooltip label={sentence} description>
        <button
          type="button"
          aria-pressed={onlyMe}
          aria-describedby={whyId}
          disabled={locked}
          onClick={onToggle}
          className={`${look} transition disabled:opacity-50 ${onlyMe ? 'bg-subtle text-ink' : 'text-muted hover:bg-hover hover:text-ink'}`}
          data-testid="only-me-toggle"
          data-who={mine ? 'me' : who.kind}
        >
          <Icon size={13} aria-hidden />
          {label}
        </button>
      </Tooltip>
      {why}
    </>
  )
}
