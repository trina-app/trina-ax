# 태그 하나로 배포하기 (자동 배포)

버전 태그를 push하면 GitHub Actions가 시험, 빌드, 서명, 업데이트 주소 업로드, GitHub Release를 모두 한다. 사람은 태그만 단다.
설치된 서버는 자동 업데이트로 받는다.

- 워크플로: `.github/workflows/release.yml`
- 시험: `.github/workflows/ci.yml`(push·PR 때와 같은 job 전부)
- 스크립트: `scripts/release/release-ci.ts`(태그, 키 확인, 리눅스 서명, SHA256SUMS), `publish.ts`(사무실 피드), `publish-server.ts`(리눅스 서버 피드), `worker.js`(업데이트 주소)
- 제품마다 다른 값(업데이트 주소, 서명 키, Cloudflare 이름)은 배포 채널 `shared/src/release-channel.ts`에서 읽는다(`docs/EDITION-RELEASE.md`). 워크플로와 스크립트에는 제품 이름이나 주소가 없다.

## 1. 배포하는 법

```sh
# 1) 버전을 올린다: server/package.json과 desktop/package.json의 version (예: 0.3.0-beta.1)
git commit -am "0.3.0-beta.1"
git push origin main

# 2) 그 커밋에 태그를 단다. 태그 메시지가 릴리스 노트가 된다(설치의 "새 버전" 안내, GitHub Release).
git tag -a v0.3.0-beta.1 -m "새 기능: …"
git push origin v0.3.0-beta.1
```

- 태그는 `v` + `server/package.json`의 version과 정확히 같아야 한다. 다르면 아무것도 하지 않고 실패한다.
- 태그에 `-`가 있으면 beta 채널(`v0.3.0-beta.1`, `v0.3.0-rc.1`), 없으면 stable 채널(`v0.3.0`)이다.
- 주석 없는 태그(`git tag v0.3.0`)도 된다. 그때 피드의 노트는 비고, GitHub Release는 노트를 자동으로 만든다.
- 진행은 GitHub의 Actions 탭 → Release에서 본다. 한 번에 하나만 돈다(다음 태그는 앞의 것이 끝날 때까지 기다린다).

## 2. 흐름

| 순서 | job | 하는 일 | 비밀값 |
|---|---|---|---|
| 1 | prepare | 태그 = 버전 확인, 채널 결정, 비밀값 두 개가 있는지, **서명 키의 공개키가 `RELEASE_CHANNEL.keys`에 있는지**(다른 제품 키면 여기서 바로 실패), 태그 메시지 → 릴리스 노트 | 키 확인 단계만 |
| 2 | test | `ci.yml` 전체: typecheck, native, 단위, fuzz, 웹, 중계, 리눅스 T1(amd64·arm64), 리눅스 묶음 L19 + verify-bundle, 설치 T2 | 없음 |
| 2 | build-linux | 리눅스 kit amd64(ubuntu-24.04)·arm64(ubuntu-24.04-arm): whisper, native, 웹, `build-bundle.ts --os linux --strict`(서명 없이) | 없음 |
| 2 | build-office | 사무실 zip(macos-15, 두 맥 프로세서 universal, `bun run build:office`) | 없음 |
| 2 | build-windows | 윈도우 설치 파일 + `latest.yml`(windows-2025, `desktop dist:win`, 버전은 태그 것) | 없음 |
| 3 | publish | 리눅스 묶음 서명(manifest.sig) → 사무실 피드(`publish.ts`) → 서버 피드(`publish-server.ts`) → `SHA256SUMS` + `.sig` | 키 + Cloudflare 토큰 |
| 4 | github-release | 태그 이름으로 Release. 자산: 리눅스 kit 2개, 사무실 zip, 윈도우 설치 파일, `SHA256SUMS`, `SHA256SUMS.sig`. beta는 prerelease | 없음(`contents: write`만) |

2의 네 job은 동시에 돈다. publish는 시험과 빌드가 모두 통과해야 시작한다.

