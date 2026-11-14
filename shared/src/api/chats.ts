// Chats, messages, turn control, projects, ask_user answers. Owner: B (server/src/routes/chats.ts).
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { Access, EngineId, IsoTime, PageQuery, QueryBool, RelPath, page } from './common'
import { endpoint, empty, stream } from './endpoint'
import { SealedSecret } from './credentials'
import { AudienceSplit, Chat, Message, MessageSources, Project, SubjectType, UserRef } from './entities'
import { ANSWER_NOTE_MAX, AnswerShareConfirm, AnswerShareProvenance, ROOM_FILES_MAX, RoomMessage } from './rooms'
import { IntegrationStatus } from './integrations'
import { TurnRequest } from './ws'

/** GET /api/chats/:id/files/:fileId: thumb=1 an image's preview, download=1 as an attachment */
export const ChatFileQuery = z.object({ thumb: QueryBool.optional(), download: QueryBool.optional() })

// ---------------- an answer sent to a room ("대화방에 보내기") ----------------
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
export const ShareAnswerToRoomResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('sent'), message: RoomMessage, cut: z.boolean() }),
  AnswerShareConfirm,
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
  /** only my chats in this list folder of mine (docs/DECISIONS.md "List folders"), newest first; another person's
   * folder answers 404. Not with projectId or trash. */
  folderId: Uuid7.optional(),
  /** only the Trina list's "Other chats" (GET /api/chats/groups `other`, its next pages): my list's chats in no project
   * I can see and in none of my list folders, pinned ones left out. Not with q, projectId, folderId, sideRoomId or trash. */
  other: QueryBool.optional(),
})

// ---------------- the Trina list's groups (GET /api/chats/groups) ----------------
/** Project groups in the Trina list: the projects with my activity in the last CHAT_GROUPS_RECENT_DAYS days, at most
 * this many, the most recent first (the rest are behind "All projects"). */
export const CHAT_GROUPS_PROJECTS_MAX = 8
export const CHAT_GROUPS_RECENT_DAYS = 14
/** a project group with no activity of mine for this many days starts folded */
export const CHAT_GROUPS_FOLD_DAYS = 7
/** rows of each group that come with it (`top`), the most recently active first */
export const CHAT_GROUPS_TOP = 3
/** A chat of a group that shows a session marker now (docs/DECISIONS.md "Session markers"): what the marker is made of,
 * so a folded header or a group's "N more" shows the strongest mark of rows that are not in `top`. */
