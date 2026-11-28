// The only Chrome DevTools Protocol methods this extension sends (docs/decisions/20261128-trina-in-chrome.md: "a fixed
// list of CDP methods"). No cookie, storage or browser-wide method: the extension never reads the person's cookies or
// site storage, and it drives only the tabs of its own group. tests/unit/chrome-ext-cdp.test.ts fails when the code
// sends a method that is not here, or when this list gains a cookie or storage method.
export const CDP_METHODS: ReadonlySet<string> = new Set([
  // pages: load, history, pictures, frames, dialogs, file pickers
  'Page.enable',
  'Page.navigate',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Page.stopLoading',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'Page.getFrameTree',
  'Page.createIsolatedWorld',
  'Page.handleJavaScriptDialog',
  'Page.setInterceptFileChooserDialog',
  // scripts: the page script in an isolated world, the AI's javascript_tool in the page
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.releaseObject',
  'Runtime.runIfWaitingForDebugger',
  // the element behind a file picker (file_upload)
  'DOM.resolveNode',
  // what the page requested (read_network_requests: method, address, status, type; one body on request)
  'Network.enable',
  'Network.getResponseBody',
  'Network.setBlockedURLs',
  // the AI's mouse and keyboard
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  // resize_window
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
  'Emulation.setTouchEmulationEnabled',
  'Emulation.setUserAgentOverride',
  'Emulation.setEmulatedMedia',
  // the guards: requests to the team's addresses, and a scripted page's requests to sites nobody allowed
  'Fetch.enable',
  'Fetch.disable',
  'Fetch.failRequest',
  'Fetch.continueRequest',
  // out-of-process frames and workers of a driven tab (their file pickers and requests are guarded too), and closing
  // a window a scripted document opened (it cannot be guarded)
  'Target.setAutoAttach',
  'Target.closeTarget',
])
