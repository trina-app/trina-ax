import { StatusBar } from 'expo-status-bar'
import { NavigationBar } from 'expo-navigation-bar'
import Constants from 'expo-constants'
import * as Crypto from 'expo-crypto'
import * as WebBrowser from 'expo-web-browser'
import { getLocales } from 'expo-localization'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ComponentRef, type ComponentType, type RefAttributes, type ReactNode } from 'react'
import { AccessibilityInfo, ActivityIndicator, Alert, Appearance, AppState, BackHandler, findNodeHandle, Keyboard, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, TurboModuleRegistry, View, type TurboModule } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView as NativeWebView, type WebViewProps } from 'react-native-webview'
import { FileTransfers, MobileReceiver, StuckLoad, stillStuck } from './src/bridge'
import { clearDownloadCache, fileTransferIO } from './src/files'
import { APPEARANCE_CAPABILITY, MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_LABEL_CAPABILITY, PUSH_PERMISSION_CAPABILITY, PUSH_REGISTERED_CAPABILITY, googleOAuthUrl, navigationDecision, sameTeam, type MobileConfig } from './src/protocol'
import { accentInk, installGuide, mobileProduct, mobileService } from './src/product'
import { devicePushToken, devices, forgetDelivered, labels, notificationPermission, onNotificationTap, openAppSettings, quietForeground } from './src/push'
import { DARK, LIGHT, frame, insetScript, isDark, padding, pageInsets, type Insets, type Padding, type Palette } from './src/look'
import { currentDevice, leaveTeam, rememberDevice, retryRemovals } from './src/device'
import { fill, inputError, offlineError, stringsFor } from './src/strings'
import { checkTeam, readTeamInput, rememberSelfPadded, savedTeamSince, savedTeamUrl, saveTeamUrl, selfPaddedTeam } from './src/team'
import { LinkGate, readAppLink, type LinkOffer } from './src/team-link'
import { ReinstallSignOut, reinstallDone, wasReinstalled } from './src/install'
import { reinstallDeps } from './src/files'
import type { TeamAddress } from './src/address'

const product = mobileProduct(Constants.expoConfig?.extra?.teamAxEdition)
/** the hosted team domain (bare names) and the install guide link of ③, from the edition (app.config.ts) */
const service = mobileService(Constants.expoConfig?.extra?.teamAxService, Constants.expoConfig?.extra?.teamAxService)
const VERSION = Constants.expoConfig?.version ?? '1.0.0'
const language = getLocales()[0]?.languageCode
const t = stringsFor(language)
/** ③'s "install it yourself" page: the repository's guide, which links no paid plan (App Review 3.1.1, Google Play
 * payments); phones have no "create a team" button for the same reason */
const INSTALL_GUIDE = installGuide(service.repository, language?.toLowerCase().startsWith('ko') ?? false)
/** Links that open the app: `<scheme>://open?url=…` and the hosted team domain's invite and team links (universal
 * links, app links). Every one goes through screen ④ (LinkAsk) before anything is fetched. */
const LINKS = { teamDomain: service.teamDomain, loopbackHttp: false, scheme: product.scheme, universal: !!service.teamDomain }
/** The host to show for a team address: punycode with its port, as the app connected to it (never Unicode). */
const hostOf = (origin: string) => { try { return new URL(origin).host } catch { return origin } }
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
/** The phone's look, read from the OS each time it may have changed: on mount, when the app comes back and when the OS
 * says so. React Native's useColorScheme keeps a cached value that only the OS's change event updates, and Android
 * sends none to an activity created again after BACK, so the bands around an older team's page kept the old look. */
interface AppearanceModule extends TurboModule { getColorScheme(): string | null }
const NativeAppearance = TurboModuleRegistry.get<AppearanceModule>('Appearance')
const osScheme = (): string | null => { try { return NativeAppearance?.getColorScheme() ?? Appearance.getColorScheme() ?? null } catch { return Appearance.getColorScheme() ?? null } }
function usePhoneScheme(): string | null {
  const [scheme, setScheme] = useState(osScheme)
  useEffect(() => {
    const read = () => setScheme(osScheme())
    read()
    const change = Appearance.addChangeListener(read)
    const active = AppState.addEventListener('change', state => { if (state === 'active') read() })
    return () => { change.remove(); active.remove() }
  }, [])
  return scheme
}
/** Android draws edge to edge (target SDK 36), so the window no longer shrinks for the keyboard: a screen lifts itself
 * by the keyboard's height (React Native reports it without the navigation bar under it). 0 on iOS. */
