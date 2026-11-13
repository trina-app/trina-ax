// The formatted-text components (components/Markdown.tsx: react-markdown, GFM, math with KaTeX and its styles; with the
// answer's rich copy, lib/richCopy.tsx, about 1.2 MB) as a file of their own, loaded the first time something on screen
// needs them: an answer, a room message, a file or a skill's example. The sign-in page and a Home with nothing to format
// never download them (docs/DECISIONS.md "First load: compressed files, one language, formatting on demand").
// Until the file is here (a moment; on a failure, for good) the text shows as it is, its lines kept, so nothing is
// missing, only not formatted yet. Once loaded, every later use draws formatted at once, with no step in between.
// Screens that open later anyway (Projects, Skills, the artifact panel) import components/Markdown.tsx directly.
import clsx from 'clsx'
import { useEffect, useState, type ComponentProps } from 'react'
import type * as MarkdownModule from './Markdown'
import type * as RichCopyModule from '../lib/richCopy'

interface Loaded { md: typeof MarkdownModule; copy: typeof RichCopyModule }

let loaded: Loaded | null = null
let loading: Promise<Loaded> | null = null

/** Load the formatting code (once; a failed load is tried again by the next caller). */
export function loadMarkdown(): Promise<Loaded> {
  loading ??= Promise.all([import('./Markdown'), import('../lib/richCopy')]).then(
    ([md, copy]) => (loaded = { md, copy }),
    (e: unknown) => {
      loading = null
      throw e
    },
  )
  return loading
}

/** Back to not loaded (web/test/unit/lazy-markdown.test.tsx); the next use loads it again. */
export function forgetMarkdownForTest() { loaded = null; loading = null }

/** The loaded modules, loading them when they are not here yet (the component draws again once they are). */
function useLoaded(): Loaded | null {
  const [, setReady] = useState(!!loaded)
  useEffect(() => {
    if (loaded) return
    let live = true
    loadMarkdown().then(() => { if (live) setReady(true) }, () => { /* stays plain text */ })
    return () => { live = false }
  }, [])
  return loaded
}

const plain = 'whitespace-pre-wrap break-words'

export function Markdown(props: ComponentProps<typeof MarkdownModule.Markdown>) {
  const m = useLoaded()
  if (m) return <m.md.Markdown {...props} />
  return <div className={clsx(plain, props.className)} data-testid="md-plain">{props.text}</div>
}

export function PersonMarkdown(props: ComponentProps<typeof MarkdownModule.PersonMarkdown>) {
  const m = useLoaded()
  if (m) return <m.md.PersonMarkdown {...props} />
  return <div className={clsx(plain, props.className)} data-testid="md-plain">{props.text}{props.after}</div>
}

export function CodeBlock(props: ComponentProps<typeof MarkdownModule.CodeBlock>) {
  const m = useLoaded()
  if (m) return <m.md.CodeBlock {...props} />
  return <pre className="overflow-x-auto whitespace-pre text-sm"><code>{props.code}</code></pre>
}

/** An image on the team server (chat steps): drawn once the formatting code is here. */
export function TeamImage(props: ComponentProps<typeof MarkdownModule.TeamImage>) {
  const m = useLoaded()
  return m ? <m.md.TeamImage {...props} /> : null
}

/** An answer as formatted text for the clipboard (lib/richCopy.tsx answerHtml). Throws while the formatting code is not
 * here: the copy is then the Markdown only (components/ui.tsx CopyButton). */
export function answerHtml(...args: Parameters<typeof RichCopyModule.answerHtml>): string {
  if (!loaded) {
    void loadMarkdown().catch(() => {})
    throw new Error('formatting not loaded yet')
  }
  return loaded.copy.answerHtml(...args)
}