export const ChatMark = Chat.pick({ id: true, runState: true, waiting: true, unseen: true, lastOutcome: true })
export type ChatMark = z.infer<typeof ChatMark>
const GroupHead = {
  /** every chat of the group I can open now (never one I cannot), pinned ones left out (they are under `pinned`) */
  count: z.number().int().nonnegative(),
  /** its first CHAT_GROUPS_TOP chats, the most recently active first */
  top: z.array(Chat),
  /** the chats of the group that show a marker now, `top`'s included */
  marked: z.array(ChatMark),
}
export const ChatGroups = z.object({
  /** my pinned chats (the most recently pinned first), as the first page of GET /api/chats has them */
  pinned: z.array(Chat),
  /** my chat list folders in their order (docs/DECISIONS.md "List folders"), each with what I can open in it now */
  folders: z.array(z.object({ id: Uuid7, name: z.string(), position: z.number().int().nonnegative(), ...GroupHead })),
  /** the projects I can see with my activity in the last 14 days, the most recent first, at most 8. A project I cannot
   * see now is never named: my chats in it are in `other`. */
  projects: z.array(z.object({ projectId: Uuid7, name: z.string(), lastActivityAt: IsoTime, folded: z.boolean(), ...GroupHead })),
  /** the projects I can see that are not in `projects` (behind "All projects") */
  projectsMore: z.number().int().nonnegative(),
  /** page 1 of my other chats: in no project I can see and in no folder of mine (the next pages: GET /api/chats?other=1) */
  other: page(Chat),
  /** every project I can see that holds chats I can open (mine, pinned ones too, and its shared chats; never another
   * person's private chat), the most recent first: how many and when the latest was active (the 프로젝트 panel's "2시간 전 · 대화 5"). A project with none is not here. Absent from older
   * servers. */
  projectActivity: z.array(z.object({ projectId: Uuid7, count: z.number().int().nonnegative(), lastActivityAt: IsoTime })).optional(),
})
export type ChatGroups = z.infer<typeof ChatGroups>
export const CreateChatBody = z.object({
  projectId: Uuid7.nullable().optional(),
  /** a side chat of this room (✦ Trina, docs/DECISIONS.md "Trina side chat"): I must be in the room; never with a
   * project (a side chat is mine alone) */
  sideRoomId: Uuid7.optional(),
  title: z.string().max(200).optional(),
  engine: EngineId.optional(),
  model: z.string().max(100).nullable().optional(),
  /** "Only me" (docs/DECISIONS.md "Team project chats shared by default"): a chat in a team project starts shared with
   * its members unless this is true; then it is its creator's alone until they share it (POST /api/chats/:id/share).
   * Ignored outside team projects (every other chat is one person's anyway). */
  private: z.boolean().optional(),
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
/** `through`: show the branch holding this answer, for this read only (the chat's active branch is not changed for anyone:
 * a widening list item opens /c/<chatId>?answer=<messageId>); an id not in the chat, or an answer hidden from the viewer,
 * is ignored (the active branch). Older pages of that view pass it too. */
export const ListMessagesQuery = PageQuery.extend({ through: Uuid7.optional() })
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

// ---------------- projects ----------------
/** Who works in a team project (each gets read and write; nobody else but the creator, the owner and admins). */
export const ProjectParticipant = z.object({ subjectType: z.enum(['group', 'user']), subjectId: z.string().min(1).max(64) })
export type ProjectParticipant = z.infer<typeof ProjectParticipant>
// ---------------- a chat outside projects shared with chosen people and groups (Share…) ----------------
/** At most this many people and groups in one chat's audience (a group is one entry). */
export const CHAT_AUDIENCE_MAX = 100
/** One row of GET /api/chats/:id/audience. A group's `members` only for the chat's creator and admins (others learn
 * names only, never a group's size); `mine`: I am in that group. */
export const ChatAudienceRow = z.object({
  subjectType: z.enum(['user', 'group']), subjectId: z.string(), name: z.string(),
  /** a person's profile line, when set */
  title: z.string().optional(),
  /** a person's photo (/api/people/:id/avatar?v=<it>); absent without one */
  avatarVersion: z.number().int().positive().optional(),
  /** a group's size: the creator and admins only */
  members: z.number().int().nonnegative().optional(),
  /** I am in this group */
  mine: z.literal(true).optional(),
  /** a person whose account is disabled (they do not see the chat now; back in once enabled): the creator and admins
   * only, everyone else does not get the row */
  inactive: z.literal(true).optional(),
  /** a person: the groups listed here that they are in too (they keep the chat through them when taken out by name: QA
   * TC-2264). The creator and admins only, and only groups the viewer is in (admins: any) */
  inGroups: z.array(z.string()).optional(),
})
/** GET /api/chats/:id/audience: who the chat is shared with (docs/DECISIONS.md "Chats shared with people and groups").
 * `kind`: 'people' (shared with the subjects listed), 'project' (a shared project chat: its project's members see it,
 * nothing is listed), 'private' (its creator's alone). `canEdit`: I may change who sees it here (its creator, for a
 * chat outside projects). */
export const ChatAudience = z.object({
  kind: z.enum(['private', 'project', 'people']),
  canEdit: z.boolean(),
  /** who started the chat */
  by: z.object({ id: z.string(), name: z.string() }),
  subjects: z.array(ChatAudienceRow),
  /** how many people see it now, its creator included (with a group in it: for the creator and admins only) */
  count: z.number().int().nonnegative().optional(),
})
export type ChatAudience = z.infer<typeof ChatAudience>
export const PutChatAudienceBody = z.object({
  /** everyone it is shared with after the save (Drive's save model: the whole list); [] makes it mine alone again */
  subjects: z.array(ProjectParticipant).max(CHAT_AUDIENCE_MAX + 1),
  /** the last "confirm"'s key: I saw that state and said yes */
  confirmKey: z.string().min(1).max(200).optional(),
}).strict()
export const PutChatAudienceResult = z.discriminatedUnion('status', [
  /** saved: the chat as I see it and its audience now. `filesNotCopied`: at a first share, how many of my earlier
   * computer uploads in it could not be shared with it (too large, no storage room, changed since): still mine alone */
  z.object({
    status: z.literal('saved'), chat: Chat, audience: ChatAudience, filesNotCopied: z.number().int().positive().optional(),
    /** people taken out by name who still see it through a group listed (QA TC-2264): their name and those groups' names.
     * Only through groups I am in (admins any); someone kept only through other groups is not listed */
    keptThrough: z.array(z.object({ name: z.string(), groups: z.array(z.string()).min(1) })).optional(),
  }),
  /** nothing changed yet: the check for the people who would start to see it. `added`: how many people (never who);
   * `provenance`: its answers carry content from places some of them cannot open (null: none); `memories`: an answer
   * may have used my personal memories; `hiddenAnswers`: answers whose recorded places some of them cannot open;
   * `earlierFiles`: at a first share, how many files I attached from my computer will be visible to them;
   * `confirmKey`: send it back to save. `reason` 'changed': asked again after a key, something changed meanwhile */
  z.object({
    status: z.literal('confirm'),
    added: z.number().int().nonnegative(),
    provenance: AnswerShareProvenance.nullable(),
    memories: z.boolean(),
    hiddenAnswers: z.number().int().nonnegative(),
    earlierFiles: z.number().int().positive().optional(),
    confirmKey: z.string(),
    reason: z.literal('changed').optional(),
  }),
])
export type PutChatAudienceResult = z.infer<typeof PutChatAudienceResult>

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
  /** Kept so older apps still parse (docs/DECISIONS.md "Team project chats shared by default"): a team project always
   * shares its new chats (each chat may still start "Only me"). true is accepted and changes nothing; false is 409
   * share_chats_always; on a personal project 409 project_personal. */
  shareChats: z.boolean().optional(),
  /** repointed at a projects/<name> folder that holds skills: they switch on in the project's chats: 409
   * project_skills_on unless true (docs/DECISIONS.md "Project skills") */
  skillsOk: z.boolean().optional(),
  /** the name and instructions as the edit form loaded them: when either is not what the project has now (someone
   * else saved in between), nothing is saved and the answer is 409 `project_changed` with `params.name` and
   * `params.instructions`, the project's values now (QA TC-1013). Absent (older clients): the save goes through. */
  base: z.object({ name: z.string().max(100).optional(), instructions: z.string().max(50_000).optional() }).optional(),
})
export const DeleteProjectQuery = z.object({
  /** ignored since "Project contents only for members": a team project in projects/<name> whose folder is in place
   * always goes to the trash with its folder (the project stays, `inTrash`, until Restore or a second DELETE) */
  trashFolder: QueryBool.optional(),
  /** 되돌리기 after "move to a new project": delete only the caller's own personal project that is still as it was made
   * (no chats, no instructions, no scheduled task, nothing in its folder), with its empty folder; otherwise 409
   * `project_not_empty` and nothing changes */
  ifEmpty: QueryBool.optional(),
})
/** GET /api/projects and GET /api/projects/:id: `manage=1` (the owner and admins) also answers the team projects the
 * caller manages without being a member (Project.member false, no contents). Without it: projects the caller reads. */
