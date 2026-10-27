import { StatusBar } from 'expo-status-bar'
import Constants from 'expo-constants'
import * as Crypto from 'expo-crypto'
import * as WebBrowser from 'expo-web-browser'
import { useEffect, useRef, useState, type ComponentType, type RefAttributes, type ReactNode } from 'react'
import { ActivityIndicator, Alert, AppState, BackHandler, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { WebView as NativeWebView, type WebViewProps } from 'react-native-webview'
import { FileTransfers, MobileReceiver } from './src/bridge'
import { clearDownloadCache, fileTransferIO } from './src/files'
import { MOBILE_CAPABILITIES, googleOAuthUrl, navigationDecision, sameTeam, type MobileConfig } from './src/protocol'
import { mobileProduct } from './src/product'
import { checkTeam, parseTeamAddress, savedTeamUrl, saveTeamUrl } from './src/team'
import type { TeamAddress } from './src/address'

const product = mobileProduct(Constants.expoConfig?.extra?.teamAxEdition)
const VERSION = '0.2.2'
type WebHandle = { goBack(): void; reload(): void; injectJavaScript(script: string): void }
// WebView 14's public component declaration omits the forwarded ref; native implementations expose these methods.
const WebView = NativeWebView as unknown as ComponentType<WebViewProps & RefAttributes<WebHandle>>
const bootstrap = (config: MobileConfig, ready = false) => `if(window.top===window.self){Object.defineProperty(window,'mycelMobile',{value:Object.freeze(${JSON.stringify(config)}),configurable:true});${ready ? "window.dispatchEvent(new Event('mycel:mobile-ready'));" : ''}}true;`

export default function App() {
  const [team, setTeam] = useState<TeamAddress | null | undefined>()
  useEffect(() => {
    try { clearDownloadCache() } catch { /* a later operation reports an inaccessible cache */ }
    void savedTeamUrl().then(origin => setTeam(origin ? { origin, entryPath: '/' } : null))
  }, [])
  return <SafeAreaProvider><StatusBar style="auto" />
    {team === undefined ? <Center><ActivityIndicator color={product.accent} /></Center>
      : team === null ? <Setup onDone={async address => { await saveTeamUrl(address.origin); setTeam(address) }} />
      : <TeamWeb key={team.origin} address={team} onChangeTeam={async () => { await saveTeamUrl(null); setTeam(null) }} />}
  </SafeAreaProvider>
}
function Center({ children }: { children: ReactNode }) { return <SafeAreaView style={[s.fill, s.center]}>{children}</SafeAreaView> }
function Setup({ onDone }: { onDone: (address: TeamAddress) => Promise<void> }) {
  const [value, setValue] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function connect() {
    if (busy) return
    const address = parseTeamAddress(value)
    if (!address) { setError('Enter an HTTPS team address or invitation link.'); return }
    setBusy(true); setError('')
    try {
      if (!(await checkTeam(address.origin))) { setError('Could not reach the team server. Check the address, connection and HTTPS certificate.'); return }
      await onDone(address)
    } catch { setError('Could not save the team address. Try again.') }
    finally { setBusy(false) }
  }
  return <SafeAreaView style={s.fill}><KeyboardAvoidingView style={[s.fill, s.setup]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <Text style={s.title}>{product.name}</Text><Text style={s.hint}>Enter the team address or invitation link your team shared with you.</Text>
    <TextInput style={s.input} value={value} onChangeText={setValue} placeholder="https://team.example.com" autoCapitalize="none" autoCorrect={false}
      keyboardType="url" returnKeyType="go" onSubmitEditing={() => void connect()} editable={!busy} testID="team-url" />
    {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    <Pressable style={s.button} onPress={() => void connect()} disabled={busy} testID="team-connect">
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>Connect</Text>}
    </Pressable>
  </KeyboardAvoidingView></SafeAreaView>
}
function TeamWeb({ address, onChangeTeam }: { address: TeamAddress; onChangeTeam: () => Promise<void> }) {
  const web = useRef<WebHandle>(null), navigation = useRef(0), loadFailed = useRef(false), cleanup = useRef(Promise.resolve())
  const [canBack, setCanBack] = useState(false), [pathname, setPathname] = useState(address.entryPath), [failed, setFailed] = useState(false)
  const receiver = useRef<MobileReceiver | null>(null)
  if (!receiver.current) {
    const config: MobileConfig = { protocol: 1, appVersion: VERSION, platform: Platform.OS === 'ios' ? 'ios' : 'android', nonce: '0'.repeat(64), generation: 1, capabilities: MOBILE_CAPABILITIES }
    receiver.current = new MobileReceiver(address.origin, config, new FileTransfers(fileTransferIO()), async url => { await Linking.openURL(url) })
    void receiver.current.disable()
  }
  const r = receiver.current
  useEffect(() => () => { navigation.current++; void r.disable() }, [r])
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => { if (!canBack) return false; web.current?.goBack(); return true })
    return () => back.remove()
  }, [canBack])
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
      void (googleOAuthUrl(url) ? Linking.openURL(url) : WebBrowser.openBrowserAsync(url)).catch(() => Alert.alert(product.name, 'Could not open the browser.'))
    } catch { /* opaque/local schemes never leave the WebView */ }
  }
  if (failed) return <Center><Text style={s.title}>Could not connect</Text><Text style={s.hint}>Check your connection and the team server's HTTPS certificate.</Text>
    <Pressable style={s.button} onPress={() => setFailed(false)}><Text style={s.buttonText}>Try again</Text></Pressable>
    <Pressable style={s.link} onPress={() => void changeTeam()}><Text>Change team address</Text></Pressable></Center>
  return <View style={s.fill}><SafeAreaView edges={['top', 'left', 'right']} style={s.fill}>
    <WebView ref={web} source={{ uri: address.origin + address.entryPath }} style={s.fill}
      originWhitelist={['*']} applicationNameForUserAgent={`${product.userAgent}/${VERSION}`}
      sharedCookiesEnabled thirdPartyCookiesEnabled={false} mixedContentMode="never" allowFileAccess={false}
      allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      injectedJavaScriptForMainFrameOnly injectedJavaScriptBeforeContentLoadedForMainFrameOnly
      javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows
      allowsBackForwardNavigationGestures pullToRefreshEnabled allowsInlineMediaPlayback
      onShouldStartLoadWithRequest={request => {
        const decision = navigationDecision(address.origin, request.url, request.isTopFrame)
        if (decision === 'external') external(request.url)
        return decision === 'internal'
      }}
      onOpenWindow={event => external(event.nativeEvent.targetUrl)}
      onLoadStart={() => { loadFailed.current = false; void clear() }} onLoadEnd={event => { void loaded(event.nativeEvent.url).catch(() => setFailed(true)) }}
      onNavigationStateChange={state => { setCanBack(state.canGoBack); if (sameTeam(address.origin, state.url)) setPathname(new URL(state.url).pathname) }}
      onMessage={event => {
        void r.receive(event.nativeEvent.data, event.nativeEvent.url).then(reply => {
          if (!reply) return
          const script = (reply.nextGeneration ? bootstrap(r.config) : '') + `window.dispatchEvent(new CustomEvent('mycel:mobile',{detail:${JSON.stringify(reply)}}));true;`
          web.current?.injectJavaScript(script)
        }).catch(() => {})
      }}
      onFileDownload={event => { const url = event.nativeEvent.downloadUrl; if (sameTeam(address.origin, url)) web.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('mycel:download',{detail:{url:${JSON.stringify(url)}}}));true;`) }}
      onError={() => { loadFailed.current = true; void clear(); setFailed(true) }} onHttpError={event => { if (event.nativeEvent.statusCode >= 500) { void clear(); setFailed(true) } }}
      onContentProcessDidTerminate={() => { void clear(); setFailed(true) }} onRenderProcessGone={() => { void clear(); setFailed(true) }}
      startInLoadingState renderLoading={() => <View style={[StyleSheet.absoluteFill, s.center]}><ActivityIndicator color={product.accent} /></View>}
      testID="team-web" />
    </SafeAreaView>
    {(pathname === '/login' || pathname.startsWith('/invite')) && <SafeAreaView edges={['bottom']} style={s.footer}>
      <Pressable onPress={() => void changeTeam()} testID="change-team"><Text>Connect to another team</Text></Pressable>
    </SafeAreaView>}
  </View>
}
const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#faf9f6' }, center: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  setup: { justifyContent: 'center', paddingHorizontal: 24 }, title: { fontSize: 24, fontWeight: '700', color: '#1b1b1b', marginBottom: 8 },
  hint: { fontSize: 15, color: '#555', marginBottom: 16, lineHeight: 21 }, input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 10, padding: 14, fontSize: 16, backgroundColor: '#fff' },
  error: { color: '#b3261e', marginTop: 10, lineHeight: 20 }, button: { marginTop: 16, backgroundColor: product.accent, borderRadius: 10, padding: 14, alignItems: 'center', minWidth: 160 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' }, link: { marginTop: 16, padding: 8 }, footer: { alignItems: 'center', paddingVertical: 8 },
})
