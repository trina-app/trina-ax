// Poll until a condition holds, instead of sleeping a fixed time (fixed sleeps made tests flaky under load).
export async function waitFor<T>(fn: () => T | Promise<T>, o: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<T> {
  const deadline = Date.now() + (o.timeoutMs ?? 5000)
  let last: T
  for (;;) {
    last = await fn()
    if (last) return last
    if (Date.now() > deadline) return last
    await Bun.sleep(o.intervalMs ?? 10)
  }
}
