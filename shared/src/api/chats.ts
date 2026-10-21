// Chats, messages, turn control, projects, ask_user answers. Owner: B (server/src/routes/chats.ts).
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { EngineId, IsoTime, PageQuery, QueryBool, RelPath, page } from './common'
import { endpoint, empty } from './endpoint'
import { Chat, Message, Project } from './entities'
import { TurnRequest } from './ws'

// ---------------- chats ----------------
export const ListChatsQuery = PageQuery.extend({
  /** title / message text search */
  q: z.string().max(200).optional(),
  projectId: Uuid7.optional(),
  /** list the chat trash (deleted within 7 days) instead */
  trash: QueryBool.optional(),
})
export const CreateChatBody = z.object({
  projectId: Uuid7.nullable().optional(),
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
export const DeletedChat = z.object({ id: Uuid7, deletedAt: IsoTime, purgeAt: IsoTime })

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
  /** 0 = running now, n = n turns ahead in the queue */
  queuePosition: z.number().int().nonnegative(),
})
export type TurnStarted = z.infer<typeof TurnStarted>

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
export const TurnAnswerBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ask_user'),
    requestId: z.string().min(1).max(100),
    /** null = skipped */
    answer: z.union([z.string().max(10_000), z.array(z.string().max(1000)).max(20)]).nullable(),
  }),
  z.object({
    kind: z.literal('browser_site'),
    requestId: z.string().min(1).max(100),
    decision: z.enum(['once', 'always', 'deny']),
  }),
])
export type TurnAnswerBody = z.infer<typeof TurnAnswerBody>
/** Cards still waiting for an answer in this chat (after a reload / resync the client shows them again).
 * browser_site requests are listed only for the window that sent the turn (X-Mycel-Window). */
export const OpenTurnRequest = z.object({ turnId: Uuid7, chatId: Uuid7, messageId: Uuid7, request: TurnRequest })
export type OpenTurnRequest = z.infer<typeof OpenTurnRequest>

// ---------------- projects ----------------
export const CreateProjectBody = z.object({
  name: z.string().trim().min(1).max(100),
  folderPath: RelPath,
  instructions: z.string().max(50_000).default(''),
})
/** Creator or admin+ only. folderPath: admin or owner only, never under users/ (a personal project is shared by copy). */
export const UpdateProjectBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  folderPath: RelPath.optional(),
  instructions: z.string().max(50_000).optional(),
})

export const CHATS = {
  listChats: endpoint({ method: 'GET', path: '/api/chats', auth: 'user', owner: 'B', query: ListChatsQuery, response: page(Chat), summary: 'Own chats, newest first (search with q, trash with trash=1).' }),
  createChat: endpoint({ method: 'POST', path: '/api/chats', auth: 'user', owner: 'B', status: 201, body: CreateChatBody, response: Chat, summary: 'New empty chat (optionally inside a project).' }),
  getChat: endpoint({ method: 'GET', path: '/api/chats/:id', auth: 'user', owner: 'B', response: Chat, summary: 'One own chat.' }),
  updateChat: endpoint({ method: 'PATCH', path: '/api/chats/:id', auth: 'user', owner: 'B', body: UpdateChatBody, response: Chat, summary: 'Rename, move to a project, change engine/model.' }),
  deleteChat: endpoint({ method: 'DELETE', path: '/api/chats/:id', auth: 'user', owner: 'B', response: DeletedChat, summary: 'Move to chat trash (purged after 7 days). Stops a running turn.' }),
  restoreChat: endpoint({ method: 'POST', path: '/api/chats/:id/restore', auth: 'user', owner: 'B', response: Chat, summary: 'Bring a chat back from the trash.' }),
  listMessages: endpoint({ method: 'GET', path: '/api/chats/:id/messages', auth: 'user', owner: 'B', query: ListMessagesQuery, response: MessagesPage, summary: 'Active branch of the conversation, paged backwards.' }),
  sendMessage: endpoint({ method: 'POST', path: '/api/chats/:id/messages', auth: 'user', owner: 'B', status: 202, body: SendMessageBody, response: TurnStarted, summary: 'Save the message, create the empty answer, queue the turn. Send the X-Mycel-Window header so browser tools reach this window.' }),
  stop: endpoint({ method: 'POST', path: '/api/chats/:id/stop', auth: 'user', owner: 'B', response: StopResponse, summary: 'Stop the running or queued turn of this chat.' }),
  regenerate: endpoint({ method: 'POST', path: '/api/chats/:id/messages/:messageId/regenerate', auth: 'user', owner: 'B', status: 202, body: RegenerateBody, response: TurnStarted, summary: 'New answer to the same user message (sibling of :messageId, an assistant message).' }),
  editMessage: endpoint({ method: 'POST', path: '/api/chats/:id/messages/:messageId/edit', auth: 'user', owner: 'B', status: 202, body: EditMessageBody, response: TurnStarted, summary: 'Edited copy of user message :messageId as a new branch, then answer it.' }),
  selectBranch: endpoint({ method: 'POST', path: '/api/chats/:id/branch', auth: 'user', owner: 'B', body: SelectBranchBody, response: MessagesPage, summary: 'Switch the visible branch ("< 2/3 >"); returns the newest page of the new path.' }),
  listTurnRequests: endpoint({ method: 'GET', path: '/api/chats/:id/requests', auth: 'user', owner: 'B', response: z.object({ items: z.array(OpenTurnRequest) }), summary: 'Open ask_user / browser site cards of the running turn of this chat.' }),
  answerTurn: endpoint({ method: 'POST', path: '/api/turns/:id/answer', auth: 'user', owner: 'B', body: TurnAnswerBody, response: empty, status: 204, summary: 'Answer an ask_user card or a browser site confirmation of an own running turn.' }),

  listProjects: endpoint({ method: 'GET', path: '/api/projects', auth: 'user', owner: 'B', response: z.object({ items: z.array(Project) }), summary: 'Projects whose folder the caller can read.' }),
  createProject: endpoint({ method: 'POST', path: '/api/projects', auth: 'user', owner: 'B', status: 201, body: CreateProjectBody, response: Project, summary: 'New project on a folder the caller can write.' }),
  getProject: endpoint({ method: 'GET', path: '/api/projects/:id', auth: 'user', owner: 'B', response: Project, summary: 'One project.' }),
  updateProject: endpoint({ method: 'PATCH', path: '/api/projects/:id', auth: 'user', owner: 'B', body: UpdateProjectBody, response: Project, summary: 'Edit name / instructions (the creator or an admin, with write access to the folder; audited, readers notified). folderPath: admins only, never under users/.' }),
  deleteProject: endpoint({ method: 'DELETE', path: '/api/projects/:id', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Delete the project (the creator or an admin; chats stay, without project; the folder stays).' }),
} as const
