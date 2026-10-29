# 판매판 빌드의 제품 이름

판매판은 `editions/<name>/branding/product.json`에서 `displayName`, `shortName`, `artifactBase`, `officeBundle` 네 이름만 정한다. 다른 회사에도 필요한 적용 도구는 코어의 `scripts/product-brand.ts`에 둔다.

별도 판매판 빌드 사본에서 다음 순서로 사용한다.

```sh
bun scripts/product-brand.ts editions/trina/branding/product.json
bun scripts/product-brand.ts editions/trina/branding/product.json --apply
bun run --cwd web build
```

첫 명령은 검토만 한다. `--apply`는 `shared/src/product.ts`의 네 필드를 바꾼다. 서버·웹·데스크톱·menubar·설치 묶음은 이후 각 기존 빌드를 실행해야 같은 이름을 받는다. 이미 만들어진 바이너리나 웹 dist에는 소급 적용되지 않는다.

제품 이름의 단일 출처는 계속 `PRODUCT`다. 설치된 앱의 bundle ID, 데이터 디렉터리, 환경 변수, 소켓, MCP 이름은 바꾸지 않아 기존 연결·업데이트 경로를 보존한다. 의료 앱의 별도 native bundle ID는 모바일 설정에서 독립적으로 유지한다.

브랜드 설정 파일에 다른 필드를 넣거나 쉘/소스 특수문자·잘못된 파일 이름을 넣으면 쓰기 전에 거부한다. 알 수 없는 product 소스 형식도 거부한다. 동일 설정을 반복 적용하면 추가 차이가 생기지 않는다. 로고·상표·앱 서명·배포 계정 설정을 바꾸는 도구는 아니다.

코어 자체의 중립 소스에는 판매판 이름을 적용하지 않는다. 포크 동기화에서 `product.ts`가 충돌하면 upstream 중립 파일을 받은 뒤 edition 설정을 다시 적용하고 제품명 검사와 각 빌드를 실행한다.

업데이트 주소와 서명 키는 이름과 따로 `editions/<name>/branding/release-channel.json`에서 정한다. [EDITION-RELEASE.md](EDITION-RELEASE.md)를 본다.

## 소스 코드 링크 (AGPL-3.0)

판매판 앱의 "소스 코드" 링크와 소스 요청 메일 주소는 `editions/<name>/branding/source.json`에서 정한다. 필드는 `repository`(그 판매판의 공개 레포 주소), `published`(공개됐으면 `true`, 그 전에는 링크가 메일 요청으로 바뀐다), `requestEmail`(소스 요청을 받는 주소) 셋뿐이다. 코어의 비공개 레포 주소가 판매판 앱에 나오면 안 된다.

```sh
bun scripts/edition-source.ts editions/trina/branding/source.json
bun scripts/edition-source.ts editions/trina/branding/source.json --apply
```

`--apply`는 `shared/src/source.ts`의 `SOURCE_CODE` 세 필드만 바꾼다. `tests/unit/edition-source.test.ts`가 판매판 설정과 적용 값이 같은지, 다른 소스에 레포 주소가 직접 적혀 있지 않은지 확인한다.

## Hosted service addresses (2026-10-28)

An edition with its own hosted service sets its addresses in `editions/<name>/branding/service.json`:

```json
{ "teamDomain": "example.app", "officialRelayUrl": "wss://relay.example.app/connect", "accountHost": "account.example.app", "statusHost": "status.example.app" }
```

`bun scripts/edition-service.ts editions/<name>/branding/service.json --apply` writes them into
`shared/src/service-hosts.ts`. They set the desktop app's team address domain and its examples, the official relay
in Admin > System (and how the server tells it from a self-hosted relay), the claim-code hint, and the relay's account
and status links. The official relay must be under `teamDomain`. Not changed: LaunchDaemon labels and bundle ids
(`app.treesoop.*`, they are on installed machines) and the contract test vectors in `shared/src/cloud-protocol/`.
