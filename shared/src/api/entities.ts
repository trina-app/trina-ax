// What the API returns for the tables of design tab 1. These are API views (camelCase, no secrets, no hashes),
// not raw rows. Server code maps rows -> these shapes; clients only ever see these.
import { z } from 'zod'
import { RecommendedTools } from './team-tools'
import { UserId, Uuid7 } from '../ids'
import { StepShared } from './share-card'
import { Access, ApiErrorBody, ClientKind, EngineId, IsoTime, Locale, GuestDetail, GuestPlace, RelPath, Role, TeamRole, TextSize, Theme, UserStatus } from './common'

// ---------------- people ----------------
/** Minimal person reference (chat authors, audit actors, file authors). */
export const UserRef = z.object({ id: UserId, name: z.string() })
export type UserRef = z.infer<typeof UserRef>

/** How many folds a person's lists keep (ListFolds); a newer choice pushes out the oldest. */
export const LIST_FOLDS_MAX = 200
/** One fold's key: `section:<list>:<section>` (a list's section), `room-folder:<id>`, `folder:<id>` (my folders). */
export const ListFoldKey = z.string().min(1).max(120).regex(/^[a-z][a-z-]*:[A-Za-z0-9:_-]+$/)
/** The sections and folders of my lists I folded or opened (web components/panels/folds.ts), on every device I sign in
 * on; a key not there starts as its list starts it (most open). */
export const ListFolds = z.record(ListFoldKey, z.enum(['open', 'folded'])).refine((o) => Object.keys(o).length <= LIST_FOLDS_MAX, { message: `at most ${LIST_FOLDS_MAX} folds` })
export type ListFolds = z.infer<typeof ListFolds>

/** One surface's history view, as the person chose it (web nav/HistoryList.tsx): only what differs from that surface's
 * default (a later default reaches everyone who did not choose otherwise); a value this version does not know reads as
 * absent (docs/decisions/20261122-history-view-per-person.md). */
export const HistoryViewChoice = z.object({
  status: z.enum(['all', 'waiting', 'project', 'noProject', 'confidential']).optional().catch(undefined),
  activity: z.enum(['all', 'today', 'week', 'month']).optional().catch(undefined),
  group: z.enum(['none', 'date', 'project']).optional().catch(undefined),
  sort: z.enum(['updated', 'created', 'title']).optional().catch(undefined),
})
export type HistoryViewChoice = z.infer<typeof HistoryViewChoice>
/** The Trina history's filter, group and sort, per surface: the computer's Trina panel and the phone's ☰ drawer. */
export const HistoryView = z.object({ panel: HistoryViewChoice.optional().catch(undefined), drawer: HistoryViewChoice.optional().catch(undefined) })
export type HistoryView = z.infer<typeof HistoryView>

export const UserPrefs = z.object({
  theme: Theme.optional(),
  /** the person's text size on every device they sign in on (Settings > Profile); absent = default. A stored value this
   * version does not know (a later version's step) reads as absent instead of hiding the other preferences. */
  textSize: TextSize.optional().catch(undefined),
  /** language for AI answers if different from the UI language */
  answerLocale: Locale.optional(),
  /** own default engine/model for new chats ("내 기본 엔진/모델"; only for people who may pick the engine) */
  engine: EngineId.optional(),
  model: z.string().max(100).optional(),
  /** set themselves away (the account menu's "자리 비움으로 표시"; docs/DECISIONS.md "접속 상태"): their dot shows away
   * until they change it. Only PUT /api/me/away sets it; PATCH /api/me leaves it as it is. */
  away: z.boolean().optional(),
  /** the one-time line under a room's header ("✦ Ask Trina about this room. Only you see it.") was closed, or ✦ was
   * used: it never shows again (docs/DECISIONS.md "A welcome for invited people") */
  roomAskHint: z.literal('seen').optional().catch(undefined),
  /** an owner's or admin's one-time line on Admin › Home that members can now share folders in their own files
   * (docs/AGENTS/plan/20261116-1330-folder-share-web.md) was closed: it never shows again */
  folderShareNotice: z.literal('seen').optional().catch(undefined),
  /** the office owner's one-time notice on Admin › Home that the server removed Claude Code connections from this Mac
   * (server/src/office/claude-mcp-notice.ts) was closed: it never shows again */
  officeMcpNotice: z.literal('seen').optional().catch(undefined),
  /** an owner's or admin's one-time notice that the dev environment exists and is off for their team (a team from before
   * 2026-11-06, docs/decisions/20261118-run-code-skills-subagents.md) was closed or followed: it never shows again */
  devEnvOffer: z.literal('seen').optional().catch(undefined),
  /** my lists' folds (ListFolds); a stored value that does not read reads as absent, never hiding the other preferences */
  listFolds: ListFolds.optional().catch(undefined),
  /** the Trina history's filter, group and sort on every device I sign in on (HistoryView); absent = the defaults */
  historyView: HistoryView.optional().catch(undefined),
  /** 'off': a room message with "@전체" goes without the question first ("Don't ask again" on that question; Settings ›
   * Notifications › "Ask before notifying everyone" turns it back on). One choice for every room; absent = ask. */
  mentionAllAsk: z.literal('off').optional().catch(undefined),
  /** 'hidden': the person hid the 7-day team goal card on Home (its "Hide"); Admin › Home's "Show the team goal again"
   * clears it. On every device (owner 2026-11-20: every Home onboarding card can be closed) */
  goalCard: z.literal('hidden').optional().catch(undefined),
  /** 'hidden': the person hid "Ready in your team" on Home (its "Hide"); Settings › Profile's "Show it again" clears it */
  preparedCard: z.literal('hidden').optional().catch(undefined),
  /** 'off': the person turned off "자동으로 기억하기" (Settings › Memory): the AI keeps only what they ask it to keep,
   * as before 2026-11-22. Absent = on (docs/decisions/20261122-auto-memory.md) */
  autoMemory: z.literal('off').optional().catch(undefined),
  /** 'seen': the one-time line under the first memory the AI kept on its own was shown */
  autoMemoryNotice: z.literal('seen').optional().catch(undefined),
})
export type UserPrefs = z.infer<typeof UserPrefs>

/** users (admin view). Never includes password_hash. */
export const User = z.object({
  id: UserId,
  username: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  role: Role,
  status: UserStatus,
  mustChangePassword: z.boolean(),
  /** while the account still has a temporary password (admin "add member" / "reset password"): until when it works,
   * and whether it was voided after too many wrong sign-in tries (Admin > Members shows both; a reset gives a new one) */
  tempPassword: z.object({ expiresAt: IsoTime, voided: z.boolean() }).nullable().optional(),
  /** the language the person sees: their own choice, else the team default */
  locale: Locale,
  /** their own choice; null = follows the team default */
  localeChoice: Locale.nullable(),
  groupIds: z.array(Uuid7),
  createdAt: IsoTime,
  lastSeenAt: IsoTime.nullable(),
  /** role guest only: their one place and AI choice */
  guest: GuestDetail.optional(),
})
export type User = z.infer<typeof User>

export const Group = z.object({
  id: Uuid7,
  name: z.string(),
  description: z.string().nullable(),
  memberIds: z.array(UserId),
})
export type Group = z.infer<typeof Group>

/** sessions (the signed-in person's own list). */
export const Session = z.object({
  id: Uuid7,
  client: ClientKind,
  userAgent: z.string().nullable(),
  createdAt: IsoTime,
  lastSeenAt: IsoTime,
  expiresAt: IsoTime,
  /** the session making this request */
  current: z.boolean(),
})
export type Session = z.infer<typeof Session>

/** invites. The token is shown once, at creation (CreateInviteResponse). */
export const Invite = z.object({
  id: Uuid7,
  role: Role.exclude(['owner']),
  groupIds: z.array(Uuid7),
  createdBy: UserRef.nullable(),
  createdAt: IsoTime,
  expiresAt: IsoTime,
  usedAt: IsoTime.nullable(),
  usedBy: UserRef.nullable(),
  /** a lead invite ("이 사람이 팀장이에요", docs/DECISIONS.md "W6"): the owner's words for whom it is, while it is still
   * flagged (a transfer clears every flag); absent or null otherwise and from older servers */
  leadFor: z.string().nullable().optional(),
  /** a guest invite's one place; absent on member invites. `name`: the project's or the group chat's name (the invite
   * list names it, as Admin's guest rows do; older servers sent a project's only; '' for a group chat with no name) */
  guestPlace: GuestPlace.extend({ name: z.string().optional() }).optional(),
  /** a guest invite: who the link is for, in the inviter's words (CreateGuestInviteBody.name; the invite list tells
   * the links apart by it); absent when none was given and on member invites */
  guestName: z.string().optional(),
  /** a link nobody has used, turned off or let run out that no longer works anyway, and why: its maker left the room or
   * lost the project or the right to make it (inviter_gone), the room or project is gone (place_gone), or its Team AI
   * account was removed (ai_gone). Admin's invite list leaves it out (only links that still work are listed). Absent while it works and from older servers */
  stopped: z.enum(['inviter_gone', 'place_gone', 'ai_gone']).optional(),
})
export type Invite = z.infer<typeof Invite>

