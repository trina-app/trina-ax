// Words that depend on where the page runs: inside the phone app (a WebView around this web app, lib/mobile.ts
// mobileApp) there is no browser to set up and no new tab, so the copy names the phone's Settings and "your browser"
// (a link leaves the app) instead. A computer's browser, a phone's browser and the desktop app keep the browser words.
import type { MobileConfig } from '../../../mobile/src/protocol'

/** Where the microphone was blocked, and so where it is allowed again: the browser's site settings (app: null), or the
 * phone's Settings for this app (iPhone and iPad: Settings › {product} › Microphone; Android: Apps › {product} ›
 * Permissions). The app's bridge says which phone it is (lib/mobile.ts mobileApp), not the user agent. */
export function micDeniedKey(app: Pick<MobileConfig, 'platform'> | null): 'voice.denied' | 'voice.deniedIos' | 'voice.deniedAndroid' {
  if (!app) return 'voice.denied'
  return app.platform === 'ios' ? 'voice.deniedIos' : 'voice.deniedAndroid'
}

/** An answer's outside image is a link: in a browser it opens in a new tab, in the phone app it leaves the app for the
 * phone's browser. */
export function externalImageHintKey(inPhoneApp: boolean): 'md.externalImageHint' | 'md.externalImageHintApp' {
  return inPhoneApp ? 'md.externalImageHintApp' : 'md.externalImageHint'
}

/** The ⋯ menu's chat item: a file is asked about, a folder starts a chat about the folder. */
export function chatItemKey(folder: boolean): 'files.chatWithFolder' | 'files.askAi' {
  return folder ? 'files.chatWithFolder' : 'files.askAi'
}
