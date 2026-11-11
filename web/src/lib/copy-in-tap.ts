// Copying the invite or team link inside the person's tap on "Copy invite & get the app" (docs/DECISIONS.md "Get the
// app"). The answer has to be known before the tap's own navigation to the store goes ahead: in-app browsers
// (KakaoTalk, Instagram, Line) often have no navigator.clipboard or refuse it, and a person who installs with nothing
// to paste has lost the invite. So the async Clipboard API is started inside the tap (never awaited before the
// navigation), and the old synchronous copy (a hidden read-only textarea + execCommand('copy')) gives the answer now.

export interface CopyEnv {
  doc: Pick<Document, 'createElement' | 'execCommand' | 'activeElement'> & { body: Pick<HTMLElement, 'appendChild' | 'removeChild'> }
  clipboard?: { writeText(text: string): Promise<void> } | null
}

/** The synchronous copy: true only when the browser says it copied. */
export function execCopy(text: string, doc: CopyEnv['doc']): boolean {
  const before = doc.activeElement as HTMLElement | null
  const area = doc.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.setAttribute('aria-hidden', 'true')
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px'
  doc.body.appendChild(area)
  let ok = false
  try {
    area.select()
    area.setSelectionRange(0, text.length)
    ok = doc.execCommand('copy') === true
  } catch {
    ok = false
  } finally {
    doc.body.removeChild(area)
    before?.focus?.()
  }
  return ok
}

/**
 * Copy `text` within the tap. `now`: copied for sure already (the synchronous copy worked); otherwise `later` is the
 * Clipboard API's answer (null when there is none). The write starts here, in the gesture, either way.
 */
export function copyInTap(text: string, env: CopyEnv): { now: boolean; later: Promise<boolean> | null } {
  let later: Promise<boolean> | null = null
  try {
    later = env.clipboard?.writeText ? env.clipboard.writeText(text).then(() => true, () => false) : null
  } catch {
    later = null
  }
  return { now: execCopy(text, env.doc), later }
}
