// Chats, messages, turn control, projects, ask_user answers. Owner: B (server/src/routes/chats.ts).
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { Access, EngineId, IsoTime, PageQuery, QueryBool, RelPath, page } from './common'
import { endpoint, empty } from './endpoint'
import { SealedSecret } from './credentials'
import { AudienceSplit, Chat, Message, MessageSources, Project, SubjectType } from './entities'
import { ANSWER_NOTE_MAX, ROOM_FILES_MAX, RoomMessage } from './rooms'
import { IntegrationStatus } from './integrations'
import { TurnRequest } from './ws'

// ---------------- an answer sent to a room ("대화방에 보내기") ----------------
/** at most this many rows in a "confirm": past it the rest of the answer's links is one more row nothing is told about
 * (everyone else counted) */
export const ANSWER_SHARE_FILES_MAX = 100
export const ShareAnswerToRoomBody = z.object({
  roomId: Uuid7,
  /** one line before the answer ("한마디 덧붙이기"); newlines become spaces */
  note: z.string().max(ANSWER_NOTE_MAX).optional(),
  /** older clients: send even though some members cannot open what the answer used, as the number of people the person
   * said yes to (the last "confirm"'s `people`). More people than that now: "confirm" again. Nothing is attached */
  confirm: z.number().int().positive().optional(),
  /** the last "confirm"'s `confirmKey`: the person saw that state and said yes. Anything changed since (a member swapped
   * for another, someone lost access, a file moved): "confirm" again with a new key */
  confirmKey: z.string().min(1).max(200).optional(),
  /** linked files to send with the message as copies (room files): only paths of the last "confirm"'s `files` whose
   * `attach` is 'yes'; my read access is checked again when they are copied */
  attach: z.array(RelPath).max(ROOM_FILES_MAX).optional(),
  /** a reply in this message's thread instead of a message of the room (a side chat's answer to a question about that
   * message: rooms.ts threadRefOf). It must be a message of the room I see that can have a thread and is not deleted;
   * anything else is 409 `reason: 'thread_root'`, checked before anything else of the request (the sending budget too) */
  threadRootId: Uuid7.optional(),
  /** client-made id: sending the same one again returns the first message */
  clientMessageId: z.string().min(8).max(64),
}).strict()
/** Where something the answer used came from that some member cannot open (never who cannot). */
export const AnswerSharePlace = z.discriminatedUnion('kind', [
  /** a team folder ('' = the top of the team folder) */
  z.object({ kind: z.literal('folder'), path: z.string() }),
  /** my own folder, or what only I saw (the in-app browser, a personal connection) */
  z.object({ kind: z.literal('mine') }),
  /** a team connection (a connected service) or a shared Google Drive, by its name */
  z.object({ kind: z.literal('service'), name: z.string() }),
  /** a team room by its group's name, or the everyone room (name '') */
  z.object({ kind: z.literal('room'), name: z.string() }),
  /** a 1:1 or group conversation (never named: its name is people's names) */
  z.object({ kind: z.literal('conversation') }),
])
export type AnswerSharePlace = z.infer<typeof AnswerSharePlace>
/** One file the answer links to or shows, as the person sending may be told. */
export const AnswerShareFile = z.object({
  /** its name; '' when `missing` (never named: I cannot open it now) */
  name: z.string(),
  /** its team path, only when I may open it now */
  path: RelPath.optional(),
  /** I cannot open it now: gone or not mine to open read the same, and it is never named */
  missing: z.boolean(),
  /** yes: it can go with the message as a copy (the switch, on by default); no: not needed (everyone can open it) or not
   * a file to copy; too_big: over 50 MB; hidden: I cannot open it (`missing`) */
  attach: z.enum(['yes', 'no', 'too_big', 'hidden']),
  /** members of the room (not me) who cannot open it now; for a `missing` file, everyone else (nothing is told) */
  unable: z.number().int().nonnegative(),
})
export type AnswerShareFile = z.infer<typeof AnswerShareFile>
/** The answer carries content from material some members cannot see. */
export const AnswerShareProvenance = z.object({
  /** members (not me) who cannot see some of it */
  people: z.number().int().positive(),
  /** where it came from, named only where I may look myself */
  places: z.array(AnswerSharePlace),
  /** more such places that are not named */
  otherPlaces: z.boolean(),
  /** what this answer used is not all known (it is not on the chat's current branch): `people` is everyone else */
  unknown: z.literal(true).optional(),
})
export type AnswerShareProvenance = z.infer<typeof AnswerShareProvenance>
export const ShareAnswerToRoomResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('sent'), message: RoomMessage, cut: z.boolean() }),
  /** nothing sent. `files`: every file the answer links to (a row each); `provenance`: content from material some members
   * cannot see (null: none); `confirmKey`: send it with the same request to go ahead. Older clients read `people` (the
   * members, not me, who cannot open a linked file or see some of that material), `places` and `otherPlaces` */
  z.object({
    status: z.literal('confirm'), people: z.number().int().positive(), places: z.array(AnswerSharePlace), otherPlaces: z.boolean(),
    files: z.array(AnswerShareFile).max(ANSWER_SHARE_FILES_MAX),
    provenance: AnswerShareProvenance.nullable(),
    confirmKey: z.string(),
    /** asked again after a confirmKey: `changed`, something changed meanwhile (the app says so); `choice`, the same state,
     * but the files I chose to attach change the provenance line (shown for that choice) */
    reason: z.enum(['changed', 'choice']).optional(),
  }),
])
export type ShareAnswerToRoomResult = z.infer<typeof ShareAnswerToRoomResult>