function useAndroidKeyboard(): number {
  const [keyboard, setKeyboard] = useState(0)
  useEffect(() => {
    if (Platform.OS !== 'android') return
    const show = Keyboard.addListener('keyboardDidShow', e => setKeyboard(e.endCoordinates.height))
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(0))
    return () => { show.remove(); hide.remove() }
  }, [])
  return keyboard
}
const bootstrap = (config: MobileConfig, ready = false) => `if(window.top===window.self){Object.defineProperty(window,'mycelMobile',{value:Object.freeze(${JSON.stringify(config)}),configurable:true});${ready ? "window.dispatchEvent(new Event('mycel:mobile-ready'));" : ''}}true;`

export default function App() {
  const [team, setTeam] = useState<TeamAddress | null | undefined>()
  // the first-run box over the team that is still connected ("다른 팀에 연결"): the team stays until another one answered
  // and the person said yes
  const [adding, setAdding] = useState(false)
  // screen ④: a link from outside waits for the person's yes (nothing is fetched before it)
  const gate = useRef(new LinkGate()), [link, setLink] = useState<LinkOffer | null>(null)
  useEffect(() => {
    const take = (url: string | null | undefined) => {
      if (!url) return
      const p = readAppLink(url, LINKS)
      if (!p) return
      if (!p.ok) { Alert.alert(product.name, t.linkBad); return }
      setLink(gate.current.put(p, Date.now()))
    }
    void Linking.getInitialURL().then(take, () => {})
    const sub = Linking.addEventListener('url', e => take(e.url))
    return () => sub.remove()
  }, [])
  // A tapped notification's path on the current team, with a counter so the same path can be opened twice.
  const [opened, setOpened] = useState<{ path: string; n: number } | null>(null)
  const since = useRef(Date.now()), hasTeam = useRef(false), device = useRef<string | null>(null), padsAtLaunch = useRef<string | null>(null)
  // deleted and installed again: the team address (keychain) is still there, the session the WebView kept is ended once
  // (one object for the whole launch, so switching teams and back never signs out again)
  const signOut = useRef<ReinstallSignOut | null>(null)
  // the page's look (appearance-v1): status bar text and the native screens follow it; null until a page said
  const [page, setPage] = useState<PageLook | null>(null)
  const dark = isDark(page?.dark ?? null, usePhoneScheme())
  useEffect(() => windowLook(page), [page])
  useEffect(() => {
    try { clearDownloadCache() } catch { /* a later operation reports an inaccessible cache */ }
    let off = () => {}
    // removals owed to teams left while their server could not be reached
    void retryRemovals(devices).catch(() => {})
    void Promise.all([savedTeamUrl(), savedTeamSince(), selfPaddedTeam()]).then(async ([origin, chosen, pads]) => {
      since.current = chosen; hasTeam.current = !!origin; padsAtLaunch.current = pads
      const deps = reinstallDeps()
      const reinstalled = await wasReinstalled(deps, { ios: Platform.OS === 'ios', hasTeam: !!origin }).catch(() => false)
      // the keychain outlived the deleted app: its notification extension names nobody until this install registers
      if (reinstalled) await labels?.forget().catch(() => {})
      if (reinstalled && origin) signOut.current = new ReinstallSignOut(origin, () => reinstallDone(deps), () => Crypto.randomUUID())
      let deviceRead = true
      device.current = origin ? (await currentDevice(devices, origin).catch(() => { deviceRead = false; return null }))?.deviceId ?? null : null
      // what the extension may use belongs to this team and this device, or it goes (not when the device could not be read)
      if (deviceRead) await labels?.tidy(origin, device.current).catch(() => {})
      setTeam(origin ? { origin, entryPath: '/' } : null)
      off = onNotificationTap(() => since.current, () => device.current, path => { if (hasTeam.current) setOpened(o => ({ path, n: (o?.n ?? 0) + 1 })) })
    })
    return () => off()
  }, [])
  // Android: the status bar icons and the three-button bar's contrast scrim follow the look (React Native set the scrim
  // once, from the phone's look at launch)
  /** Leave the team on this phone: notifications stop, the phone is removed from the team (now, or at a later start if
   * that server cannot be reached). Only after the person chose another team that answered and it was saved. */
  async function leave(origin: string) {
    device.current = null; forgetDelivered()
    // the notification extension stops asking the team left for names
    await labels?.forget().catch(() => {})
    void leaveTeam(devices, origin).catch(() => {})
  }
  // one function for the box's [{old}(으)로 돌아가기]: Android back's handler is registered once, not on every render
  const closeAdding = useCallback(() => setAdding(false), [])
  async function connect(address: TeamAddress) {
    const old = team && team.origin !== address.origin ? team.origin : null
    // the new team is saved first: if that fails (an address the store refuses), the phone is still in the old team
    await saveTeamUrl(address.origin); since.current = Date.now(); hasTeam.current = true
    if (old) await leave(old)
    // the new team's page starts at the link's page (TeamWeb's first address)
    setOpened(null); setPage(null); setAdding(false); setTeam(address)
  }
  // Android: the status bar icons and the three-button bar's contrast scrim follow the look (React Native set the scrim
  // once, from the phone's look at launch)
  return <SafeAreaProvider><Look.Provider value={dark ? DARK : LIGHT}>{Platform.OS === 'android' && <><StatusBar style={dark ? 'light' : 'dark'} /><NavigationBar style={dark ? 'light' : 'dark'} /></>}
    {team === undefined ? <Center><ActivityIndicator color={product.accent} /></Center>
      : team === null ? <Setup current={null} onDone={connect} />
      : <>
        <TeamWeb key={team.origin} address={team} hidden={adding} pads={padsAtLaunch.current === team.origin} signOut={signOut.current} opened={opened} onDevice={id => { device.current = id }} onAppearance={look => setPage(p => p?.dark === look.dark && p.system === look.system ? p : look)}
          onChangeTeam={() => setAdding(true)} />
        {adding && <View style={StyleSheet.absoluteFill}><Setup current={team.origin} onBack={closeAdding}
          // the same team again: its page opens there (a link's join page, or its start)
          onSame={address => { setAdding(false); setOpened(o => ({ path: address.entryPath, n: (o?.n ?? 0) + 1 })) }}
          onDone={connect} /></View>}
      </>}
    {team !== undefined && link && <View style={StyleSheet.absoluteFill}><LinkAsk offer={link} gate={gate.current} current={team?.origin ?? null}
      onClose={() => setLink(null)}
      onSame={path => { setLink(null); setAdding(false); setOpened(o => ({ path, n: (o?.n ?? 0) + 1 })) }}
      onDone={async address => { await connect(address); setLink(null) }} /></View>}
  </Look.Provider></SafeAreaProvider>
}
// Insets as explicit padding on every native screen: with edge-to-edge (Android, targetSdk 36) the app draws under the
// status bar and the gesture bar, and buttons must stay clear of both.
function Center({ children }: { children: ReactNode }) {
  const i = useSafeAreaInsets(), c = useContext(Look)
  return <View style={[s.fill, s.center, { backgroundColor: c.canvas, paddingTop: i.top + 24, paddingBottom: i.bottom + 24, paddingLeft: i.left + 24, paddingRight: i.right + 24 }]}>{children}</View>
}
/** A question before connecting: an address the hosted service does not run (once, on the first connect), a renamed
 * team, or leaving the team this phone is in. [취소] has the focus. */
