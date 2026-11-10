// The box that starts a chat: on the new-chat page (pages/Home.tsx) and on a project's page (pages/Projects.tsx). The
// first message creates the chat, in the project when there is one, and opens it. A draft and its attachments are kept
// per place ("new", "project:<id>"), so a project's page and "/?project=<id>" share one.
// In a project that shares its chats (docs/DECISIONS.md "Shared project chats") the new chat is a shared chat: the line
// under the box says how many people will see it, and a file from this computer is saved in the project folder (a line
// under the chips says so).
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Attachment, Project } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { sharesNewChats } from '../../lib/sharedChat'
import { useT } from '../../i18n'
import { draftChat, draftChatIfAny, forgetDraftChat, rememberChat } from '../../lib/teamAttach'
import { useChats } from '../../store/chats'
import { useEngines } from '../../store/engines'
import { canChooseEngine, useMeStrict } from '../../store/session'
import AiAccessBanner from './AiAccessBanner'
import Composer, { type EngineChoice } from './Composer'

export function NewChatComposer({ projectId, project, initialText, resetKey = 0, autoFocus, placeholder, onSent, skill, aiLine = true, waitsFor }: {
  projectId: string | null
  /** the project, when known: whether its new chats are shared, and with how many people */
  project?: Project | null
  initialText?: string
  /** a new value starts the box again with `initialText` (a chosen example or question) */
  resetKey?: number
  autoFocus?: boolean
  placeholder?: string
  /** the first message went out (its chat opens next) */
  onSent?: (chatId: string) => void
  /** a skill chosen for the first message, shown by its title (Composer `skill`) */
  skill?: { name: string; title: string } | null
  /** the "no AI" line above the box (false: Home shows its own card instead) */
  aiLine?: boolean
  /** `initialText` needs the person's own text after it: not sent alone, this line under the box (Composer `waitsFor`) */
  waitsFor?: { text: string; hint: string }
}) {
  const me = useMeStrict()
  const t = useT()
  const navigate = useNavigate()
  const shared = !!project && project.id === projectId && sharesNewChats(project, !!me.server?.allChatsConfidential)
  const sharedLine = shared ? t('projects.sharedNewChat', { n: project.audience ?? 0 }) : undefined
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

  const draftId = projectId ? `project:${projectId}` : 'new'
  // the chat a draft's attachments go into: kept with the draft (lib/teamAttach), so chips kept while the person was
  // on another page are still sent into the chat they were attached to
  const ensureChat = () =>
    draftChat(me.user.id, draftId, () =>
      api.call(API.createChat, { body: { projectId, engine: engine.engine, model: engine.model ?? undefined } }).then((c) => {
        upsertChat(c)
        return c.id
      }),
    )

  const onSend = async (text: string, attachments: Attachment[]) => {
    const pending = draftChatIfAny(me.user.id, draftId)
    const chatId = pending ? await pending : null
    const r = await send({ chatId, content: text, attachments, author: { id: me.user.id, name: me.user.name }, projectId, engine: engine.engine, model: engine.model })
    forgetDraftChat(me.user.id, draftId)
    onSent?.(r.chatId)
    // the current chat from now on, before the (lazily loaded) chat page mounts and says so itself: "Add to …" on the
    // file screen was missing when the person went there that quickly (e2e team-files, flaky)
    rememberChat(me.user.id, r.chatId)
    navigate(`/c/${r.chatId}`)
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
      placeholder={placeholder}
      footer={sharedLine}
      phoneFooter={sharedLine}
      sharedUploads={shared ? { audience: project.audience ?? 0 } : undefined}
      projectId={projectId}
      waitsFor={waitsFor}
    />
    </>
  )
}
