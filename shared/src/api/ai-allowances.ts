// What the signed-in person allowed the AI in advance (Settings › 트리나에게 허용한 것). Owner: B
// (server/src/routes/ai-allowances.ts, server/src/rooms/ai-grants.ts). Only the person sees and deletes their own: another
// person's id answers 404, like one that is not there. One kind today, a room's folder for new files ("이 방에서는 항상
// 허용", docs/DECISIONS.md "대화방에서 새 파일은 미리 허용"); the list is a union by `kind` so other kinds (sites allowed
// for a conversation) can join it.
import { z } from 'zod'
import { UserRef } from './entities'
import { endpoint, empty } from './endpoint'
import { RoomKind } from './rooms'

/** "이 방에서는 항상 허용": in this room, when the person calls @트리나, it may make new files in `folder` (and its
 * subfolders) without asking, until `expiresAt`. The room as the person sees it (the fields its title is made of). */
export const RoomFilesAllowance = z.object({
  kind: z.literal('room_files'),
  id: z.string(),
  room: z.object({ id: z.string(), kind: RoomKind, name: z.string().nullable(), peers: z.array(UserRef), memberCount: z.number().int().nonnegative() }),
  /** the team folder, as the file layer names it */
  folder: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
})
export type RoomFilesAllowance = z.infer<typeof RoomFilesAllowance>

/** The kinds of the AI's cards a person can answer with "Always allow" (docs/DECISIONS.md "Always allow on every card",
 * server/src/chat/always-allow.ts). After that answer the card of that kind is not raised for them again in the chats
 * they watch, until they take it back here. */
export const CARD_ALWAYS_KINDS = ['room_change', 'remember', 'save_wider', 'post_to_room', 'shared_read', 'move_files', 'skill_files', 'skill_save', 'delete_files', 'project_members', 'video', 'big_download'] as const
export const CardAlwaysKind = z.enum(CARD_ALWAYS_KINDS)
export type CardAlwaysKind = z.infer<typeof CardAlwaysKind>

/** "Always allow" on one kind of card (id `card:<kind>`). */
export const CardAllowance = z.object({
  kind: z.literal('card'),
  id: z.string(),
  card: CardAlwaysKind,
  createdAt: z.string(),
})
export type CardAllowance = z.infer<typeof CardAllowance>

export const AiAllowance = z.discriminatedUnion('kind', [RoomFilesAllowance, CardAllowance])
export type AiAllowance = z.infer<typeof AiAllowance>

export const AI_ALLOWANCES = {
  listAiAllowances: endpoint({ method: 'GET', path: '/api/ai-allowances', auth: 'user', owner: 'B', response: z.object({ items: z.array(AiAllowance) }), summary: 'What I allowed the AI in advance ("Always allow" on a kind of card, room folders for new files), newest first.' }),
  deleteAiAllowance: endpoint({ method: 'DELETE', path: '/api/ai-allowances/:id', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Take one of my allowances back (404: not mine or not there).' }),
} as const
