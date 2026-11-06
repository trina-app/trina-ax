// The root typecheck reaches mobile/app.config.ts through tests/unit/mobile-push.test.ts, but the phone app's own
// packages (mobile/package-lock.json) are installed neither for it nor in CI. These are the two types app.config.ts
// imports, loosely; the app's own typecheck (mobile/tsconfig.json) uses Expo's real ones.
declare module 'expo/config' {
  export interface ExpoConfig { [key: string]: any }
  export interface ConfigContext { config: Partial<ExpoConfig>; projectRoot: string; [key: string]: any }
}