// ---------------- folders and rules (tab 2) ----------------
export const SubjectType = z.enum(['everyone', 'role', 'group', 'user'])
export type SubjectType = z.infer<typeof SubjectType>
/** One rule: who (subject) gets what (access) on a folder. subjectId: null for everyone, a Role for role, group id, user id. */
export const FolderRuleInput = z.discriminatedUnion('subjectType', [
  z.object({ subjectType: z.literal('everyone'), subjectId: z.null(), access: Access }),
  z.object({ subjectType: z.literal('role'), subjectId: TeamRole, access: Access }),
  z.object({ subjectType: z.literal('group'), subjectId: Uuid7, access: Access }),
  z.object({ subjectType: z.literal('user'), subjectId: UserId, access: Access }),
])
export type FolderRuleInput = z.infer<typeof FolderRuleInput>
export const FolderRule = z.object({
  id: Uuid7,
  folderId: Uuid7,
  subjectType: SubjectType,
  subjectId: z.string().nullable(),
  access: Access,
  updatedBy: UserRef.nullable(),
  updatedAt: IsoTime,
  /** a person rule the one-time conversion to additive access wrote ("Added when folders changed"; docs/DECISIONS.md
   * "Folder access adds up like Google Drive (P2)"). Saving it with the same access keeps the mark. Absent: not one */
  byConversion: z.boolean().optional(),
})
export type FolderRule = z.infer<typeof FolderRule>
/** folders: a folder that carries rules. path: actual on-disk names, no trailing slash, '' = team root. */
export const Folder = z.object({
  id: Uuid7,
  path: RelPath,
  exists: z.boolean(),
  rules: z.array(FolderRule),
  createdAt: IsoTime,
  /** the group whose folder this is (groups.folder_id). null: none; absent: an older server */
  groupId: z.string().nullable().optional(),
  /** why the admin API keeps this row (its rules can still change): 'team' for shared/ and skills/, which keep at least
   * one rule; 'group' for a group's folder while the group exists. null: it may be removed; absent: an older server */
  keep: z.enum(['team', 'group']).nullable().optional(),
  /** the folder answers never show this path (inside users/, .system/ in any case, a temp name, a name the team folder
   * refuses): Admin › Folder permissions lists such a row apart, to edit or remove. Absent: an older server */
  hidden: z.boolean().optional(),
  /** a hash of the folder's rules as they are now (the same rules in any order give the same hash): a save sends it
   * back as `expectedHash`, and the server answers 409 when another admin changed them first. Absent: an older server */
  rulesHash: z.string().optional(),
  /** Limit access: nothing from the folders above reaches it, only its own rules (and the owner and admins, outside
   * projects). Access otherwise adds up from the folders above. Absent: an older server */
  limited: z.boolean().optional(),
})
export type Folder = z.infer<typeof Folder>

// ---------------- projects, chats, messages ----------------
/**
 * Who sees a project or a folder, apart (docs/DECISIONS.md "Who sees it: the project's own people first"): `direct` the
 * people who see it by its own rules (judged as a member would be, so the owner or an admin who is in a rule counts once,
 * here), `byRole` the owner and admins who see it only by their role. They add up to the total next to it. Sent only to
 * the owner and admins: next to the total a member already gets, `direct` would tell them how many see it only by role.
 */
export const AudienceSplit = z.object({ direct: z.number().int().nonnegative(), byRole: z.number().int().nonnegative() })
export type AudienceSplit = z.infer<typeof AudienceSplit>

export const Project = z.object({
  id: Uuid7,
  name: z.string(),
  /** folder inside the team folder that the project's chats use as default context */
  folderPath: RelPath,
  instructions: z.string(),
  createdBy: UserRef.nullable(),
  createdAt: IsoTime,
  /** the caller may edit/delete the project (write access to folderPath) */
  canEdit: z.boolean(),
  /** its folder is in the trash (or was purged from there): only admins and the owner see such a project, and its chats
   * get none of it; restoring the folder, or pointing the project at a folder (PATCH folderPath, also the same path),
   * ends that. Absent from older servers: false. */
  inTrash: z.boolean().optional(),
  /** shared project chats (docs/DECISIONS.md "Shared project chats", "Team project chats shared by default"): new chats
   * in this project are shared with its members unless started "Only me". Every team project since 2026-11-13; absent
   * from older servers and for personal projects: off. */
  shareChats: z.boolean().optional(),
  /** how many active people see this project now (who can read its folder, owner and admins included; while its folder
   * is in the trash, the owner and admins): the people a shared chat of it is shown to. A count, never names. */
  audience: z.number().int().nonnegative().optional(),
  /** `audience` apart (AudienceSplit): a team project, for the owner and admins only. Its 멤버 row says "멤버 3명".
   * While its folder is in the trash nobody sees it by a rule. Absent: anyone else, a personal project, an older server */
  audienceSplit: AudienceSplit.optional(),
  /** how many shared chats it has (not in the trash): the delete dialog says they go to their creators' trash, the
   * repoint dialog who will see them */
  sharedChats: z.number().int().nonnegative().optional(),
  /** a team project's members (docs/DECISIONS.md "Project members in one panel"): the caller changes them in the members
   * dialog (its creator or an admin, `ProjectAccess.editable` for them: a projects/<name> folder in place, and for a
   * member creator one the server made). Absent for a personal project and from older servers: false. */
  membersEditable: z.boolean().optional(),
  /** a team project: its creator changes its members too (their account is active and the folder is theirs to change),
   * so its page names them in "멤버는 …님(만든 사람)이나 관리자가 바꿔요"; false: only admins. Absent: personal, older server */
  creatorChangesMembers: z.boolean().optional(),
  /** while it shares its chats: the caller may send files from the computer into them (they go into the project's chat
   * attachments folder, which the caller may write: server/src/uploads/shared-chat.ts). false: the message box offers
   * team files only. Absent (older server, or not sharing): allowed. */
  chatUploads: z.boolean().optional(),
  /** a team project: nobody but the caller sees it by a rule of its folder (a person, group, role or everyone rule), so
   * anyone else of `audience` is the owner or an admin, who see every project ("나와 관리자만 봐요" under a chat's box,
   * docs/DECISIONS.md "Who sees it, always"). Judged role-blind, and only for a caller who may read its rules anyway (an
   * owner or admin, or whoever may change its members): to anyone else it would tell that the others are admins.
   * Absent: someone else sees it by a rule, the caller may not read its rules, a personal project, or an older server. */
  alone: z.literal(true).optional(),
  /** false: the caller manages this team project without being a member (the owner or an admin, GET with manage=1):
   * its name, creator and member count only; `instructions` is empty and nothing of its contents comes with it
   * (docs/DECISIONS.md "Project contents only for members"). Absent: a member, or an older server. */
  member: z.literal(false).optional(),
  /** the caller may manage it without reading it: rename, members, delete, restore (the owner or an admin for a team
   * project; its creator while they may edit it). Absent from older servers: use canEdit. */
  canManage: z.boolean().optional(),
  /** the caller may delete it (DELETE /api/projects/:id). false: they manage it, but an older project a member made on
   * a folder an admin made stays with that folder, so only an admin deletes it (409 project_folder_stays; QA TC-1016).
   * Absent from older servers: use canManage. */
  canDelete: z.boolean().optional(),
  /** a team project in projects/<name> the caller is a member of (docs/DECISIONS.md "Leaving a project"): 'yes' they may
   * leave it; 'last' nobody else is in it (the owner and admins who manage it without being members do not count), so
   * they delete it or add someone first. Absent: a personal project, not a member, in the trash, an older server. */
  leave: z.enum(['yes', 'last']).optional(),
  /** while it is in the trash (`inTrash`, its folder not deleted for good from there): who moved it there and when
   * (docs/DECISIONS.md "A team project in the trash: its members keep its card"). Absent otherwise, older servers. */
  trashed: z.object({ by: UserRef.nullable(), at: IsoTime }).optional(),
  /** while it is in the trash: the caller is one of its members (they read it again once it is back), so its card stays
   * on their Projects list, saying only that it is in the trash. Its contents still come to nobody. Absent: not a member,
   * not in the trash, an older server. */
  wasMember: z.literal(true).optional(),
  /** the caller may restore it from the trash (POST /api/projects/:id/restore, or its row in Files › Trash): the owner and
   * admins for a team project, and its creator while they are one of its members. Absent: no, or an older server (there:
   * the owner and admins). */
  canRestore: z.literal(true).optional(),
  /** the project's own chat room (docs/decisions/20261120-project-is-room.md), for someone who reads the project (never
   * with `member: false`): its id and my unread count there (0 until the room's people are put right for me). Absent: no
   * room yet (POST /api/projects/:id/room makes it), a personal or older project, the project in the trash, an older
   * server. */
  room: z.object({ id: Uuid7, unread: z.number().int().nonnegative() }).optional(),
})
export type Project = z.infer<typeof Project>

