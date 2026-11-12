# 트리나 Microsoft Store 빌드

이 폴더는 데스크톱 앱을 Microsoft Store용 MSIX 패키지로 만드는 설정입니다. 앱 코드는 같고, 배포 설정만 다릅니다.

지금 윈도우 설치 파일(NSIS `.exe`)은 서명이 없어서 설치할 때 "Windows의 PC 보호" 화면이 뜹니다. 스토어 패키지는 Microsoft가 서명하므로 이 화면 없이 설치되고, 업데이트도 스토어가 합니다.

- [electron-builder.msix.config.ts](electron-builder.msix.config.ts): `desktop/electron-builder.config.ts`를 그대로 쓰고 스토어에 필요한 것만 바꿉니다. `appx` 대상(MSIX 파일), Partner Center가 준 패키지 ID, 스토어 버전, 타일 이미지, 매니페스트입니다. 기본 설정의 appId는 바꾸지 않습니다. NSIS 앱이 그 값으로 설치된 앱을 알아봅니다.
- [build-resources/appxmanifest.xml](build-resources/appxmanifest.xml): electron-builder 기본 매니페스트에 마이크 권한(채팅 음성 입력) 한 줄을 더한 것입니다.
- [build-resources/appx/](build-resources/appx/): 시작 메뉴·작업 표시줄 타일 이미지입니다. 트리나 마크(`editions/trina/branding/mobile/icon.svg`)로 만들었고, 넓은 타일은 [build-resources/wide-tile.svg](build-resources/wide-tile.svg)입니다. 다시 만들 때: `rsvg-convert -w <크기> -h <크기> <svg> -o <파일>.png`.
- [listing.md](listing.md): 스토어 등록 문구(영어, 한국어)와 제출 화면에 넣을 답입니다.

스토어 빌드는 앱 자체 업데이트를 하지 않습니다(`process.windowsStore`, `desktop/src/common/update.ts`). 팀 페이지의 설정 › 앱도 스토어 빌드 안에서는 설치 파일을 보여 주지 않습니다. 윈도우 줄은 "이 앱"과 "Microsoft Store에서 업데이트돼요" 한 줄이고, 맥 줄은 App Store로 갑니다(데스크톱 브리지의 `store` 값, `web/src/lib/apps.ts`).

MSIX 앱은 자기 데이터를 따로 둡니다. NSIS로 설치한 앱의 팀 목록과 로그인은 넘어오지 않으니, 스토어 앱을 처음 열면 팀 주소를 다시 넣고 로그인합니다. 두 앱을 같이 설치할 수도 있습니다.

## 패키지 ID

Partner Center에서 앱 이름 "Trina AX"를 예약하면 제품 관리 > 제품 ID 화면에 `Package/Identity/Name`과 `Package/Identity/Publisher`(`CN=...`)가 나옵니다. 이 두 값을 설정 파일의 `IDENTITY`에 넣습니다. 게시자 표시 이름은 계정의 게시자 이름 `Trina Inc.`와 글자까지 같아야 합니다. 이 값들은 설치된 패키지에서 누구나 볼 수 있는 값이라 비밀이 아닙니다.

## 버전

스토어에 올리는 패키지는 매번 버전이 지난번보다 높아야 하고, 네 번째 자리는 0이어야 합니다. `0.4.0-beta.10` 같은 미리보기 버전은 `0.4.0.0`으로 줄어들어서 같은 번호가 되므로, 스토어 버전은 `MSSTORE_VERSION=x.y.z`로 따로 줍니다. 앱 안에 보이는 버전도 이 값입니다.

## 빌드

MSIX는 윈도우에서만 만들 수 있습니다(`makeappx.exe`). 보통은 GitHub Actions의 [Microsoft Store package](../../../.github/workflows/msstore.yml) 작업을 씁니다. Actions 탭에서 "Run workflow"를 누르고, 브랜치나 태그와 스토어 버전을 고르면 `msstore-msix` 아티팩트로 `.msix` 파일이 나옵니다. 이 폴더를 고치는 PR에서는 임시 ID(`MSSTORE_TEST=1`)로 빌드만 확인합니다.

윈도우 PC에서 직접 만들 때:

```sh
bun install --frozen-lockfile
cd desktop
NODE_ENV=production bun build.ts
MSSTORE_VERSION=0.4.0 bunx electron-builder --config ../editions/trina/microsoft-store/electron-builder.msix.config.ts --win appx --x64 --publish never
```

결과물은 `desktop/release/Trina-AX-<버전>-store-x64.msix`입니다. 서명하지 않은 채로 Partner Center에 올립니다. 스토어가 서명합니다.

## 제출

Partner Center(contact@trina.app, Aside의 트리나 프로필)에서 앱 > 제출을 만들고 [listing.md](listing.md)대로 채웁니다. `runFullTrust`는 제한된 권한이라 제출 옵션에 이유를 적어야 합니다. 인증 심사는 보통 며칠 걸리고, 통과하면 바로 공개되도록 둡니다.