export const ProjectsQuery = z.object({ manage: QueryBool.optional() })
/** The owner's or an admin's card for team projects from before the update (docs/DECISIONS.md "Projects from before the
 * update: one card, Add me to these"): id and name only, never their contents. No items: no card. */
export const ProjectsUpdateNotice = z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) })
export type ProjectsUpdateNotice = z.infer<typeof ProjectsUpdateNotice>
/** "Add me to these": how many projects the caller is a member of now, and how many could not be saved. */
export const ProjectsUpdateJoined = z.object({ joined: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() })
export type ProjectsUpdateJoined = z.infer<typeof ProjectsUpdateJoined>

/** A participant as the project's edit screen shows it. `creator`: the project's creator, always kept. `except` (a
 * group): the people in it who left the project (a "no access" rule of their own; docs/DECISIONS.md "Leaving a
 * project"), shown as "Marketing · except Kim". Absent: nobody. */
export const ProjectMember = ProjectParticipant.extend({ name: z.string(), creator: z.boolean().optional(), except: z.array(z.object({ id: z.string(), name: z.string() })).optional() })
export type ProjectMember = z.infer<typeof ProjectMember>
/** A rule of the project folder (or a folder inside it) that the project screen shows but does not change: read-only
 * people or groups, roles, an everyone rule other than "nobody else", rules inside it. Admin › Folder permissions does. */