// ---------------- an existing chat shared with its project's members ("프로젝트 멤버와 공유") ----------------
export const ShareChatBody = z.object({
  /** the last "confirm"'s `confirmKey`: the person saw that state and said yes. Anything changed since (the project's
   * people, what they may read, a new message on any branch): "confirm" again with a new key */
  confirmKey: z.string().min(1).max(200).optional(),
  /** answer "confirm" first even when nothing applies (the title menu's item: the question before an irreversible
   * share); without it a chat with nothing to ask about is shared at once (the move dialog's switch) */
  ask: z.boolean().optional(),
}).strict()
export const ShareChatResult = z.discriminatedUnion('status', [
  /** shared now: the chat as I see it (with `shared`) */
  z.object({ status: z.literal('shared'), chat: Chat }),
  /** nothing changed yet. `audience`: the project's people (not me) who would see it; `provenance`: its answers carry
   * content from material some of them cannot see (null: none; `unknown`: not all of what it used is known);
   * `memories`: an answer may have used my personal memories; `confirmKey`: send it back to share. `reason` 'changed':
   * asked again after a key, something changed meanwhile */
  z.object({
    status: z.literal('confirm'),
    audience: z.number().int().nonnegative(),
    provenance: AnswerShareProvenance.nullable(),
    memories: z.boolean(),
    confirmKey: z.string(),
    reason: z.literal('changed').optional(),
  }),
])
export type ShareChatResult = z.infer<typeof ShareChatResult>

// ---------------- chats ----------------
export const ListChatsQuery = PageQuery.extend({
  /** title / message text search */
  q: z.string().max(200).optional(),
  projectId: Uuid7.optional(),
  /** list the chat trash (deleted within the team's chat retention) instead: my own chats and the shared chats I deleted,
   * each while I may restore it */
  trash: QueryBool.optional(),
  /** only my chats opened from this room's side panel (✦ Trina), newest first */
  sideRoomId: Uuid7.optional(),
})
export const CreateChatBody = z.object({
  projectId: Uuid7.nullable().optional(),
  /** a side chat of this room (✦ Trina, docs/DECISIONS.md "Trina side chat"): I must be in the room; never with a
   * project (a side chat is mine alone) */
  sideRoomId: Uuid7.optional(),
  title: z.string().max(200).optional(),
  engine: EngineId.optional(),
  model: z.string().max(100).nullable().optional(),
})
export const UpdateChatBody = z.object({
  title: z.string().max(200).optional(),
  projectId: Uuid7.nullable().optional(),
  engine: EngineId.optional(),
  model: z.string().max(100).nullable().optional(),
})
/** What the composer may offer this person (GET /api/engines). */
export const ChatEngines = z.object({
  /** owner / admins always; others when Admin > AI engines allows them */
  canChoose: z.boolean(),
  /** the team default (new chats of people who may not pick, and of people without their own default) */
  defaultEngine: EngineId,
  defaultModel: z.string().nullable(),
  /** engines this person may pick, with their models; empty when canChoose is false */
  engines: z.array(z.object({ id: EngineId, label: z.string(), models: z.array(z.object({ id: z.string(), label: z.string() })) })),
})
export type ChatEngines = z.infer<typeof ChatEngines>
export const DeletedChat = z.object({ id: Uuid7, deletedAt: IsoTime, purgeAt: IsoTime })
/** The longest sentence of "what my group often asks" (docs/DECISIONS.md "Home: what my group often asks"). */
export const OFTEN_ASKED_TEXT_MAX = 80
/** At most this many on Home (3 at first, More shows the rest). */
export const OFTEN_ASKED_ITEMS_MAX = 10
const OftenAskedItems = z.array(z.string().min(1).max(OFTEN_ASKED_TEXT_MAX)).max(OFTEN_ASKED_ITEMS_MAX)
/**
 * GET /api/questions/often-asked: one list for the caller, generic sentences only (never who asked, how many or
 * when). `group`: the caller's one group with a list (its name); `groups`: several of their groups, taking turns;
 * `team`: the whole team's list (no group of theirs has one); `none`: nothing to show (too little data, or the team
 * turned it off).
 */
