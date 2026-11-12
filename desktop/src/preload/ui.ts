// Preload of the desktop app's own screens (welcome / team list, the host strip and the browser pane toolbar), served from the
// mycel-ui:// scheme. The main process answers each channel only for the view it belongs to (main/main.ts registerIpc).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const on = (channel: string) => (cb: (payload: any) => void) => {
  const handler = (_e: IpcRendererEvent, payload: unknown) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

contextBridge.exposeInMainWorld('mycelUi', {
  strings: () => ipcRenderer.sendSync('ui:strings'),
  onLocale: on('ui:locale'),
  setLocale: (locale: string) => ipcRenderer.send('ui:set-locale', String(locale)),
  welcome: {
    state: () => ipcRenderer.invoke('ui:welcome-state'),
    onState: on('ui:welcome-state'),
    add: (address: string, confirmed?: boolean) => ipcRenderer.invoke('ui:add-team', String(address), confirmed === true),
    openLink: (kind: 'signup' | 'docs') => ipcRenderer.send('ui:open-link', kind === 'signup' ? 'signup' : 'docs'),
    answerLink: (yes: boolean, host: string) => ipcRenderer.invoke('ui:link-answer', yes === true, String(host)),
    linkShown: (id: number) => ipcRenderer.send('ui:link-shown', Number(id)),
    open: (id: string) => ipcRenderer.send('ui:open-team', String(id)),
    remove: (id: string) => ipcRenderer.invoke('ui:remove-team', String(id)),
    back: () => ipcRenderer.send('ui:back'),
    retry: () => ipcRenderer.send('ui:retry'),
  },
  hostbar: {
    state: () => ipcRenderer.invoke('ui:hostbar-state'),
    onState: on('ui:hostbar'),
    teams: () => ipcRenderer.send('ui:hostbar-teams'),
  },
  pane: {
    state: () => ipcRenderer.invoke('ui:pane-state'),
    onState: on('ui:pane-state'),
    onPrompts: on('ui:pane-prompts'),
    onActivity: on('ui:pane-activity'),
    onActivityReset: on('ui:pane-activity-reset'),
    onSites: on('ui:pane-sites'),
    navigate: (url: string) => ipcRenderer.send('ui:pane-navigate', String(url)),
    history: (dir: 'back' | 'forward' | 'reload') => ipcRenderer.send('ui:pane-history', dir),
    newTab: () => ipcRenderer.send('ui:pane-new-tab'),
    select: (id: string) => ipcRenderer.send('ui:pane-select', String(id)),
    closeTab: (id: string) => ipcRenderer.send('ui:pane-close-tab', String(id)),
    close: () => ipcRenderer.send('ui:pane-close'),
    stop: () => ipcRenderer.send('ui:pane-stop'),
    answer: (id: string, decision: 'once' | 'always' | 'deny') => ipcRenderer.send('ui:pane-answer', { id: String(id), decision }),
    toolbarHeight: (h: number) => ipcRenderer.send('ui:pane-toolbar-height', Number(h)),
    width: () => ipcRenderer.invoke('ui:pane-width'),
    onWidth: on('ui:pane-width'),
    drag: (phase: 'start' | 'move' | 'end' | 'reset', edgeX?: number) => ipcRenderer.send('ui:pane-drag', String(phase), edgeX === undefined ? undefined : Number(edgeX)),
    resizeKey: (key: string, shift: boolean) => ipcRenderer.send('ui:pane-resize-key', String(key), shift === true),
    sites: () => ipcRenderer.invoke('ui:pane-sites'),
    removeSite: (host: string) => ipcRenderer.send('ui:pane-site-remove', String(host)),
    clearSites: () => ipcRenderer.send('ui:pane-sites-clear'),
    setSiteAccess: (v: 'ask' | 'all') => ipcRenderer.send('ui:pane-site-access', v === 'all' ? 'all' : 'ask'),
  },
})
