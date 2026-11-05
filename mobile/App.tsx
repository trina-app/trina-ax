import { StatusBar } from 'expo-status-bar'
import { NavigationBar } from 'expo-navigation-bar'
import Constants from 'expo-constants'
import * as Crypto from 'expo-crypto'
import * as WebBrowser from 'expo-web-browser'
import { getLocales } from 'expo-localization'
import { createContext, useContext, useEffect, useRef, useState, type ComponentType, type RefAttributes, type ReactNode } from 'react'
import { ActivityIndicator, Alert, Appearance, AppState, BackHandler, Keyboard, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView as NativeWebView, type WebViewProps } from 'react-native-webview'
import { FileTransfers, MobileReceiver } from './src/bridge'
import { clearDownloadCache, fileTransferIO } from './src/files'
import { APPEARANCE_CAPABILITY, MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_PERMISSION_CAPABILITY, PUSH_REGISTERED_CAPABILITY, googleOAuthUrl, navigationDecision, sameTeam, type MobileConfig } from './src/protocol'
import { accentInk, mobileProduct } from './src/product'
import { devicePushToken, devices, forgetDelivered, notificationPermission, onNotificationTap, openAppSettings, quietForeground } from './src/push'
import { DARK, LIGHT, frame, insetScript, isDark, type Palette } from './src/look'
import { currentDevice, leaveTeam, rememberDevice, retryRemovals } from './src/device'
import { offlineError, stringsFor } from './src/strings'
import { checkTeam, parseTeamAddress, savedTeamSince, savedTeamUrl, saveTeamUrl } from './src/team'
import type { TeamAddress } from './src/address'

const product = mobileProduct(Constants.expoConfig?.extra?.teamAxEdition)
const VERSION = Constants.expoConfig?.version ?? '1.0.0'
const t = stringsFor(getLocales()[0]?.languageCode)
quietForeground()
type WebHandle = { goBack(): void; reload(): void; injectJavaScript(script: string): void }
// WebView 14's public component declaration omits the forwarded ref; native implementations expose these methods.
const WebView = NativeWebView as unknown as ComponentType<WebViewProps & RefAttributes<WebHandle>>
/** The colours around the page: the page's look once it said (appearance-v1), the phone's before. */
const Look = createContext<Palette>(LIGHT)
type PageLook = { dark: boolean; system: boolean }
/** iOS: the status bar text is the system's default style, which follows the look of the app's windows. In the simulator
 * (iOS 26) React Native's StatusBar style kept the look of the launch and did not follow later changes, so iOS gets no
 * StatusBar style: a page with a theme of its own sets that look on the app's windows, a page that follows the phone
 * (and every native screen) leaves the windows to the phone, so a change of the phone's look still reaches the page. */
function windowLook(page: PageLook | null) {
  if (Platform.OS === 'ios') Appearance.setColorScheme(!page || page.system ? 'unspecified' : page.dark ? 'dark' : 'light')
}
const bootstrap = (config: MobileConfig, ready = false) => `if(window.top===window.self){Object.defineProperty(window,'mycelMobile',{value:Object.freeze(${JSON.stringify(config)}),configurable:true});${ready ? "window.dispatchEvent(new Event('mycel:mobile-ready'));" : ''}}true;`

