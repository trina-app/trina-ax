// The one door to the DevTools Protocol: every command goes through cdp(), which refuses any method outside
// CDP_METHODS (cdp-methods.ts). tests/unit/chrome-ext-cdp.test.ts checks that no other file calls
// chrome.debugger.sendCommand and that every method named in a cdp( call is on the list.
import { CDP_METHODS } from './cdp-methods'

/** a tab, or one of its child targets (an out-of-process frame or a worker) */
export interface Target {
  tabId: number
  sessionId?: string
}

export function cdp<T = any>(target: Target, method: string, params?: Record<string, unknown>): Promise<T> {
  if (!CDP_METHODS.has(method)) return Promise.reject(new Error(`The extension does not send ${method}.`))
  return chrome.debugger.sendCommand(target.sessionId ? { tabId: target.tabId, sessionId: target.sessionId } : { tabId: target.tabId }, method, params) as Promise<T>
}
