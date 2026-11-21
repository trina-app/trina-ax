// A chat file's link (/c/<chat>?file=<id>, an answer's attached file) opens its viewer beside the chat only when the
// person can open the chat and the file (QA TC-6935: someone taken out of the chat got "This chat is no longer shared"
// beside a viewer titled "file" that said "This format can't be previewed" with a Download that could not work, and at
// phone width the viewer covered the real reason).

/** What the page does with ?file=<id> now:
 *  none  no link, a malformed id, or the chat does not open (its page says why; no viewer over it)
 *  wait  the chat is still loading
 *  open  the chat is open and its messages name the file: open the viewer with that name
 *  look  the chat is open but the file is not among the messages on screen: ask the server for it (its versions); a
 *        file I may not open gets one plain notice and no viewer (the server's 404 is the same for gone and not mine) */
export type ChatFileLinkStep = 'none' | 'wait' | 'open' | 'look'

export function chatFileLinkStep(o: { file: string | null; loading: boolean; loadError: unknown; name: string | null }): ChatFileLinkStep {
  if (!o.file || !/^[A-Za-z0-9_-]{1,64}$/.test(o.file)) return 'none'
  if (o.loadError) return 'none'
  if (o.loading) return 'wait'
  return o.name ? 'open' : 'look'
}

/** The name a chat file's versions give it (the newest), or null */
export function chatFileName(v: { items: { name: string; head?: true }[] } | null | undefined): string | null {
  if (!v?.items.length) return null
  return (v.items.find((i) => i.head) ?? v.items[v.items.length - 1]!).name || null
}
