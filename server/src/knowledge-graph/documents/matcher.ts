// Many names found in one text in a single pass (Aho-Corasick): which of the folder's documents a document mentions by
// name. Time grows with the text, not with the number of names.
export class Matcher {
  private next: Map<string, number>[] = [new Map()]
  private fail: number[] = [0]
  /** the patterns that end at each state, own and through fail links */
  private out: number[][] = [[]]
  constructor(readonly patterns: readonly string[]) {
    patterns.forEach((p, i) => {
      if (!p) return
      let s = 0
      for (const ch of p) {
        let n = this.next[s]!.get(ch)
        if (n === undefined) { n = this.next.length; this.next.push(new Map()); this.fail.push(0); this.out.push([]); this.next[s]!.set(ch, n) }
        s = n
      }
      this.out[s]!.push(i)
    })
    const queue: number[] = []
    for (const n of this.next[0]!.values()) queue.push(n)
    for (let q = 0; q < queue.length; q++) {
      const s = queue[q]!
      for (const [ch, n] of this.next[s]!) {
        let f = this.fail[s]!
        while (f && !this.next[f]!.has(ch)) f = this.fail[f]!
        const to = this.next[f]!.get(ch)
        this.fail[n] = to !== undefined && to !== n ? to : 0
        if (this.out[this.fail[n]!]!.length) this.out[n] = [...this.out[n]!, ...this.out[this.fail[n]!]!]
        queue.push(n)
      }
    }
  }
  /** indexes of the patterns found in `text` (each once) */
  find(text: string): Set<number> {
    const found = new Set<number>()
    let s = 0
    for (const ch of text) {
      while (s && !this.next[s]!.has(ch)) s = this.fail[s]!
      s = this.next[s]!.get(ch) ?? 0
      for (const i of this.out[s]!) found.add(i)
    }
    return found
  }
}
