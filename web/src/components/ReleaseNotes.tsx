// A release's notes on an update card (Admin › System: the office Mac's automatic updates and a server's update). The
// feed's notes are Markdown, many screens long and in two languages; the card shows the first paragraph (the release's
// one-line summary) and "More" opens the whole notes, rendered like an answer.
import { useState } from 'react'
import { useT } from '../i18n'
import { Markdown } from './Markdown'

const SUMMARY_MAX = 400

/** The first block that is not a heading, as Markdown (its lines kept, so a list stays a list), cut to SUMMARY_MAX
 * characters at a line or a word, never inside a link or a bold span; `more` when the notes hold anything else. */
export function notesSummary(notes: string): { summary: string; more: boolean } {
  const text = notes.replace(/\r\n?/g, '\n').trim()
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  const first = blocks.find((b) => !/^#{1,6}\s/.test(b)) ?? ''
  let summary = first
  let cut = false
  if (summary.length > SUMMARY_MAX) {
    cut = true
    const lines = summary.split('\n')
    let kept = ''
    for (const l of lines) { if ((kept ? kept.length + 1 : 0) + l.length > SUMMARY_MAX) break; kept = kept ? `${kept}\n${l}` : l }
    if (!kept) {
      // one long line: at a word, then without a link or bold span it would cut in two
      const at = lines[0]!.lastIndexOf(' ', SUMMARY_MAX)
      kept = lines[0]!.slice(0, at > SUMMARY_MAX / 2 ? at : SUMMARY_MAX).trimEnd()
      const open = kept.lastIndexOf('[')
      if (open >= 0 && !/\]\([^)]*\)/.test(kept.slice(open))) kept = kept.slice(0, open).trimEnd()
      if ((kept.match(/\*\*/g) ?? []).length % 2) kept = kept.slice(0, kept.lastIndexOf('**')).trimEnd()
    }
    summary = `${kept}…`
  }
  return { summary, more: cut || blocks.length > 1 || (blocks.length === 1 && blocks[0] !== first) }
}

export function ReleaseNotes({ notes }: { notes: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const { summary, more } = notesSummary(notes)
  if (!summary && !more) return null
  return (
    <div className="mt-1 text-xs text-muted" data-testid="release-notes">
      {(open || summary) && <Markdown text={open ? notes : summary} size="small" className="text-muted" />}
      {more && (
        <button type="button" className="mt-1 text-accent-text underline underline-offset-2" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(open ? 'update.notesLess' : 'update.notesMore')}
        </button>
      )}
    </div>
  )
}
