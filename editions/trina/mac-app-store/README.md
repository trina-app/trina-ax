# 트리나 Mac App Store 빌드

이 폴더는 데스크톱 앱을 Mac App Store용 `.pkg`로 만드는 설정입니다. 앱 코드는 같고, 배포 설정만 다릅니다.

- [electron-builder.mas.config.ts](electron-builder.mas.config.ts): `desktop/electron-builder.config.ts`를 그대로 쓰고 스토어에 필요한 것만 바꿉니다. 번들 ID `app.trina.ax`, `mas` 대상(universal), 샌드박스 권한, 프로비저닝 프로필, 빌드 번호입니다. 기본 설정의 appId는 바꾸지 않습니다. 윈도우 앱이 그 값으로 설치된 앱을 알아봅니다.
- [entitlements.mas.plist](entitlements.mas.plist): 앱 본체 권한입니다. 앱 샌드박스, 앱 그룹, 바깥 연결(팀 서버, 앱 안 브라우저), 사람이 고르거나 저장하는 파일과 다운로드 폴더, 음성 입력용 마이크입니다.
- [entitlements.mas.inherit.plist](entitlements.mas.inherit.plist): 앱 안 Electron 도우미 프로그램 권한입니다. 앱의 샌드박스를 그대로 물려받습니다.
- [entitlements.mas.loginhelper.plist](entitlements.mas.loginhelper.plist): Electron 로그인 도우미 권한입니다. macOS가 직접 실행하므로 샌드박스를 따로 켭니다.

스토어 빌드는 앱 자체 업데이트 안내를 띄우지 않습니다. 업데이트는 App Store가 합니다(`desktop/src/common/update.ts`). 팀 페이지의 설정 > 앱도 스토어 빌드 안에서는 데스크톱 설치 파일(맥 .dmg, 윈도우 .exe)과 설치 안내를 보여 주지 않고, App Store에서 업데이트된다는 한 줄만 보여 줍니다(데스크톱 브리지의 `store` 값, `web/src/lib/downloads.ts`).

스토어 앱은 자기 데이터를 샌드박스 안에 따로 둡니다(`~/Library/Containers/app.trina.ax/`). dmg로 설치한 앱의 팀 목록과 로그인, 앱 안 브라우저 설정은 넘어오지 않습니다. dmg 앱을 쓰던 사람이 스토어 앱을 처음 열면 팀 목록이 비어 있으니 팀 주소를 다시 넣고 로그인합니다.

## 버전

사람이 보는 버전은 `desktop/package.json`의 version입니다. `MAS_BUILD_NUMBER`는 App Store Connect에 올릴 때마다 지난번보다 커야 합니다. 같은 버전을 다시 올릴 때도 올립니다.

## 빌드

맥에서 Xcode 명령줄 도구가 있어야 합니다. 키체인에 두 인증서가 있어야 합니다.

- `Apple Distribution: Trina Inc. (YWW96288YY)`: 앱 서명
- `3rd Party Mac Developer Installer: Trina Inc. (YWW96288YY)`: `.pkg` 서명 (만들 때 고르는 종류 이름은 Mac Installer Distribution입니다)

인증서와 프로비저닝 프로필은 App Store Connect가 아니라 Apple Developer 사이트의 Certificates, Identifiers & Profiles에서 만들고 받습니다. 키체인에서 인증서가 "신뢰되지 않음"으로 보이면 Apple WWDR 중간 인증서(G3)를 같은 키체인에 넣습니다. 프로비저닝 프로필은 `app.trina.ax`용 Mac App Store 프로필입니다. 프로필 파일은 그대로 앱에 들어가므로 누구나 읽을 수 있어야 합니다(`chmod 644`). 아니면 업로드 검사에서 거절됩니다(ITMS-90255). 인증서, 암호, 프로필, API 키는 저장소에 넣지 않습니다.

```sh
bun install --frozen-lockfile
cd desktop
NODE_ENV=production bun build.ts
MAS_BUILD_NUMBER=1 MAS_PROVISIONING_PROFILE=/경로/프로필.provisionprofile \
  bunx electron-builder --config ../editions/trina/mac-app-store/electron-builder.mas.config.ts --mac mas --universal --publish never
```

결과물은 `desktop/release/mas-universal/` 아래 앱과 `.pkg`입니다. 인증서가 별도 키체인에 있으면 `CSC_KEYCHAIN=<키체인 파일>`을 같이 줍니다.

## 확인과 업로드

```sh
codesign -dvvv --entitlements - "desktop/release/mas-universal/<앱 이름>.app"
pkgutil --check-signature desktop/release/mas-universal/<파일>.pkg
xcrun altool --validate-app -f desktop/release/mas-universal/<파일>.pkg -t macos --apiKey <키 ID> --apiIssuer <Issuer ID>
xcrun altool --upload-app -f desktop/release/mas-universal/<파일>.pkg -t macos --apiKey <키 ID> --apiIssuer <Issuer ID>
```

altool은 App Store Connect API 키 파일(`AuthKey_<키 ID>.p8`)을 `~/.appstoreconnect/private_keys/`에서 찾습니다. 올린 뒤에는 키 파일을 지웁니다. 처리가 끝나면 App Store Connect의 TestFlight와 앱 버전 화면에 빌드가 보입니다.
