// Copying several messages of a room (components/rooms/RoomMessages.tsx, the timeline and a thread's panel): ⌘C over
// more than one message gives their words as plain text, one message per block, never the buttons and marks around
// them (the hover bar's ✅ 👀 👍, reactions, "답글 3개", "수정됨", a file's buttons, the avatar):
//
//   소라님  오후 2:57
//   금요일까지 보내 주세요
//
//   피드백도 부탁드려요
//   brief.pdf
//
//   벤  오후 2:58
//   네, 수요일까지요
//
// The author and time once per run of one author (as the list shows them), a file as its name, a date line when the
// selection crosses a day, an event line ("가나님이 방 이름을 바꿨어요") as a line of its own, one blank line between
// blocks. A first or last message only partly selected gives the part selected (under its author line). A selection
// inside one message is the browser's own copy, as before. No text/html: a paste anywhere gets the same plain text.
//
// What the list marks: a message row (data-testid="room-message"), its words (the class `select-text`: the rest of the
// row cannot be selected), its files (`data-file-name`), its run (`room-run`, with `room-run-head`: the name, then
// <time>), a date line (`room-day`) and an event line (`room-event`).

/** One thing a selection covers, in the page's order. `run`: the run a message belongs to (the same value for one
 * author's messages shown under one name). */
export type CopyItem =
  /** a message: its run's name and time, the selected part of its words, the names of its files the selection reaches */
  | { kind: 'message'; run: unknown; author: string; time: string; text: string; files: string[] }
  /** a line of its own: a date line, an event line */
  | { kind: 'line'; text: string }
  /** a run's name and time, selected themselves */
  | { kind: 'head'; run: unknown }

const said = (i: CopyItem) => (i.kind === 'head' ? true : i.kind === 'line' ? !!i.text.trim() : !!i.text.trim() || i.files.length > 0)

/** The plain text of what a selection covers; null when it is one message alone (or less), which the browser copies
 * as it is. A message with nothing selected (the selection ends at its very start) is left out. */
export function copyPlainText(items: readonly CopyItem[]): string | null {
  const kept = items.filter(said)
  if (kept.length < 2) return null
  const blocks: string[] = []
  // the run whose author line was written last
  let run: unknown = undefined
  let written = false
  for (const i of kept) {
    if (i.kind === 'head') continue
    if (i.kind === 'line') {
      blocks.push(i.text.trim())
      written = false
      continue
    }
    const lines: string[] = []
    if (!written || i.run !== run) lines.push(`${i.author}  ${i.time}`.trim())
    run = i.run
    written = true
    const text = i.text.trim()
    if (text) lines.push(text)
    lines.push(...i.files)
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}

const ROW = '[data-testid="room-message"]'
const WORDS = 'select-text'

/** The part of `el` inside `range`, as the page shows it: its line breaks (a message's own, an answer's paragraphs),
 * without what cannot be selected (`select-none`, a screen reader's words). */
function selectedText(range: Range, el: Element): string {
  if (!range.intersectsNode(el)) return ''
  const part = document.createRange()
  part.selectNodeContents(el)
  if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset)
  if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset)
  if (part.collapsed) return ''
  // the element's own box around the part keeps how it lays out its text (a message's pre-wrap lines)
  const box = el.cloneNode(false) as HTMLElement
  box.append(part.cloneContents())
  for (const skip of box.querySelectorAll('.select-none, .sr-only')) skip.remove()
  // innerText knows the line breaks only of something laid out: briefly, out of sight
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;top:0;left:-10000px;width:800px;opacity:0;pointer-events:none'
  host.append(box)
  document.body.append(host)
  try {
    return box.innerText ?? box.textContent ?? ''
  } finally {
    host.remove()
  }
}

/** The run's name and time (the head of the run `row` is in). */
function runOf(row: Element): { run: Element | null; author: string; time: string } {
  const run = row.closest('[data-testid="room-run"]')
  const head = run?.querySelector('[data-testid="room-run-head"]')
  return { run, author: head?.querySelector('span')?.textContent?.trim() ?? '', time: head?.querySelector('time')?.textContent?.trim() ?? '' }
}

/** What `range` covers, in the page's order (lists of a room: the timeline, a thread's root and replies). Nothing when it
 * lies inside one message. */
export function selectionItems(range: Range): CopyItem[] {
  const common = range.commonAncestorContainer
  const scope = common instanceof Element ? common : common.parentElement
  if (!scope || scope.closest(ROW)) return []
  const items: CopyItem[] = []
  for (const el of scope.querySelectorAll(`${ROW}, [data-testid="room-run-head"], [data-testid="room-event"], [data-testid="room-day"]`)) {
    if (!range.intersectsNode(el)) continue
    const what = el.getAttribute('data-testid')
    if (what === 'room-day') {
      if (selectedText(range, el).trim()) items.push({ kind: 'line', text: el.textContent ?? '' })
    } else if (what === 'room-event') {
      items.push({ kind: 'line', text: selectedText(range, el) })
    } else if (what === 'room-run-head') {
      if (selectedText(range, el).trim()) items.push({ kind: 'head', run: el.closest('[data-testid="room-run"]') })
    } else {
      // the outermost words of the row (a shared answer's note and its answer; not the parts of an answer)
      const words = [...el.querySelectorAll(`.${WORDS}`)].filter((w) => {
        const up = w.parentElement?.closest(`.${WORDS}`)
        return !up || !el.contains(up)
      })
      const text = words.map((w) => selectedText(range, w).trim()).filter(Boolean).join('\n')
      const files = [...el.querySelectorAll<HTMLElement>('[data-file-name]')].filter((f) => range.intersectsNode(f)).map((f) => f.dataset.fileName ?? '')
      items.push({ kind: 'message', ...runOf(el), text, files })
    }
  }
  return items
}

/** The plain text a copy of the page's selection should give, or null for the browser's own copy (no selection, one
 * message or less, or a selection outside the messages). */
export function copiedMessages(selection: Selection | null): string | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  return copyPlainText(selectionItems(selection.getRangeAt(0)))
}