export const OftenAsked = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('none'), items: z.array(z.string()).max(0) }).strict(),
  z.object({ scope: z.literal('team'), items: OftenAskedItems }).strict(),
  z.object({ scope: z.literal('groups'), items: OftenAskedItems }).strict(),
  z.object({ scope: z.literal('group'), group: z.string().min(1).max(200), items: OftenAskedItems }).strict(),
])
export type OftenAsked = z.infer<typeof OftenAsked>

// ---------------- messages ----------------
/**
 * GET /api/chats/:id/messages returns the active branch, oldest first. Without a cursor: the newest `limit`
 * messages; nextCursor fetches older ones (prepend). Streaming answers come back with the content saved so far.
 */
export const ListMessagesQuery = PageQuery
export const MessagesPage = page(Message)

export const SendMessageBody = z.object({
  content: z.string().max(200_000),
  /** uploaded via POST /api/uploads or an upload session with target attachment */
  attachmentIds: z.array(Uuid7).max(20).default([]),
  /** message to answer under; default: the chat's active leaf */
  parentId: Uuid7.nullable().optional(),
  /** only for people who may pick the engine (Me.user.canChooseEngine); anyone else naming another engine or model
   * than the chat's gets 403 */
  engine: EngineId.optional(),
  model: z.string().max(100).nullable().optional(),
  /** client-generated id; resending the same clientMessageId after a reconnect returns the first result (idempotent) */
  clientMessageId: z.string().min(8).max(64),
}).refine((b) => b.content.trim().length > 0 || b.attachmentIds.length > 0, { message: 'empty message', path: ['content'] })

/** Response of send / edit / regenerate: the turn is queued; text arrives over the WebSocket. */
export const TurnStarted = z.object({
  /** the new user message (send, edit); null for regenerate */
  userMessage: Message.nullable(),
  /** the new assistant message, status 'streaming', empty content */
  assistantMessage: Message,
  turnId: Uuid7,
  /** 0 = execution slot assigned; n >= 1 = advisory fair-queue rank (not an ETA). */
  queuePosition: z.number().int().nonnegative(),
  queueEpoch: z.string().optional(),
  queueRevision: z.number().int().nonnegative().optional(),
})
export type TurnStarted = z.infer<typeof TurnStarted>

export const ChatQueueSnapshot = z.object({
  state: z.enum(['queued', 'running', 'idle']),
  turnId: Uuid7.nullable(), messageId: Uuid7.nullable(), position: z.number().int().nonnegative().nullable(),
  epoch: z.string(), revision: z.number().int().nonnegative(),
})
export type ChatQueueSnapshot = z.infer<typeof ChatQueueSnapshot>

export const RegenerateBody = z.object({
  engine: EngineId.optional(),
  model: z.string().max(100).nullable().optional(),
})
/** Edit a user message: adds a sibling user message (same parent) and answers it. Team-folder file changes of the
 * old branch are NOT undone (the UI says so). */
export const EditMessageBody = z.object({
  content: z.string().min(1).max(200_000),
  attachmentIds: z.array(Uuid7).max(20).default([]),
  engine: EngineId.optional(),
  model: z.string().max(100).nullable().optional(),
  clientMessageId: z.string().min(8).max(64),
})
/** Show another branch: messageId is any message; the chat's active leaf becomes the newest leaf under it. */
export const SelectBranchBody = z.object({ messageId: Uuid7 })
export const StopResponse = z.object({ stopped: z.boolean(), turnId: Uuid7.nullable() })

// ---------------- ask_user / browser site confirmation ----------------
/** the longest answer to a question (one text), and the longest of each when it takes several */
export const ASK_ANSWER_MAX = 10_000
export const ASK_ANSWER_ITEM_MAX = 1000
export const TurnAnswerBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ask_user'),
    requestId: z.string().min(1).max(100),
    /** null = skipped */
    answer: z.union([z.string().max(ASK_ANSWER_MAX), z.array(z.string().max(ASK_ANSWER_ITEM_MAX)).max(20)]).nullable(),
  }),
  z.object({
    kind: z.literal('browser_site'),
    requestId: z.string().min(1).max(100),
    decision: z.enum(['once', 'always', 'deny']),
  }),
  /** a dev_env_site card: only the person who owns the turn can answer it (POST /api/turns/:id/answer) */
  z.object({
    kind: z.literal('dev_env_site'),
    requestId: z.string().min(1).max(100),
    decision: z.enum(['once', 'always', 'deny']),
  }),
])
export type TurnAnswerBody = z.infer<typeof TurnAnswerBody>

