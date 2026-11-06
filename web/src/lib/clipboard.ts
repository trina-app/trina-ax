// Writing to the clipboard with more than plain text (lib/richCopy.tsx makes an answer's HTML): the async clipboard
// when the page may use it (https, the desktop app: its team page may write the clipboard, desktop/src/main/security.ts),
// else the copy command, which works on plain http too (a team server on the office network) and in older browsers,
// else the plain text alone.
export interface ClipboardDeps {
  clipboard?: Pick<Clipboard, 'write' | 'writeText'> | null
  ClipboardItem?: typeof ClipboardItem | null
  /** a copy command whose `copy` event carries both flavours (plain http on an office network, older browsers) */
  copyEvent?: (data: { html: string; plain: string }) => boolean
}

/** document.execCommand('copy') with a listener that sets both flavours. A selected hidden text area gives the
 * command something to copy, which Safari needs to run it at all. */
function copyEvent(data: { html: string; plain: string }): boolean {
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return
    e.clipboardData.setData('text/html', data.html)
    e.clipboardData.setData('text/plain', data.plain)
    e.preventDefault()
  }
  const ta = document.createElement('textarea')
  ta.value = data.plain
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.addEventListener('copy', onCopy, true)
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.removeEventListener('copy', onCopy, true)
    ta.remove()
  }
}

const pageDeps = (): ClipboardDeps => ({
  clipboard: typeof navigator !== 'undefined' ? navigator.clipboard ?? null : null,
  ClipboardItem: typeof ClipboardItem !== 'undefined' ? ClipboardItem : null,
  copyEvent,
})

/** Both flavours on the clipboard: the async clipboard first (https, the desktop app), else the copy command, else at
 * least the plain text. Resolves false when nothing could be copied. */
export async function writeRich(data: { html: string; plain: string }, deps: ClipboardDeps = pageDeps()): Promise<boolean> {
  const { clipboard, ClipboardItem: Item } = deps
  if (clipboard?.write && Item) {
    try {
      await clipboard.write([new Item({ 'text/html': new Blob([data.html], { type: 'text/html' }), 'text/plain': new Blob([data.plain], { type: 'text/plain' }) })])
      return true
    } catch {
      // not allowed here (no focus, an older browser without text/html): try the copy command
    }
  }
  if (deps.copyEvent?.(data)) return true
  try {
    await clipboard?.writeText(data.plain)
    return !!clipboard
  } catch {
    return false
  }
}
