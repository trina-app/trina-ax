// The chat a demo fake's tool call comes from (demo/fakes/higgsfield.ts): the connection call (connections/tools.ts)
// runs inside withDemoChat, and a fake reads it with demoChat(). The fakes answer at the network seam
// (connections/net.ts), where no chat travels with the request. A leaf module: it imports nothing of the server.
import { AsyncLocalStorage } from 'node:async_hooks'

const scope = new AsyncLocalStorage<{ chat: string }>()

/** run `fn` as a tool call of this chat ('' or none: no chat known) */
export function withDemoChat<T>(chat: string, fn: () => T): T {
  return chat ? scope.run({ chat }, fn) : fn()
}

/** the chat of the tool call running now, or null when none is known */
export const demoChat = (): string | null => scope.getStore()?.chat ?? null
