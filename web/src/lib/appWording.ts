// Words that depend on where the page runs: inside the phone app (a WebView around this web app, lib/mobile.ts
// mobileApp) there is no browser to set up and no new tab, so the copy names the phone's Settings and "your browser"
// (a link leaves the app) instead. A computer's browser, a phone's browser and the desktop app keep the browser words.
import type { MobileConfig } from '../../../mobile/src/protocol'
import type { RecorderErrorCode } from './recorder'

/** Where the microphone was blocked, and so where it is allowed again: the browser's site settings (app: null), or the
 * phone's Settings for this app (iPhone and iPad: Settings › {product} › Microphone; Android: Apps › {product} ›
 * Permissions). The app's bridge says which phone it is (lib/mobile.ts mobileApp), not the user agent. */
export function micDeniedKey(app: Pick<MobileConfig, 'platform'> | null): 'voice.denied' | 'voice.deniedIos' | 'voice.deniedAndroid' {
  if (!app) return 'voice.denied'
  return app.platform === 'ios' ? 'voice.deniedIos' : 'voice.deniedAndroid'
}

export type MicErrorKey = ReturnType<typeof micDeniedKey> | 'voice.notAllowed' | 'voice.noMic' | 'voice.micFailed' | 'voice.micFailedApp' | 'voice.unsupported'

/** What the message box says when the microphone did not start (lib/recorder.ts RecorderError), honestly by cause:
 * - refused, and the browser would still ask (`permission` "prompt": the question was closed or answered "not now"):
 *   ask again by tapping the mic. Only in a browser: inside the phone app the phone answers, and a phone that refused
 *   is changed in its Settings;
 * - refused otherwise: blocked, and where to allow it (micDeniedKey), with the phone app's Open Settings;
 * - no microphone (a computer without one) or one that did not start: never "blocked". Inside the phone app the phone
 *   always has one, so both are "could not start" there, with the app update as the way out when it keeps happening
 *   (the Android app 1.0.8 and older lacked a permission the WebView needs, QA TC-4740). */
export function micErrorKey(code: RecorderErrorCode, o: { app: Pick<MobileConfig, 'platform'> | null; permission: PermissionState | null }): MicErrorKey {
  if (code === 'unsupported') return 'voice.unsupported'
  if (code === 'denied') return !o.app && o.permission === 'prompt' ? 'voice.notAllowed' : micDeniedKey(o.app)
  if (o.app) return 'voice.micFailedApp'
  return code === 'missing' ? 'voice.noMic' : 'voice.micFailed'
}

/** Whether that wording is "blocked", so the phone app shows its Open Settings beside it. */
export const micBlocked = (key: MicErrorKey) => key === 'voice.denied' || key === 'voice.deniedIos' || key === 'voice.deniedAndroid'

/** Settings › Notifications › "Show message preview": the Android app's pushes carry no text and the app does not ask
 * its team for the first line yet (the iPhone app's notification extension does, docs/DECISIONS.md "아이폰 알림의
 * 이름"), so inside it the words say the setting reaches the computer and the iPhone only (QA TC-4692). */
export function messagePreviewDescKey(app: Pick<MobileConfig, 'platform'> | null): 'notifications.messagePreviewDesc' | 'notifications.messagePreviewDescAndroid' {
  return app?.platform === 'android' ? 'notifications.messagePreviewDescAndroid' : 'notifications.messagePreviewDesc'
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
