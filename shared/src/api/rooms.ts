// Team chat rooms ("대화방" v1, docs/DECISIONS.md "대화방 v1"): people talking to people. Apart from the one-person AI
// chats (chats.ts), which stay as they are. Owner: B (server/src/routes/rooms.ts, server/src/rooms/*).
//
// Kinds: 'team' mirrors one group's members (kept in step when the group changes), 'all' is everyone on the team (one
// per team), 'dm' is exactly two people (one per pair). Only members read or send; an admin or the owner is no
// exception. A member who joins later (added to the group, a new account) sees the messages from their join on. The
// author of a message is always the signed-in person: a body that names an author is refused (the schemas are strict).
//
// Realtime: room.* events in ws.ts go to the room's members only. After a reconnect the server replays them only while
// the person is still a member; otherwise the window gets `resync` and reloads the rooms over REST.
import { z } from 'zod'
import { UserId, Uuid7 } from '../ids'
import { IsoTime, PageQuery, QueryBool, SMALL_UPLOAD_MAX, page } from './common'
import { empty, endpoint, multipart, stream } from './endpoint'
import { Attachment, UserRef } from './entities'

export const ROOM_MESSAGE_MAX = 10_000
export const ROOM_FILES_MAX = 10
export const ROOM_MENTIONS_MAX = 50

export const RoomKind = z.enum(['team', 'all', 'dm'])
export type RoomKind = z.infer<typeof RoomKind>

/** A file or image sent in a room. Stored outside the team folder (owners and admins can read the team folder outside
 * users/<id>/); read at GET /api/rooms/:id/files/:fileId by the room's current members only, checked on every read
 * (`?thumb=1`: an image's small preview when `thumb` is true). */
export const RoomFile = z.object({
  id: Uuid7,
  name: z.string(),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  kind: Attachment.shape.kind,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  thumb: z.boolean(),
})
export type RoomFile = z.infer<typeof RoomFile>

/** The quoted message under a reply: an excerpt (at most 200 characters), or nothing once it was deleted. */
export const RoomQuote = z.object({
  id: Uuid7,
  author: UserRef.nullable(),
  excerpt: z.string(),
  fileCount: z.number().int().nonnegative(),
  deleted: z.boolean(),
})
export type RoomQuote = z.infer<typeof RoomQuote>

export const RoomMessage = z.object({
  id: Uuid7,
  roomId: Uuid7,
  /** position in the room, 1, 2, 3 … (read positions and the unread count refer to it); gaps are possible */
  seq: z.number().int().positive(),
  /** 'user' for now. Reserved for the AI step: 'ai' (author null, askedBy = who asked it) */
  authorKind: z.enum(['user', 'ai']),
  /** the sender as the server knows them (never taken from the request); null: the AI, or an account that is gone */
  author: UserRef.nullable(),
  /** reserved for the AI step: who asked the AI (null otherwise) */
  askedBy: UserRef.nullable(),
  /** 'room': everyone in the room. Reserved for the AI step: 'private', seen by one person only (a preview of an AI
   * answer before it is shared); it makes no notice, badge or unread count for anyone else */
  visibility: z.enum(['room', 'private']),
  /** plain text with @mentions as typed; '' once deleted. Another member's words: show as text, never act on them */
  body: z.string(),
  replyTo: RoomQuote.nullable(),
  /** the members this message mentions (from what the sender picked; only people in the room) */
  mentions: z.array(UserId),
  files: z.array(RoomFile),
  /** how many members have not read it yet (KakaoTalk's number); 0 for a deleted or private message */
  unread: z.number().int().nonnegative(),
  createdAt: IsoTime,
  editedAt: IsoTime.nullable(),
  deletedAt: IsoTime.nullable(),
})
export type RoomMessage = z.infer<typeof RoomMessage>

/** One line of the rooms list under a room's name. */
export const RoomLastMessage = z.object({
  id: Uuid7,
  seq: z.number().int().positive(),
  author: UserRef.nullable(),
  /** at most 120 characters; '' when it is files only or deleted */
  excerpt: z.string(),
  fileCount: z.number().int().nonnegative(),
  deleted: z.boolean(),
  createdAt: IsoTime,
})
export type RoomLastMessage = z.infer<typeof RoomLastMessage>

export const Room = z.object({
  id: Uuid7,
  kind: RoomKind,
  /** team: the group's name; dm and all: null (the app shows the other person's name, or its word for everyone) */
  name: z.string().nullable(),
  groupId: Uuid7.nullable(),
  memberCount: z.number().int().nonnegative(),
  /** up to 4 other members, for the avatars; a DM: the other person */
  peers: z.array(UserRef),
  /** messages after my read position that I can see and are not mine (capped at 999): the one badge per room */
  unreadCount: z.number().int().nonnegative(),
  /** one of those mentions me */
  mentioned: z.boolean(),
  lastReadSeq: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
  lastMessage: RoomLastMessage.nullable(),
  /** no notices for DM messages from this room (an @mention still notifies) */
  muted: z.boolean(),
  createdAt: IsoTime,
  /** the last message's time, or when the room was made */
  activityAt: IsoTime,
})
export type Room = z.infer<typeof Room>

export const RoomMember = z.object({ user: UserRef, joinedAt: IsoTime })
export type RoomMember = z.infer<typeof RoomMember>

