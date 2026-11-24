// trina_docs (docs/decisions/20261124-trina-docs-tool.md): asked how to use, set up or fix the app, the AI searches the
// app's own docs, the ones of this server's version (data.ts), and answers from them with the page's link. Local:
// nothing leaves the server, so it is offered where the AI's other local tools are, confidential chats too
// (safe-ops/confidential.ts LOCAL_TOOLS), in shared chats (rooms/ai-tools.ts SHARED_TOOLS: public docs, nothing about
// anyone) and to sub-agents (read-only, the Explore helper too: shared READ_ONLY_TOOLS); not to a guest (the team's
// screens are not theirs, as the app map: chat/app-map.ts) and not where this server has no docs.
//
// Kept small: its definition goes with every request of a turn that offers it (the reason a help tool was turned down
// in docs/decisions/20261116-ai-app-map.md). tests/unit/docs-help.test.ts holds its size.
import { z } from 'zod'
import type { Locale } from '@mycel/shared/api'
import type { Tool } from '../chat/tools'
import { neutralizeTags } from '../chat/prompt'
import { docsHelpOn, helpIndex } from './data'
import { docsHome, searchDocs, searchLangs, type DocsHit } from './search'

export const DOCS_TOOL = 'trina_docs'
export const DOCS_DESCRIPTION = 'Search the docs of this app (how to use, set up or fix it), kept on this server. Returns up to 3 pages, each with a short passage and its link.'
export const DocsInput = z.strictObject({
  query: z.string().trim().min(1).max(300).describe('The question, or its key words, in any language.'),
})

/** The tool's JSON schema as the engine sees it. */
export function docsInputSchema(): Record<string, unknown> {
  const j = z.toJSONSchema(DocsInput, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
  delete j.$schema
  return j
}

/** The result's text: each page with its link, the section and the passage. */
export function docsText(hits: DocsHit[], home: string, english: boolean): string {
  // a search in another language: some pages are only in English, and English words find them
  const again = english ? '' : ' Some pages are only in English: if this does not answer it, search once more in English words.'
  if (!hits.length) return `Nothing in the docs matches.${again} Do not guess how the app works: say you did not find it in the docs, and give the docs' address: ${home}`
  return [
    `Docs of this app, best match first. Answer from them, and end your answer with the link of the page you used.${again}`,
    ...hits.map((h, i) => `${i + 1}. ${neutralizeTags(h.title)}: ${h.url}${h.english ? ' (English page)' : ''}\n   ${neutralizeTags(h.heading)}: ${neutralizeTags(h.passage)}`),
  ].join('\n')
}

/** Is the tool offered (the server has docs)? */
export const docsToolOn = (root?: string) => docsHelpOn(root)

/** The tool of one turn, for a person whose language is `locale`. */
export function docsTool(locale: Locale, root?: string): Tool {
  return {
    name: DOCS_TOOL,
    description: DOCS_DESCRIPTION,
    inputSchema: docsInputSchema(),
    async call(args) {
      const a = DocsInput.safeParse(args)
      if (!a.success) return { content: [{ type: 'text', text: `Invalid input: ${a.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}` }], isError: true, summary: `${DOCS_TOOL} -> invalid input` }
      const index = helpIndex(root)
      if (!index) return { content: [{ type: 'text', text: 'Error: the docs are not on this server.' }], isError: true, summary: `${DOCS_TOOL} -> no docs` }
      const hits = searchDocs(index, a.data.query, locale)
      // the audit line names the pages, never the question (the person's words)
      return { content: [{ type: 'text', text: docsText(hits, docsHome(index, locale), searchLangs(a.data.query, locale)[0] === 'en') }], summary: `${DOCS_TOOL} -> ${hits.length ? hits.map((h) => h.slug).join(', ') : 'nothing found'}` }
    },
  }
}

/** The instructions' line where the tool is offered: what to search it for, the link at the end, and prices. */
export function docsRule(appName: string, root?: string): string {
  const pricing = helpIndex(root)?.pricing
  return `Questions about using, setting up or fixing ${appName}: search with ${DOCS_TOOL} first, answer from what it finds and end with the page's link.${pricing ? ` Prices and plans: link ${pricing}.` : ''}`
}
