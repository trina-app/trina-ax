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
