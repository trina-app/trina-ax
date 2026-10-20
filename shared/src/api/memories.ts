// What the AI remembers about the signed-in person (remember / forget tools). Owner: B (server/src/routes/memories.ts).
// Only the person sees and deletes their memories; admins can't (tab 1).
import { endpoint, empty } from './endpoint'
import { PageQuery, page } from './common'
import { Memory } from './entities'

export const MEMORIES = {
  listMemories: endpoint({ method: 'GET', path: '/api/memories', auth: 'user', owner: 'B', query: PageQuery, response: page(Memory), summary: 'Own memories, newest first.' }),
  deleteMemory: endpoint({ method: 'DELETE', path: '/api/memories/:id', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Forget one memory.' }),
  clearMemories: endpoint({ method: 'DELETE', path: '/api/memories', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Forget everything.' }),
} as const