/** POST /api/turns/:id/connect: finishing a connect_service card (ConnectServiceRequest). A key never goes through
 * /answer: answers reach the AI and its session file. The AI learns only the outcome (connected, skipped, the tools). */
const ConnectRequestId = z.string().min(1).max(100)
export const TurnConnectBody = z.discriminatedUnion('action', [
  /** add the connection. A key (bearer / header) comes sealed for 'integration.secret'; a sign-in service is added and
   * then signed in to (state 'sign_in'). A team connection: who may use it, the admin alone or everyone. Again after a
   * failed check: the same connection gets the new key, no second one is made. */
  z.object({ action: z.literal('connect'), requestId: ConnectRequestId, sealed: SealedSecret.optional(), access: z.enum(['me', 'everyone']).optional() }),
  /** after signing in at the service, or after Google Drive: the server checks it is connected and tells the AI */
  z.object({ action: z.literal('done'), requestId: ConnectRequestId }),
  /** not now: the AI continues without it */
  z.object({ action: z.literal('skip'), requestId: ConnectRequestId }),
])
export type TurnConnectBody = z.infer<typeof TurnConnectBody>
export const TurnConnectResult = z.object({
  /** connected: done, the card closes. sign_in: added, now sign in (POST /api/integrations/:integrationId/authorize).
   * retry: added but its check failed (lastError says why, in words a person can act on); the card stays for another
   * key. skipped: closed without a connection */
  state: z.enum(['connected', 'sign_in', 'retry', 'skipped']),
  integrationId: z.string().optional(),
  status: IntegrationStatus.optional(),
  lastError: z.string().nullable().optional(),
})
export type TurnConnectResult = z.infer<typeof TurnConnectResult>
/** Cards still waiting for an answer in this chat (after a reload / resync the client shows them again).
 * browser_site requests are listed only for the window that sent the turn (X-Mycel-Window). */
export const OpenTurnRequest = z.object({ turnId: Uuid7, chatId: Uuid7, messageId: Uuid7, request: TurnRequest })
export type OpenTurnRequest = z.infer<typeof OpenTurnRequest>
/** A room's card as its asker reads it again (GET /api/rooms/:id/ai/requests): no chat id. The room's AI session is a
 * chat of its own that is never listed or opened as a chat (GET /api/chats leaves out chats with a room), and the room
 * finds a card by its turn (web RoomAiStatus). */
export const RoomTurnRequest = OpenTurnRequest.omit({ chatId: true })
export type RoomTurnRequest = z.infer<typeof RoomTurnRequest>

// ---------------- projects ----------------
/** Who works in a team project (each gets read and write; nobody else but the creator, the owner and admins). */
export const ProjectParticipant = z.object({ subjectType: z.enum(['group', 'user']), subjectId: z.string().min(1).max(64) })
export type ProjectParticipant = z.infer<typeof ProjectParticipant>
/**
 * Two kinds (docs/DECISIONS.md "Projects live only in projects/"):
 * - scope 'team': a new folder projects/<name> (its name from slug, else folderPath's last name, else the project's name;
 *   a taken name gets "-2"), made by the server with each participant and the creator write and everyone else none.
 *   Members too, unless Admin › Team settings lets only admins (403, params.reason projects_admins_only). A member
 *   names only their own groups and active people.
 * - scope 'personal': users/<me>/projects/<name>, only the caller sees it.
 * A folderPath anywhere else (an existing team folder, shared/, groups/, the root, users/<me>/other) is 400 with
 * params.reason project_location.
 */
export const CreateProjectBody = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(['team', 'personal']).default('team'),
  /** team: projects/<name>; personal: users/<me>/projects/<name> (default: from slug or the name) */
  folderPath: RelPath.optional(),
  /** folder name for the new folder (default: from the name, like group folders) */
  slug: z.string().trim().min(1).max(100).optional(),
  participants: z.array(ProjectParticipant).max(200).default([]),
  instructions: z.string().max(50_000).default(''),
})
/** Share a personal project with the team: a new team project folder projects/<name> with these participants (as
 * createProject makes one), the personal folder's files copied into it (at most 1,000 files / 500 MB), and the project
 * points at it; the personal folder stays. dryRun: {viewersAdded} only (the people who would see it, me left out; for
 * someone who is not the owner or an admin only the people and groups chosen, `adminsApart`, as in the new-project dry
 * run, so it never tells a member who the admins are). */
