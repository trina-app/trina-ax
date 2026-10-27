import type { ConfigContext, ExpoConfig } from 'expo/config'
import { mobileProduct } from './src/product'
export default ({ config }: ConfigContext): ExpoConfig => {
  const product = mobileProduct(config.extra?.teamAxEdition)
  return {
    name: product.name, slug: 'team-ax-mobile', version: '0.2.2', scheme: product.scheme,
    orientation: 'portrait', userInterfaceStyle: 'automatic',
    ios: { supportsTablet: true, bundleIdentifier: product.bundleId },
    android: { package: product.bundleId, permissions: [], blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.CAMERA'] },
    plugins: ['expo-secure-store'],
    extra: { teamAxEdition: product },
  }
}
