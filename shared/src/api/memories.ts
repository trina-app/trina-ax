// What the AI remembers about the signed-in person (remember / forget tools). Owner: B (server/src/routes/memories.ts).
// Only the person sees, adds, corrects and deletes their memories; admins can't (tab 1).
import { z } from 'zod'
import { endpoint, empty } from './endpoint'
import { PageQuery, page } from './common'
import { Memory } from './entities'

/** One memory is one line of at most this many characters once runs of spaces and line breaks are folded into one
 * space: the AI's remember and the person's own (server/src/chat/prompt.ts cleanMemoryText). */
export const MEMORY_TEXT_MAX = 300
/** A memory the person writes or corrects in Settings › Memory. The server folds and checks the text like the AI's. */
export const MemoryInput = z.object({ text: z.string().max(2000) }).strict()
export type MemoryInput = z.infer<typeof MemoryInput>

export const MEMORIES = {
  listMemories: endpoint({ method: 'GET', path: '/api/memories', auth: 'user', owner: 'B', query: PageQuery, response: page(Memory), summary: 'Own memories, newest first.' }),
  createMemory: endpoint({ method: 'POST', path: '/api/memories', auth: 'user', owner: 'B', body: MemoryInput, response: Memory, status: 201, summary: 'Add a memory of one\'s own (same limits as the AI\'s remember).' }),
  updateMemory: endpoint({ method: 'PATCH', path: '/api/memories/:id', auth: 'user', owner: 'B', body: MemoryInput, response: Memory, summary: 'Correct the text of one of the own memories.' }),
  deleteMemory: endpoint({ method: 'DELETE', path: '/api/memories/:id', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Forget one memory.' }),
  clearMemories: endpoint({ method: 'DELETE', path: '/api/memories', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Forget everything.' }),
} as const