export const ShareProjectBody = z.object({
  participants: z.array(ProjectParticipant).max(200).default([]),
  dryRun: z.boolean().default(false),
  /** older clients: only 'projects' is accepted (anything else: 400 project_location) */
  toParent: RelPath.optional(),
  /** the personal folder's skills/ holds skills: copied into projects/<name>/skills they switch on in the project's
   * chats: 409 project_skills_on unless true (docs/DECISIONS.md "Project skills") */
  skillsOk: z.boolean().optional(),
})
export const ShareProjectResult = z.union([Project, z.object({ viewersAdded: z.number().int().nonnegative(), adminsApart: z.boolean().optional() })])
/** Creator or admin+ only. folderPath (repoint): admins only, only for a project whose folder is in the trash or missing,
 * only to an existing projects/<name> no other project uses (else 409 / 400 project_location). */
export const UpdateProjectBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  folderPath: RelPath.optional(),
  instructions: z.string().max(50_000).optional(),
  /** shared project chats on or off (team projects; the creator or an admin who can write the folder). 409 with reason
   * project_personal (a personal project), safe_ops (safe operations are on) or project_in_trash. Off keeps the chats
   * already shared. */
  shareChats: z.boolean().optional(),
  /** repointed at a projects/<name> folder that holds skills: they switch on in the project's chats: 409
   * project_skills_on unless true (docs/DECISIONS.md "Project skills") */
  skillsOk: z.boolean().optional(),
})
export const DeleteProjectQuery = z.object({
  /** ignored since "Project contents only for members": a team project in projects/<name> whose folder is in place
   * always goes to the trash with its folder (the project stays, `inTrash`, until Restore or a second DELETE) */
  trashFolder: QueryBool.optional(),
})
/** GET /api/projects and GET /api/projects/:id: `manage=1` (the owner and admins) also answers the team projects the
 * caller manages without being a member (Project.member false, no contents). Without it: projects the caller reads. */
export const ProjectsQuery = z.object({ manage: QueryBool.optional() })

/** A participant as the project's edit screen shows it. `creator`: the project's creator, always kept. */
export const ProjectMember = ProjectParticipant.extend({ name: z.string(), creator: z.boolean().optional() })
export type ProjectMember = z.infer<typeof ProjectMember>
/** A rule of the project folder (or a folder inside it) that the project screen shows but does not change: read-only
 * people or groups, roles, an everyone rule other than "nobody else", rules inside it. Admin › Folder permissions does. */
export const ProjectOtherRule = z.object({ path: RelPath, subjectType: SubjectType, subjectId: z.string().nullable(), name: z.string().nullable(), access: Access })
export type ProjectOtherRule = z.infer<typeof ProjectOtherRule>
/** Who sees a team project (GET /api/projects/:id/access; its creator and admins). */
export const ProjectAccess = z.object({
  /** participants can be changed here: a team project in projects/<name> whose folder is in place */
  editable: z.boolean(),
  participants: z.array(ProjectMember),
  otherRules: z.array(ProjectOtherRule),
  /** the folder's Folder.rulesHash now: PUT participants sends it back (409 rules_changed when someone changed them).
   * Empty for a member's answer about a project they may not change. */
  rulesHash: z.string(),
  /** how many active people see the project now: its members (for a project in projects/ the owner and admins only when
   * they are members; docs/DECISIONS.md "Project contents only for members") */
  people: z.number().int().nonnegative(),
  /** folders inside the project with rules of their own that the caller cannot read (their rules are not listed in
   * otherRules; only the folders are counted). Absent: 0 */
  otherRulesHidden: z.number().int().positive().optional(),
})
export type ProjectAccess = z.infer<typeof ProjectAccess>
/** A dry run: who would see a new project with these participants, or an existing one (projectId) after this change. */
export const ProjectAccessPreviewBody = z.object({ projectId: Uuid7.optional(), participants: z.array(ProjectParticipant).max(200), removeRules: z.array(z.object({ subjectType: SubjectType, subjectId: z.string().nullable() })).max(50).optional() })
export const ProjectAccessPreview = z.object({
  /** active people who would see it: the creator and the people and groups chosen (a new team project in projects/ is
   * members only: the owner and admins are counted only when chosen) */
  people: z.number().int().nonnegative(),
  /** an existing project the caller manages without reading it (the owner or an admin who is not a member): what the
   * added people would see is not counted (files, othersFiles, sharedChats, skills are 0, no skillNames); the screen
   * says that they will see its files and chats. Absent: false */
  contentsHidden: z.boolean().optional(),
  /** older servers: a new project's count left the owner and admins out for a member caller. Not sent any more (a new
   * team project is members only, so nobody is counted by role). Absent: false */
  adminsApart: z.boolean().optional(),
  /** `people` apart (AudienceSplit), for the owner and admins only: a new project's caller and the people and groups
   * chosen (`direct`) and the other admins and the owner; an existing one's people by its rules after the change */
  split: AudienceSplit.optional(),
  /** an existing project: people who would start or stop seeing it */
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** what the added people would see (0 when nobody is added): its files, those that other people than the caller put
   * there, its shared chats (each with its whole history) and its project skills (skills/<name>/SKILL.md in its folder) */
  files: z.number().int().nonnegative(),
  othersFiles: z.number().int().nonnegative(),
  sharedChats: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
  /** those project skills by name (their folder's name, at most 10, sorted): the confirm names them, since the people
   * who gain the project start using them in its chats */
  skillNames: z.array(z.string()).max(10).optional(),
  /** an existing project: saving also writes the floor rule ("everyone: none"), which a folder older builds made does not
   * have, so anyone who saw it only through a rule above it stops seeing it; the screen asks first. Absent: false */
  addsFloor: z.boolean().optional(),
  /** an existing project: saving also puts its creator's rule back (someone took it away in Admin › Folder
   * permissions); the screen asks first. Absent: false */
  restoresCreator: z.boolean().optional(),
})
export type ProjectAccessPreview = z.infer<typeof ProjectAccessPreview>
/** A rule on the project's own folder that the members screen does not set (a read-only person or group, a role rule, an
 * everyone rule other than "everyone else: none"), taken out by whoever manages the members (docs/DECISIONS.md
 * "Project contents only for members"). Taking one out only narrows who sees it: the floor stays or comes back. */