- **맥 데스크톱 앱(dmg)은 넣지 않는다.** Apple 서명·공증이 아직 없다. 맥 데스크는 지금처럼 "새 버전이 있어요" 안내만 받는다.
- 시험·빌드·배포는 모두 태그가 가리키는 같은 커밋으로 한다. publish와 github-release는 시작할 때 태그가 아직 그 커밋인지 다시 보고, 태그가 옮겨졌으면 멈춘다.

### 업데이트 주소의 파일

| 경로 | 무엇 | 캐시 |
|---|---|---|
| `<officeDir>/<channel>.json` | 사무실 맥의 서명된 목록(사무실 zip, 윈도우 설치 파일) | 안 함 |
| `<officeDir>/<version>/…` | 사무실 zip, 윈도우 설치 파일, `latest.yml` | 영구 |
| `server/<channel>.json` + `.sig` | 리눅스 서버의 채널 머리. 아래 `release.json`과 같은 바이트 | 안 함 |
| `server/<version>/release.json` + `.sig` | 그 버전의 릴리스 정보(`mycel-ctl update --version`) | 안 함 |
| `server/<version>/manifest-linux-<arch>.json` + `.sig` | 묶음의 서명된 파일 목록(다음 릴리스가 root 파일 변경을 판단) | 안 함 |
| `server/<version>/<version>-linux-<arch>.tar.zst` | 설치된 서버가 받는 업데이트 묶음 | 영구 |
| `server/<version>/<kit>-<version>-linux-<arch>.tar.gz` | 새 설치용 kit(`docs/INSTALL-LINUX.md` 3장) | 영구 |

Worker(`scripts/release/worker.js`)는 이 경로만 읽기 전용으로 내준다. 나머지는 404다.

### 설치에 닿는 방법

- 사무실 맥: 매일 밤 `<feed>/<officeDir>/<channel>.json`을 본다(`docs/OFFICE.md` 6장).
- 리눅스 서버: `<feed>/server/<channel>.json`과 `.sig`를 본다.
  - 앱만 바뀐 릴리스는 서버가 업데이트 창(기본 03:00–05:00) 안에서 스스로 적용한다.
  - root 부분(실행기·샌드박스·유닛)이 바뀐 릴리스(`needsRoot`)는 `mycel-update.timer`(매일 04:30 ± 90분)가 적용한다.
  - `needsRoot`는 `publish-server.ts`가 정한다. 새 묶음의 `root/` 파일을 두 채널 머리 버전의 `manifest-linux-<arch>.json`과 비교하고, 비교할 수 없으면 "바뀜"으로 둔다.

## 3. 지키는 것

- **되돌아가기 금지**: 채널 머리보다 오래된 버전은 올리지 않는다.
- **같은 이름, 다른 내용 금지**: 이미 올라간 파일은 내용(sha256)을 비교한다. 다르면 멈춘다. 같은 버전을 다시 올릴 때는 같은 파일만 건너뛴다.
- **머리는 마지막**: 버전 파일 → 파일 목록 → `release.json` → 채널 머리 순서로 올린다. 중간에 끊겨도 설치는 옛 머리를 계속 본다. 머리와 `.sig` 사이에서 끊긴 상태는 다음 실행이 알아보고 다시 올린다.
- **다시 읽어 검증**: 올린 뒤 업데이트 주소로 머리를 읽는다. 설치된 서버의 `UpdateManager.checkFeed`와 같은 코드로 확인하고, 묶음과 kit도 내려받아 sha256을 비교한다. 사무실 피드도 같은 방식이다(`publish.ts`).
- **리눅스 묶음은 서명 전에 검증**: 모든 파일이 manifest와 맞고, `mycel-ctl`이 그 아키텍처 것이고, kit 안의 manifest가 업데이트 묶음과 같은 서명본이고, kit의 `product.env`가 이 제품의 업데이트 주소를 가리켜야 한다.
- **stable은 beta도 올린다**: stable 배포는 beta 채널이 더 새 버전이 아니면 beta 머리도 이 버전으로 옮긴다(beta를 받는 설치도 정식판을 받는다).
- **비밀값**
  - 두 job(prepare의 키 확인 단계, publish)에만, 쓰는 단계에만 준다. 빌드 job은 비밀값을 보지 않는다.
  - 서명 키는 `umask 077`로 `$RUNNER_TEMP/release-key.pem`(600)에 쓰고, 실패해도 지운다. 로그에는 key id만 나온다.
  - publish job은 `bun install --ignore-scripts`로 패키지 설치 스크립트를 돌리지 않는다.
  - `pull_request`로는 release.yml이 돌지 않는다. ci.yml은 비밀값을 쓰지 않는다(호출할 때도 넘기지 않는다).