type Ask = { kind: 'outside' | 'renamed' | 'switch'; address: TeamAddress; host: string; hosted: boolean }
/**
 * The first-run screen: ① one box for an invite link, a team link, an address or a pasted message; ② no address; ③ no
 * team yet (docs/DECISIONS.md "First run: one box"). `current`: the team this phone is in, while another is being added
 * over it ([{team}(으)로 돌아가기]); it is left only when the new address answered and the person said yes.
 */
function Setup({ current, onDone, onBack, onSame }: { current: string | null; onDone: (address: TeamAddress) => Promise<void>; onBack?: () => void; onSame?: (address: TeamAddress) => void }) {
  const [value, setValue] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [view, setView] = useState<'main' | 'unknown' | 'none'>('main'), [ask, setAsk] = useState<Ask | null>(null)
  const cancelRef = useRef<ComponentRef<typeof Pressable>>(null)
  async function submit() {
    if (busy) return
    const r = readTeamInput(value, service.teamDomain)
    if (!r.ok) { setError(inputError(t, r.error)); return }
    if (current === r.origin) { onSame?.({ origin: r.origin, entryPath: r.entryPath }); return }
    setBusy(true); setError(''); setAsk(null)
    try {
      // the name is checked only here, on the button, and only under the team domain
      const c = await checkTeam(r.origin, service.teamDomain)
      if (!c.ok) {
        setError(c.reason === 'unknown' ? fill(t.teamUnknown, { name: r.name ?? r.host }) : c.reason === 'suspended' ? t.suspended : c.reason === 'notTeam' ? t.notTeam : t.unreachableSetup)
        return
      }
      const address = { origin: c.origin, entryPath: r.entryPath }
      if (current === c.origin) { onSame?.(address); return }
      // a build without a hosted service has nothing to compare with: no "not run by" question there
      const hosted = c.renamed || r.hosted || !service.teamDomain
      if (current) setAsk({ kind: 'switch', address, host: hostOf(c.origin), hosted })
      else if (c.renamed) setAsk({ kind: 'renamed', address, host: hostOf(c.origin), hosted })
      else if (!hosted) setAsk({ kind: 'outside', address, host: hostOf(c.origin), hosted })
      else await onDone(address)
    } catch { setError(t.saveFailed) }
    finally { setBusy(false) }
  }
  async function yes(a: Ask) {
    setBusy(true)
    try { await onDone(a.address) } catch { setError(t.saveFailed); setAsk(null) } finally { setBusy(false) }
  }
  // screen readers start on [취소] (the safe answer)
  useEffect(() => {
    if (!ask) return
    const id = setTimeout(() => { const n = cancelRef.current && findNodeHandle(cancelRef.current); if (n) AccessibilityInfo.setAccessibilityFocus(n) }, 300)
    return () => clearTimeout(id)
  }, [ask])
  // Android back: the question, then ② / ③, then back to the team this phone is in
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (ask) { setAsk(null); return true }
      if (view !== 'main') { setView('main'); return true }
      if (onBack) { onBack(); return true }
      return false
    })
    return () => sub.remove()
  }, [ask, view, onBack])
  // iOS: KeyboardAvoidingView; Android: the form is lifted by the keyboard (it covered the Connect button)
  const i = useSafeAreaInsets(), c = useContext(Look), keyboard = useAndroidKeyboard()
  const back = (label: string, onPress: () => void, testID: string, primary = false) =>
    <Pressable style={primary ? s.button : s.secondary} onPress={onPress} testID={testID} accessibilityRole="button">
      <Text style={primary ? s.buttonText : [s.secondaryText, { color: c.ink, borderColor: c.field }]}>{label}</Text>
    </Pressable>
  const body = view === 'unknown'
    ? <View testID="no-address-view">
      <Text style={[s.title, { color: c.ink }]} accessibilityRole="header">{t.noAddress}</Text>
      {[t.noAddressPaste, t.noAddressDevice, t.noAddressAsk].map((line, n) => <View key={n} style={s.step}><Text style={[s.stepNo, { color: c.muted }]}>{n + 1}.</Text><Text style={[s.stepText, { color: c.ink }]}>{line}</Text></View>)}
      {back(t.back, () => setView('main'), 'view-back')}
    </View>
    : view === 'none'
    ? <View testID="no-team-view">
      <Text style={[s.title, { color: c.ink }]} accessibilityRole="header">{t.noTeam}</Text>
      <Text style={[s.hint, { color: c.muted }]}>{t.noTeamBody}</Text>
      {/* no "create a team" here: it leads to a paid plan outside the app (App Review 3.1.1, Google Play payments) */}
      {INSTALL_GUIDE && back(`${t.noTeamDocs} ↗`, () => { void WebBrowser.openBrowserAsync(INSTALL_GUIDE).catch(() => Alert.alert(product.name, t.browserFailed)) }, 'install-docs')}
      {back(t.noTeamEnter, () => setView('main'), 'view-back', true)}
    </View>
    : <View>
      <Text style={[s.title, { color: c.ink }]} accessibilityRole="header">{t.setupTitle}</Text><Text style={[s.hint, { color: c.muted }]}>{t.setupHint}</Text>
      <TextInput style={[s.input, { borderColor: c.field, backgroundColor: c.surface, color: c.ink }]} value={value} onChangeText={v => { setValue(v); if (ask) setAsk(null) }} placeholder={t.setupPlaceholder} placeholderTextColor={c.field}
        autoCapitalize="none" autoCorrect={false} keyboardAppearance={c === DARK ? 'dark' : 'light'} accessibilityLabel={t.setupPlaceholder}
        keyboardType="url" returnKeyType="go" onSubmitEditing={() => void submit()} editable={!busy} testID="team-url" />
      {!!error && <Text accessibilityRole="alert" style={[s.error, { color: c.danger }]} testID="setup-error">{error}</Text>}
      {ask ? <View style={[s.ask, { borderColor: c.field, backgroundColor: c.surface }]} testID="setup-ask" accessibilityViewIsModal>
        {ask.kind === 'switch' && current && <Text style={[s.askTitle, { color: c.ink }]}>{fill(t.switchTitle, { old: hostOf(current), new: ask.host })}</Text>}
        <Text style={[s.askHost, { color: c.ink }]} testID="setup-ask-host">{ask.host}</Text>
        {ask.kind === 'renamed' && <Text style={[s.askText, { color: c.ink }]}>{fill(t.renamed, { host: ask.host })}</Text>}
        {!ask.hosted && <Text style={[s.askText, { color: c.ink }]}>{t.outsideBody}</Text>}
        {ask.kind === 'switch' && current && <Text style={[s.askText, { color: c.muted }]}>{fill(t.switchBody, { old: hostOf(current) })}</Text>}
        <View style={s.askRow}>
          <Pressable ref={cancelRef} style={[s.secondary, s.askButton]} onPress={() => setAsk(null)} testID="setup-ask-cancel" accessibilityRole="button"><Text style={[s.secondaryText, { color: c.ink, borderColor: c.field }]}>{t.cancel}</Text></Pressable>
          <Pressable style={[s.button, s.askButton]} onPress={() => void yes(ask)} disabled={busy} testID="setup-ask-yes" accessibilityRole="button">
            {busy ? <ActivityIndicator color={accentInk(product.accent)} /> : <Text style={s.buttonText}>{ask.kind === 'switch' ? t.switchYes : t.outsideConnect}</Text>}</Pressable>
        </View>
      </View>
      : <Pressable style={s.button} onPress={() => void submit()} disabled={busy} testID="team-connect" accessibilityRole="button">
        {busy ? <ActivityIndicator color={accentInk(product.accent)} /> : <Text style={s.buttonText}>{t.connect}</Text>}
      </Pressable>}
      <View style={s.helpRow}>
        <Pressable onPress={() => setView('unknown')} style={s.helpLink} testID="no-address" accessibilityRole="button"><Text style={[s.linkText, s.underline, { color: c.ink }]}>{t.noAddress}</Text></Pressable>
        <Text style={[s.linkText, { color: c.muted }]} accessibilityElementsHidden importantForAccessibility="no">·</Text>
        <Pressable onPress={() => setView('none')} style={s.helpLink} testID="no-team" accessibilityRole="button"><Text style={[s.linkText, s.underline, { color: c.ink }]}>{t.noTeam}</Text></Pressable>
      </View>
      {current && onBack && <Pressable onPress={onBack} style={[s.link, s.centered]} testID="setup-back" accessibilityRole="button"><Text style={[s.linkText, s.underline, { color: c.ink }]}>{fill(t.backTo, { team: hostOf(current) })}</Text></Pressable>}
    </View>
  return <View style={[s.fill, { backgroundColor: c.canvas, paddingTop: i.top, paddingBottom: keyboard ? keyboard + i.bottom : i.bottom, paddingLeft: i.left, paddingRight: i.right }]}><KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={s.setup} keyboardShouldPersistTaps="handled">{body}</ScrollView>
  </KeyboardAvoidingView></View>
}
/**
 * ④ A link from outside: "{host}에 연결할까요? 직접 받은 링크가 맞을 때만 연결하세요.", the outside note when the hosted
 * service does not run it, and when this phone is in another team the switch line. [취소] has the focus; [연결] (or
 * [바꾸기]) only then checks the address and connects: the same path as the box, leaving the old team only now.
 */