export const ProjectRuleRef = z.object({ subjectType: SubjectType, subjectId: z.string().nullable() })
export const PutProjectParticipantsBody = z.object({ participants: z.array(ProjectParticipant).max(200), expectedHash: z.string().min(1).max(64), removeRules: z.array(ProjectRuleRef).max(50).optional() })

export const CHATS = {
  oftenAsked: endpoint({ method: 'GET', path: '/api/questions/often-asked', auth: 'user', owner: 'B', response: OftenAsked, summary: 'Home’s "what my group often asks": generic sentences that 3 or more people of the caller’s group (else the team) asked in a similar way, rewritten once a day; never who asked, how many or when. Empty while the team setting is off or there is too little data.' }),
  listChats: endpoint({ method: 'GET', path: '/api/chats', auth: 'user', owner: 'B', query: ListChatsQuery, response: page(Chat), summary: 'Own chats and the shared project chats I wrote in, newest first (search with q, trash with trash=1: my own and the shared chats I deleted, while I may restore them). With projectId: my chats there and every shared chat of that project I can see, each with who wrote in it (shared.people: the 3 most recent, shared.peopleCount). Without q and trash, the first page starts with my pinned chats of that list (pinnedAt, the most recently pinned first) and the pages after it leave them out.' }),
  createChat: endpoint({ method: 'POST', path: '/api/chats', auth: 'user', owner: 'B', status: 201, body: CreateChatBody, response: Chat, summary: 'New empty chat (optionally inside a project). In a project that shares its chats it is a shared chat (never in a personal project or while safe operations are on).' }),
  chatEngines: endpoint({ method: 'GET', path: '/api/engines', auth: 'user', owner: 'B', response: ChatEngines, summary: 'Whether the caller may pick the engine / model, the team default, and the engines + models they may pick.' }),
  getChat: endpoint({ method: 'GET', path: '/api/chats/:id', auth: 'user', owner: 'B', response: Chat, summary: 'One own chat, or a shared project chat I can see.' }),
  getChatQueue: endpoint({ method: 'GET', path: '/api/chats/:id/queue', auth: 'user', owner: 'B', response: ChatQueueSnapshot, summary: 'Own chat queue snapshot; advisory rank and epoch/revision for reconnect recovery.' }),
  updateChat: endpoint({ method: 'PATCH', path: '/api/chats/:id', auth: 'user', owner: 'B', body: UpdateChatBody, response: Chat, summary: 'Rename, move to a project, change engine/model. A shared chat: its creator only, and it never changes project (409 shared_chat_move).' }),
  deleteChat: endpoint({ method: 'DELETE', path: '/api/chats/:id', auth: 'user', owner: 'B', response: DeletedChat, summary: 'Move to chat trash (purged after the team\'s chat retention). Stops a running turn. A shared chat: its creator or an editor of its project (audited when someone else); it is in its creator\'s trash and in the deleter\'s.' }),
  restoreChat: endpoint({ method: 'POST', path: '/api/chats/:id/restore', auth: 'user', owner: 'B', response: Chat, summary: 'Bring a chat back from the trash.' }),
  pinChat: endpoint({ method: 'POST', path: '/api/chats/:id/pin', auth: 'user', owner: 'B', response: Chat, summary: 'Pin a chat I can see to the top of my chat list ("Pin to top"), for me only (a shared project chat too). Pinned already: unchanged. At most 50 pins (409 chat_pins_full). My other windows hear it (chat.updated).' }),
  unpinChat: endpoint({ method: 'DELETE', path: '/api/chats/:id/pin', auth: 'user', owner: 'B', response: Chat, summary: 'Unpin a chat ("Unpin"); not pinned: unchanged. My other windows hear it (chat.updated).' }),
  markChatSeen: endpoint({ method: 'POST', path: '/api/chats/:id/seen', auth: 'user', owner: 'B', response: Chat, summary: 'I have this own chat on screen: its finished answers are seen (Chat.unseen goes away in every window and device).' }),
  listMessages: endpoint({ method: 'GET', path: '/api/chats/:id/messages', auth: 'user', owner: 'B', query: ListMessagesQuery, response: MessagesPage, summary: 'Active branch of the conversation, paged backwards.' }),
  sendMessage: endpoint({ method: 'POST', path: '/api/chats/:id/messages', auth: 'user', owner: 'B', status: 202, body: SendMessageBody, response: TurnStarted, summary: 'Save the message, create the empty answer, queue the turn. Send the X-Mycel-Window header so browser tools reach this window.' }),
  stop: endpoint({ method: 'POST', path: '/api/chats/:id/stop', auth: 'user', owner: 'B', response: StopResponse, summary: 'Stop the running or queued turn of this chat (a shared chat: only the person whose turn it is).' }),
  shareAnswerToRoom: endpoint({ method: 'POST', path: '/api/chats/:id/messages/:messageId/share-to-room', auth: 'user', owner: 'B', body: ShareAnswerToRoomBody, response: ShareAnswerToRoomResult, summary: 'Post a finished answer of my own AI chat to a room I am in, as my message (my note, then the answer as a quote), or as a reply in a message\'s thread there (threadRootId: a room\'s side chat). When some member cannot open a file it links to, or it carries content from material some cannot see, it first answers "confirm": a row per linked file and one provenance line, as counts and places I may look myself (never who), with a confirmKey; sent again with that key it posts, attaching the linked files asked for (attach). Older clients: confirm = the number of people. Rate-limited and notified like any message; audited. The AI\'s post_to_room tool (the person\'s own chat, after their yes on one server card) goes through the same checks and is audited with via ai.' }),
  shareChat: endpoint({ method: 'POST', path: '/api/chats/:id/share', auth: 'user', owner: 'B', body: ShareChatBody, response: ShareChatResult, summary: 'Share my private chat with its project\'s members (a team project that shares its chats). First a check of every branch: when its answers carry content from material some of them cannot see, or may have used my personal memories (or with ask), it answers "confirm" (how many, the places I may look myself, never who) with a confirmKey; sent again with that key it shares. Never undone. 409 with reason project_not_sharing, project_personal, project_in_trash, safe_ops, already_shared, scheduled_run, chat_busy or share_hidden. Rate-limited like a room message; audited.' }),
  messageSources: endpoint({ method: 'GET', path: '/api/chats/:id/messages/:messageId/sources', auth: 'user', owner: 'B', response: MessageSources, summary: 'The files the AI read or saw passages of for this answer, each checked against the viewer\'s access now (no name or path for the others).' }),
  regenerate: endpoint({ method: 'POST', path: '/api/chats/:id/messages/:messageId/regenerate', auth: 'user', owner: 'B', status: 202, body: RegenerateBody, response: TurnStarted, summary: 'New answer to the same user message (sibling of :messageId, an assistant message).' }),
  editMessage: endpoint({ method: 'POST', path: '/api/chats/:id/messages/:messageId/edit', auth: 'user', owner: 'B', status: 202, body: EditMessageBody, response: TurnStarted, summary: 'Edited copy of user message :messageId as a new branch, then answer it.' }),
  selectBranch: endpoint({ method: 'POST', path: '/api/chats/:id/branch', auth: 'user', owner: 'B', body: SelectBranchBody, response: MessagesPage, summary: 'Switch the visible branch ("< 2/3 >"); returns the newest page of the new path.' }),
  listTurnRequests: endpoint({ method: 'GET', path: '/api/chats/:id/requests', auth: 'user', owner: 'B', response: z.object({ items: z.array(OpenTurnRequest) }), summary: 'Open ask_user / browser site cards of the running turn of this chat.' }),
  // here, not in rooms.ts: ws.ts (TurnRequest) and this file import rooms.ts
  listRoomAiRequests: endpoint({ method: 'GET', path: '/api/rooms/:id/ai/requests', auth: 'user', owner: 'B', response: z.object({ items: z.array(RoomTurnRequest) }), summary: "Open cards (the AI's questions, confirmations) of the caller's own questions to the AI in a room I am in, its threads included; never anyone else's." }),
  connectTurn: endpoint({ method: 'POST', path: '/api/turns/:id/connect', auth: 'user', owner: 'B', body: TurnConnectBody, response: TurnConnectResult, summary: 'Finish a connect_service card: add the connection with a sealed key, after a sign-in, or skip' }),
  answerTurn: endpoint({ method: 'POST', path: '/api/turns/:id/answer', auth: 'user', owner: 'B', body: TurnAnswerBody, response: empty, status: 204, summary: 'Answer an ask_user card or a browser site confirmation of an own running turn.' }),

  listProjects: endpoint({ method: 'GET', path: '/api/projects', auth: 'user', owner: 'B', query: ProjectsQuery, response: z.object({ items: z.array(Project) }), summary: 'Projects whose folder the caller can read; manage=1 (the owner and admins): also the team projects they manage without being a member, without their contents.' }),
  createProject: endpoint({ method: 'POST', path: '/api/projects', auth: 'user', owner: 'B', status: 201, body: CreateProjectBody, response: Project, summary: 'New project: a new team project folder projects/<name> with participants (members too, unless the team lets only admins), or a personal one in users/<me>/projects/<name>. Nowhere else.' }),
  previewProjectAccess: endpoint({ method: 'POST', path: '/api/projects/access-preview', auth: 'user', owner: 'B', body: ProjectAccessPreviewBody, response: ProjectAccessPreview, summary: 'Dry run: how many people would see a new team project with these participants (for the owner and admins also apart: by its rules, by role only), or (projectId: its creator or an admin) who gains and loses an existing one, what the people who gain it would see, and whether saving also writes the floor rule or puts the creator\'s rule back (the screen asks first then). Nothing is saved.' }),
  getProject: endpoint({ method: 'GET', path: '/api/projects/:id', auth: 'user', owner: 'B', query: ProjectsQuery, response: Project, summary: 'One project (manage=1: also one the owner or an admin manages without being a member, without its contents).' }),
  restoreProject: endpoint({ method: 'POST', path: '/api/projects/:id/restore', auth: 'user', owner: 'B', response: Project, summary: 'Put a team project whose folder is in the trash back, with its folder (the owner or an admin; audited).' }),
  getProjectAccess: endpoint({ method: 'GET', path: '/api/projects/:id/access', auth: 'user', owner: 'B', response: ProjectAccess, summary: 'Who sees a team project: its participants, the rules the project screen does not change, the rules hash (its creator or an admin).' }),
  putProjectParticipants: endpoint({ method: 'PUT', path: '/api/projects/:id/participants', auth: 'user', owner: 'B', body: PutProjectParticipantsBody, response: ProjectAccess, summary: 'Change who sees a team project in projects/<name> (its creator or an admin): the folder rules, as Admin › Folder permissions saves them (409 rules_changed when they changed since expectedHash; audited; people who lose it lose its shared chats).' }),
  updateProject: endpoint({ method: 'PATCH', path: '/api/projects/:id', auth: 'user', owner: 'B', body: UpdateProjectBody, response: Project, summary: 'Edit name / instructions / shareChats (the creator or an admin, with write access to the folder; audited, readers notified). folderPath: admins only, for a project whose folder is in the trash or missing, to an existing projects/<name>.' }),
  shareProject: endpoint({ method: 'POST', path: '/api/projects/:id/share', auth: 'user', owner: 'B', body: ShareProjectBody, response: ShareProjectResult, summary: 'Make a personal project a team project: a new projects/<name> with participants, the files copied into it, the project pointed at it (the personal folder stays).' }),
  deleteProject: endpoint({ method: 'DELETE', path: '/api/projects/:id', auth: 'user', owner: 'B', query: DeleteProjectQuery, response: empty, status: 204, summary: 'Delete the project. A team project in projects/<name> whose folder is in place goes to the trash with its folder first (it stays, inTrash, until restored); a second DELETE, or any other project: for good (the creator or an admin; private chats stay, without project; its shared chats go to their creators\' trash and stop being shared, or are deleted for good when the creator would not see the project).' }),
} as const