/** Run state of a chat, from the turn queue. */
export const ChatRunState = z.enum(['idle', 'queued', 'running'])
export type ChatRunState = z.infer<typeof ChatRunState>
/** At most this many of a shared chat's other writers come with it (Chat.shared.people): the faces its list rows show. */
export const CHAT_PEOPLE_SHOWN = 3
export const Chat = z.object({
  id: Uuid7,
  projectId: Uuid7.nullable(),
  title: z.string(),
  engine: EngineId,
  model: z.string().nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  /** soft delete; purged 7 days later */
  deletedAt: IsoTime.nullable(),
  runState: ChatRunState,
  /** Safe operations 1A (docs/SAFE-OPS-1A.md): a confidential conversation. Egress tools are off on the server, and
   * the web app shows its artifacts and HTML / SVG previews without scripts outside the desktop app. Absent = no. */
  confidential: z.literal(true).optional(),
  /** the AI asked me something in this chat and waits (an open ask_user / connect_service card shown in every window;
   * a card for one desktop window only is not counted). Absent = no. */
  waiting: z.literal(true).optional(),
  /** the earlier answer here ended, but the end of the AI's work is not confirmed yet (the server's quarantined slot,
   * at most a few minutes past the answer's time limit): the chat takes no new message until then and says so; other
   * chats work as usual. Absent = no. */
  ending: z.literal(true).optional(),
  /** I answered the AI here, and the answer waits for a free place among the team's running answers to go on (the AI
   * gave its place back while it waited for me). Absent = no. */
  waitingForPlace: z.literal(true).optional(),
  /** a run of one of my own scheduled tasks (its first turn is the task's run; only for the task's owner): the task and
   * how this run went (null while it runs). The lists fold the runs of one task into one row that opens the task
   * (docs/DECISIONS.md "Scheduled runs fold in Recent"). Absent = not a run, or the task is gone. */
  schedule: z.object({ id: z.string(), title: z.string(), templateId: z.string().nullable(), outcome: z.enum(['succeeded', 'problems', 'failed']).nullable() }).optional(),
  /** an answer finished here after I last had the chat on screen (POST /api/chats/:id/seen; migration 252). Absent = no. */
  unseen: z.literal(true).optional(),
  /** a chat shared with people: the messages of others (and Trina's answers to them) I have not read here yet
   * (server/src/chat/message-notices.ts; `unseen` is set with it). Absent = none. */
  unreadCount: z.number().int().positive().optional(),
  /** a chat shared with people that I muted ("Mute this chat"): nothing there tells me. Absent = not muted. */
  muted: z.literal(true).optional(),
  /** a chat shared with people: one of my unread messages there mentions me (the row shows "@"). Absent = no. */
  mentioned: z.literal(true).optional(),
  /** how the newest finished answer ended when it did not end well (docs/DECISIONS.md "Session markers"): 'error' (it
   * failed, a server stop included) or 'paused' (it stopped at the per-answer limit of tool rounds or working time,
   * Message.stopReason). Absent = it finished normally (or the person stopped it), or no answer finished yet. With
   * `unseen` it is the row's "?". */
  lastOutcome: z.enum(['error', 'paused']).optional(),
  /** 내 스킬 가져오기 (docs/DECISIONS.md "W5"): a merge chat made at the end of the welcome steps whose turn waits for its
   * person; the chat page starts it when it is on screen (POST /api/skill-shares/merge-chats/:id/start), so the save
   * cards it raises are there while they look. Absent = no. */
  mergeWaiting: z.literal(true).optional(),
  /** the room whose side panel (✦ Trina) this chat was opened from (docs/DECISIONS.md "Trina side chat"): the AI is
   * told the room, and an answer goes there only with "Share to room". Absent: an ordinary chat. */
  sideRoomId: z.string().optional(),
  /** when I pinned it to the top of my chat list ("상단에 고정", POST /api/chats/:id/pin; migration 277). Mine only: on
   * a shared project chat nobody else sees my pin. Absent = not pinned. */
  pinnedAt: IsoTime.optional(),
  /** the list folder I keep it in (PUT /api/chats/:id/folder; docs/DECISIONS.md "List folders"). Mine only, and only on
   * my own chat with no project. Absent = in no folder. */
  folderId: Uuid7.optional(),
  /** a shared project chat (docs/DECISIONS.md "Shared project chats"): the people who can see its project see it and may
   * continue it, each turn as the person who sent it. Absent: a chat of one person. */
  shared: z.object({
    /** 'project': a shared project chat (its project's members see it); 'people': a chat outside projects its creator
     * shared with chosen people and groups (docs/DECISIONS.md "Chats shared with people and groups"). Absent (older
     * server): 'project'. */
    kind: z.enum(['project', 'people']).optional(),
    /** who made it */
    by: UserRef,
    /** how many people see it now (the project's audience) */
    audience: z.number().int().nonnegative(),
    /** a chat shared with people and groups with a group in it, to anyone but its creator and admins: how many see it is
     * not told (it would tell a group's size), and `audience` is 0 */
    audienceHidden: z.literal(true).optional(),
    /** someone else's question is being answered now (their name; `waiting`: the AI waits for their yes on a card);
     * null when nobody's is, or when it is mine */
    answering: z.object({ name: z.string(), waiting: z.literal(true).optional() }).nullable(),
    /** how many other people have messages waiting there to be sent when the answer ends (PUT /api/chats/:id/waiting): a
     * number, never who or what. Absent: none (or an older server). */
    waiting: z.number().int().positive().optional(),
    /** I made it or wrote in it: it is in my chat list */
    mine: z.boolean(),
    /** I may delete it (its creator or an editor of its project) */
    canDelete: z.boolean(),
    /** I may send files from the computer here (they go into the project's chat attachments folder, which I may write:
     * server/src/uploads/shared-chat.ts). false: the message box offers team files only. Absent (older server): allowed. */
    canUpload: z.boolean().optional(),
    /** the other people who wrote in it (sent a question there, its creator included when they did; never the viewer),
     * the most recent first, at most CHAT_PEOPLE_SHOWN of them: the faces of its list rows (docs/DECISIONS.md "Faces in
     * every chat list"). In every chat list (GET /api/chats in all its forms but the trash, GET /api/chats/groups) and in
     * chat.updated; absent elsewhere (a single chat, an action's answer), and empty while nobody else wrote. People the
     * viewer sees in the chat anyway. */
    people: z.array(UserRef).max(CHAT_PEOPLE_SHOWN).optional(),
    /** how many other people wrote in it (with `people`) */
    peopleCount: z.number().int().nonnegative().optional(),
    /** a chat shared with people, for someone it names by name (not its creator): they may leave it ("Leave this
     * chat", POST /api/chats/:id/leave). Absent: in it through a group only, its creator, or another kind of chat. */
    named: z.literal(true).optional(),
    /** a chat shared with people whose creator's account is gone, for the others in it (QA TC-7431): deleted (`until`:
     * when the chat goes for good, auth/sweeper.ts) or switched off. Absent: their account is there (or it is mine). */
    byGone: z.discriminatedUnion('state', [z.object({ state: z.literal('deleted'), until: IsoTime }), z.object({ state: z.literal('disabled') })]).optional(),
  }).optional(),
})
export type Chat = z.infer<typeof Chat>

/**
 * messages.attachments[]: files the person attached. Uploads are stored in users/<id>/.attachments/<chatId>/;
 * team files (source 'team', POST /api/attachments/team-file) are references to a file in the team folder, not copies:
 * the server follows the file (moves, edits) and checks the person's read access again whenever it is shown or sent.
 * In a chat shared with people and groups a file from the computer is kept with the chat (source 'chat', no team path:
 * GET /api/chats/:id/files/:fileId, for everyone who sees the chat).
 */
