// The story's state in one tab (web/demo/script.ts): what has happened, which story messages are due, which line the
// guide shows, whether the end card is up, and which canned answer a message gets. No DOM and no server here, so the
// unit tests drive it directly (web/test/unit/demo-engine.test.ts).
import type { DemoAnswer, DemoEvent, DemoFile, DemoGuideStep, DemoScript, DemoTrigger, Id } from './script'

/** where a message was sent: Home's chat, a project's chat, the side chat of a room */
export type Place = 'home' | { project: Id } | { side: Id }
/** one thing that happened (a trigger without lists) */
export type Happening = { start: true } | { answer: Id } | { shared: Id } | { event: Id } | { opened: { room: Id } | { project: Id } }

const keyOf = (h: Happening): string =>
  'start' in h ? 'start' : 'answer' in h ? `answer:${h.answer}` : 'shared' in h ? `shared:${h.shared}` : 'event' in h ? `event:${h.event}`
    : 'room' in h.opened ? `opened:room:${h.opened.room}` : `opened:project:${h.opened.project}`

/** the keys a trigger is met by (an answer list: any of them) */
export const keysOf = (t: DemoTrigger): string[] => ('answer' in t ? [t.answer].flat().map((id) => `answer:${id}`) : [keyOf(t as Happening)])

const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim()
const samePlace = (where: DemoAnswer['where'], place: Place) => {
  if (!where || where === 'any') return true
  if (where === 'home' || place === 'home') return where === place
  if ('project' in where) return 'project' in place && place.project === where.project
  return 'side' in place && place.side === where.side
}
/** a guide step's place as a message place (a room is no place to ask the AI) */
const placeOfGo = (go: DemoGuideStep['go']): Place | null => (go === 'home' ? 'home' : 'room' in go ? null : go)

export class StoryEngine {
  private happened = new Set<string>()
  private due = new Set<string>()
  /** answers in the order they finished (the latest last) */
  answers: Id[] = []
  endShown = false
  endClosed = false
  private listeners = new Set<() => void>()
  private timers: ReturnType<typeof setTimeout>[] = []

  constructor(readonly script: DemoScript, private post: (ev: DemoEvent) => void, private wait: (fn: () => void, ms: number) => unknown = (fn, ms) => this.timers.push(setTimeout(fn, ms))) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  private changed() { for (const l of this.listeners) l() }

  has(t: DemoTrigger): boolean { return keysOf(t).some((k) => this.happened.has(k)) }

  fire(h: Happening) {
    const key = keyOf(h)
    if (this.happened.has(key)) return
    this.happened.add(key)
    for (const ev of this.script.events) {
      if (this.due.has(ev.id) || !keysOf(ev.after).includes(key)) continue
      this.due.add(ev.id)
      this.wait(() => this.post(ev), ev.delayMs ?? 1500)
    }
    const end = this.script.end
    if (!this.endShown && keysOf(end.after).includes(key)) {
      this.wait(() => { this.endShown = true; this.changed() }, end.delayMs ?? 2500)
    }
    this.changed()
  }

  answered(id: Id) {
    this.answers = [...this.answers.filter((x) => x !== id), id]
    this.fire({ answer: id })
  }

  /** the guide's line now: the first step not over yet, once its start happened; null between steps and at the end */
  guide(): DemoGuideStep | null {
    const steps = this.script.guide
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!
      if (this.has(s.until)) continue
      if (s.after && !this.has(s.after)) return null
      return s
    }
    return null
  }

  closeEnd() {
    this.endClosed = true
    this.changed()
  }

  /** the canned answer for a message: its exact prompt, the one for this place first */
  answerFor(prompt: string, place: Place): DemoAnswer | null {
    const same = this.script.answers.filter((a) => norm(a.prompt) === norm(prompt))
    return same.find((a) => samePlace(a.where, place)) ?? same[0] ?? null
  }

  /** the prompts offered after free typing: the guide's suggestions when it points here, else the answers of this
   * place, else the guide's suggestions anyway */
  suggestionsFor(place: Place): DemoAnswer[] {
    const step = this.guide()
    const byId = (ids: Id[]) => ids.flatMap((id) => this.script.answers.filter((a) => a.id === id))
    const guided = step?.suggest ? byId(step.suggest) : []
    const here = step && placeOfGo(step.go)
    if (guided.length && here && samePlace(here === 'home' ? 'home' : here, place)) return guided
    if (step && step.go === 'home' && place === 'home') {
      const home = this.script.answers.find((a) => norm(a.prompt) === norm(this.script.home.prompt))
      if (home) return [home]
    }
    const local = this.script.answers.filter((a) => a.where && a.where !== 'any' && samePlace(a.where, place))
    return local.length ? local : guided
  }

  /** a file's asset, following the visitor's choice (DemoFile.pick) */
  pickAsset(f: DemoFile): string | undefined {
    if (f.pick) for (const id of [...this.answers].reverse()) if (f.pick[id]) return f.pick[id]
    return f.asset
  }

  stop() { for (const t of this.timers) clearTimeout(t) }
}
