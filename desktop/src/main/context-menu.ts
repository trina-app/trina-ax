// The right-click menu: the items common/context-menu.ts picks for what is under the pointer. 이미지 복사 copies the
// picture as drawn (Electron's copyImageAt: the preview panel's original, a message's thumbnail), 이미지 저장…
// downloads the team page's own image with the app's usual save dialog, 링크 복사 puts the address on the clipboard
// (no item opens a link), and the text items run the page's own edit commands on the page that was right-clicked. The
// photo items only where the team page itself was right-clicked, never in a frame inside it (an artifact).
import { BaseWindow, clipboard, Menu, type WebContents, type WebFrameMain } from 'electron'
import { contextMenuItems, isTeamPage, saveableImage, type ClickedFrame, type ContextAction } from '../common/context-menu'
import type { UiLocale } from '../common/i18n'

function clickedFrame(f: WebFrameMain | null | undefined): ClickedFrame | null {
  try {
    return f && !f.isDestroyed() && !f.detached ? { url: f.url, top: f.parent === null } : null
  } catch {
    return null // gone meanwhile
  }
}

/** right-click menus of the app open now: the window leaves the keyboard where it is meanwhile (app-window.ts) */
let menusOpen = 0
export const contextMenuOpen = () => menusOpen > 0

/** `allowedOrigins`: the team's addresses (the team page); none for the app's own screens (their text fields and links). */
export function attachContextMenu(wc: WebContents, o: { window: BaseWindow; locale: () => UiLocale; allowedOrigins: () => readonly string[] }) {
  wc.on('context-menu', (_e, p) => {
    const teamPage = () => isTeamPage(clickedFrame(p.frame), o.allowedOrigins())
    const items = contextMenuItems(p, o.locale(), { teamPage: teamPage(), allowedOrigins: o.allowedOrigins() })
    if (!items.length || wc.isDestroyed() || o.window.isDestroyed()) return
    const run: Record<ContextAction, () => void> = {
      copyImage: () => teamPage() && wc.copyImageAt(p.x, p.y),
      // checked again at the click: the page may have moved to its other address, or the frame gone, meanwhile
      saveImage: () => teamPage() && saveableImage(p.srcURL, o.allowedOrigins()) && wc.downloadURL(p.srcURL),
      copyLink: () => void clipboard.writeText(p.linkURL).catch(() => {}),
      cut: () => wc.cut(),
      copy: () => wc.copy(),
      paste: () => wc.paste(),
      selectAll: () => wc.selectAll(),
    }
    const menu = Menu.buildFromTemplate(items.map((it) => ('id' in it ? { label: it.label, enabled: it.enabled, click: () => !wc.isDestroyed() && run[it.id]() } : it)))
    menusOpen++
    let closed = false
    const close = () => {
      if (!closed) menusOpen--
      closed = true
    }
    try {
      menu.popup({ window: o.window, frame: p.frame ?? undefined, callback: close })
    } catch {
      close()
    }
  })
}