export const ProjectOtherRule = z.object({ path: RelPath, subjectType: SubjectType, subjectId: z.string().nullable(), name: z.string().nullable(), access: Access })
export type ProjectOtherRule = z.infer<typeof ProjectOtherRule>
/** POST /api/projects/:id/leave: how many of the caller's private chats in it moved to their own chats. */
export const LeaveProjectResult = z.object({ movedChats: z.number().int().nonnegative() })
export type LeaveProjectResult = z.infer<typeof LeaveProjectResult>
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
  /** people who left the project (docs/DECISIONS.md "Leaving a project") whom no group row shows as `except`: "Left:
   * Bob", with Add back (naming them as a participant) for whoever changes the members. Absent: nobody. */
  left: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
})
export type ProjectAccess = z.infer<typeof ProjectAccess>
/** A person in a team project, for its page's faces and its members dialog. `avatarVersion`: their photo (absent without
 * one; the photo is at /api/people/:id/avatar?v=<it>). `creator`: the project's creator. */
/** `guest`: someone from outside the team (docs/DECISIONS.md "Guests"): their "Guest" tag and the header's "Includes 1 guest"
 * also for an owner or admin outside the guest's one place, whose people list (GET /api/people) does not have them. */
export const ProjectPerson = z.object({ id: z.string(), name: z.string(), avatarVersion: z.number().int().positive().optional(), creator: z.literal(true).optional(), guest: z.literal(true).optional() })
export type ProjectPerson = z.infer<typeof ProjectPerson>
/**
 * Who is in a team project in projects/<name> (GET /api/projects/:id/people; its members, and the owner, admins and its
 * creator who manage it): `people` every active person who sees it now, each once (also when two groups hold them), the
 * creator first, then by name. `groups`, only for whoever manages it (who already reads its participants in GET
 * …/access): each group it was shared with and the people of `people` in it. Nothing while its folder is in the trash.
 */
export const ProjectPeople = z.object({
  people: z.array(ProjectPerson),
  groups: z.array(z.object({ id: z.string(), name: z.string(), people: z.array(z.string()) })).optional(),
})
export type ProjectPeople = z.infer<typeof ProjectPeople>
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
  /** an existing project: the names of up to 3 of the `removed` people, by name (the confirm says "Kim, Lee and 2 more
   * lose access"; QA TC-1067). Only to whoever may change its members, who reads its people anyway. Absent: none */
  removedNames: z.array(z.string()).max(3).optional(),
  /** what the added people would see (0 when nobody is added): its files, those that other people than the caller put
   * there, its shared chats (each with its whole history) and its project skills (skills/<name>/SKILL.md in its folder) */
  files: z.number().int().nonnegative(),
  othersFiles: z.number().int().nonnegative(),
  sharedChats: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
  /** those project skills by name (their folder's name, at most 10, sorted): the confirm names them, since the people
   * who gain the project start using them in its chats */
  skillNames: z.array(z.string()).max(10).optional(),
  /** an existing project: the answers of its shared chats the people who gain it would start seeing although they used
   * places some of them can't open (the widening warning, docs/DECISIONS.md "People who see a shared chat later: nothing
   * new is hidden"; the list: POST /api/sharing/widening-answers). Only answers the caller sees. Absent: none */
  hiddenAnswers: z.number().int().nonnegative().optional(),
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
/** A person or group someone shares with (the Members dialog's participants; a chat's audience later). */
export const ChatAudienceSubject = ProjectParticipant
export type ChatAudienceSubject = z.infer<typeof ChatAudienceSubject>
/** The widening list (docs/DECISIONS.md "People who see a shared chat later: nothing new is hidden"): a team project and
 * the participants its Members dialog would save (`add`: the whole list, as for the dry run); `cursor` from the page
 * before; `limit` 1..50 (20). */