- **권한**: 최상위 `contents: read`. `contents: write`는 github-release job에만.
- **외부 action**: 모두 커밋 SHA로 고정했다(ci.yml 포함). 올릴 때는 새 태그의 SHA를 확인해 바꾼다.
- **워크플로를 고친 뒤**: `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/release.yml .github/workflows/ci.yml`
  (shellcheck가 있으면 `-shellcheck $(command -v shellcheck)`도). 스크립트 시험은 `bun test tests/unit/release-ci.test.ts tests/unit/publish-server.test.ts`.

## 4. 처음 한 번 할 일 (계정, 대표 확인 뒤)

1. **GitHub Actions 결제 확인.** 이 레포는 private이라 Actions가 결제 계정의 분을 쓴다. 결제가 막혀 있거나(카드 실패, 지출 한도 0) 분이 바닥나면 **job이 시작되지 않는다.** 태그를 달아도 아무것도 빌드·배포되지 않고, run의 모든 job이 몇 초 만에 실패하며 이 안내만 남는다.
   > The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings

   2026-10-27 현재 이 레포의 CI가 이 상태다(적어도 10-22부터 모든 run이 시작 전에 실패). Settings → Billing and plans에서 결제 수단과 Actions 지출 한도를 고친 뒤 첫 태그를 단다.
2. **Cloudflare 토큰을 CI 전용으로 새로 만든다.** 권한은 최소로 한다.
   - Zone → Zone → Read: 업데이트 주소의 zone 하나(`RELEASE_CHANNEL.hosting.zone`)
   - Account → Workers R2 Storage → Edit
   - CI는 `hosting.ts setup`을 하지 않으므로 Workers Scripts·Routes 권한은 필요 없다.
3. **비밀값을 넣는다.** 레포의 Settings → Secrets and variables → Actions, 또는:
   ```sh
   gh secret set RELEASE_SIGNING_KEY --repo potenlab/team-ax < ~/.config/teamax-release/release-key.pem
   gh secret set CLOUDFLARE_API_TOKEN --repo potenlab/team-ax      # 물으면 토큰을 붙여 넣는다
   ```
   키 폴더는 `RELEASE_CHANNEL.keyDir`이다(Team AX: `teamax-release`). 파일을 화면에 출력하지 말고 리다이렉트로만 넣는다.
4. **Worker를 다시 배포한다.** 새 `worker.js`만 `server/`를 내준다. 그 전에는 `publish-server.ts`가 업로드 전에 멈춘다("does not serve server/ yet").
   ```sh
   bun scripts/release/hosting.ts setup     # 개발 맥, 기존 토큰(~/.config/treesoop/secrets.env)
   bun scripts/release/hosting.ts status    # 끝에 "Updates: office/, server/"
   ```
5. (권장) **태그 보호**: 쓰기 권한이 있는 사람은 누구나 `v*` 태그로 배포를 시작할 수 있다. GitHub 요금제가 rulesets를 지원하면 `v*` 태그 만들기·옮기기·지우기를 관리자만 하게 한다.
6. (선택) **environment**: GitHub Pro 이상이면 `release` environment를 만들어 비밀값을 거기로 옮기고 `v*` 태그에서만 쓰게 할 수 있다. 이때 release.yml의 prepare와 publish job에 `environment: release`를 더한다(지금은 Free 요금제를 생각해 넣지 않았다).

