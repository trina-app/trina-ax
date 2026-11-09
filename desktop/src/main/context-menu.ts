// The team page's right-click menu: the items common/context-menu.ts picks for what is under the pointer. 이미지 복사
// copies the picture as drawn (Electron's copyImageAt: the preview panel's original, a message's thumbnail), 이미지
// 저장… downloads the team page's own image with the app's usual save dialog, 링크 복사 puts the address on the
// clipboard (no item opens a link), and the text items are Electron's edit roles.
import { BaseWindow, clipboard, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { contextMenuItems, saveableImage, type ContextAction } from '../common/context-menu'
import type { UiLocale } from '../common/i18n'

export function attachContextMenu(wc: WebContents, o: { window: BaseWindow; locale: () => UiLocale; allowedOrigins: () => readonly string[] }) {
  wc.on('context-menu', (_e, p) => {
    const items = contextMenuItems(p, o.locale(), { canSave: (src) => saveableImage(src, o.allowedOrigins()) })
    if (!items.length || wc.isDestroyed() || o.window.isDestroyed()) return
    const run: Record<ContextAction, () => void> = {
      copyImage: () => wc.copyImageAt(p.x, p.y),
      // checked again at the click: the page may have moved to another address while the menu was open
      saveImage: () => saveableImage(p.srcURL, o.allowedOrigins()) && wc.downloadURL(p.srcURL),
      copyLink: () => clipboard.writeText(p.linkURL),
    }
    const template: MenuItemConstructorOptions[] = items.map((it) => ('id' in it ? { label: it.label, click: () => !wc.isDestroyed() && run[it.id]() } : it))
    Menu.buildFromTemplate(template).popup({ window: o.window, frame: p.frame ?? undefined })
  })
}
