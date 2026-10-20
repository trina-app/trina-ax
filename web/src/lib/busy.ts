// What would be lost by reloading the page right now: uploads in flight, a non-empty composer. After the server
// reports a newer version the page reloads by itself only when nothing here is busy (tab 5 "버전 불일치").
const counters = new Map<string, number>()

export function markBusy(kind: 'upload' | 'draft' | 'recording'): () => void {
  counters.set(kind, (counters.get(kind) ?? 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    counters.set(kind, Math.max(0, (counters.get(kind) ?? 1) - 1))
  }
}

export const isBusy = () => [...counters.values()].some((n) => n > 0)
