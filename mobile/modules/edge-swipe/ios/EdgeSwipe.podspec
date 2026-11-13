# The app's own Expo module (mobile/modules/edge-swipe, linked by Expo's autolinking from mobile/modules): the iPhone's
# edge swipe on the team page turned on and off without losing WebKit's pictures of earlier screens (EdgeSwipeModule.swift).
Pod::Spec.new do |s|
  s.name           = 'EdgeSwipe'
  s.version        = '1.0.0'
  s.summary        = 'Turns the WebView edge swipe on and off'
  s.description    = 'Turns the WKWebView back and forward edge swipe on and off while WebKit keeps its navigation snapshots.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Team AX'
  s.homepage       = 'https://github.com/trina-app/trina-ax'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files   = '**/*.swift'
end
