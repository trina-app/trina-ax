# The app's own Expo module (mobile/modules/push-sync, linked by Expo's autolinking from mobile/modules): the iPhone takes
# the notifications read on another device off Notification Center when a silent sync lists them (PushSync.swift).
Pod::Spec.new do |s|
  s.name           = 'PushSync'
  s.version        = '1.0.0'
  s.summary        = 'Removes delivered notifications a silent sync lists'
  s.description    = 'Takes the delivered notifications whose notice ids a silent sync push lists off Notification Center.'
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