export const Attachment = z.object({
  id: Uuid7,
  name: z.string(),
  /** team-relative path: of the stored upload (users/<me>/.attachments/<chatId>/<name>), or where the referenced team
   * file is now ('' when it is unavailable, and for a chat's own file) */
  path: RelPath,
  size: z.number().int().nonnegative(),
  mime: z.string(),
  kind: z.enum(['image', 'pdf', 'document', 'spreadsheet', 'presentation', 'audio', 'video', 'text', 'other']),
  /** images: width/height for layout before the thumbnail loads */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** 'team': a reference to a team-folder file; 'chat': a file from the computer kept with a chat shared with people and
   * groups (its people open it through the chat); absent: an upload */
  source: z.enum(['upload', 'team', 'chat']).optional(),
  /** team references: sha256 of the content when it was attached */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** team references: the content changed since it was attached (the AI gets the current version) */
  changed: z.boolean().optional(),
  /** team references: moved or renamed since it was attached (`path` is where it is now) */
  moved: z.boolean().optional(),
  /** team references: deleted, or the viewer can no longer read it; name, path and size are then blanked */
  unavailable: z.boolean().optional(),
  /** the answer to an upload only: how many bytes the server received, when the file it kept is another size (a
   * picture's place and camera cut out after it arrived whole: a file kept with a chat shared with people). The sender
   * checks the file arrived whole against this, `size` is what everyone opens (QA TC-2023) */
  receivedSize: z.number().int().nonnegative().optional(),
  /** a chat file (source 'chat') the chat got without anyone sending it from their computer: 'shared-copy' is a copy of
   * a file the chat made in its creator's own folder, added by the creator's own press when the chat was shared
   * (docs/decisions/20261121-share-chat-files.md), attached to the answer that made it; 'ai' is the AI's own output
   * attached to its answer (server/src/chat/work-file-tool.ts). Absent: someone's upload */
  origin: z.enum(['ai', 'shared-copy']).optional(),
  /** 'shared-copy', for the chat's creator only (a path in their own folder): the team path it was copied from, so
   * their own link to it opens this copy. Everyone else reaches the copy through the link's panel (file-access 'copy').
   * The server keeps the original's sha256 beside it for its own re-check; that is never sent */
  from: RelPath.optional(),
  /** a chat file (source 'chat') changed since it was sent (server chat/chat-files.ts putVersion): the newest version,
   * which every open and link of this id gives. `by` / `byName` saved it ("Updated by <name>"), `ai` when the AI did it
   * for them ("Trina for <name>"); `version` its number (the first file is 1). `size`, `mime`, `width`, `height` of the
   * attachment are the newest version's. Absent: never changed */
  updated: z.object({ by: z.string(), byName: z.string(), at: IsoTime, version: z.number().int().positive(), ai: z.literal(true).optional() }).optional(),
})
export type Attachment = z.infer<typeof Attachment>
/** One version of a chat file (server ChatFiles.versions: read {versions}, the web's history). Never a hash or a path. */
export const ChatFileVersion = z.object({
  id: Uuid7,
  /** 1 for the first file, then 2, 3 … (kept when older versions are pruned) */
  version: z.number().int().positive(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  createdAt: IsoTime,
  /** who saved it (user id) and their name now; `ai` when the AI saved it for them */
  by: z.string(),
  byName: z.string(),
  ai: z.literal(true).optional(),
  /** the newest version (what the chip and every link open) */
  head: z.literal(true).optional(),
})
export type ChatFileVersion = z.infer<typeof ChatFileVersion>
/** At most this many attachments (uploads and team files together) per message: 100, what one model request may hold
 * in pictures (a person attaches 60 photos and asks about all of them, docs/decisions/20261118-limits-images.md). */
export const MESSAGE_ATTACHMENTS_MAX = 100
/** At most this many characters of text per AI chat message (send and edit; both message boxes, the full chat's and
 * the side chat's, say so before sending, and a longer paste goes in as a text file: web/src/lib/longPaste.ts). */
export const MESSAGE_TEXT_MAX = 200_000

/** A next step under an AI step (Step.fixes): a line the server wrote, and one button that runs
 * POST /api/share-fixes/:id/run as the person. Names are people's display names as the server read them.
 * - let_view: `people` get view access to `file` (the person may share it). The list shown is the list granted.
 * - ask_owner: the file's owner (`owner`) is asked to share `file` with `count` people (their names only when the
 *   person asks for themselves or may see them).
 * - ask_admin: an admin (`owner`: their name) gets a message about the folder `file`.
 * - share_project: the app's own "Share with project members" flow for chat `chatId` opens (no server run).
 * `state`: open (the button shows), done (`doneCount` people; the line says what happened), gone (nothing left to do:
 * everyone can open it already, or the file or the room is gone). */
export const StepFixKind = z.enum(['let_view', 'ask_owner', 'ask_admin', 'share_project'])
export type StepFixKind = z.infer<typeof StepFixKind>
export const StepFix = z.object({
  id: z.string().max(64),
  kind: StepFixKind,
  /** the file's or the folder's name (one line), or the project's for share_project */
  file: z.string().max(200),
  /** more files of the same offer, when it is about several (the count beyond `file`) */
  moreFiles: z.number().int().min(0).optional(),
  /** where the people are, as the person sees it ("#Sales"); absent when the offer is not about a room */
  place: z.string().max(200).optional(),
  /** the first few people it is about, by name, and how many in all */
  people: z.array(z.string().max(120)).max(5).optional(),
  count: z.number().int().min(0),
  /** guests among the people who cannot open it: never given a file */
  guests: z.number().int().min(0).optional(),
  /** ask_admin: why an admin is asked. folder (or absent): a team folder only admins share; switch: the team turned off
   * members' file sharing (the admins are asked to turn it on) */
  reason: z.enum(['folder', 'switch']).optional(),
  /** who is asked: the file's owner, or the admin(s) */
  owner: z.string().max(200).optional(),
  chatId: z.string().max(64).optional(),
  state: z.enum(['open', 'done', 'gone']),
  doneCount: z.number().int().min(0).optional(),
  /** after let_view ran: people in the room who still cannot open it and were not on the list (they joined since) */
  left: z.number().int().min(0).optional(),
})
export type StepFix = z.infer<typeof StepFix>
/** POST /api/share-fixes/:id/run: what the offer became (the app keeps the rest of the line it showed) */
export const RunStepFixResult = z.object({ state: z.enum(['open', 'done', 'gone']), doneCount: z.number().int().min(0).optional(), left: z.number().int().min(0).optional() })
export type RunStepFixResult = z.infer<typeof RunStepFixResult>

/** Folders a my_folders step keeps for its card (Step.folders); the rest is a count (Step.moreFolders). */
export const MY_FOLDERS_MAX = 30

/** messages.steps[]: what the AI did ("파일 검색 중"). Shown as a collapsible list under the answer. */
export const StepKind = z.enum(['tool', 'thinking', 'web_search', 'browser', 'artifact', 'ask_user'])
export const Step = z.object({
  id: z.string().max(100),
  kind: StepKind,
  /** tool name as the engine saw it, e.g. "grep", "make_file", "WebSearch", "navigate" */
  tool: z.string().max(100).optional(),
  /** short human summary, e.g. 'grep "invoice" in finance/' (never raw tool input) */
  label: z.string().max(500),
  status: z.enum(['running', 'ok', 'error']),
  /** the step was still running when the answer paused at its per-answer time limit (Message.stopReason): it was cut
   * off, not failed, and "continue" picks the work up. status stays 'error' so apps without this field still show it
   * as not finished; absent on every other step */
  paused: z.literal(true).optional(),
  /** the step was still running when the person stopped the answer (Stop, like Claude Code's "Interrupted"): it was cut
   * off, not failed. status stays 'error' for apps without this field, as with `paused`; absent on every other step */
  stopped: z.literal(true).optional(),
  startedAt: IsoTime,
  endedAt: IsoTime.nullable(),
  /** optional longer result summary (e.g. search result titles), shown when expanded */
  detail: z.string().max(4000).optional(),
  /** web search cards */
  sources: z.array(z.object({ title: z.string(), url: z.string() })).max(50).optional(),
  /** a post_to_room step that posted (server/src/chat/post-to-room.ts): where the message went, for the step's 보기 (the
   * room at the message, or the thread at the reply), as the button's sent line has it */
  posted: z.object({
    roomId: Uuid7, messageId: Uuid7, threadRootId: Uuid7.optional(),
    /** what went, for the card: the message's first words (plain, one line) and the names of the files sent with it,
     * read from the posted message itself (never the AI's words about it) */
    preview: z.string().max(120).optional(),
    files: z.array(z.string().max(255)).max(10).optional(),
  }).optional(),
  /** a share_with_person or stop_sharing step: what it did, for its card (api/share-card.ts). Only for the person whose
   * turn it was; absent for every other viewer of a shared chat */
  shared: StepShared.optional(),
  /** a my_folders step (server/src/chat/my-folders.ts; docs/decisions/20261122-demo-permission-scene.md): the folders
   * the person's AI could see when it ran, each with its access, for the card "Folders your AI can see". Only folders
   * they can open, never one hidden from them; only the person whose turn it was gets it (ChatStore.viewSteps) */
  folders: z.array(z.object({ path: z.string().max(4096), access: z.enum(['edit', 'view']) })).max(MY_FOLDERS_MAX).optional(),
  /** how many more folders the person can open than `folders` lists */
  moreFolders: z.number().int().min(1).optional(),
  /** next steps the server offers under this step (server/src/files/share-fixes.ts; docs/decisions/
   * 20261116-ai-share-who-can-open.md): "3 people in #Sales can't open it yet" with one button. Written by the server
   * from its own records, never from the AI's text; only the person whose turn it was gets them */
  fixes: z.array(z.lazy(() => StepFix)).max(4).optional(),
  /** screenshot shared from the browser pane / pictures a tool saved and the chat shows itself (change_banner_text's
   * sizes, a saved connection picture): served via /api/files/download. `label`: words shown under the picture ("1080x1920") */
  images: z.array(z.object({ path: RelPath, alt: z.string().optional(), label: z.string().max(60).optional() })).max(20).optional(),
  /** a step a sub-agent took: the id of its sub-task step (tool 'agent'). Apps without this field show it in the flat
   * list (docs/DECISIONS.md "Sub-agents") */
  parentId: z.string().max(100).optional(),
  /** a remember or forget step that changed one of the person's memories (chat/tools.ts): which, how, its text and,
   * for a change, the text before, for the step's 되돌리기 (through the memory routes). Only for the person whose turn it
   * was (stripped for every other viewer, as `detail` is) */
  memory: z.object({
    id: z.string().max(64),
    change: z.enum(['created', 'updated', 'forgotten']),
    text: z.string().max(1000),
    before: z.string().max(1000).optional(),
    /** the first memory the AI kept on its own for this person: the step shows the one-time line under it */
    first: z.literal(true).optional(),
  }).optional(),
  /** a sub-task step (tool 'agent'): the sub-agent's tool calls and working time so far, and how many of its earliest
   * steps were not kept with the answer (`hidden`; the most recent ones are) */
  subtask: z.object({ toolUses: z.number().int().min(0).optional(), ms: z.number().int().min(0).optional(), hidden: z.number().int().min(0).optional() }).optional(),
  /** how much of the answer text (characters of Message.content) was written when the step started: an artifact's
   * card shows at that point of the answer. Absent on steps from before this field */
  textAt: z.number().int().min(0).optional(),
  /** box_shell on the srt runner (docs/DECISIONS.md "Dev environment: one queue"): the command or job waits in the team
   * queue. id: the queued run (POST /api/dev-env/runs/:id/stop cancels it); position: its place in line when the step
   * was written (the app reads the live place from GET /api/dev-env/runs); state: waiting, started, expired (the
   * command waited too long: the dev environment is full) or cancelled. A dev server (kind server, state started)
   * has the port the AI named: the step shows a Preview button for it (POST /api/dev-env/runs/:id/preview). Absent on
   * every other step */
  devEnvRun: z.object({
    id: z.string().max(64),
    kind: z.enum(['command', 'job', 'server']),
    state: z.enum(['waiting', 'started', 'expired', 'cancelled']),
    position: z.number().int().min(1).nullable(),
    /** project: the command waits for another command in the same project (no place in line, no Cancel; it holds no slot) */
    why: z.literal('project').optional(),
    port: z.number().int().min(1).max(65535).optional(),
  }).optional(),
  /** the AI's to-do list for this answer (todo_write, like Claude Code's TodoWrite): one step per answer, its list
   * replaced in place on each call and kept with the answer. Apps show it as a checklist card, not as a step line;
   * an app without this field shows the step's label only */
  todos: z.array(z.object({
    content: z.string().max(300),
    status: z.enum(['pending', 'in_progress', 'completed']),
    activeForm: z.string().max(300).optional(),
  })).max(50).optional(),
})
export type Step = z.infer<typeof Step>

/** "파일 3개 저장 · 1개 충돌 사본 · 1개 권한 없음" under an answer (from file_events of the turn). Files only: a folder the
 * answer made or moved is not one. `moved`: a file the answer moved here (`action` 'create', so an older app still shows
 * it as new). */
export const FileChangeSummary = z.object({
  saved: z.array(z.object({ path: RelPath, action: z.enum(['create', 'update']), moved: z.literal(true).optional() })),
  conflicts: z.array(z.object({ path: RelPath, copyPath: RelPath })),
  rejected: z.array(z.object({ path: z.string(), reason: z.string() })),
  /** an answer that saved more files than the list keeps (FILE_SUMMARY_LIST_MAX): the rest, as a count per folder
   * (the files' parent folders; `count` is their sum). An app without this field shows the list's length. */
  more: z.object({
    count: z.number().int().nonnegative(),
    folders: z.array(z.object({ path: RelPath, count: z.number().int().positive() })).max(2000),
  }).optional(),
})
export type FileChangeSummary = z.infer<typeof FileChangeSummary>
/** files an answer's summary lists one by one; the rest are counted by folder (FileChangeSummary.more) */
export const FILE_SUMMARY_LIST_MAX = 100

/**
 * Where in a file a passage is (docs/DECISIONS.md "Sources under each answer"): a PDF page (1-based, as a PDF viewer
 * counts), a spreadsheet sheet with the A1 range of the rows, a slide (its number in the show order, hidden slides
 * counted, as PowerPoint numbers them), or the heading of a Word / Hangul section. Absent when it is not known.
 */
export const SourceLoc = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), page: z.number().int().positive() }),
  z.object({ kind: z.literal('sheet'), sheet: z.string().max(200), range: z.string().regex(/^[A-Z]{1,3}\d{1,7}(?::[A-Z]{1,3}\d{1,7})?$/).optional() }),
  z.object({ kind: z.literal('slide'), slide: z.number().int().positive() }),
  z.object({ kind: z.literal('heading'), heading: z.string().max(200) }),
])
export type SourceLoc = z.infer<typeof SourceLoc>

