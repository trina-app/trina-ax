// Tiny typed pub/sub for app-wide signals that are not state (files changed, memories changed, reload asked).
export class Emitter<T> {
  private ls = new Set<(v: T) => void>()
  on(fn: (v: T) => void): () => void {
    this.ls.add(fn)
    return () => { this.ls.delete(fn) }
  }
  emit(v: T) {
    for (const fn of [...this.ls]) {
      try { fn(v) } catch (e) { console.error(e) }
    }
  }
  get size() { return this.ls.size }
}
