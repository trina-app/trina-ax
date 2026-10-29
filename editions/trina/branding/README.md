# 트리나 공개 브랜드 설정

이 폴더는 공개 앱의 이름, 업데이트 채널, 서비스 주소와 소스 링크 설정을 담습니다. 호스팅 결제·운영 코드와 웹사이트 원본은 이 저장소에 포함되지 않습니다.

## 앱·설치 파일 이름

[product.json](product.json)을 `bun scripts/product-brand.ts editions/trina/branding/product.json`으로 검토합니다. 적용할 별도 빌드 사본에서 같은 명령에 `--apply`를 붙인 뒤 필요한 앱을 다시 빌드하세요. 설치 ID와 기존 데이터 경로는 유지합니다. [브랜드 적용 절차](../../../docs/EDITION-BRANDING.md).

## 업데이트 채널

[release-channel.json](release-channel.json)은 업데이트 주소와 신뢰할 공개 서명 키를 정합니다. `bun scripts/edition-release.ts editions/trina/branding/release-channel.json`으로 검토하고, 적용할 빌드 사본에서 `--apply`를 사용합니다. 생성 대상은 `shared/src/release-channel.ts`와 `native/internal/bundle/release_keys.go`입니다.

공개 피드 `https://updates.trina.app`는 Linux 서버와 사무실 Mac 업데이트를 제공합니다. 현재 배포 버전과 파일은 [최신 릴리스](https://github.com/trina-app/trina-ax/releases/latest)에서 확인하세요. 피드가 없다는 이전 작업 기록은 현재 상태가 아닙니다. 개인 서명 키는 저장소·로그·채팅에 넣지 않습니다. 키 교체와 운영 인프라 변경은 담당자의 별도 배포 절차를 따릅니다. [채널과 서명](../../../docs/EDITION-RELEASE.md).

## 서비스 주소

[service.json](service.json)은 팀 도메인과 공식 중계·계정·상태 페이지의 기본 주소를 정합니다. `bun scripts/edition-service.ts editions/trina/branding/service.json`으로 검토하고, `--apply`로 `shared/src/service-hosts.ts`에 적용합니다. 주소 설정 자체는 서비스 가용성이나 무료 등록을 보장하지 않습니다. 공식 중계 등록에는 발급받은 연결 코드가 필요합니다. 기존 LaunchDaemon 이름과 데이터 경로는 호환성을 위해 유지합니다.

## 소스 링크

[source.json](source.json)은 공개 저장소 `trina-app/trina-ax`, `published: true`, 요청 메일 `contact@trina.app`을 정합니다. `bun scripts/edition-source.ts editions/trina/branding/source.json`으로 검토하고, `--apply`로 `shared/src/source.ts`에 적용합니다. 앱은 유효한 실행 버전에 해당하는 소스 태그로 연결하며, 버전이 없거나 유효하지 않으면 소스 요청 경로를 사용합니다. [소스 제공 범위](../../../docs/SOURCE-OFFER.md).

## 웹사이트 출처 기록

[웹사이트 원본 라이선스](LICENSE.website-upstream.txt)와 [기존 출처 고지](NOTICE.website-upstream.md)는 보존합니다. 이 고지는 과거 웹사이트 작업의 출처 기록이며, 비공개 웹사이트 파일이나 당시 로컬 경로가 이 공개 폴더에 존재한다는 뜻은 아닙니다. 현재 공개 앱 화면과 가상 자료의 출처는 [스크린샷 기록](../../../docs/images/README.md)에 있습니다. 상표·제3자 고지는 코드 라이선스와 별도로 확인하세요.