## 5. beta → stable

1. `0.3.0-beta.1`로 올리고 `v0.3.0-beta.1`을 단다. beta 채널을 보는 설치만 받는다.
   - 사무실 맥: `~/TeamAX/teamax update channel beta`
   - 리눅스 서버: `server.json`의 `update.channel`
2. 문제가 있으면 고쳐서 `0.3.0-beta.2`.
3. 괜찮으면 버전을 `0.3.0`으로 올린 커밋에 `v0.3.0`을 단다. stable 설치가 받는다. beta 채널도 `0.3.0`으로 옮겨진다.
   - 버전 문자열이 파일 안에 들어가므로 beta 파일을 그대로 승격하지 않고 다시 빌드한다. 시험도 다시 돈다.

## 6. 실패했을 때

| 어디서 | 상태 | 할 일 |
|---|---|---|
| prepare: 태그 ≠ 버전 | 아무것도 안 함 | 태그를 지운다(`git push --delete origin vX && git tag -d vX`). 버전을 고친 커밋에 다시 단다. |
| prepare: 비밀값 없음, 키 불일치 | 아무것도 안 함 | 비밀값을 고친 뒤 그 run에서 "Re-run all jobs" |
| test·build | 아무것도 안 올라감 | 고친 커밋에 **새 버전**으로 태그(예: `0.3.1`, `0.3.0-beta.2`). 태그를 옮기지 않는다. |
| publish 중간 | 버전 파일 일부만 올라갔을 수 있다. 머리는 그대로라 설치는 영향 없음 | 그 run에서 **"Re-run failed jobs"**. 같은 run의 빌드 결과(7일 보관)를 다시 쓰므로 이미 올라간 파일과 같아 이어서 올라간다. |
| "Re-run all jobs"나 workflow_dispatch로 다시 | 새로 빌드한 파일은 이미 올라간 것과 내용이 달라 거부된다 | 새 버전으로 태그 |
| github-release | 피드는 이미 끝남 | "Re-run failed jobs" |
| 잘못된 버전이 나감 | 설치는 뒤로 가지 않는다 | 고친 새 버전을 낸다. 리눅스 서버는 새 버전이 켜지지 않으면 이전 버전으로 스스로 돌아가고 7일간 다시 시도하지 않는다. 사무실 맥도 되돌린다(`docs/OFFICE.md`). |

- 같은 태그를 다시 돌리려면 Actions → Release → Run workflow에서 tag를 넣는다. "Use workflow from"도 같은 태그로 고른다(그 태그의 release.yml·ci.yml로 돈다).
- 로컬에서 같은 일을 하려면 `publish.ts`(사무실)와 `publish-server.ts --dir <서명된 묶음 폴더>`(리눅스)를 쓴다. 리눅스 묶음은 리눅스(같은 아키텍처)에서만 빌드된다.
- GitHub Release 파일 확인: 받은 폴더에서 `bun scripts/release/release-ci.ts verify-sums SHA256SUMS`(이 빌드의 공개키로 `.sig`를 확인한 뒤 옆의 파일 sha256을 본다).

## 7. 키를 바꿀 때

설치는 빌드에 들어 있는 공개키(`RELEASE_CHANNEL.keys`)만 믿는다. 순서를 지키지 않으면 설치가 업데이트를 받지 못한다.