function LinkAsk({ offer, gate, current, onClose, onSame, onDone }: { offer: LinkOffer; gate: LinkGate; current: string | null; onClose: () => void; onSame: (path: string) => void; onDone: (address: TeamAddress) => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const cancelRef = useRef<ComponentRef<typeof Pressable>>(null)
  const i = useSafeAreaInsets(), c = useContext(Look)
  const switching = !!current && current !== offer.origin
  function no() { gate.answer(false, offer.host, Date.now()); onClose() }
  async function yes() {
    if (busy) return
    // the yes counts for this host only, and not right under the tap that opened the app
    const o = gate.answer(true, offer.host, Date.now())
    if (!o) return
    setBusy(true); setError('')
    try {
      const r = await checkTeam(o.origin, service.teamDomain)
      if (!r.ok) { setError(r.reason === 'unknown' ? fill(t.teamUnknown, { name: o.name ?? o.host }) : r.reason === 'suspended' ? t.suspended : r.reason === 'notTeam' ? t.notTeam : t.unreachableSetup); return }
      if (current === r.origin) onSame(o.entryPath)
      else await onDone({ origin: r.origin, entryPath: o.entryPath })
    } catch { setError(t.saveFailed) } finally { setBusy(false) }
  }
  useEffect(() => {
    const id = setTimeout(() => { const n = cancelRef.current && findNodeHandle(cancelRef.current); if (n) AccessibilityInfo.setAccessibilityFocus(n) }, 300)
    const back = BackHandler.addEventListener('hardwareBackPress', () => { no(); return true })
    return () => { clearTimeout(id); back.remove() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer])
  return <View style={[s.fill, s.center, { backgroundColor: c.canvas, paddingTop: i.top + 24, paddingBottom: i.bottom + 24, paddingLeft: i.left + 24, paddingRight: i.right + 24 }]} accessibilityViewIsModal testID="link-ask">
    <View style={s.linkCard}>
      <Text style={[s.title, { color: c.ink }]} accessibilityRole="header" testID="link-title">{fill(t.linkTitle, { host: offer.host })}</Text>
      <Text style={[s.hint, { color: c.muted }]}>{t.linkBody}</Text>
      {!offer.hosted && <Text style={[s.askText, { color: c.ink }]} testID="link-outside">{t.outsideBody}</Text>}
      {switching && <Text style={[s.askText, { color: c.muted }]}>{fill(t.switchBody, { old: hostOf(current!) })}</Text>}
      {!!error && <Text accessibilityRole="alert" style={[s.error, { color: c.danger }]} testID="link-error">{error}</Text>}
      <View style={s.askRow}>
        <Pressable ref={cancelRef} style={[s.secondary, s.askButton]} onPress={no} testID="link-cancel" accessibilityRole="button"><Text style={[s.secondaryText, { color: c.ink, borderColor: c.field }]}>{t.cancel}</Text></Pressable>
        {!error && <Pressable style={[s.button, s.askButton]} onPress={() => void yes()} disabled={busy} testID="link-connect" accessibilityRole="button">
          {busy ? <ActivityIndicator color={accentInk(product.accent)} /> : <Text style={s.buttonText}>{switching ? t.switchYes : t.outsideConnect}</Text>}</Pressable>}
      </View>
    </View>
  </View>
}
type Failure = 'offline' | 'unreachable'
function TeamWeb({ address, hidden, pads, signOut, opened, onDevice, onAppearance, onChangeTeam }: { address: TeamAddress; hidden: boolean; pads: boolean; signOut: ReinstallSignOut | null; opened: { path: string; n: number } | null; onDevice: (id: string) => void; onAppearance: (look: PageLook) => void; onChangeTeam: () => void }) {
  const web = useRef<WebHandle>(null), navigation = useRef(0), loadFailed = useRef(false), cleanup = useRef(Promise.resolve()), ready = useRef(false)
  const [canBack, setCanBack] = useState(false), [pathname, setPathname] = useState(address.entryPath), [failed, setFailed] = useState<Failure | null>(null)
  const [source, setSource] = useState(address.origin + address.entryPath)
  const insets = useSafeAreaInsets(), c = useContext(Look)
  // Does the page on screen pad itself (src/look.ts padding)? Predicted from this team's last page, confirmed by the
  // page (appearance-v1). Until a page of this team has said so, the app keeps its own padding, so a team server that
  // has not updated still fits between the system bars.
  const [pad, setPad] = useState<Padding>({ selfPadded: pads, confirmed: false })
  const padRef = useRef(pad), insetsRef = useRef<Insets>(insets), stuck = useRef(new StuckLoad(10_000))
  // the top-level URL on screen: every load start and navigation state change (the stuck-load check compares it)
  const currentUrl = useRef(address.origin + address.entryPath)
  padRef.current = pad; insetsRef.current = insets
  const selfPadded = pad.selfPadded
  const receiver = useRef<MobileReceiver | null>(null)
  if (!receiver.current) {
    // push-label-v1 only where the notification extension can read the label key (an iPhone build with the extension)
    const config: MobileConfig = { protocol: 1, appVersion: VERSION, platform: Platform.OS === 'ios' ? 'ios' : 'android', nonce: '0'.repeat(64), generation: 1, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_REGISTERED_CAPABILITY, PUSH_PERMISSION_CAPABILITY, APPEARANCE_CAPABILITY, ...(labels ? [PUSH_LABEL_CAPABILITY] : [])] }
    receiver.current = new MobileReceiver(address.origin, config, new FileTransfers(fileTransferIO()), async url => { await Linking.openURL(url) }, {
      token: () => devicePushToken(t.channelName),
      async registered({ deviceId, removeKey }) {
        await rememberDevice(devices, { origin: address.origin, deviceId, removeKey, at: Date.now() }); onDevice(deviceId)
        // the notification extension may ask this team for this device's room pushes now
        await labels?.registered(address.origin, deviceId).catch(() => {})
      },
      permission: notificationPermission, openSettings: openAppSettings,
      ...(labels ? { labelHash: () => labels!.keyHash(address.origin) } : {}),
      // signed out (or the session expired, or another person signed in): no names stay on the lock screen, and the
      // extension stops asking
      async signedOut() { forgetDelivered(); await labels?.forget().catch(() => {}) },
    }, look => {
      onAppearance(look)
      if (padRef.current.confirmed) return
      // the insets first, then the app's padding goes: the page never sits under the status bar in between
      web.current?.injectJavaScript(insetScript(insetsRef.current))
      setPad(p => padding(p, 'appearance'))
      if (!padRef.current.selfPadded) void rememberSelfPadded(address.origin, true)
    })
    void receiver.current.disable()
  }
  const r = receiver.current
  useEffect(() => () => { navigation.current++; stuck.current.cancel(); void r.disable() }, [r])
  useEffect(() => {
    // under the first-run box ("다른 팀에 연결"), the box answers Android back
    if (hidden) return
    const back = BackHandler.addEventListener('hardwareBackPress', () => { if (!canBack) return false; web.current?.goBack(); return true })
    return () => back.remove()
  }, [canBack, hidden])
  useEffect(() => {
    // A tapped notification: same-origin path only (checked in src/push.ts), opened in this team's page.
    if (!opened) return
    const target = address.origin + opened.path
    if (!sameTeam(address.origin, target)) return
    setFailed(null)
    if (ready.current) web.current?.injectJavaScript(`window.location.assign(${JSON.stringify(opened.path)});true;`)
    else setSource(target)
  }, [opened, address.origin])
  // A page that pads itself draws under the status bar and the home indicator / navigation bar (web/src/index.css) and
  // gets the insets as CSS variables: before each load while the app expects it to, and again when they change
  // (Android's navigation mode). While the app pads the page it sends zero, so the page never pads twice.
  const insetJs = insetScript(pageInsets(selfPadded, insets))
  useEffect(() => { web.current?.injectJavaScript(insetJs) }, [insetJs])
  // Android: the page is lifted by the keyboard (its message box stayed under it); the page then sees a short viewport
  // and drops its own bottom inset (web/src/lib/viewport.ts)
  const keyboard = useAndroidKeyboard()
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') web.current?.injectJavaScript("window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('mycel:mobile-foreground'));true;")
    })
    return () => sub.remove()
  }, [])
  const clear = () => { navigation.current++; cleanup.current = r.disable(); return cleanup.current }
  /** Installs the bridge on the page that has loaded; false when it did not (a newer load, a failure, not the team). */
  async function loaded(url: string): Promise<boolean> {
    const generation = navigation.current
    await cleanup.current
    const random = await Crypto.getRandomBytesAsync(32)
    if (generation !== navigation.current || loadFailed.current || !sameTeam(address.origin, url)) return false
    r.activate({ ...r.config, nonce: Array.from(random, b => b.toString(16).padStart(2, '0')).join(''), generation: r.config.generation + 1 })
    web.current?.injectJavaScript(bootstrap(r.config, true))
    return true
  }
  // "다른 팀에 연결" / "팀 주소 바꾸기": the first-run box over this team, which stays connected until another team answered
  // and the person said yes (App connect)
  function changeTeam() { onChangeTeam() }
  function external(url: string) {
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:' || u.username || u.password) return
      void (googleOAuthUrl(url) ? Linking.openURL(url) : WebBrowser.openBrowserAsync(url)).catch(() => Alert.alert(product.name, t.browserFailed))
    } catch { /* opaque/local schemes never leave the WebView */ }
  }
  const fail = (kind: Failure) => { ready.current = false; stuck.current.cancel(); void clear(); setFailed(kind) }
  /** The page has arrived: install the bridge; a page that does not confirm it pads itself gets the app's padding. */
  function settle(url: string) {
    void loaded(url).then(installed => {
      ready.current = installed && !loadFailed.current
      // after a reinstall: only on this team's own page, the one on screen, whose bridge was just installed
      const end = ready.current && sameTeam(address.origin, currentUrl.current) ? signOut?.script(address.origin, currentUrl.current) : null
      if (end) web.current?.injectJavaScript(end)
      const page = navigation.current
      setTimeout(() => {
        if (page !== navigation.current || !ready.current || padRef.current.confirmed || !padRef.current.selfPadded) return
        setPad(p => padding(p, 'unconfirmed')); void rememberSelfPadded(address.origin, false)
      }, 3000)
    }, () => fail('unreachable'))
  }
  // Offline / cannot reach the team: a native screen (the web page is not there to explain), retry reloads the page.
  if (failed) return <Center>
    <Text style={[s.title, s.centerText, { color: c.ink }]} accessibilityRole="header">{failed === 'offline' ? t.offlineTitle : t.unreachableTitle}</Text>
    <Text style={[s.hint, s.centerText, { color: c.muted }]}>{failed === 'offline' ? t.offlineHint : t.unreachableHint}</Text>
    <Pressable style={s.button} onPress={() => setFailed(null)} testID="retry"><Text style={s.buttonText}>{t.retry}</Text></Pressable>
    <Pressable style={s.link} onPress={changeTeam} testID="failed-change-team"><Text style={[s.linkText, { color: c.ink }]}>{t.changeTeam}</Text></Pressable></Center>
  // the sign-in pages: the team address the app connected to (drawn here: a page can draw anything) and "another team"
  const showFooter = pathname === '/login' || pathname === '/join' || pathname.startsWith('/invite')
  // Edge to edge for a page that pads itself: it fills the screen under the status bar and the home indicator /
  // navigation bar in its own colours (env(safe-area-inset-*), and --app-inset-* from insetScript for WebViews that
  // report none). Any other page keeps the app's padding (src/look.ts frame). The sign-in pages end above the app's own
  // "another team" footer.
  const edges = frame({ selfPadded, android: Platform.OS === 'android', footer: showFooter, keyboard, insets })
  return <View style={[s.fill, { backgroundColor: c.canvas, paddingTop: edges.top, paddingLeft: insets.left, paddingRight: insets.right, paddingBottom: edges.bottom }]}
    accessibilityElementsHidden={hidden} importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}><View style={s.fill}>
    <WebView ref={web} source={{ uri: source }} style={[s.fill, { backgroundColor: c.canvas }]}
      injectedJavaScriptBeforeContentLoaded={insetJs}
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
      onLoadStart={event => {
        currentUrl.current = event.nativeEvent.url; stuck.current.cancel()
        if (Platform.OS === 'android' && !event.nativeEvent.loading) return
        loadFailed.current = false; ready.current = false; void clear()
        // the old page stays on screen until the new one arrives: its frame stays too (no padding change here)
        setPad(p => padding(p, 'load-start'))
        // Android: a same-document navigation reported as loading gets no load end; the bridge must not stay off
        if (Platform.OS === 'android') stuck.current.arm(event.nativeEvent.url,
          saved => stillStuck({ saved, current: currentUrl.current, origin: address.origin, ready: ready.current, failed: loadFailed.current }), settle)
      }}
      onLoadEnd={event => { stuck.current.cancel(); settle(event.nativeEvent.url) }}
      onNavigationStateChange={state => { currentUrl.current = state.url; setCanBack(state.canGoBack); if (sameTeam(address.origin, state.url)) setPathname(new URL(state.url).pathname) }}
      onMessage={event => {
        // the reinstall sign-out's answer (its one-time token), not a bridge message
        if (signOut && sameTeam(address.origin, event.nativeEvent.url) && signOut.answer(event.nativeEvent.data)) return
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
      <Text style={[s.footerHost, { color: c.muted }]} testID="team-host" numberOfLines={1} ellipsizeMode="middle">{hostOf(address.origin)}</Text>
      <Pressable onPress={changeTeam} style={s.footerButton} testID="change-team" accessibilityRole="button"><Text style={[s.linkText, s.underline, { color: c.ink }]}>{t.otherTeam}</Text></Pressable>
    </View>}
  </View>
}
// layout only; the colours come from the look (src/look.ts: the web app's light and dark tokens)
const s = StyleSheet.create({
  fill: { flex: 1 }, center: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  setup: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 24 }, title: { fontSize: 24, fontWeight: '600', marginBottom: 8 },
  hint: { fontSize: 15, marginBottom: 16, lineHeight: 21 }, input: { borderWidth: 1, borderRadius: 10, padding: 14, fontSize: 16 },
  error: { marginTop: 10, lineHeight: 20 }, button: { marginTop: 16, backgroundColor: product.accent, borderRadius: 10, padding: 14, alignItems: 'center', minWidth: 160 },
  buttonText: { color: accentInk(product.accent), fontSize: 16, fontWeight: '600' }, link: { marginTop: 16, padding: 8 }, footer: { alignItems: 'center', paddingTop: 8 }, footerButton: { paddingVertical: 8, paddingHorizontal: 16 },
  linkText: { fontSize: 15 }, centerText: { textAlign: 'center' }, underline: { textDecorationLine: 'underline' }, centered: { alignSelf: 'center' },
  secondary: { marginTop: 12, alignItems: 'center' }, secondaryText: { fontSize: 16, fontWeight: '500', borderWidth: 1, borderRadius: 10, padding: 13, minWidth: 160, width: '100%', textAlign: 'center', overflow: 'hidden' },
  helpRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', marginTop: 16, gap: 4 }, helpLink: { paddingVertical: 8, paddingHorizontal: 4 },
  step: { flexDirection: 'row', gap: 8, marginBottom: 12 }, stepNo: { fontSize: 15, lineHeight: 22, minWidth: 18 }, stepText: { flex: 1, fontSize: 15, lineHeight: 22 },
  ask: { marginTop: 16, borderWidth: 1, borderRadius: 12, padding: 16 }, askTitle: { fontSize: 16, fontWeight: '600', lineHeight: 22, marginBottom: 6 },
  askHost: { fontSize: 15, fontWeight: '600', marginBottom: 6 }, askText: { fontSize: 15, lineHeight: 21, marginBottom: 6 },
  askRow: { flexDirection: 'row', gap: 10, marginTop: 8 }, askButton: { flex: 1, minWidth: 0, marginTop: 0 },
  footerHost: { fontSize: 13, paddingHorizontal: 16 }, linkCard: { width: '100%', maxWidth: 480 },
})
