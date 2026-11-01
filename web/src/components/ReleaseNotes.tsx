// A release's notes on an update card (Admin › System: the office Mac's automatic updates and a server's update). The
// feed's notes are Markdown, many screens long and in two languages; the card shows the first paragraph (the release's
// one-line summary) and "More" opens the whole notes, rendered like an answer.
import { useState } from 'react'
import { useT } from '../i18n'
import { Markdown } from './Markdown'

const SUMMARY_MAX = 400

/** The first paragraph that is not a heading, cut at SUMMARY_MAX characters; `more` when the notes hold anything else. */
export function notesSummary(notes: string): { summary: string; more: boolean } {
  const text = notes.replace(/\r\n?/g, '\n').trim()
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  const first = blocks.find((b) => !/^#{1,6}\s/.test(b)) ?? ''
  let summary = first.replace(/^#{1,6}\s+/gm, '').replace(/\s*\n\s*/g, ' ')
  let cut = false
  if (summary.length > SUMMARY_MAX) {
    const at = summary.lastIndexOf(' ', SUMMARY_MAX)
    summary = `${summary.slice(0, at > SUMMARY_MAX / 2 ? at : SUMMARY_MAX).trimEnd()}…`
    cut = true
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
      {(open || summary) && <Markdown text={open ? notes : summary} className="text-xs leading-5 text-muted prose-h1:text-sm prose-h2:text-sm prose-h3:text-xs" />}
      {more && (
        <button type="button" className="mt-1 text-accent-text underline underline-offset-2" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(open ? 'update.notesLess' : 'update.notesMore')}
        </button>
      )}
    </div>
  )
}