/** One file of an answer's "참고한 파일" list (GET /api/chats/:id/messages/:messageId/sources), as the viewer may see it
 * now: the AI read it, or saw passages of it in search / grep results, while it wrote the answer. */
export const MessageSourceFile = z.object({
  path: RelPath,
  name: z.string(),
  /** places the AI looked at (pages, sheets, slides, sections), at most 20; empty: the file as a whole */
  locs: z.array(SourceLoc).max(20),
  /** how: 'read' (the read tool), 'search' (passages of a removed search tool, in older answers), 'grep' (matching
   * lines) */
  via: z.array(z.enum(['read', 'search', 'grep'])).min(1),
  /** a sub-agent of the answer (not the main AI) opened it; absent: the main AI did */
  subagent: z.literal(true).optional(),
})
export type MessageSourceFile = z.infer<typeof MessageSourceFile>
export const MessageSources = z.object({
  files: z.array(MessageSourceFile),
  /** files the viewer may not open now (access taken away, deleted, moved): counted only, no name or path */
  unavailable: z.number().int().nonnegative(),
})
export type MessageSources = z.infer<typeof MessageSources>

export const MessageStatus = z.enum(['streaming', 'done', 'error', 'stopped'])
export type MessageStatus = z.infer<typeof MessageStatus>
/** Why a finished answer ended before the AI was done: it reached the per-answer limit of tool calls (`tool_limit`,
 * Claude Code --max-turns, Admin > Team settings `answerStepLimit`, default 500, the API engine's rounds too), or, for
 * answers from before 2026-11-14, the old limit of working time (`time_limit`, 20 active minutes or 45 in total; one
 * answer has no time limit since then, docs/DECISIONS.md "No time limit on one answer"). Its status stays 'done': not
 * an error, not a stop by the person; the screen offers "continue". */
export const TurnStopReason = z.enum(['tool_limit', 'time_limit'])
export type TurnStopReason = z.infer<typeof TurnStopReason>
export const Usage = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative() })
export type Usage = z.infer<typeof Usage>

/**
 * messages. Conversations are trees: editing a user message or regenerating an answer adds a sibling with the
 * same parentId; the chat shows one path (chats.active_leaf_id). `branch` lets the UI show "< 2/3 >".
 */
/** The talk under an AI answer of a shared chat (docs/decisions/20261116-chat-answer-threads.md), as I see it: how many
 * replies, the time of the last one, up to 3 people who replied (the latest first) and whether a thread I follow (I
 * asked the answer or replied) has a reply I have not read. The rooms' RoomThreadSummary, for chats. */
export const ChatThreadSummary = z.object({
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: IsoTime.nullable(),
  repliers: z.array(UserRef),
  newReplies: z.boolean(),
})
export type ChatThreadSummary = z.infer<typeof ChatThreadSummary>
/** One reply under an answer of a shared chat: people's words only (the AI never writes or reads these). `author` null:
 * an account that is gone and has no tombstone name. */
export const ChatThreadReply = z.object({
  id: Uuid7,
  chatId: Uuid7,
  rootId: Uuid7,
  author: UserRef.nullable(),
  /** plain text; links are made clickable by the app, nothing else is formatted */
  content: z.string(),
  /** the people it mentions by "@name" (ids; docs/decisions/20261118-chat-thread-mentions.md): only people who saw the
   * thread when it was sent. Older servers omit it */
  mentions: z.array(UserId).optional(),
  createdAt: IsoTime,
  /** I may delete it: my own, or I may moderate the chat (its creator; a project editor for a project chat) */
  canDelete: z.boolean(),
})
export type ChatThreadReply = z.infer<typeof ChatThreadReply>

