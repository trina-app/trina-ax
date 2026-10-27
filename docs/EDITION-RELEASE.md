# 판매판의 배포 채널

배포 채널은 이 제품의 업데이트가 어디서 오고 어떤 키로 서명되는지를 정한다. 코어와 각 판매판(Trina AX, 의료판)은 채널을 따로 쓴다. 설치된 서버는 자기 제품의 업데이트만 받는다. 업데이트가 이 빌드에 들어 있는 키로 검증되어야 하고, 사무실 모드 업데이트 목록의 `product`도 맞아야 한다.

채널 값은 두 소스 파일에만 있다. 서버, 사무실 업데이트, 배포 스크립트, 리눅스 설치 묶음(`product.env`의 `RELEASE_FEED`)은 모두 여기서 읽는다.

| 파일 | 내용 |
|---|---|
| `shared/src/release-channel.ts` | `RELEASE_CHANNEL` 전체 |
| `native/internal/bundle/release_keys.go` | 같은 키(`mycel-ctl`, 리눅스 bootstrap) |

## 판매판이 채널을 정하는 방법

1. 판매판의 서명 키를 만든다. 배포하는 맥에서 한 번만 한다.

   ```sh
   TEAMAX_RELEASE_KEY=~/.config/<keyDir>/release-key.pem bun scripts/release/keygen.ts
   ```

   공개키만 출력된다. 개인키는 레포·로그·채팅에 넣지 않는다. 개인키를 잃으면 이미 설치된 서버는 새 업데이트를 받지 못하니 따로 백업한다.

2. `editions/<name>/branding/release-channel.json`을 쓴다. 필드는 정확히 다음과 같다.

   ```json
   {
     "feed": "https://updates.example.com",
     "keys": ["<공개키 base64>"],
     "officeProduct": "example-office",
     "officeDir": "office",
     "keyDir": "example-release",
     "hosting": { "zone": "example.com", "bucket": "example-updates", "worker": "example-updates" }
   }
   ```

3. 검토한 뒤 적용한다.

   ```sh
   bun scripts/edition-release.ts editions/<name>/branding/release-channel.json
   bun scripts/edition-release.ts editions/<name>/branding/release-channel.json --apply
   ```

   앞 명령은 검토만 한다.

4. 각 빌드를 다시 한다. 웹, 서버 묶음, 사무실 zip, `mycel-ctl`이 모두 새 값을 받아야 한다.

5. 태그로 배포하려면 그 레포에 비밀값 `RELEASE_SIGNING_KEY`(이 채널의 키)와 `CLOUDFLARE_API_TOKEN`을 넣는다(`docs/RELEASE-CI.md` 9장). 워크플로가 비밀값의 키가 `keys`에 있는지 먼저 확인한다.

## 필드

| 필드 | 뜻 |
|---|---|
| `feed` | 업데이트 주소. https 원점만 쓴다(경로·포트 없음). 사무실 모드는 `<feed>/<officeDir>/<channel>.json`, 리눅스 서버는 `<feed>/server/<channel>.json`을 읽는다. |
| `keys` | 믿는 Ed25519 공개키 1~4개(raw 32바이트, base64) |
| `officeProduct` | 서명된 사무실 업데이트 목록의 `product` 값. `-office`로 끝난다. |
| `officeDir` | 업데이트 주소 안의 사무실 모드 폴더. `server`는 쓸 수 없다. |
| `keyDir` | 배포 맥의 개인키 폴더 `~/.config/<keyDir>/` |
| `hosting` | 업데이트 주소를 올리는 Cloudflare zone, R2 bucket, Worker 이름(`scripts/release/hosting.ts`) |

## 지키는 것

- `feed`의 호스트는 `hosting.zone` 안에 있어야 한다.
- 잘못된 키, 같은 키 두 번, 알 수 없는 필드, http 주소는 쓰기 전에 거부한다.
- 같은 설정을 다시 적용하면 바뀌는 것이 없다.
- `tests/unit/release-channel.test.ts`가 다음을 확인한다.
  - 두 파일이 도구가 쓰는 내용과 정확히 같다.
  - 판매판 레포라면 `editions/*/branding/release-channel.json`과 같은 값이다.
  - 다른 소스 파일에 업데이트 주소·bucket·키가 직접 적혀 있지 않다.
- 키를 바꿀 때는 새 키를 먼저 추가해 그 빌드를 배포한다. 그다음 새 키로 서명하고, 모든 설치가 새 빌드를 받은 뒤 옛 키를 뺀다.
- 업데이트 주소를 Cloudflare에 실제로 만드는 일(`hosting.ts setup`)과 첫 배포(`publish.ts`)는 운영 계정을 바꾸는 일이다. 대표 확인 뒤에 한다.

## 포크 동기화

포크를 코어와 병합할 때 이 두 파일이 충돌하면 코어 쪽 파일을 받는다. 그다음 판매판 설정을 다시 적용하고(`--apply`) 위 시험을 돌린다. 문서(`docs/OFFICE.md`, `docs/INSTALL-LINUX.md`, `scripts/office/README.txt`)에 적힌 Team AX 주소는 판매판 문서를 손볼 때 같이 바꾼다.
