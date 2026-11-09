// The team page's right-click menu (main/context-menu.ts). Electron shows no menu of its own, so a right-click on a
// photo, a link or selected text did nothing in the app. What is under the pointer (Electron's context-menu facts)
// decides the items, in the app's language: a photo 이미지 복사 / 이미지 저장…, a link 링크 복사, selected text 복사, a
// text field 잘라내기 / 복사 / 붙여넣기 / 모두 선택. Nothing else: no Inspect, nothing that opens a link (docs/DECISIONS.md
// "Desktop: a right-click menu"). Pure: unit-tested in tests/unit/e-desktop-common.test.ts.
import { t, type UiLocale } from './i18n'

/** The parts of Electron's ContextMenuParams the menu reads. */
export interface ContextFacts {
  mediaType: string
  srcURL: string
  hasImageContents: boolean
  linkURL: string
  selectionText: string
  isEditable: boolean
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean }
}

/** What an item does (main/context-menu.ts). The text items are the page's own edit commands, run on the page that
 * was right-clicked (not an edit role, which goes to whichever view has the focus). */
export type ContextAction = 'copyImage' | 'saveImage' | 'copyLink' | 'cut' | 'copy' | 'paste' | 'selectAll'

export type ContextItem = { id: ContextAction; label: string; enabled: boolean } | { type: 'separator' }

/** The items for what was right-clicked, in groups with a line between; none: no menu at all. `canSave`: whether the
 * image's address may be saved through the app (saveableImage). */
export function contextMenuItems(p: ContextFacts, locale: UiLocale, o: { canSave: (src: string) => boolean }): ContextItem[] {
  const groups: ContextItem[][] = []
  if (p.isEditable) {
    // a text field: the four edit items, each greyed out when it cannot apply (nothing selected, nothing to paste)
    groups.push(
      [
        { id: 'cut', label: t(locale, 'ctx.cut'), enabled: p.editFlags.canCut },
        { id: 'copy', label: t(locale, 'ctx.copy'), enabled: p.editFlags.canCopy },
        { id: 'paste', label: t(locale, 'ctx.paste'), enabled: p.editFlags.canPaste },
      ],
      [{ id: 'selectAll', label: t(locale, 'ctx.selectAll'), enabled: p.editFlags.canSelectAll }],
    )
  } else {
    if (p.linkURL) groups.push([{ id: 'copyLink', label: t(locale, 'ctx.copyLink'), enabled: true }])
    if (p.mediaType === 'image') {
      const image: ContextItem[] = []
      if (p.hasImageContents) image.push({ id: 'copyImage', label: t(locale, 'ctx.copyImage'), enabled: true })
      if (p.srcURL && o.canSave(p.srcURL)) image.push({ id: 'saveImage', label: t(locale, 'ctx.saveImage'), enabled: true })
      if (image.length) groups.push(image)
    }
    if (p.selectionText.trim() && p.editFlags.canCopy) groups.push([{ id: 'copy', label: t(locale, 'ctx.copy'), enabled: true }])
  }
  return groups.flatMap((g, i) => (i ? [{ type: 'separator' as const }, ...g] : g))
}

/**
 * Whether 이미지 저장… may save this image: one the team page itself serves (the team address or its office address)
 * or a picture the page made of its own bytes (a `blob:` address of those origins: the preview panel's original).
 * Anything else (an image from another site, a `data:` picture in an artifact) can be copied, not saved through the
 * app: the save would fetch it with the team's session.
 */
export function saveableImage(src: string, allowedOrigins: readonly string[]): boolean {
  let u: URL
  try {
    u = new URL(src)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'blob:') return false
  // a blob: address's origin is the page's that made it ("blob:https://acme.example/…" → https://acme.example)
  return u.origin !== 'null' && allowedOrigins.includes(u.origin)
}