export const Message = z.object({
  id: Uuid7,
  chatId: Uuid7,
  parentId: Uuid7.nullable(),
  role: z.enum(['user', 'assistant']),
  author: UserRef.nullable(),
  /** markdown; for a streaming answer, the text saved so far (deltas continue from content.length) */
  content: z.string(),
  attachments: z.array(Attachment),
  steps: z.array(Step),
  status: MessageStatus,
  error: ApiErrorBody.nullable(),
  turnId: Uuid7.nullable(),
  engine: EngineId.nullable(),
  model: z.string().nullable(),
  files: FileChangeSummary.nullable(),
  usage: Usage.nullable(),
  createdAt: IsoTime,
  branch: z.object({ index: z.number().int().nonnegative(), count: z.number().int().positive(), siblingIds: z.array(Uuid7) }),
  /** answers only: the answer paused at a per-answer limit (TurnStopReason); absent or null: it ended normally */
  stopReason: TurnStopReason.nullable().optional(),
  /** an answer stopped because its requester's account was deleted ('requester_removed') or switched off
   * ('requester_disabled'): who, by name, so the people still in a shared chat read why it stopped (QA TC-7431;
   * messages.stopped_for, migration 435). Absent: any other end. */
  stoppedFor: z.object({ reason: z.enum(['requester_removed', 'requester_disabled']), name: z.string() }).optional(),
  /** answers only: the AI got only the recent part of this conversation (the history a fresh engine session gets is
   * cut at 40,000 characters, and a session resumed from such a start keeps that); absent: all of it */
  historyTrimmed: z.boolean().optional(),
  /** answers only, with historyTrimmed: the cut came from the team's AI model, whose context holds only a short
   * conversation (server/src/chat/history-fit.ts), not from a long chat */
  historySmallModel: z.literal(true).optional(),
  /** finished answers only: how many team files the AI read or saw passages of while writing it ("참고한 파일 N개");
   * the list itself, checked against the viewer's access, comes from GET .../messages/:messageId/sources. Absent: none */
  sourceCount: z.number().int().positive().optional(),
  /** finished answers that ran a team skill ("/name", a form or the skill tool): the skill as recorded, and how many
   * team files went into it (team-file references of the question and files read, outside personal folders and
   * skills/). The step summary then reads "팀 스킬 '할 일 정리' · 팀 파일 2개". Absent: no team skill ran. `by`: who made the
   * skill (its file's first version), when that is someone else than the person who asked and not a starter pack's
   * text: "김지훈님의 팀 스킬 '견적서 쓰기' · 팀 파일 1개" */
  receipt: z.object({ skill: z.object({ path: z.string(), name: z.string(), by: z.string().optional() }), teamFiles: z.number().int().nonnegative() }).optional(),
  /** a shared project chat's answer hidden from me (docs/DECISIONS.md "People who see a shared chat later"): it used
   * something I cannot open, and I did not see the chat when it did. Shown as one line in its place: content is '' and
   * nothing of it comes (no steps, files, sources, artifacts, model or error); its place in the branch stays. Never on
   * an answer of my own question */
  withheld: z.literal(true).optional(),
  /** a finished answer of a shared chat with replies under it that I may see: the thread's summary (absent: none) */
  thread: ChatThreadSummary.optional(),
  /** questions only: this message is the person's answer on the AI's cards (its questions, a website, a delete, a
   * share: chat/open-questions.ts), picked with the cards' buttons, not typed. Each card's choice in words, null for
   * Skip. The apps show it as one quiet line under the answer that asked, never as a message the person wrote.
   * `hidden`: a shared chat where the cards' words are hidden (their answer used what not everyone may read): the line
   * says only that they answered, and `choices` is empty. Absent: the person's own words */
  cardAnswer: z.object({ choices: z.array(z.string().nullable()), hidden: z.literal(true).optional() }).optional(),
})
export type Message = z.infer<typeof Message>

// ---------------- artifacts, memories ----------------
export const ArtifactType = z.enum(['html', 'react', 'svg', 'mermaid', 'markdown', 'code'])
export type ArtifactType = z.infer<typeof ArtifactType>
/** artifacts: one row per version; `key` groups the versions of one artifact in a chat. */
export const Artifact = z.object({
  id: Uuid7,
  chatId: Uuid7,
  messageId: Uuid7.nullable(),
  key: z.string(),
  version: z.number().int().positive(),
  type: ArtifactType,
  title: z.string().nullable(),
  language: z.string().nullable(),
  content: z.string(),
  createdAt: IsoTime,
})
export type Artifact = z.infer<typeof Artifact>
export const ArtifactSummary = Artifact.omit({ content: true }).extend({ size: z.number().int().nonnegative() })
export type ArtifactSummary = z.infer<typeof ArtifactSummary>

export const Memory = z.object({
  id: Uuid7,
  text: z.string(),
  sourceChatId: Uuid7.nullable(),
  createdAt: IsoTime,
  /** in the person's own list only: the AI does not get this memory now (it gets the newest that fit; older ones are
   * kept, listed and marked, QA TC-213). Absent: in use, or not said */
  unused: z.literal(true).optional(),
})
export type Memory = z.infer<typeof Memory>

// ---------------- turns, jobs ----------------
export const TurnStatus = z.enum(['queued', 'running', 'done', 'error', 'stopped', 'interrupted'])
export const Turn = z.object({
  id: Uuid7,
  chatId: Uuid7,
  userId: UserId,
  messageId: Uuid7.nullable(),
  engine: z.string(),
  model: z.string().nullable(),
  status: TurnStatus,
  startedAt: IsoTime,
  endedAt: IsoTime.nullable(),
  usage: Usage,
})
export type Turn = z.infer<typeof Turn>

export const JobKind = z.enum(['transcribe', 'backup', 'restore', 'update', 'export'])
export type JobKind = z.infer<typeof JobKind>
export const JobStatus = z.enum(['queued', 'running', 'done', 'failed', 'canceled'])
export type JobStatus = z.infer<typeof JobStatus>
export const TranscribeResult = z.object({
  text: z.string(),
  language: z.string().nullable(),
  durationSec: z.number().nonnegative().nullable(),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })).optional(),
})
export type TranscribeResult = z.infer<typeof TranscribeResult>
export const BackupResult = z.object({ backupId: z.string(), size: z.number().int().nonnegative(), createdAt: IsoTime })
export const RestoreResult = z.object({ backupId: z.string(), restoredAt: IsoTime, lostSince: IsoTime.nullable() })
export const UpdateResult = z.object({ fromVersion: z.string(), toVersion: z.string(), rolledBack: z.boolean() })
export const ExportResult = z.object({ path: RelPath, size: z.number().int().nonnegative() })
/** A member's own export (Settings › Export, POST /api/me/export): `download` is where its maker gets the ZIP, for 24
 * hours; `chats` how many chats it holds. */
export const MyExportResult = z.object({ download: z.string().regex(/^\/api\/me\/export\/[0-9a-f-]{36}\/download$/), size: z.number().int().nonnegative(), chats: z.number().int().nonnegative() })
export type MyExportResult = z.infer<typeof MyExportResult>
export const JobResult = z.union([TranscribeResult, BackupResult, RestoreResult, UpdateResult, ExportResult, MyExportResult])
export const Job = z.object({
  id: Uuid7,
  kind: JobKind,
  status: JobStatus,
  /** 0..1, null while unknown */
  progress: z.number().min(0).max(1).nullable(),
  /** short human status line ("모델 내려받는 중") */
  message: z.string().nullable(),
  result: JobResult.nullable(),
  error: ApiErrorBody.nullable(),
  createdAt: IsoTime,
  finishedAt: IsoTime.nullable(),
})
export type Job = z.infer<typeof Job>

// ---------------- files ----------------
export const FileEntry = z.object({
  name: z.string(),
  path: RelPath,
  type: z.enum(['file', 'folder']),
  /** bytes; null for folders */
  size: z.number().int().nonnegative().nullable(),
  mtime: IsoTime,
  mime: z.string().nullable(),
  /** the caller's access (folders shown only for navigation have 'none' and are greyed out) */
  access: Access,
  /** a download-only file (generated output Safe operations 1A quarantined, docs/SAFE-OPS-1A.md): it can be downloaded,
   * but the AI cannot read it and in-app previews are off, so "Ask AI" and "add to chat" are not offered. Absent on
   * every other entry (and from servers before this field) */
  downloadOnly: z.literal(true).optional(),
  /** a folder the caller may write that they still may not rename, move or put in the trash (file listings only,
   * GET /api/files/tree): 'admin' only the owner or an admin may (a group, project or rule folder, shared/, skills/, or
   * one holding such a folder; never sent to the owner or an admin), 'always' nobody may (a personal folder, a folder
   * holding a plugin's managed folder). Absent everywhere else and from older servers: the server still decides. */
  fixed: z.enum(['admin', 'always']).optional(),
  /** an upload's answer only: the name already held this person's own upload of this very file (the last 24 hours), so
   * that file was kept and nothing new was made (keepSame). Find work files' Undo takes back only files a run made
   * (docs/DECISIONS.md "Find work files on this computer"). Absent on every other entry and from older servers. */
  kept: z.literal(true).optional(),
  /** in a listing of the caller's OWN files only (docs/decisions/20261116-folder-share-server.md): 'own' the entry has
   * people of its own on it, 'through' a folder above it is shared. Absent everywhere else and from older servers. */
  shared: z.enum(['own', 'through']).optional(),
})
export type FileEntry = z.infer<typeof FileEntry>