export default function App() {
  const [team, setTeam] = useState<TeamAddress | null | undefined>()
  // A tapped notification's path on the current team, with a counter so the same path can be opened twice.
  const [opened, setOpened] = useState<{ path: string; n: number } | null>(null)
  const since = useRef(Date.now()), hasTeam = useRef(false), device = useRef<string | null>(null)
  // the page's look (appearance-v1): status bar text and the native screens follow it; null until a page said
  const [page, setPage] = useState<PageLook | null>(null)
  const dark = isDark(page?.dark ?? null, useColorScheme())
  useEffect(() => windowLook(page), [page])
  useEffect(() => {
    try { clearDownloadCache() } catch { /* a later operation reports an inaccessible cache */ }
    let off = () => {}
    // removals owed to teams left while their server could not be reached
    void retryRemovals(devices).catch(() => {})
    void Promise.all([savedTeamUrl(), savedTeamSince()]).then(async ([origin, chosen]) => {
      since.current = chosen; hasTeam.current = !!origin
      device.current = origin ? (await currentDevice(devices, origin).catch(() => null))?.deviceId ?? null : null
      setTeam(origin ? { origin, entryPath: '/' } : null)
      off = onNotificationTap(() => since.current, () => device.current, path => { if (hasTeam.current) setOpened(o => ({ path, n: (o?.n ?? 0) + 1 })) })
    })
    return () => off()
  }, [])
  // Android: the status bar icons and the three-button bar's contrast scrim follow the look (React Native set the scrim
  // once, from the phone's look at launch)
  return <SafeAreaProvider><Look.Provider value={dark ? DARK : LIGHT}>{Platform.OS === 'android' && <><StatusBar style={dark ? 'light' : 'dark'} /><NavigationBar style={dark ? 'light' : 'dark'} /></>}
    {team === undefined ? <Center><ActivityIndicator color={product.accent} /></Center>
      : team === null ? <Setup onDone={async address => { await saveTeamUrl(address.origin); since.current = Date.now(); hasTeam.current = true; setOpened(null); setTeam(address) }} />
      : <TeamWeb key={team.origin} address={team} opened={opened} onDevice={id => { device.current = id }} onAppearance={look => setPage(p => p?.dark === look.dark && p.system === look.system ? p : look)}
        onChangeTeam={async () => {
          hasTeam.current = false; device.current = null; forgetDelivered()
          // remove this phone from the team it leaves (now, or at a later start if that server cannot be reached)
          void leaveTeam(devices, team.origin).catch(() => {})
          await saveTeamUrl(null); setOpened(null); setPage(null); setTeam(null)
        }} />}
  </Look.Provider></SafeAreaProvider>
}
// Insets as explicit padding on every native screen: with edge-to-edge (Android, targetSdk 36) the app draws under the
// status bar and the gesture bar, and buttons must stay clear of both.
function Center({ children }: { children: ReactNode }) {
  const i = useSafeAreaInsets(), c = useContext(Look)
  return <View style={[s.fill, s.center, { backgroundColor: c.canvas, paddingTop: i.top + 24, paddingBottom: i.bottom + 24, paddingLeft: i.left + 24, paddingRight: i.right + 24 }]}>{children}</View>
}
function Setup({ onDone }: { onDone: (address: TeamAddress) => Promise<void> }) {
  const [value, setValue] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function connect() {
    if (busy) return
    const address = parseTeamAddress(value)
    if (!address) { setError(t.invalidAddress); return }
    setBusy(true); setError('')
    try {
      if (!(await checkTeam(address.origin))) { setError(t.unreachableSetup); return }
      await onDone(address)
    } catch { setError(t.saveFailed) }
    finally { setBusy(false) }
  }
  const i = useSafeAreaInsets(), c = useContext(Look)
  return <View style={[s.fill, { backgroundColor: c.canvas, paddingTop: i.top, paddingBottom: i.bottom, paddingLeft: i.left, paddingRight: i.right }]}><KeyboardAvoidingView style={[s.fill, s.setup]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <Text style={[s.title, { color: c.ink }]}>{product.name}</Text><Text style={[s.hint, { color: c.muted }]}>{t.setupHint}</Text>
    <TextInput style={[s.input, { borderColor: c.field, backgroundColor: c.surface, color: c.ink }]} value={value} onChangeText={setValue} placeholder={t.setupPlaceholder} placeholderTextColor={c.field}
      autoCapitalize="none" autoCorrect={false} keyboardAppearance={c === DARK ? 'dark' : 'light'}
      keyboardType="url" returnKeyType="go" onSubmitEditing={() => void connect()} editable={!busy} testID="team-url" />
    {!!error && <Text accessibilityRole="alert" style={[s.error, { color: c.danger }]}>{error}</Text>}
    <Pressable style={s.button} onPress={() => void connect()} disabled={busy} testID="team-connect">
      {busy ? <ActivityIndicator color={accentInk(product.accent)} /> : <Text style={s.buttonText}>{t.connect}</Text>}
    </Pressable>
  </KeyboardAvoidingView></View>
}
type Failure = 'offline' | 'unreachable'
function TeamWeb({ address, opened, onDevice, onAppearance, onChangeTeam }: { address: TeamAddress; opened: { path: string; n: number } | null; onDevice: (id: string) => void; onAppearance: (look: PageLook) => void; onChangeTeam: () => Promise<void> }) {
  const web = useRef<WebHandle>(null), navigation = useRef(0), loadFailed = useRef(false), cleanup = useRef(Promise.resolve()), ready = useRef(false)
  const [canBack, setCanBack] = useState(false), [pathname, setPathname] = useState(address.entryPath), [failed, setFailed] = useState<Failure | null>(null)
  const [source, setSource] = useState(address.origin + address.entryPath)
  const insets = useSafeAreaInsets(), c = useContext(Look)
  // the page on screen pads itself (it reported its look, appearance-v1): until then, and again after every full load,
  // the app keeps its own padding, so a team server that has not updated still fits between the system bars
  const [selfPadded, setSelfPadded] = useState(false)
  const receiver = useRef<MobileReceiver | null>(null)
  if (!receiver.current) {
    const config: MobileConfig = { protocol: 1, appVersion: VERSION, platform: Platform.OS === 'ios' ? 'ios' : 'android', nonce: '0'.repeat(64), generation: 1, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_REGISTERED_CAPABILITY, PUSH_PERMISSION_CAPABILITY, APPEARANCE_CAPABILITY] }
    receiver.current = new MobileReceiver(address.origin, config, new FileTransfers(fileTransferIO()), async url => { await Linking.openURL(url) }, {
      token: () => devicePushToken(t.channelName),
      async registered({ deviceId, removeKey }) { await rememberDevice(devices, { origin: address.origin, deviceId, removeKey, at: Date.now() }); onDevice(deviceId) },
      permission: notificationPermission, openSettings: openAppSettings,
    }, look => { onAppearance(look); setSelfPadded(true) })
    void receiver.current.disable()
  }
  const r = receiver.current
  useEffect(() => () => { navigation.current++; void r.disable() }, [r])
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => { if (!canBack) return false; web.current?.goBack(); return true })
    return () => back.remove()
  }, [canBack])
  useEffect(() => {
    // A tapped notification: same-origin path only (checked in src/push.ts), opened in this team's page.
    if (!opened) return
    const target = address.origin + opened.path
    if (!sameTeam(address.origin, target)) return
    setFailed(null)
    if (ready.current) web.current?.injectJavaScript(`window.location.assign(${JSON.stringify(opened.path)});true;`)
    else setSource(target)
  }, [opened, address.origin])
  // a page that pads itself draws under the status bar and the home indicator / navigation bar (web/src/index.css); it
  // gets the insets as CSS variables when it said so, and again when they change (Android's navigation mode)
  const insetJs = insetScript(insets)
  useEffect(() => { if (selfPadded) web.current?.injectJavaScript(insetJs) }, [selfPadded, insetJs])
  // Android draws edge to edge (target SDK 36), so the window no longer shrinks for the keyboard and the page's message
  // box stayed under it. The app lifts the page by the keyboard (React Native reports its height without the navigation
  // bar under it); the page then sees a short viewport and drops its own bottom inset (web/src/lib/viewport.ts).
  const [keyboard, setKeyboard] = useState(0)
  useEffect(() => {
    if (Platform.OS !== 'android') return
    const show = Keyboard.addListener('keyboardDidShow', e => setKeyboard(e.endCoordinates.height))
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(0))
    return () => { show.remove(); hide.remove() }
  }, [])
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') web.current?.injectJavaScript("window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('mycel:mobile-foreground'));true;")
    })
    return () => sub.remove()
  }, [])
  const clear = () => { navigation.current++; cleanup.current = r.disable(); return cleanup.current }
  async function loaded(url: string) {
    const generation = navigation.current
    await cleanup.current
    const random = await Crypto.getRandomBytesAsync(32)
    if (generation !== navigation.current || loadFailed.current || !sameTeam(address.origin, url)) return
    r.activate({ ...r.config, nonce: Array.from(random, b => b.toString(16).padStart(2, '0')).join(''), generation: r.config.generation + 1 })
    web.current?.injectJavaScript(bootstrap(r.config, true))
  }
  async function changeTeam() { await clear(); await onChangeTeam() }
  function external(url: string) {
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:' || u.username || u.password) return
      void (googleOAuthUrl(url) ? Linking.openURL(url) : WebBrowser.openBrowserAsync(url)).catch(() => Alert.alert(product.name, t.browserFailed))
    } catch { /* opaque/local schemes never leave the WebView */ }
  }
  const fail = (kind: Failure) => { ready.current = false; void clear(); setFailed(kind) }
  // Offline / cannot reach the team: a native screen (the web page is not there to explain), retry reloads the page.
  if (failed) return <Center>
    <Text style={[s.title, s.centerText, { color: c.ink }]} accessibilityRole="header">{failed === 'offline' ? t.offlineTitle : t.unreachableTitle}</Text>
    <Text style={[s.hint, s.centerText, { color: c.muted }]}>{failed === 'offline' ? t.offlineHint : t.unreachableHint}</Text>
    <Pressable style={s.button} onPress={() => setFailed(null)} testID="retry"><Text style={s.buttonText}>{t.retry}</Text></Pressable>
    <Pressable style={s.link} onPress={() => void changeTeam()} testID="failed-change-team"><Text style={[s.linkText, { color: c.ink }]}>{t.changeTeam}</Text></Pressable></Center>
  const showFooter = pathname === '/login' || pathname.startsWith('/invite')
  // Edge to edge for a page that pads itself: it fills the screen under the status bar and the home indicator /
  // navigation bar in its own colours (env(safe-area-inset-*), and --app-inset-* from insetScript for WebViews that
  // report none). Any other page keeps the app's padding (src/look.ts frame). The sign-in pages end above the app's own
  // "another team" footer.
  const pad = frame({ selfPadded, android: Platform.OS === 'android', footer: showFooter, keyboard, insets })
  return <View style={[s.fill, { backgroundColor: c.canvas, paddingTop: pad.top, paddingLeft: insets.left, paddingRight: insets.right, paddingBottom: pad.bottom }]}><View style={s.fill}>
    <WebView ref={web} source={{ uri: source }} style={[s.fill, { backgroundColor: c.canvas }]}
      originWhitelist={['*']} applicationNameForUserAgent={`${product.userAgent}/${VERSION}`}
      sharedCookiesEnabled thirdPartyCookiesEnabled={false} mixedContentMode="never" allowFileAccess={false}
      allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      injectedJavaScriptForMainFrameOnly injectedJavaScriptBeforeContentLoadedForMainFrameOnly
      javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows
      allowsBackForwardNavigationGestures pullToRefreshEnabled allowsInlineMediaPlayback
      // iOS: no ^ v ✓ bar above the keyboard; the page's message box sits right on it (the page has no form to step through)
      hideKeyboardAccessoryView
      // Camera (photo attachment) and microphone (voice input) for the team's own page only; iOS asks once per app.
      mediaCapturePermissionGrantType="grantIfSameHostElseDeny"
      onShouldStartLoadWithRequest={request => {
        const decision = navigationDecision(address.origin, request.url, request.isTopFrame)
        if (decision === 'external') external(request.url)
        return decision === 'internal'
      }}
      onOpenWindow={event => external(event.nativeEvent.targetUrl)}
      // Android also reports a same-document navigation (history.pushState: the web app moving to its next page, as
      // after sign-in) as a load start, with no load end after it. The document and its bridge stay then, so nothing
      // is fenced: fencing it left the bridge off until the next full load (no session reset, push or file share).
      onLoadStart={event => { if (Platform.OS === 'android' && !event.nativeEvent.loading) return; loadFailed.current = false; ready.current = false; setSelfPadded(false); void clear() }}
      onLoadEnd={event => { void loaded(event.nativeEvent.url).then(() => { ready.current = !loadFailed.current }, () => fail('unreachable')) }}
      onNavigationStateChange={state => { setCanBack(state.canGoBack); if (sameTeam(address.origin, state.url)) setPathname(new URL(state.url).pathname) }}
      onMessage={event => {
        void r.receive(event.nativeEvent.data, event.nativeEvent.url).then(reply => {
          if (!reply) return
          const script = (reply.nextGeneration ? bootstrap(r.config) : '') + `window.dispatchEvent(new CustomEvent('mycel:mobile',{detail:${JSON.stringify(reply)}}));true;`
          web.current?.injectJavaScript(script)
        }).catch(() => {})
      }}
      onFileDownload={event => { const url = event.nativeEvent.downloadUrl; if (sameTeam(address.origin, url)) web.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('mycel:download',{detail:{url:${JSON.stringify(url)}}}));true;`) }}
      onError={event => { loadFailed.current = true; fail(offlineError(event.nativeEvent.code, event.nativeEvent.description) ? 'offline' : 'unreachable') }}
      onHttpError={event => { if (event.nativeEvent.statusCode >= 500) fail('unreachable') }}
      onContentProcessDidTerminate={() => fail('unreachable')} onRenderProcessGone={() => fail('unreachable')}
      startInLoadingState renderLoading={() => <View style={[StyleSheet.absoluteFill, s.center, { backgroundColor: c.canvas }]}><ActivityIndicator color={product.accent} /></View>}
      testID="team-web" />
    </View>
    {showFooter && <View style={[s.footer, { backgroundColor: c.canvas, paddingBottom: insets.bottom + 8 }]}>
      <Pressable onPress={() => void changeTeam()} style={s.footerButton} testID="change-team"><Text style={[s.linkText, { color: c.ink }]}>{t.otherTeam}</Text></Pressable>
    </View>}
  </View>
}
// layout only; the colours come from the look (src/look.ts: the web app's light and dark tokens)
const s = StyleSheet.create({
  fill: { flex: 1 }, center: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  setup: { justifyContent: 'center', paddingHorizontal: 24 }, title: { fontSize: 24, fontWeight: '600', marginBottom: 8 },
  hint: { fontSize: 15, marginBottom: 16, lineHeight: 21 }, input: { borderWidth: 1, borderRadius: 10, padding: 14, fontSize: 16 },
  error: { marginTop: 10, lineHeight: 20 }, button: { marginTop: 16, backgroundColor: product.accent, borderRadius: 10, padding: 14, alignItems: 'center', minWidth: 160 },
  buttonText: { color: accentInk(product.accent), fontSize: 16, fontWeight: '600' }, link: { marginTop: 16, padding: 8 }, footer: { alignItems: 'center', paddingTop: 8 }, footerButton: { paddingVertical: 8, paddingHorizontal: 16 },
  linkText: { fontSize: 15 }, centerText: { textAlign: 'center' },
})
