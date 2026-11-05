import { StatusBar } from 'expo-status-bar'
import Constants from 'expo-constants'
import * as Crypto from 'expo-crypto'
import * as WebBrowser from 'expo-web-browser'
import { getLocales } from 'expo-localization'
import { useEffect, useRef, useState, type ComponentType, type RefAttributes, type ReactNode } from 'react'
import { ActivityIndicator, Alert, AppState, BackHandler, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView as NativeWebView, type WebViewProps } from 'react-native-webview'
import { FileTransfers, MobileReceiver } from './src/bridge'
import { clearDownloadCache, fileTransferIO } from './src/files'
import { MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_REGISTERED_CAPABILITY, googleOAuthUrl, navigationDecision, sameTeam, type MobileConfig } from './src/protocol'
import { accentInk, mobileProduct } from './src/product'
import { devicePushToken, devices, forgetDelivered, onNotificationTap, quietForeground } from './src/push'
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
const bootstrap = (config: MobileConfig, ready = false) => `if(window.top===window.self){Object.defineProperty(window,'mycelMobile',{value:Object.freeze(${JSON.stringify(config)}),configurable:true});${ready ? "window.dispatchEvent(new Event('mycel:mobile-ready'));" : ''}}true;`

export default function App() {
  const [team, setTeam] = useState<TeamAddress | null | undefined>()
  // A tapped notification's path on the current team, with a counter so the same path can be opened twice.
  const [opened, setOpened] = useState<{ path: string; n: number } | null>(null)
  const since = useRef(Date.now()), hasTeam = useRef(false), device = useRef<string | null>(null)
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
  return <SafeAreaProvider><StatusBar style="auto" />
    {team === undefined ? <Center><ActivityIndicator color={product.accent} /></Center>
      : team === null ? <Setup onDone={async address => { await saveTeamUrl(address.origin); since.current = Date.now(); hasTeam.current = true; setOpened(null); setTeam(address) }} />
      : <TeamWeb key={team.origin} address={team} opened={opened} onDevice={id => { device.current = id }}
        onChangeTeam={async () => {
          hasTeam.current = false; device.current = null; forgetDelivered()
          // remove this phone from the team it leaves (now, or at a later start if that server cannot be reached)
          void leaveTeam(devices, team.origin).catch(() => {})
          await saveTeamUrl(null); setOpened(null); setTeam(null)
        }} />}
  </SafeAreaProvider>
}
// Insets as explicit padding on every native screen: with edge-to-edge (Android, targetSdk 36) the app draws under the
// status bar and the gesture bar, and buttons must stay clear of both.
function Center({ children }: { children: ReactNode }) {
  const i = useSafeAreaInsets()
  return <View style={[s.fill, s.center, { paddingTop: i.top + 24, paddingBottom: i.bottom + 24, paddingLeft: i.left + 24, paddingRight: i.right + 24 }]}>{children}</View>
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
  const i = useSafeAreaInsets()
  return <View style={[s.fill, { paddingTop: i.top, paddingBottom: i.bottom, paddingLeft: i.left, paddingRight: i.right }]}><KeyboardAvoidingView style={[s.fill, s.setup]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <Text style={s.title}>{product.name}</Text><Text style={s.hint}>{t.setupHint}</Text>
    <TextInput style={s.input} value={value} onChangeText={setValue} placeholder={t.setupPlaceholder} autoCapitalize="none" autoCorrect={false}
      keyboardType="url" returnKeyType="go" onSubmitEditing={() => void connect()} editable={!busy} testID="team-url" />
    {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    <Pressable style={s.button} onPress={() => void connect()} disabled={busy} testID="team-connect">
      {busy ? <ActivityIndicator color={accentInk(product.accent)} /> : <Text style={s.buttonText}>{t.connect}</Text>}
    </Pressable>
  </KeyboardAvoidingView></View>
}
type Failure = 'offline' | 'unreachable'
function TeamWeb({ address, opened, onDevice, onChangeTeam }: { address: TeamAddress; opened: { path: string; n: number } | null; onDevice: (id: string) => void; onChangeTeam: () => Promise<void> }) {
  const web = useRef<WebHandle>(null), navigation = useRef(0), loadFailed = useRef(false), cleanup = useRef(Promise.resolve()), ready = useRef(false)
  const [canBack, setCanBack] = useState(false), [pathname, setPathname] = useState(address.entryPath), [failed, setFailed] = useState<Failure | null>(null)
  const [source, setSource] = useState(address.origin + address.entryPath)
  const insets = useSafeAreaInsets()
  const receiver = useRef<MobileReceiver | null>(null)
  if (!receiver.current) {
    const config: MobileConfig = { protocol: 1, appVersion: VERSION, platform: Platform.OS === 'ios' ? 'ios' : 'android', nonce: '0'.repeat(64), generation: 1, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_REGISTERED_CAPABILITY] }
    receiver.current = new MobileReceiver(address.origin, config, new FileTransfers(fileTransferIO()), async url => { await Linking.openURL(url) }, {
      token: () => devicePushToken(t.channelName),
      async registered({ deviceId, removeKey }) { await rememberDevice(devices, { origin: address.origin, deviceId, removeKey, at: Date.now() }); onDevice(deviceId) },
    })
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
    <Text style={[s.title, s.centerText]} accessibilityRole="header">{failed === 'offline' ? t.offlineTitle : t.unreachableTitle}</Text>
    <Text style={[s.hint, s.centerText]}>{failed === 'offline' ? t.offlineHint : t.unreachableHint}</Text>
    <Pressable style={s.button} onPress={() => setFailed(null)} testID="retry"><Text style={s.buttonText}>{t.retry}</Text></Pressable>
    <Pressable style={s.link} onPress={() => void changeTeam()} testID="failed-change-team"><Text style={s.linkText}>{t.changeTeam}</Text></Pressable></Center>
  const showFooter = pathname === '/login' || pathname.startsWith('/invite')
  // iOS: the page runs under the home indicator and pads itself (env(safe-area-inset-bottom)); Android's WebView does
  // not report that inset, so the app keeps the page above the gesture bar.
  return <View style={[s.fill, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right, paddingBottom: showFooter || Platform.OS === 'ios' ? 0 : insets.bottom }]}><View style={s.fill}>
    <WebView ref={web} source={{ uri: source }} style={s.fill}
      originWhitelist={['*']} applicationNameForUserAgent={`${product.userAgent}/${VERSION}`}
      sharedCookiesEnabled thirdPartyCookiesEnabled={false} mixedContentMode="never" allowFileAccess={false}
      allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      injectedJavaScriptForMainFrameOnly injectedJavaScriptBeforeContentLoadedForMainFrameOnly
      javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows
      allowsBackForwardNavigationGestures pullToRefreshEnabled allowsInlineMediaPlayback
      // Camera (photo attachment) and microphone (voice input) for the team's own page only; iOS asks once per app.
      mediaCapturePermissionGrantType="grantIfSameHostElseDeny"
      onShouldStartLoadWithRequest={request => {
        const decision = navigationDecision(address.origin, request.url, request.isTopFrame)
        if (decision === 'external') external(request.url)
        return decision === 'internal'
      }}
      onOpenWindow={event => external(event.nativeEvent.targetUrl)}
      onLoadStart={() => { loadFailed.current = false; ready.current = false; void clear() }}
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
      startInLoadingState renderLoading={() => <View style={[StyleSheet.absoluteFill, s.center]}><ActivityIndicator color={product.accent} /></View>}
      testID="team-web" />
    </View>
    {showFooter && <View style={[s.footer, { paddingBottom: insets.bottom + 8 }]}>
      <Pressable onPress={() => void changeTeam()} style={s.footerButton} testID="change-team"><Text style={s.linkText}>{t.otherTeam}</Text></Pressable>
    </View>}
  </View>
}
// the web app's light tokens (web/src/theme.edition.css): canvas, ink, muted, field edge (>= 3:1), danger
const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#fcfbf8' }, center: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  setup: { justifyContent: 'center', paddingHorizontal: 24 }, title: { fontSize: 24, fontWeight: '600', color: '#14110f', marginBottom: 8 },
  hint: { fontSize: 15, color: '#514b45', marginBottom: 16, lineHeight: 21 }, input: { borderWidth: 1, borderColor: '#8c8378', borderRadius: 10, padding: 14, fontSize: 16, backgroundColor: '#fff' },
  error: { color: '#b42318', marginTop: 10, lineHeight: 20 }, button: { marginTop: 16, backgroundColor: product.accent, borderRadius: 10, padding: 14, alignItems: 'center', minWidth: 160 },
  buttonText: { color: accentInk(product.accent), fontSize: 16, fontWeight: '600' }, link: { marginTop: 16, padding: 8 }, footer: { alignItems: 'center', paddingTop: 8 }, footerButton: { paddingVertical: 8, paddingHorizontal: 16 },
  linkText: { color: '#14110f', fontSize: 15 }, centerText: { textAlign: 'center' },
})