/** file_versions */
export const FileVersion = z.object({
  id: Uuid7,
  path: RelPath,
  version: z.number().int().positive(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  /** the person whose save REPLACED this content (and stored it as a version); kept for older clients */
  author: UserRef.nullable(),
  /** the AI turn of that replacing save */
  turnId: Uuid7.nullable(),
  kind: z.enum(['edit', 'conflict_copy', 'restore']),
  conflictPath: RelPath.nullable(),
  createdAt: IsoTime,
  /** the person whose save PRODUCED this content (null: not known, e.g. versions stored before this was recorded;
   * then only `author`, "replaced by", is known) */
  savedBy: UserRef.nullable().optional(),
  /** the AI turn of the save that produced this content (null: not during an AI answer, or not known) */
  savedTurnId: Uuid7.nullable().optional(),
  /** the AI chat of `savedTurnId` (the version history's "Open the chat"), only when the caller may open that chat now
   * (server/src/chat/version-chats.ts). Absent otherwise: someone else's chat, one in the trash or gone, a confidential
   * chat that is not theirs, an answer hidden from them in a shared chat, a room's AI, and older servers. */
  savedChatId: Uuid7.optional(),
})
export type FileVersion = z.infer<typeof FileVersion>

/** One change in a file's history (GET /api/files/history `events`), newest first. Read from file_events, following
 * moves and renames back to earlier paths. */
export const FileHistoryEvent = z.object({
  id: z.number().int(),
  at: IsoTime,
  kind: z.enum(['created', 'edited', 'uploaded', 'restored', 'moved', 'renamed', 'copied', 'conflict']),
  by: UserRef.nullable(),
  /** the AI turn it happened in (null: a person on the file screen) */
  turnId: Uuid7.nullable(),
  /** the file's path just after the change */
  path: RelPath,
  /** moved / renamed: the path before; copied: the source; restored from the trash: the original path.
   * null also when the caller may not read that path. */
  from: RelPath.nullable(),
  size: z.number().int().nonnegative().nullable(),
})
export type FileHistoryEvent = z.infer<typeof FileHistoryEvent>

/** trash_items (30 days; restore needs write access to the original path) */
export const TrashItem = z.object({
  id: Uuid7,
  originalPath: RelPath,
  size: z.number().int().nonnegative(),
  deletedBy: UserRef.nullable(),
  turnId: Uuid7.nullable(),
  deletedAt: IsoTime,
  purgeAt: IsoTime,
  /** a whole folder was deleted (restored as one); absent = file */
  type: z.enum(['file', 'folder']).optional(),
  /** a team project's own folder, which went to the trash with its project: the project's name and id, so Files › Trash
   * shows it as the project (docs/DECISIONS.md "A team project in the trash: its members keep its card"). Absent: any
   * other item, an older server. */
  project: z.object({ id: Uuid7, name: z.string() }).optional(),
})
export type TrashItem = z.infer<typeof TrashItem>

/** upload_sessions */
export const UploadTarget = z.discriminatedUnion('kind', [
  /** a file in the team folder (full path including the name); write access checked at create and at complete */
  z.object({ kind: z.literal('path'), path: RelPath, onExists: z.enum(['fail', 'replace', 'rename']).default('rename') }),
  /** a chat attachment, stored in users/<me>/.attachments/<chatId>/ */
  z.object({ kind: z.literal('attachment'), chatId: Uuid7, name: z.string().min(1).max(255) }),
  /** audio for transcription (not kept in the team folder); chatId as in TranscribeFields */
  z.object({ kind: z.literal('transcribe'), name: z.string().min(1).max(255), chatId: Uuid7.optional() }),
  /** a file to send in a room the caller is in (at most ROOM_FILE_MAX): kept as their unsent upload there, like
   * POST /api/rooms/:id/files; membership checked at create and at complete */
  z.object({ kind: z.literal('room'), roomId: Uuid7, name: z.string().min(1).max(255) }),
])
export type UploadTarget = z.infer<typeof UploadTarget>
export const UploadSession = z.object({
  id: Uuid7,
  target: UploadTarget,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  chunkSize: z.number().int().positive(),
  chunkCount: z.number().int().nonnegative(),
  /** chunk numbers (0-based) already stored */
  received: z.array(z.number().int().nonnegative()),
  expiresAt: IsoTime,
})
export type UploadSession = z.infer<typeof UploadSession>

// ---------------- admin data ----------------
export const EngineAccount = z.object({
  id: Uuid7,
  engine: z.enum(['anthropic', 'openai']),
  label: z.string().nullable(),
  status: z.enum(['ok', 'invalid']),
  checkedAt: IsoTime.nullable(),
  /** last 4 characters of the key, for recognition */
  hint: z.string().nullable(),
})
export type EngineAccount = z.infer<typeof EngineAccount>

export const Budget = z.object({
  id: Uuid7,
  subjectType: z.enum(['team', 'group', 'user']),
  subjectId: z.string().nullable(),
  period: z.enum(['day', 'month']),
  limitUsd: z.number().nonnegative(),
  limitTokens: z.number().int().nonnegative().nullable(),
  action: z.enum(['warn', 'block']),
  /** spent in the current period */
  usedUsd: z.number().nonnegative(),
  usedTokens: z.number().int().nonnegative(),
})
export type Budget = z.infer<typeof Budget>

/** audit_log (admin actions) and file_events (file changes) in one list for the admin screen. */
export const AuditEntry = z.object({
  id: z.string(),
  source: z.enum(['admin', 'file', 'tool', 'auth']),
  at: IsoTime,
  actor: UserRef.nullable(),
  action: z.string(),
  target: z.string().nullable(),
  turnId: Uuid7.nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
})
export type AuditEntry = z.infer<typeof AuditEntry>

/** Voice input (speech to text): off (default), OpenRouter's speech-to-text API with the team's key (cloud), or
 * whisper.cpp on this server (private, slow on small servers). docs/DECISIONS.md "Voice input through OpenRouter". */
export const SpeechProvider = z.enum(['off', 'openrouter', 'local'])
export type SpeechProvider = z.infer<typeof SpeechProvider>
export const DEFAULT_SPEECH_MODEL = 'openai/whisper-large-v3-turbo'
/** The least a server needs to turn sound into text itself by default (whisper.cpp next to the AI, voice input and
 * other reads): 4 CPU cores and 8 GB of memory (the owner, 2026-11-19). A 2 vCPU box took 1.5-1.9 s for each second
 * of speech (QA 2026-11-01). The memory floor is a little under 8 GiB: an "8 GB" machine reports less. */
export const LOCAL_SPEECH_MIN_CORES = 4
export const LOCAL_SPEECH_MIN_MEMORY = 7.5 * 1024 ** 3
/** whether a server with `cpuCores` and `memoryBytes` is big enough for local speech-to-text by default */
export const localSpeechBigEnough = (cpuCores: number, memoryBytes: number): boolean =>
  cpuCores >= LOCAL_SPEECH_MIN_CORES && memoryBytes >= LOCAL_SPEECH_MIN_MEMORY
/** Where the server runs, for the default of "Turn video sound into text": `hosted` (the hosting service's server, a
 * plan), `hostedKey` (OpenRouter goes with the hosting service's speech key: the plan's hours), `mac` (an Apple silicon
 * Mac that runs whisper.cpp on its GPU), `bigEnough` (localSpeechBigEnough). */
export interface MediaTranscriptsHost { hosted: boolean; hostedKey: boolean; mac: boolean; bigEnough: boolean }
/** "Turn video sound into text" (TeamSettings.aiMediaTranscripts) when the admin has not chosen (the owner and the
 * coordinator, 2026-11-19; docs/decisions/20261119-speech-defaults-no-cap.md): for "this server" (the sound stays
 * here) on when hosted, on a Mac or on a server with at least 4 CPU cores and 8 GB (a self-installed Linux server, the
 * Docker image), off on a smaller one (too slow; frames still go); for OpenRouter on only with the hosting service's key
 * (the plan's hours), off with the team's own key anywhere, hosted too (team files' sound would go to a third party at
 * the team's cost without anyone picking that). An admin's choice always wins. The one place this default lives. */
export const mediaTranscriptsDefault = (provider: SpeechProvider, host: MediaTranscriptsHost): boolean =>
  provider === 'local' ? host.hosted || host.mac || host.bigEnough : provider === 'openrouter' && host.hostedKey
/** whether the default is off only because this server is too small for local speech (the read and the settings switch say so) */
export const mediaTranscriptsOffSmall = (provider: SpeechProvider, host: MediaTranscriptsHost): boolean =>
  provider === 'local' && !mediaTranscriptsDefault(provider, host)
/** whether AI reads of video and audio files transcribe their sound: never with voice input off */
export const mediaTranscriptsOn = (s: { speechProvider: SpeechProvider; aiMediaTranscripts: boolean | null }, host: MediaTranscriptsHost): boolean =>
  s.speechProvider !== 'off' && (s.aiMediaTranscripts ?? mediaTranscriptsDefault(s.speechProvider, host))
/** an OpenRouter model id: "<vendor>/<model>" */
export const SpeechModel = z.string().max(128).regex(/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/)

/** Tool rounds one answer may take (Claude Code `--max-turns`; Admin > Team settings `answerStepLimit`). A round is one
 * reply of the AI: tools it calls together in one reply count once. Claude Code itself has no such cap; with
 * the budgets it is what ends a long answer (one answer has no time limit). docs/DECISIONS.md "Tool rounds per answer". */
export const DEFAULT_ANSWER_STEP_LIMIT = 500
/** a guest's answers take at most this many rounds, whatever the team setting (the default before 2026-11-18;
 * docs/decisions/20261118-limits-caps.md) */
export const GUEST_ANSWER_STEP_LIMIT = 150
/** an answer nobody watches (a scheduled run, a run asked from Slack) takes at most this many rounds: nobody can stop a
 * long run there (docs/decisions/20261118-limits-caps.md) */
export const UNATTENDED_ANSWER_STEP_LIMIT = 150
export const ANSWER_STEP_LIMIT_MIN = 10
export const ANSWER_STEP_LIMIT_MAX = 2000

/** settings (team-level, key/value json in the DB). */
export const TeamSettings = z.object({
  /** 1-100 characters on a self-installed server. A hosted server takes only a name the hosting service takes
   * (cloud-protocol/team-name.ts teamNameProblem: 1-60 characters, no hidden characters), checked by the server when
   * the name changes (system/cloud-team-name.ts hostedTeamName); a name kept from before stays readable here. */
  teamName: z.string().min(1).max(100),
  defaultLocale: Locale,
  defaultEngine: EngineId,
  defaultModel: z.string().nullable(),
  /** turns running at the same time across the team */
  concurrency: z.number().int().min(1).max(16),
  updateChannel: z.enum(['stable', 'beta']),
  /** when updates may install automatically: "HH:mm-HH:mm" in the team time zone; null = default 03:00-05:00 */
  updateWindow: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/).nullable(),
  auditRetentionDays: z.number().int().min(7).max(3650),
  fileHistoryRetentionDays: z.number().int().min(1).max(3650),
  trashRetentionDays: z.number().int().min(1).max(365),
  chatTrashRetentionDays: z.number().int().min(1).max(365),
  /** the team's time zone (IANA, e.g. Asia/Seoul): "today" / "this month" of budgets and usage, schedules, the nightly
   * backup. Changing it moves the current day / month boundaries (the data stays). */
  timeZone: z.string().min(1).max(64).refine((tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false } }, 'unknown time zone'),
  /** people may turn on "Allow all websites" in the desktop app's in-app browser (default on). Off: the desktop app
   * refuses it and turns it back to "ask for each new site" for anyone who had it on. */
  browserAllowAll: z.boolean(),
  /** "Allow all websites" also covers the AI's web reads (default on, the owner's call 2026-11-11; docs/DECISIONS.md
   * "Allow all websites covers the AI's web reads"): members may turn on their own switch, which lets the AI open
   * ordinary public addresses without the address card when they ask (chats and rooms). Works only while browserAllowAll
   * is on too.
   * Off: nobody's switch works, and turning it off turns everyone's off. */
  webAllowAll: z.boolean(),
  /** members may add their own external-service connections (Settings > External services; default on). Off: none can
   * be added and the ones there are left out of chats (team connections are not affected). */
  personalIntegrations: z.boolean(),
  /** "Apps on your computer" (default on; docs/decisions/20261118-local-app-connectors.md): members may connect a
   * program on their own computer (Aside, ego lite ...) that the desktop app runs for the AI. Off: none can be added
   * and the ones there are left out of chats. Needs personalIntegrations too (they are personal connections). Older
   * servers omit it. */
  localApps: z.boolean().optional(),
  /** "팀 추천" (docs/decisions/20261120-team-vs-personal-onboarding.md, shared/src/api/team-tools.ts): the tools an owner
   * or admin recommends, first in each person's Settings › Connectors. Gates nothing. Absent (every team before it, an
   * older server) or empty: none. */
  recommendedTools: RecommendedTools.optional(),
  /** "Send images, PDF pages and video frames to the AI" (default on): an AI read of a photo, screenshot, scanned PDF
   * page or video gives the model the image (like Claude Code). Off: no pixels go to the provider; a Mac server reads
   * the text with Apple Vision instead, a Linux server says the image is not shown. */
  aiVision: z.boolean(),
  /** "Let the AI split work into sub-tasks" (default on): Claude Code's Agent tool, like Claude Code. Sub-agents have the
   * same tools as the AI (minus asking the person, memories, the chat title, schedules, video and the browser) and the
   * same person's access. Off: the AI does everything itself (docs/DECISIONS.md "Sub-agents") */
  aiSubagents: z.boolean(),
  /** "'항상 허용' 쓰기" (default on): the AI's confirmation cards offer "Always allow" (docs/DECISIONS.md "Always allow on
   * every card", server/src/chat/always-allow.ts; before 2026-11-13 only a room's change card, "대화방에서 새 파일은 미리
   * 허용"). Off: no card offers it and the choices people made are ignored (kept: they count again when it is turned
   * back on) */
  roomAlwaysAllow: z.boolean(),
  /** "Members can share files they own" (default on; docs/DECISIONS.md "A member shares their own files"): a member's
   * Share on a file of theirs, and access requests to members. Off: members cannot add people or be asked; the shares
   * already made keep working until removed. The team owner and admins share team files either way. */
  memberFileShares: z.boolean(),
  /** who may make team projects (a new projects/<name> folder with the people they choose; docs/DECISIONS.md "Projects
   * live only in projects/"): 'members' (default: anyone, like a chat channel) or 'admins' (the owner and admins only).
   * Personal projects are never limited. */
  projectCreators: z.enum(['members', 'admins']),
  /** the largest file a guest may upload: in a room, to their project's folder, to an AI chat (GUEST_FILE_MAX; default
   * 100 MB, at most 1 GB; docs/decisions/20261116-guest-room-file-limit.md, 20261116-room-file-limit-1gb.md). Members
   * are not held to it. */
  guestFileMax: z.enum(['100mb', '1gb']),
  /** "Show what the team often asks" (default on; docs/DECISIONS.md "Home: what my group often asks"): Home lists
   * generic questions that 3 or more people of a group or the team asked, rewritten once a day on the owner's AI. Off:
   * the lists are deleted for everyone, no run starts, and questions sent while it is off never count. */
  oftenAsked: z.boolean(),
  /** tool rounds per answer (Claude Code `--max-turns`, default 150): at the limit the answer pauses and "continue" goes
   * on. Sub-agents keep their own 50 rounds each; the API engine keeps its own 30 */
  answerStepLimit: z.number().int().min(ANSWER_STEP_LIMIT_MIN).max(ANSWER_STEP_LIMIT_MAX),
  /** voice input: 'off' (default; 'openrouter' while not chosen and there is the hosting service's key or the team's own
   * OpenRouter key) | 'openrouter' (the team's OpenRouter key, Admin > Team settings, else the hosting service's) |
   * 'local' (whisper.cpp here; voice input needs whisper-cli and ffmpeg on the server) */
  speechProvider: SpeechProvider,
  /** the OpenRouter speech-to-text model */
  speechModel: SpeechModel,
  /** "Turn video sound into text": AI reads of video and audio files transcribe the sound with the speech provider.
   * null = not chosen: mediaTranscriptsDefault (OpenRouter: on only with the hosting key; this server: on when hosted,
   * on a Mac or with 4 cores and 8 GB, off otherwise). A change of speechProvider
   * puts it back to null, so a choice made for one provider never sends sound to another. */
  aiMediaTranscripts: z.boolean().nullable(),
  /** how long the company intro deck may take (docs/DECISIONS.md "D2", round 2; server/src/intro-deck/tiers.ts):
   * quick ≈ 3 min, standard ≈ 5 min (the default, DEFAULT_DECK_TIER: more of the site, sourced web facts), deep ≈ 10 min
   * (more again, the strongest model, two reviews). Owners and admins choose it. */
  introDeckTier: z.enum(['quick', 'standard', 'deep']),
})
export type TeamSettings = z.infer<typeof TeamSettings>
