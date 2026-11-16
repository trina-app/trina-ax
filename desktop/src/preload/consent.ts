// Preload of the app's own "Find work files on this computer" window (main/work-consent-window.ts), served from the
// mycel-ui:// scheme. It reads the finished words and gives back the person's answer; the main process answers these
// channels only for that one window (WorkConsentWindow), so the team page can neither read nor answer them.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('trinaConsent', {
  view: () => ipcRenderer.sendSync('consent:view'),
  answer: (yes: boolean) => ipcRenderer.send('consent:answer', yes === true),
})
