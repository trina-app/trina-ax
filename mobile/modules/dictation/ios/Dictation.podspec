# The app's own Expo module (mobile/modules/dictation, linked by Expo's autolinking from mobile/modules): voice input
# transcribed on the iPhone itself (DictationEngine.swift; docs/decisions/20261119-iphone-dictation.md).
Pod::Spec.new do |s|
  s.name           = 'Dictation'
  s.version        = '1.0.0'
  s.summary        = 'Voice input transcribed on the phone'
  s.description    = "Turns the page's 16 kHz voice input samples into words on the iPhone with Apple's on-device speech recognition."
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Team AX'
  s.homepage       = 'https://github.com/trina-app/trina-ax'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'Speech', 'AVFoundation'
  s.source_files   = '**/*.swift'
end
