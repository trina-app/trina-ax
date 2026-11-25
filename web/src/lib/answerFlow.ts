// An answer read in the order the work happened, as Claude Code shows it (docs/decisions/20261125-interim-text-inline.md):
// a group of steps, the text the AI wrote after it, the next group, …, the final answer. The answer's text is cut where
// each step started (Step.textAt, the same block-safe cut the artifact cards use), and text the AI wrote between two
// calls that left the answer (Step.interim, a Korean, Japanese or Chinese answer: server/src/chat/turn.ts endPiece) shows
// at its step's place. The text itself is unchanged: copy, exports and room sends use Message.content as before.
import type { Step } from '@mycel/shared/api'

/** A point of `content` at or before `at` that splits no block: between blocks (a blank line right before it, or the
 * block ends there), else back to the blank line before the block it falls in, and before a heading right above that
 * ("### 1안" stays with its quote). The end of the text is a boundary. null: inside a code block, or inside the first
 * block with no blank line before it. */
export function blockCut(content: string, at: number): number | null {
  const raw = Math.max(0, Math.min(at, content.length))
  if (raw >= content.length) return content.length
  if (raw === 0) return 0
  const before = content.slice(0, raw)
  let cut: number | null = /\n[ \t]*\n[ \t]*$/.test(before) || /^[ \t]*\n[ \t]*\n/.test(content.slice(raw)) ? raw : null
  if (cut === null) {
    const blank = [...before.matchAll(/\n[ \t]*\n/g)].pop()
    cut = blank ? blank.index! + blank[0].length : null
  }
  if (cut === null) return null
  for (;;) {
    const head = /(^|\n[ \t]*\n)(#{1,6} [^\n]*\n[ \t]*\n)$/.exec(content.slice(0, cut))
    if (!head) break
    cut -= head[2]!.length
  }
  if (cut === 0) return 0
  // an odd number of ``` fences before the cut: it is inside a code block
  if ((content.slice(0, cut).match(/```/g)?.length ?? 0) % 2 === 1) return null
  return cut
}

/** Where the answer's artifact cards go in its text: at the point where the AI made the first one, block-safe
 * (blockCut); null (after the text, as before) for steps from before Step.textAt, a point at the end of the text so far,
 * or a cut inside a code block. */
export function artifactSplit(content: string, steps: readonly Step[]): number | null {
  const at = steps.filter((s) => s.kind === 'artifact' && !s.parentId && s.textAt !== undefined).reduce<number | null>((min, s) => (min === null ? s.textAt! : Math.min(min, s.textAt!)), null)
  if (at === null || Math.min(at, content.length) >= content.length) return null
  return blockCut(content, at)
}

/** blockCut for a step: a point inside a code block goes back before the block (the cards keep their own rule). */
function stepCut(content: string, at: number): number | null {
  const cut = blockCut(content, at)
  if (cut !== null) return cut
  const fences = [...content.slice(0, Math.min(at, content.length)).matchAll(/```/g)]
  return fences.length % 2 === 1 ? blockCut(content, fences.at(-1)!.index!) : null
}

export type FlowItem =
  /** steps in a row (a top step and its sub-task's steps); `live`: the group still being worked on (the last one while
   * the answer runs); `first`: the answer's first group */
  | { kind: 'steps'; key: string; steps: Step[]; live: boolean; first: boolean }
  /** text the AI wrote between two calls that is not in the answer's text (Step.interim) */
  | { kind: 'note'; key: string; text: string }
  /** a part of the answer's text; `streaming`: the part still being written */
  | { kind: 'text'; key: string; text: string; streaming: boolean }
  /** the answer's artifact cards */
  | { kind: 'cards'; key: string }

/** The answer as one flow in the order of the work. Steps without Step.textAt (from before the field) all come before
 * the text, as before; a step whose point cannot be cut safely goes before the block it fell in. */
export function answerFlow(content: string, all: readonly Step[], streaming: boolean): FlowItem[] {
  const subtasks = new Set(all.filter((s) => s.tool === 'agent').map((s) => s.id))
  const kids = new Map<string, Step[]>()
  const top: Step[] = []
  for (const s of all) {
    if (s.parentId && subtasks.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s])
    else top.push(s)
  }
  const cardsCut = artifactSplit(content, all)
  const firstArtifact = cardsCut === null ? undefined : top.find((s) => s.kind === 'artifact' && s.textAt !== undefined)
  const out: FlowItem[] = []
  let last = 0
  let group: Extract<FlowItem, { kind: 'steps' }> | null = null
  const text = (to: number) => {
    if (to <= last) return
    const t = content.slice(last, to)
    if (t.trim()) { out.push({ kind: 'text', key: `t${last}`, text: t, streaming: false }); group = null }
    last = to
  }
  for (const s of top) {
    text(Math.max(last, stepCut(content, s.textAt ?? 0) ?? last))
    if (s.interim && s.detail?.trim()) {
      out.push({ kind: 'note', key: `n${s.id}`, text: s.detail })
      group = null
      continue
    }
    if (!group) { group = { kind: 'steps', key: `s${s.id}`, steps: [], live: false, first: !out.some((i) => i.kind === 'steps') }; out.push(group) }
    group.steps.push(s, ...(kids.get(s.id) ?? []))
    // the cards right after the step that made them (after its caption, before what follows)
    if (s === firstArtifact) { out.push({ kind: 'cards', key: 'cards' }); group = null }
  }
  text(content.length)
  if (!out.some((i) => i.kind === 'cards')) out.push({ kind: 'cards', key: 'cards' })
  if (streaming) {
    const lastText = out.findLast((i) => i.kind === 'text')
    if (lastText?.kind === 'text') lastText.streaming = true
    const lastGroup = out.findLast((i) => i.kind === 'steps')
    if (lastGroup?.kind === 'steps') lastGroup.live = true
  }
  return out
}
