// Contract-shaped test data (parsed with the shared schemas, so a contract change breaks the tests loudly).
import { Message, uuidv7, type Message as MessageT, type Step } from '@mycel/shared/api'

export const CHAT = uuidv7()

export function msg(o: Partial<MessageT> & Pick<MessageT, 'role'>): MessageT {
  const id = o.id ?? uuidv7()
  return Message.parse({
    id,
    chatId: CHAT,
    parentId: null,
    author: null,
    content: '',
    attachments: [],
    steps: [],
    status: 'done',
    error: null,
    turnId: null,
    engine: null,
    model: null,
    files: null,
    usage: null,
    createdAt: new Date().toISOString(),
    branch: { index: 0, count: 1, siblingIds: [id] },
    ...o,
  })
}

export function step(o: Partial<Step> & Pick<Step, 'id'>): Step {
  return { kind: 'tool', label: 'grep', status: 'running', startedAt: new Date().toISOString(), endedAt: null, ...o }
}