export const WideningAnswersBody = z.object({
  target: z.discriminatedUnion('kind', [z.object({ kind: z.literal('project'), projectId: Uuid7 }), z.object({ kind: z.literal('chat'), chatId: Uuid7 })]),
  add: z.array(ChatAudienceSubject).min(1).max(200),
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(50).optional(),
})
export type WideningAnswersBody = z.infer<typeof WideningAnswersBody>
/** One answer the new people would start seeing: its chat, when, who asked, its first line (plain text, at most 120
 * characters), the places it used that some of them miss (by name only where the caller may open it now; several
 * others: one `hidden`), and which of the picked people and groups miss them (names the caller chose, never anyone
 * else). */
export const WideningAnswer = z.object({
  chatId: Uuid7, chatTitle: z.string(), messageId: Uuid7, at: z.string(),
  askedBy: UserRef.extend({ avatarVersion: z.number().int().positive().optional() }).nullable(),
  preview: z.string(),
  places: z.array(z.union([z.object({ name: z.string() }), z.object({ hidden: z.literal(true) })])),
  missedBy: z.array(z.string()),
})
export type WideningAnswer = z.infer<typeof WideningAnswer>
/** `total`: how many there are (`totalCapped`: it stopped counting at 50,000); `nextCursor`: the next page, or null. */
export const WideningAnswers = z.object({ total: z.number().int().nonnegative(), totalCapped: z.boolean(), items: z.array(WideningAnswer), nextCursor: z.string().nullable() })
export type WideningAnswers = z.infer<typeof WideningAnswers>
export const PutProjectParticipantsBody = z.object({ participants: z.array(ProjectParticipant).max(200), expectedHash: z.string().min(1).max(64), removeRules: z.array(ProjectRuleRef).max(50).optional() })

