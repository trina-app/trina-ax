// Relay protocol v2, shared by the relay (relay/, Node 26) and the team server's relay client (server/src/relay-client).
// Import as '@mycel/shared/relay-protocol'. Node loads these files with type stripping: keep them erasable TypeScript.
export * from './frames.ts'
export * from './messages.ts'
export * from './mux.ts'
export * from './names.ts'
export * from './registry-api.ts'
export * from './keys.ts'

/** Team server reconnect delay: full jitter over 0.5 s * 2^attempt, capped at 30 s (tab 6). */
export function reconnectDelay(attempt: number, random: () => number = Math.random, baseMs = 500, capMs = 30_000): number {
  const cap = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 20))
  return Math.round(random() * cap)
}
/** The attempt counter resets after a connection stayed up this long. */
export const RECONNECT_STABLE_MS = 60_000
