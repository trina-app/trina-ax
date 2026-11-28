// The few extension APIs this extension uses, typed by hand (no @types/chrome dependency). Only what the code calls;
// Manifest V3 promise forms.

declare namespace chrome {
  export interface Event<F extends (...args: any[]) => any> {
    addListener(f: F): void
    removeListener(f: F): void
  }

  export namespace runtime {
    interface MessageSender { id?: string; url?: string; tab?: tabs.Tab }
    const id: string
    const lastError: { message?: string } | undefined
    function getManifest(): { version: string; name: string }
    function getURL(path: string): string
    function sendMessage<T = unknown>(message: unknown): Promise<T>
    /** one message to a native messaging host (Chrome starts it, for the ids its manifest allows only) */
    function sendNativeMessage(application: string, message: unknown): Promise<unknown>
    const onMessage: Event<(message: any, sender: MessageSender, sendResponse: (r?: unknown) => void) => boolean | void>
    const onStartup: Event<() => void>
    const onInstalled: Event<(details: { reason: string }) => void>
  }

  export namespace i18n {
    function getMessage(name: string, substitutions?: string | string[]): string
    function getUILanguage(): string
  }

  export namespace storage {
    interface Area {
      get(keys?: string | string[] | null): Promise<Record<string, any>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string | string[]): Promise<void>
    }
    const local: Area
    const session: Area
  }

  export namespace alarms {
    interface Alarm { name: string }
    function create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): Promise<void>
    const onAlarm: Event<(alarm: Alarm) => void>
  }

  export namespace permissions {
    function request(p: { origins?: string[] }): Promise<boolean>
    function contains(p: { origins?: string[] }): Promise<boolean>
    function remove(p: { origins?: string[] }): Promise<boolean>
    const onAdded: Event<(p: { origins?: string[] }) => void>
  }

  export namespace action {
    function setBadgeText(d: { text: string }): Promise<void>
    function setBadgeBackgroundColor(d: { color: string }): Promise<void>
    function setTitle(d: { title: string }): Promise<void>
  }

  export namespace tabs {
    /** without the "tabs" permission url / title are present only for origins the extension has access to */
    interface Tab {
      id?: number
      windowId: number
      groupId: number
      active: boolean
      index: number
      openerTabId?: number
      url?: string
      pendingUrl?: string
      status?: string
    }
    const TAB_ID_NONE: number
    function get(id: number): Promise<Tab>
    function getCurrent(): Promise<Tab | undefined>
    function query(q: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean; groupId?: number; windowId?: number }): Promise<Tab[]>
    function create(p: { url?: string; active?: boolean; windowId?: number; index?: number; openerTabId?: number }): Promise<Tab>
    function update(id: number, p: { active?: boolean; url?: string }): Promise<Tab>
    function remove(id: number | number[]): Promise<void>
    function group(o: { tabIds: number | number[]; groupId?: number; createProperties?: { windowId?: number } }): Promise<number>
    function ungroup(tabIds: number | number[]): Promise<void>
    const onCreated: Event<(tab: Tab) => void>
    const onRemoved: Event<(tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void>
    const onUpdated: Event<(tabId: number, change: { url?: string; status?: string; groupId?: number }, tab: Tab) => void>
  }

  export namespace tabGroups {
    type Color = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'
    interface TabGroup { id: number; title?: string; color: Color; windowId: number; collapsed: boolean }
    const TAB_GROUP_ID_NONE: number
    function get(id: number): Promise<TabGroup>
    function query(q: { title?: string; windowId?: number }): Promise<TabGroup[]>
    function update(id: number, p: { title?: string; color?: Color; collapsed?: boolean }): Promise<TabGroup>
    const onRemoved: Event<(group: TabGroup) => void>
  }

  export namespace windows {
    interface Window { id?: number; type?: string; focused: boolean; state?: string }
    function getLastFocused(o?: { windowTypes?: string[] }): Promise<Window>
    function getAll(o?: { windowTypes?: string[] }): Promise<Window[]>
    function create(o?: { url?: string; focused?: boolean; type?: string; state?: string }): Promise<Window & { tabs?: tabs.Tab[] }>
    function get(id: number): Promise<Window>
    function remove(id: number): Promise<void>
    const onRemoved: Event<(windowId: number) => void>
  }

  // `debugger` is a reserved word: declared under another name and exported as chrome.debugger
  export { debugger_ as debugger }
  export namespace debugger_ {
    interface Debuggee { tabId?: number; targetId?: string; extensionId?: string }
    /** a child target (an out-of-process frame or a worker) reached through Target.setAutoAttach flatten */
    interface DebuggerSession extends Debuggee { sessionId?: string }
    interface TargetInfo { type: string; id: string; tabId?: number; url: string; title: string; attached: boolean }
    function attach(target: Debuggee, version: string): Promise<void>
    function detach(target: Debuggee): Promise<void>
    function sendCommand(target: DebuggerSession, method: string, params?: Record<string, unknown>): Promise<any>
    function getTargets(): Promise<TargetInfo[]>
    const onEvent: Event<(source: DebuggerSession, method: string, params?: any) => void>
    const onDetach: Event<(source: Debuggee, reason: string) => void>
  }
}

interface NavigatorUAData {
  brands?: { brand: string; version: string }[]
  platform?: string
  mobile?: boolean
}
interface Navigator {
  userAgentData?: NavigatorUAData
  brave?: unknown
}