export const CHATS = {
  oftenAsked: endpoint({ method: 'GET', path: '/api/questions/often-asked', auth: 'user', owner: 'B', response: OftenAsked, summary: 'Home’s "what my group often asks": generic sentences that 3 or more people of the caller’s group (else the team) asked in a similar way, rewritten once a day; never who asked, how many or when. Empty while the team setting is off or there is too little data.' }),
  listChats: endpoint({ method: 'GET', path: '/api/chats', auth: 'user', owner: 'B', query: ListChatsQuery, response: page(Chat), summary: 'Own chats and the shared project chats I wrote in, newest first (search with q, trash with trash=1: my own and the shared chats I deleted, while I may restore them). With projectId: my chats there and every shared chat of that project I can see. Every list but the trash gives each shared chat the other people who wrote in it (shared.people: the 3 most recent, never me; shared.peopleCount). Without q and trash, the first page starts with my pinned chats of that list (pinnedAt, the most recently pinned first) and the pages after it leave them out.' }),
  listChatGroups: endpoint({ method: 'GET', path: '/api/chats/groups', auth: 'user', owner: 'B', response: ChatGroups, summary: 'My Trina list in one read: my pinned chats, my chat folders, the projects I can see with my activity in the last 14 days (at most 8, the most recent first; projectsMore counts the rest I can see), each folder and project with how many of its chats I can open now, its first 3 and the ones that show a marker now, and page 1 of my other chats (next pages: GET /api/chats?other=1); each shared chat with the other people who wrote in it (shared.people, shared.peopleCount); projectActivity: for every project I can see, how many chats in it I can open (mine and its shared chats, never another person\'s private chat) and when the latest was active. Only what my own chat list holds and only projects I can see now; nobody else\'s folders.' }),
  createChat: endpoint({ method: 'POST', path: '/api/chats', auth: 'user', owner: 'B', status: 201, body: CreateChatBody, response: Chat, summary: 'New empty chat (optionally inside a project). In a team project it is a shared chat, seen and continued by the project\'s members, unless `private` is true ("Only me"); never in a personal project or while safe operations are on.' }),
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
  getChatAudience: endpoint({ method: 'GET', path: '/api/chats/:id/audience', auth: 'user', owner: 'B', response: ChatAudience, summary: 'Who a chat I can see is shared with: for a chat outside projects shared with people and groups, the people and groups by name (a group\'s size and the count only for its creator and admins when a group is in it); a shared project chat or my private chat lists nobody. Anyone who cannot see the chat gets the 404 of a missing chat.' }),
  putChatAudience: endpoint({ method: 'PUT', path: '/api/chats/:id/audience', auth: 'user', owner: 'B', body: PutChatAudienceBody, response: PutChatAudienceResult, summary: 'Its creator saves who sees a chat outside projects (the whole list, at most 100 people and groups; [] makes it theirs alone again). Adds that bring in new people first answer "confirm" when its answers carry content from places some of them cannot open, may have used my memories, used recorded places they cannot open, or (a first share) will show them my earlier computer uploads (counts and places I may look myself, never who), with a confirmKey; sent again with that key it saves. Removed people\'s turns there stop first. A first share copies my earlier computer uploads into the chat (each at most 50 MB, metadata of photos cut out); filesNotCopied says how many could not be. 403 chat_share_creator_only to others who see it, the 404 of a missing chat to everyone else; 409 share_people_in_project, project_personal, safe_ops (adds), scheduled_run, side_chat, chat_busy (adds); 400 audience_full, unknown_subject (newly added only), needs_people. Rate-limited like a room message; audited (counts only); people added by name and through a group get an Inbox notice (at most one per chat and person a day).' }),
  userSharedChats: endpoint({ method: 'GET', path: '/api/admin/users/:id/shared-chats', auth: 'admin', owner: 'B', response: z.object({ sharedChats: z.number().int().nonnegative() }), summary: 'For the delete-account dialog: how many chats this person shared with people and groups hold other people\'s messages. Deleting the account deletes them for good after the retention period (disabling it keeps them). A count, nothing else.' }),
  hideChat: endpoint({ method: 'POST', path: '/api/chats/:id/hide', auth: 'user', owner: 'B', response: Chat, summary: '"Hide from my list": a chat someone shared with me leaves my chat lists, for me only (search still finds it); opening it (POST /api/chats/:id/seen) or DELETE brings it back. Its creator gets 400 chat_hide_creator.' }),
  unhideChat: endpoint({ method: 'DELETE', path: '/api/chats/:id/hide', auth: 'user', owner: 'B', response: Chat, summary: 'Bring a chat I hid from my list back.' }),
  chatFile: endpoint({ method: 'GET', path: '/api/chats/:id/files/:fileId', auth: 'user', owner: 'B', query: ChatFileQuery, response: stream(true), summary: 'A file from the computer kept with a chat shared with people and groups (Attachment source chat), for whoever sees the chat now (checked on every read: anyone else, a removed person included, gets the 404 of a missing chat); one not sent in a message yet only for its sender. thumb=1 for an image preview, download=1 as an attachment. Inline, a page or script type is sent as text/plain with a sandbox CSP: never a page of the app. A file on the safety check\'s download-only list is sent only with download=1 (503 quarantined otherwise).' }),
  messageSources: endpoint({ method: 'GET', path: '/api/chats/:id/messages/:messageId/sources', auth: 'user', owner: 'B', response: MessageSources, summary: 'The files the AI read or saw passages of for this answer, each checked against the viewer\'s access now (no name or path for the others).' }),
  regenerate: endpoint({ method: 'POST', path: '/api/chats/:id/messages/:messageId/regenerate', auth: 'user', owner: 'B', status: 202, body: RegenerateBody, response: TurnStarted, summary: 'New answer to the same user message (sibling of :messageId, an assistant message).' }),
  editMessage: endpoint({ method: 'POST', path: '/api/chats/:id/messages/:messageId/edit', auth: 'user', owner: 'B', status: 202, body: EditMessageBody, response: TurnStarted, summary: 'Edited copy of user message :messageId as a new branch, then answer it.' }),
  selectBranch: endpoint({ method: 'POST', path: '/api/chats/:id/branch', auth: 'user', owner: 'B', body: SelectBranchBody, response: MessagesPage, summary: 'Switch the visible branch ("< 2/3 >"); returns the newest page of the new path.' }),
  listTurnRequests: endpoint({ method: 'GET', path: '/api/chats/:id/requests', auth: 'user', owner: 'B', response: z.object({ items: z.array(OpenTurnRequest) }), summary: 'Open ask_user / browser site cards of the running turn of this chat.' }),
  // here, not in rooms.ts: ws.ts (TurnRequest) and this file import rooms.ts
  connectTurn: endpoint({ method: 'POST', path: '/api/turns/:id/connect', auth: 'user', owner: 'B', body: TurnConnectBody, response: TurnConnectResult, summary: 'Finish a connect_service card: add the connection with a sealed key, after a sign-in, or skip' }),
  answerTurn: endpoint({ method: 'POST', path: '/api/turns/:id/answer', auth: 'user', owner: 'B', body: TurnAnswerBody, response: empty, status: 204, summary: 'Answer an ask_user card or a browser site confirmation of an own running turn.' }),

  listProjects: endpoint({ method: 'GET', path: '/api/projects', auth: 'user', owner: 'B', query: ProjectsQuery, response: z.object({ items: z.array(Project) }), summary: 'Projects whose folder the caller can read; manage=1 (the owner and admins): also the team projects they manage without being a member, without their contents; and for everyone the team projects in the trash they are a member of (name and state only).' }),
  // docs/DECISIONS.md "Projects from before the update: one card, Add me to these" (Admin › Home)
  getProjectsUpdateNotice: endpoint({ method: 'GET', path: '/api/projects/update-notice', auth: 'user', owner: 'B', response: ProjectsUpdateNotice, summary: 'For the owner or an admin: the team projects from before the update to members-only projects (0.4.0 to 0.5.0) that they read by their role then and do not read now, by name, for one card on Admin › Home. Empty for members, after the card was dismissed, and for people who were not the owner or an admin at the update.' }),
  joinProjectsUpdateNotice: endpoint({ method: 'POST', path: '/api/projects/update-notice/join', auth: 'user', owner: 'B', response: ProjectsUpdateJoined, summary: '"Add me to these": the caller becomes a member of every project on their card, each saved as Add me on the project saves it (audited per project with self, its members told), plus one audit row. Projects not on the card are never touched; one that cannot be saved is skipped and counted.' }),
  dismissProjectsUpdateNotice: endpoint({ method: 'POST', path: '/api/projects/update-notice/dismiss', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Hide the card for good, for the caller (every device).' }),
  createProject: endpoint({ method: 'POST', path: '/api/projects', auth: 'user', owner: 'B', status: 201, body: CreateProjectBody, response: Project, summary: 'New project: a new team project folder projects/<name> with participants (members too, unless the team lets only admins), or a personal one in users/<me>/projects/<name>. Nowhere else.' }),
  previewProjectAccess: endpoint({ method: 'POST', path: '/api/projects/access-preview', auth: 'user', owner: 'B', body: ProjectAccessPreviewBody, response: ProjectAccessPreview, summary: 'Dry run: how many people would see a new team project with these participants (for the owner and admins also apart: by its rules, by role only), or (projectId: its creator or an admin) who gains and loses an existing one, what the people who gain it would see, and whether saving also writes the floor rule or puts the creator\'s rule back (the screen asks first then). Nothing is saved. At most 60 a minute per person (429).' }),
  wideningAnswers: endpoint({ method: 'POST', path: '/api/sharing/widening-answers', auth: 'user', owner: 'B', body: WideningAnswersBody, response: WideningAnswers, summary: 'The widening list: the answers of a team project\'s shared chats (target project) or of one chat outside projects (target chat: its Share dialog\'s whole list in add; its creator only) that the people its Members dialog would add start seeing although they used places some of them can\'t open, newest first, 20 a page (the caller\'s own view: answers hidden from them left out, a place by name only when they may open it, "missed by" only the people and groups they picked). Whoever may change its members (403 widening_not_allowed to another viewer, 404 to anyone else). The first page takes a room-send token (429); a cursor of a list whose people or position changed answers 409 changed. Nothing is saved.' }),
  getProject: endpoint({ method: 'GET', path: '/api/projects/:id', auth: 'user', owner: 'B', query: ProjectsQuery, response: Project, summary: 'One project (manage=1: also one the owner or an admin manages without being a member, without its contents, or one in the trash the caller is a member of: name and state only).' }),
  restoreProject: endpoint({ method: 'POST', path: '/api/projects/:id/restore', auth: 'user', owner: 'B', response: Project, summary: 'Put a team project whose folder is in the trash back, with its folder (the owner or an admin, or its creator while a member; audited).' }),
  getProjectPeople: endpoint({ method: 'GET', path: '/api/projects/:id/people', auth: 'user', owner: 'B', response: ProjectPeople, summary: 'Who is in a team project in projects/<name>, each person once with their photo, groups expanded (the groups only for whoever manages it). Its members, and the owner and admins who manage it; anyone else 404. 409 project_personal for a personal project, project_legacy for one made before outside projects/.' }),
  getProjectAccess: endpoint({ method: 'GET', path: '/api/projects/:id/access', auth: 'user', owner: 'B', response: ProjectAccess, summary: 'Who sees a team project: its participants, the rules the project screen does not change, the rules hash (its creator or an admin).' }),
  putProjectParticipants: endpoint({ method: 'PUT', path: '/api/projects/:id/participants', auth: 'user', owner: 'B', body: PutProjectParticipantsBody, response: ProjectAccess, summary: 'Change who sees a team project in projects/<name> (its creator or an admin): the folder rules, as Admin › Folder permissions saves them (409 rules_changed when they changed since expectedHash; audited; people who lose it lose its shared chats).' }),
  updateProject: endpoint({ method: 'PATCH', path: '/api/projects/:id', auth: 'user', owner: 'B', body: UpdateProjectBody, response: Project, summary: 'Edit name / instructions (the creator or an admin, with write access to the folder; audited, readers notified). shareChats: false is 409 share_chats_always (a team project always shares its new chats). folderPath: admins only, for a project whose folder is in the trash or missing, to an existing projects/<name>.' }),
  shareProject: endpoint({ method: 'POST', path: '/api/projects/:id/share', auth: 'user', owner: 'B', body: ShareProjectBody, response: ShareProjectResult, summary: 'Make a personal project a team project: a new projects/<name> with participants, the files copied into it, the project pointed at it; then the personal folder goes to the caller\'s trash (the files moved; a refusal leaves it).' }),
  leaveProject: endpoint({ method: 'POST', path: '/api/projects/:id/leave', auth: 'user', owner: 'B', response: LeaveProjectResult, summary: 'Leave a team project in projects/<name> (a member who reads it): their own rule becomes a "no access" rule of their own, recorded as a leave, so a group that holds them keeps it for the others and they stay out until added back by name. Their private chats in it move to their own chats; audited. 409 project_last_member (nobody else reads it), project_personal, project_not_leavable (not in place or in the trash). Anyone else 404.' }),
  deleteProject: endpoint({ method: 'DELETE', path: '/api/projects/:id', auth: 'user', owner: 'B', query: DeleteProjectQuery, response: empty, status: 204, summary: 'Delete the project. A team project in projects/<name> whose folder is in place goes to the trash with its folder first (it stays, inTrash, until restored); a second DELETE, or any other project: for good (the creator or an admin; private chats stay, without project; its shared chats go to their creators\' trash and stop being shared, or are deleted for good when the creator would not see the project).' }),
} as const