1. 새 키를 만든다: `TEAMAX_RELEASE_KEY=~/.config/<keyDir>/release-key-2.pem bun scripts/release/keygen.ts`
2. 새 공개키를 채널에 **추가**한다(`editions/<name>/branding/release-channel.json` → `edition-release.ts --apply`, 코어는 `shared/src/release-channel.ts`를 도구로). 옛 키는 남긴다.
3. 그 빌드를 **옛 키로** 배포한다(비밀값은 아직 옛 키). 모든 설치가 그 버전을 받을 때까지 기다린다.
4. 비밀값을 새 키로 바꾼다: `gh secret set RELEASE_SIGNING_KEY --repo <repo> < ~/.config/<keyDir>/release-key-2.pem`
5. 다음 태그부터 새 키로 서명된다. 모든 설치가 새 키로 서명된 빌드를 받은 뒤 옛 키를 목록에서 뺀 빌드를 낸다.

prepare는 비밀값의 키가 목록에 없으면 멈춘다. 그래서 2를 건너뛰고 4를 하면 배포가 시작되지 않는다.
키가 새었다면 같은 순서로 바꾸되 서두른다. 옛 키를 뺀 빌드가 퍼지기 전까지는 그 키로 서명된 가짜 업데이트를 설치가 믿는다.

## 8. 비용 (private 레포)

- GitHub가 호스팅하는 runner는 결제 계정의 Actions 분을 쓴다. 무료 분과 단가는 요금제마다 다르니 Billing 페이지에서 확인한다.
- 무료 분을 셀 때 리눅스 1분 = 1분, 윈도우 1분 = 2분, **macOS 1분 = 10분**으로 센다. 무료 분을 넘으면 macOS 단가가 리눅스의 약 10배다.
- 한 번 배포의 시간은 아직 재지 않았다. 대략 추정:
  - 시험(ci.yml) 리눅스 약 2시간어치(7개 job 합)
  - 리눅스 빌드 2개 약 1시간
  - 맥 빌드 약 20–30분(무료 분 기준 200–300분)
  - 윈도우 약 15–20분(무료 분 기준 30–40분)
  - publish 약 15분
  - 맥 job 하나가 한 번 배포의 절반쯤을 차지한다. 첫 배포 뒤 실제 시간을 여기에 적는다.
- arm64 리눅스 runner(`ubuntu-24.04-arm`)는 ci.yml이 이미 쓰고 있다. private 레포에서의 단가도 Billing에서 확인한다.
- 레포가 공개되면(트리나 AX) 표준 runner는 무료다.

## 9. 판매판(트리나 AX·의료판) 레포에서 할 일

워크플로와 스크립트는 코어 병합으로 받는다. 고칠 것은 없다. 제품 값은 각 레포의 배포 채널에서 읽는다.

1. 판매판 채널을 적용한다(`docs/EDITION-RELEASE.md`): 그 제품의 서명 키, `editions/<name>/branding/release-channel.json`, `edition-release.ts --apply`.
2. 그 레포에 비밀값 두 개를 넣는다. 키는 그 제품의 `keyDir`, 토큰은 그 제품 zone·bucket이 있는 Cloudflare 계정 것이다.
   ```sh
   gh secret set RELEASE_SIGNING_KEY --repo potenlab/trina-ax < ~/.config/<트리나 keyDir>/release-key.pem
   gh secret set CLOUDFLARE_API_TOKEN --repo potenlab/trina-ax
   ```
   다른 제품 키를 넣으면 prepare가 멈춘다(key id만 보여 준다).
3. 그 제품의 업데이트 주소를 만든다: `bun scripts/release/hosting.ts setup`(그 레포 작업본에서, 그 계정 토큰으로).
4. 위 4장의 결제 확인과 태그 보호를 그 레포에서도 한다.
5. **의료판 버전 규칙**: 지금 의료판 버전은 `0.2.1-medical.N`이다. `-`가 있어 이 워크플로는 beta로 낸다. stable로 내려면 버전 규칙을 정해야 한다(예: `0.2.3`처럼 `-` 없이). 정하기 전에는 의료판 태그를 달지 않는다.
6. 트리나 AX는 공개 레포가 될 예정이다.
   - 공개 레포에서도 fork PR은 비밀값을 받지 않고, release.yml은 PR로 돌지 않는다.
   - 공개 전에 `gh secret list`로 필요한 비밀값만 있는지 본다.