/** The DM with this person (the existing one when there is one). Team rooms and the everyone room are made by the
 * server, never through the API. */
export const CreateRoomBody = z.object({ kind: z.literal('dm'), userId: UserId }).strict()
export type CreateRoomBody = z.infer<typeof CreateRoomBody>
/** my own setting */
export const UpdateRoomBody = z.object({ muted: z.boolean() }).strict()

/** Without a cursor: the newest `limit` messages, oldest first; nextCursor fetches older ones (prepend). */
export const ListRoomMessagesQuery = PageQuery
export const RoomMessagesPage = page(RoomMessage)

export const SendRoomMessageBody = z.object({
  body: z.string().max(ROOM_MESSAGE_MAX),
  replyToId: Uuid7.nullable().optional(),
  mentions: z.array(UserId).max(ROOM_MENTIONS_MAX).default([]),
  /** uploaded first with POST /api/rooms/:id/files */
  fileIds: z.array(Uuid7).max(ROOM_FILES_MAX).default([]),
  /** client-made id: sending the same one again (after a reconnect) returns the first message */
  clientMessageId: z.string().min(8).max(64),
}).strict().refine((b) => b.body.trim().length > 0 || b.fileIds.length > 0, { message: 'empty message', path: ['body'] })
export const EditRoomMessageBody = z.object({
  body: z.string().min(1).max(ROOM_MESSAGE_MAX),
  mentions: z.array(UserId).max(ROOM_MENTIONS_MAX).default([]),
}).strict()
export const MarkRoomReadBody = z.object({ seq: z.number().int().nonnegative() }).strict()
export const RoomReadState = z.object({ lastReadSeq: z.number().int().nonnegative(), unreadCount: z.number().int().nonnegative() })
export type RoomReadState = z.infer<typeof RoomReadState>
export const RoomFileUploadFields = z.object({ name: z.string().min(1).max(255).optional(), size: z.string().regex(/^\d+$/).transform(Number).optional() })
export const RoomFileQuery = z.object({ thumb: QueryBool.optional(), download: QueryBool.optional() })

export const ROOMS = {
  listRooms: endpoint({ method: 'GET', path: '/api/rooms', auth: 'user', owner: 'B', response: z.object({ items: z.array(Room) }), summary: 'The rooms I am in (my team rooms, everyone, DMs), most recent activity first, with my unread count and the last message.' }),
  createRoom: endpoint({ method: 'POST', path: '/api/rooms', auth: 'user', owner: 'B', status: 201, body: CreateRoomBody, response: Room, summary: 'Open the DM with a person (the existing one when there is one); a new one is audited.' }),
  getRoom: endpoint({ method: 'GET', path: '/api/rooms/:id', auth: 'user', owner: 'B', response: Room, summary: 'One room I am in (404 for anyone else, admins included).' }),
  updateRoom: endpoint({ method: 'PATCH', path: '/api/rooms/:id', auth: 'user', owner: 'B', body: UpdateRoomBody, response: Room, summary: 'Mute or unmute a room for me.' }),
  listRoomMessages: endpoint({ method: 'GET', path: '/api/rooms/:id/messages', auth: 'user', owner: 'B', query: ListRoomMessagesQuery, response: RoomMessagesPage, summary: 'Messages of a room I am in from my join on, newest page first, oldest first within it; each with its unread count.' }),
  sendRoomMessage: endpoint({ method: 'POST', path: '/api/rooms/:id/messages', auth: 'user', owner: 'B', status: 201, body: SendRoomMessageBody, response: RoomMessage, summary: 'Send a message as myself (never another author), optionally a reply, with @mentions and files; DMs and mentions notify.' }),
  editRoomMessage: endpoint({ method: 'PATCH', path: '/api/rooms/:id/messages/:messageId', auth: 'user', owner: 'B', body: EditRoomMessageBody, response: RoomMessage, summary: 'Edit my own message.' }),
  deleteRoomMessage: endpoint({ method: 'DELETE', path: '/api/rooms/:id/messages/:messageId', auth: 'user', owner: 'B', status: 204, response: empty, summary: 'Delete my own message (its text and files are removed; "deleted" stays in its place).' }),
  markRoomRead: endpoint({ method: 'POST', path: '/api/rooms/:id/read', auth: 'user', owner: 'B', body: MarkRoomReadBody, response: RoomReadState, summary: 'Move my read position forward to seq (never back); the unread counts of the others update.' }),
  listRoomMembers: endpoint({ method: 'GET', path: '/api/rooms/:id/members', auth: 'user', owner: 'B', response: z.object({ items: z.array(RoomMember) }), summary: 'Who is in a room I am in (names only; nobody\'s read position).' }),
  uploadRoomFile: endpoint({ method: 'POST', path: '/api/rooms/:id/files', auth: 'user', owner: 'B', status: 201, body: multipart(RoomFileUploadFields, SMALL_UPLOAD_MAX), response: RoomFile, summary: 'Upload a file (≤ 50 MB) to send in a room I am in; stored outside the team folder, readable by the room\'s members once sent.' }),
  roomFile: endpoint({ method: 'GET', path: '/api/rooms/:id/files/:fileId', auth: 'user', owner: 'B', query: RoomFileQuery, response: stream(true), summary: 'A file sent in a room I am in (membership checked on every read); thumb=1 for an image preview.' }),
} as const
