# 태그 하나로 배포하기 (자동 배포)

**현재 Trina 상태:** 최신 버전은 [최신 릴리스](https://github.com/trina-app/trina-ax/releases/latest)에서 확인합니다. `https://updates.trina.app` 피드는 Linux 서버와 사무실 Mac에 업데이트를 제공합니다. 아래는 유지보수자용 배포 절차입니다.
아래 피드 업로드 설명은 별도 피드 게시 설정을 켠 경우에만 적용됩니다. 현재 워크플로의 조건을 먼저 확인하세요.

버전 태그를 push하면 GitHub Actions가 시험, 빌드, 서명과 GitHub Release 게시를 한다.
`CLOUDFLARE_API_TOKEN`이 있는 경우에만 업데이트 피드에도 게시한다. 없으면 GitHub Releases만 사용한다.

- 워크플로: `.github/workflows/release.yml`
- 시험: `.github/workflows/ci.yml`(push·PR 때와 같은 job 전부)
- 스크립트: `scripts/release/release-ci.ts`(태그, 키 확인, 리눅스 서명, SHA256SUMS), `publish.ts`(사무실 피드), `publish-server.ts`(리눅스 서버 피드), `worker.js`(업데이트 주소)
- 제품마다 다른 값(업데이트 주소, 서명 키, Cloudflare 이름)은 배포 채널 `shared/src/release-channel.ts`에서 읽는다(`docs/EDITION-RELEASE.md`). 워크플로와 스크립트에는 제품 이름이나 주소가 없다.

## 버전 번호 / Version numbers

버전은 [Semantic Versioning 2.0.0](https://semver.org/)을 따른다: `MAJOR.MINOR.PATCH`. 사람이든 AI 에이전트든 버전을 올리거나 태그를 달기 전에 아래 표로 자리를 고른다.

**공개 API**(SemVer 규칙 1). 아래가 바뀌면 설치된 팀이 영향을 받는다.
- HTTP API(`/api/…`, `shared/src/api`). 데스크톱 앱·휴대폰 앱·MCP 커넥터가 서버에 기대는 것도 포함한다. 옛 앱은 새 서버와 계속 동작해야 한다.
- 명령: 리눅스 `mycel-ctl`, 사무실 맥 `teamax`
- 플러그인, 스킬(`SKILL.md`), 연결(MCP) 형식
- 사람이 정한 설정: 팀 설정, `server.json`, `MYCEL_*` 환경 변수
- 디스크와 데이터베이스의 데이터(`server/migrations`), 팀 폴더 구조
- 업데이트 피드 형식(`release.json`, manifest)

| 무엇이 바뀌었나 | 올리는 자리 | 예 |
|---|---|---|
| 하위 호환 버그 수정만. 잘못 동작하던 것이 의도대로 동작한다. 새 기능도, 눈에 보이는 모양·동작 변화도 없다 | PATCH | 0.2.21 → 0.2.22 |
| 하위 호환 새 기능, 또는 눈에 보이는 UI/UX 변화. 무엇을 deprecated로 표시할 때도 | MINOR(PATCH는 0) | 0.2.22 → 0.3.0 |
| 설치된 팀이 무언가 하지 않으면 되던 것이 안 된다. 설정·API 삭제, 옛 앱이 못 읽는 형식, 손으로 해야 하는 업데이트 | MAJOR(MINOR·PATCH는 0) | 1.4.2 → 2.0.0 |

- **배포 번호**는 지난 태그 뒤 병합된 변경 중 가장 높은 자리로 정한다. PATCH 여럿과 MINOR 하나면 MINOR다.
- **PR마다 버전 영향을 적는다**: `patch`, `minor`, `major` 중 하나와 이유 한 줄(PR 양식). 문서·시험만 바꾸면 `none`.
- **0.x 동안**: SemVer 규칙 4에 따라 0.y.z는 초기 개발이라, 깨지는 변경도 MINOR로 낼 수 있다. 그때는 릴리스 노트의 관리자 확인 사항에 무엇이 깨지고 무엇을 해야 하는지 분명히 쓴다. 1.0.0부터는 반드시 MAJOR다. 1.0.0으로 갈 시점은 대표가 정한다. SemVer FAQ: "If your software is being used in production, it should probably already be 1.0.0."
- **베타**: `X.Y.Z-beta.N`, `X.Y.Z-rc.N`(beta 채널). 같은 `X.Y.Z`에서 pre-release는 정식보다 낮다: `1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0`. 숫자 부분은 숫자로 비교한다. 숫자 앞에 0을 붙이지 않는다(`0.3.0`이지 `0.03.0`이 아니다).
- **낸 버전은 바꾸지 않는다**(SemVer 규칙 3). 고치면 새 번호다. 태그를 옮기거나 다시 달지 않는다(6장). 깨지는 변경이 MINOR로 나갔다면 호환을 되돌린 새 MINOR를 내고, 노트에 문제 버전과 그 사실을 쓴다(SemVer FAQ).
- 형식(`v` + `server/package.json`의 version, `1.2.3` 또는 `1.2.3-beta.1`)은 `release-ci.ts`의 `RELEASE_VERSION_RE`가 확인한다. 어느 자리를 올릴지는 확인하지 않는다. 그건 사람과 에이전트가 이 표로 정한다.

## 1. 배포하는 법

```sh
# 1) 버전을 올린다: server/package.json과 desktop/package.json의 version. 자리는 위 "버전 번호"로 고른다 (예: 0.3.0-beta.1)
git commit -am "0.3.0-beta.1"
git push origin main

# 2) 그 커밋에 태그를 단다. 태그 메시지가 릴리스 노트가 된다(설치의 "새 버전" 안내, GitHub Release).
git tag -a v0.3.0-beta.1 -m "새 기능: …"
git push origin v0.3.0-beta.1
```

- 태그는 `v` + `server/package.json`의 version과 정확히 같아야 한다. 다르면 아무것도 하지 않고 실패한다.
- 태그에 `-`가 있으면 beta 채널(`v0.3.0-beta.1`, `v0.3.0-rc.1`), 없으면 stable 채널(`v0.3.0`)이다.
- stable 릴리스는 사흘에 걸쳐 나간다(아래 "단계적 배포"). 모든 서버에 한 번에 내려면 태그 메시지에 `Rollout: all` 한 줄을 넣는다.
- 주석 없는 태그(`git tag v0.3.0`)도 된다. 그때 피드의 노트는 비고, GitHub Release는 노트를 자동으로 만든다.
- 진행은 GitHub의 Actions 탭 → Release에서 본다. 한 번에 하나만 돈다(다음 태그는 앞의 것이 끝날 때까지 기다린다).

## 2. 흐름

| 순서 | job | 하는 일 | 비밀값 |
|---|---|---|---|
| 1 | prepare | 태그 = 버전 확인, 채널 결정, 필수 서명 키와 선택적인 Cloudflare 토큰이 있는지, **서명 키의 공개키가 `RELEASE_CHANNEL.keys`에 있는지**(다른 제품 키면 여기서 바로 실패), 태그 메시지 → 릴리스 노트, 단계적 배포(`Rollout:` 줄, `release-ci.ts rollout`) | 키 확인 단계만 |
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
  - 앱만 바뀐 릴리스는 서버가 업데이트 창(기본 03:00–05:00) 안에서 스스로 적용한다. stable은 그 서버의 차례가 온 뒤다(아래 "단계적 배포"; root 타이머·사무실 맥도 같다).
  - root 부분(실행기·샌드박스·유닛, root가 따로 두는 1A 프로그램 `mycel-safeops`·`pandoc`)이 바뀐 릴리스는 `mycel-update.timer`(15분마다 확인, 팀의 업데이트 시간 안에서)가 적용한다.
  - `publish-server.ts`가 새 묶음의 `root/` 파일과 `native/mycel-safeops`·`bin/pandoc`(`build-bundle.ts` `LINUX_ROOT_COPIES`)을 두 채널 머리 버전의 `manifest-linux-<arch>.json`과 비교하고(비교할 수 없으면 "바뀜"), 그 결과로 `rootSince`(같은 root 부분을 가진 가장 오래된 릴리스)를 정한다. 0.2.19 이상 서버는 `root/VERSION`과 `rootSince`만 비교한다.
  - **`needsRoot`는 0.2.18 이하 서버용이다.** 0.2.14–0.2.18 서버는 `rootSince`를 모르고 `needsRoot`만 본다. 그래서 `--needs-root auto`는 `rootSince`가 0.2.18보다 새로우면 root 부분이 안 바뀌어도 `needsRoot`를 켠다(`NEEDS_ROOT_ONLY_UNTIL`, 0.2.19 리뷰 S3). 꺼 두면 0.2.18 서버의 앱이 0.2.20 같은 앱만 바뀐 릴리스를 스스로 받아 0.2.18 root 부분 위에서 돌고, 그 뒤 모든 릴리스를 거절한다(옛 타이머는 `needsRoot`만 보므로 root 부분도 설치하지 않는다). 0.2.19부터 root 부분이 바뀌었으니 앞으로의 릴리스는 사실상 모두 `needsRoot: true`다. 0.2.18 이하 서버의 앱은 그런 릴리스를 받지 않고, root 타이머가 root 부분과 앱을 같이 설치한다. 0.2.19 이상 서버는 `rootSince`로 판단하므로 앱만 바뀐 릴리스를 그대로 스스로 받는다(앱이 0.2.18 이하로 되돌려진 서버는 root 타이머가 받는다).
  - 배포 전 확인: `publish-server.ts --dry-run`(또는 로그)의 `needsRoot true for servers on 0.2.18 or older` 줄과 `rootSince`. `--needs-root no`는 이 규칙도 끈다(경고를 남긴다). 0.2.18 이하 서버가 하나도 남지 않았을 때만 쓴다.

### 단계적 배포 (staged roll-out)

새 stable 릴리스가 같은 밤 모든 서버에 가지 않게 한다. 나쁜 릴리스가 닿는 팀이 적다. 사람이 할 일은 없다.

- 피드의 `rollout`: `{ percent: 100, salt, ramp: [{ afterHours: 0, percent: 10 }, { afterHours: 24, percent: 50 }, { afterHours: 48, percent: 100 }] }`.
  `publish-server.ts`(`release.json`)와 `publish.ts`(사무실 stable 목록)가 stable 릴리스에 쓰고, `salt`는 릴리스마다 새로 고른다(16바이트 무작위, hex).
- 각 설치가 스스로 판단한다(`server/src/system/rollout.ts`, Go는 `native/cmd/mycel-ctl/rollout.go`, 두 쪽이 `testdata/rollout.json`을 같이 시험한다):
  차례 = sha256(salt + 설치 id)의 앞 2바이트(big-endian) % 100. 차례 < 지금 percent면 자동 업데이트가 받는다. percent는 피드의 서명된
  `publishedAt`부터 지난 시간의 단계다(지난 단계 중 `afterHours`가 가장 큰 것). 다시 게시할 필요가 없다.
  - 설치 id: 앱은 `MYCEL_INSTALL_ID`, 없으면 설정 표의 `system.installId`. root 타이머는 `/etc/default/<id>`의 `MYCEL_INSTALL_ID`, 없으면
    `admin.js update-window`의 `installId`. 읽을 수 없으면 마지막 차례(99, 100% 단계)다. 영원히 빠지는 서버는 없다.
  - 기다리지 않는 것: beta 채널의 설치(stable 릴리스가 beta 머리도 되므로 같은 바이트를 보지만 `ramp`를 무시), 피드의 `urgent: true`,
    관리자가 직접 하는 업데이트(관리자 › 시스템 › 업데이트, `sudo mycel-ctl update`, 사무실 "지금 업데이트"·`teamax update now`).
  - 보이는 곳: 관리자 › 홈("새 버전 … · 이 서버 차례인 내일 새벽 03:00–05:00에 자동으로 설치돼요", 지금 설치 버튼), `sudo mycel-ctl status`
    ("this server's turn comes at …", `--detail --json`의 `updates.rollout`), 앱의 `GET /api/admin/update` `hold: 'rollout'`과 `turnAt`,
    사무실 `teamax update status`.
  - root 타이머는 창 안에서 조용한 때를 기다리는 동안(최대 1시간) 피드에 새 릴리스가 올라와도 그 회차에는 설치하지 않는다. 처음
    판단한 버전만 설치하고, 새 릴리스는 다음 확인이 차례를 보고 판단한다.
- **옛 설치(0.4.0-beta.2 이하)**: `rollout`을 zod `z.object`(엄격하지 않음)로 읽어 `ramp`를 버리고 `percent`(100)만 본다. Go `mycel-ctl`도
  모르는 필드를 무시한다. 그래서 예전처럼 바로 받는다(시험: `tests/unit/g-rollout.test.ts` "older servers", `TestOldTimerReadsARampedFeed`).
  서명은 바이트 그대로 검증하고, `minReaderRequired`·reader 수준과는 관계없다.
- **모두에게 한 번에** (나쁜 릴리스를 고치는 릴리스, 보안 수정): 태그 메시지에 한 줄 `Rollout: all`. prepare가 그 줄을 노트에서 빼고
  (`release-ci.ts rollout`) 두 피드에 `--rollout all`을 넘긴다. 그러면 `rollout`이 아예 없다. 손으로 다시 돌릴 때는 Run workflow의
  `rollout` 입력(`tag`=태그 메시지대로, `staged`, `all`). `Rollout:` 뒤에 `all`·`staged`가 아닌 말이 있거나, `Rollout:`로 시작하는 줄이
  목록·인용·제목·굵게 표시이거나 뒤에 다른 말이 붙으면 prepare가 멈춘다(오타나 꾸밈이 배포 속도를 정하지 않게).
  - 나쁜 릴리스를 고친 릴리스는 `Rollout: all`로 낸다. salt가 릴리스마다 달라서, 나쁜 릴리스를 먼저 받은 서버가 고친 릴리스는
    마지막 차례가 될 수 있다.
- 결정은 처음 올린 `release.json`에 남는다. 다시 돌리면(같은 버전, 다른 채널) 그 `release.json`을 그대로 쓴다(`--rollout all`이어도.
  경고를 남긴다). 사무실 목록도 다시 돌리면 처음 올린 `<dir>/<version>/<channel>.json`을 머리에 다시 둔다(`publishedAt`과 salt가 그대로). 처음에
  윈도우 설치 파일 없이 올린 버전에 다시 돌려 그 파일을 더해도 처음의 `publishedAt`과 `rollout`으로 다시 서명한다.
- 로컬에서: `publish-server.ts --rollout staged|all`, `publish.ts --rollout staged|all`(기본 staged, beta 채널은 늘 없음).

## 3. 지키는 것

- **되돌아가기 금지**: 채널 머리보다 오래된 버전은 올리지 않는다.
- **같은 이름, 다른 내용 금지**: 이미 올라간 파일은 내용(sha256)을 비교한다. 다르면 멈춘다. 같은 버전을 다시 올릴 때는 같은 파일만 건너뛴다.
  - 피드 읽기는 모두 한 길로 간다(`sign.ts` `feedReader`). 네트워크 오류, 5xx, 408, 429, Content-Length와 다른 길이의 응답은 결론이 아니다. 매번 새 `?t=`로 5번까지 읽고, 그래도 안 되면 아무것도 올리지 않고 멈춘다. 업로드도 5번까지 보낸다(`cloudflare.ts` `putObject`). 거부 응답과 로컬 파일 오류는 바로 멈춘다.
  - **404는 버킷에 묻는다.** 피드의 404 한 번으로는 파일을 올리지도, 되돌아가기 검사를 건너뛰지도 않는다. 버킷의 List Objects(`cloudflare.ts` `hasObject`)도 없다고 할 때만 없다. 버킷에 있으면 다시 읽고, 5번 뒤에도 피드가 404면 멈춘다. 목록을 못 읽으면(권한, 없는 버킷) 역시 멈춘다.
  - 확인과 업로드 사이는 원자적이지 않다. R2의 조건부 쓰기는 S3 API에만 있다. 같은 키에 동시에 쓰는 일은 워크플로의 `concurrency`가 막는다.
  - 다른 내용으로 읽혀도 5초 간격으로 세 번까지 읽은 뒤에 판단한다(`compareRemote`). 처음에 있던 파일이 다시 읽을 때 없다고 나와도 "없음"이 아니다.
  - 아무것도 올리지 않는 `publish.ts --dry-run`은 토큰 없이도 돈다. 그때는 404를 몇 초 간격으로 세 번 보고 없다고 판단한다.
- **같은 빌드는 같은 바이트**(리눅스에서 서명할 때): `sign-linux`를 다시 돌려도 업데이트 묶음과 kit의 바이트가 같다. 모든 항목의 시각이 `manifest.json`의 `createdAt`이고(`bundle.ts` `packTimeMs`), 순서는 이름순, 소유자는 0이고, Ed25519 서명은 결정적이고, 압축 스트림은 소스가 끝나는 시점과 무관하다(`streams.ts` `through`). 그래서 중간에 끊긴 publish를 다시 돌리면 이어서 올라간다.
  - 빌드를 다시 하면 `createdAt`부터 달라지므로 다른 파일이고, 위 규칙대로 거부된다.
  - 보장은 같은 OS, 같은 Bun에서다. kit의 gzip 헤더에는 OS 바이트가 있어 맥에서 다시 서명한 kit은 리눅스 것과 다르고, 위 규칙대로 거부된다.
- **머리는 마지막**: 버전 파일 → 파일 목록 → `release.json` → 채널 머리 순서로 올린다. 중간에 끊겨도 설치는 옛 머리를 계속 본다. 머리와 `.sig` 사이에서 끊긴 상태는 다음 실행이 알아보고 다시 올린다.
- **다시 읽어 검증**: 올린 뒤 업데이트 주소로 머리를 읽는다. 설치된 서버의 `UpdateManager.checkFeed`와 같은 코드로 확인하고, 묶음과 kit도 내려받아 sha256을 비교한다. 사무실 피드(`publish.ts`)는 더 가볍다. 올린 파일마다 HEAD로 길이만 보고, 머리는 다시 읽어 서명과 버전을 확인한다. 파일을 내려받아 sha256을 비교하지는 않는다.
- **리눅스 묶음은 서명 전에 검증**: 모든 파일이 manifest와 맞고, `mycel-ctl`이 그 아키텍처 것이고, kit 안의 manifest가 업데이트 묶음과 같은 서명본이고, kit의 `product.env`가 이 제품의 업데이트 주소를 가리켜야 한다.
- **stable은 beta도 올린다**: stable 배포는 beta 채널이 더 새 버전이 아니면 beta 머리도 이 버전으로 옮긴다(beta를 받는 설치도 정식판을 받는다).
- **비밀값**
  - 두 job(prepare의 키 확인 단계, publish)에만, 쓰는 단계에만 준다. 빌드 job은 비밀값을 보지 않는다.
  - 서명 키는 `umask 077`로 `$RUNNER_TEMP/release-key.pem`(600)에 쓰고, 실패해도 지운다. 로그에는 key id만 나온다.
  - publish job은 `bun install --ignore-scripts`로 패키지 설치 스크립트를 돌리지 않는다.
  - `pull_request`로는 release.yml이 돌지 않는다. ci.yml은 비밀값을 쓰지 않는다(호출할 때도 넘기지 않는다).
- **권한**: 최상위 `contents: read`. `contents: write`는 github-release job에만.
- **외부 action**: 모두 커밋 SHA로 고정했다(ci.yml 포함). 올릴 때는 새 태그의 SHA를 확인해 바꾼다.
- **Go 버전**: 두 워크플로의 `env`에 `GO_VERSION: 1.27.3`(0.2.15를 빌드한 버전)과 `GOTOOLCHAIN: local`을 두고, 모든
  `actions/setup-go`가 `go-version: ${{ env.GO_VERSION }}`을 쓴다. `native/go.mod`의 `go 1.27`만 보면 setup-go가 그날의 최신
  1.27.x를 깔아, Go 패치가 나오거나 러너 이미지가 바뀔 때 root 프로그램(`mycel-ctl`·실행기·샌드박스·bootstrap·`mycel-safeops`)의
  바이트가 달라지고, 그 릴리스가 `needsRoot`가 되어 모든 리눅스 서버에 root 업데이트를 요구한다.
  - 올리는 법: 새 Go를 정한 뒤 한 커밋에서 `versions.json`의 `"go"`, 두 워크플로의 `GO_VERSION`을 같이 바꾼다(`tests/unit/release-ci.test.ts`가
    셋이 같은지 본다). 필요하면 `native/go.mod`의 `go` 줄도. 그 커밋이 들어간 첫 릴리스는 root 프로그램이 바뀌므로 `needsRoot`가 되고,
    서버는 `mycel-update.timer`나 `sudo mycel-ctl update`로 한 번 root 업데이트를 받는다. 보안 패치가 아니면 다른 root 변경과 묶어 올린다.
- **워크플로를 고친 뒤**: `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/release.yml .github/workflows/ci.yml`
  (shellcheck가 있으면 `-shellcheck $(command -v shellcheck)`도). 스크립트 시험은 `bun test tests/unit/release-ci.test.ts tests/unit/publish-server.test.ts`.

## 4. 처음 한 번 할 일 (계정, 대표 확인 뒤)

1. **GitHub Actions 결제 확인.** 이 레포는 private이라 Actions가 결제 계정의 분을 쓴다. 결제가 막혀 있거나(카드 실패, 지출 한도 0) 분이 바닥나면 **job이 시작되지 않는다.** 태그를 달아도 아무것도 빌드·배포되지 않고, run의 모든 job이 몇 초 만에 실패하며 이 안내만 남는다.
   > The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings

   2026-10-27 현재 이 레포의 CI가 이 상태다(적어도 10-22부터 모든 run이 시작 전에 실패). Settings → Billing and plans에서 결제 수단과 Actions 지출 한도를 고친 뒤 첫 태그를 단다.
2. **Cloudflare 토큰을 CI 전용으로 새로 만든다**(업데이트 피드를 쓸 때만. `CLOUDFLARE_API_TOKEN`이 없으면 release.yml은 피드를 건너뛰고 GitHub Release만 만든다, 2026-10-28). 권한은 최소로 한다.
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
   bun scripts/release/hosting.ts status    # 끝에 "Updates: office/, server/". "bucket objects can be listed: yes"도 본다(이게 안 되면 publish가 멈춘다)
   ```
5. (권장) **태그 보호**: 쓰기 권한이 있는 사람은 누구나 `v*` 태그로 배포를 시작할 수 있다. GitHub 요금제가 rulesets를 지원하면 `v*` 태그 만들기·옮기기·지우기를 관리자만 하게 한다.
6. **environment `release`**: release.yml의 prepare와 publish job은 `environment: release`를 쓴다(2026-10-28). 공개 레포는 요금제와 관계없이 environment 보호 규칙을 쓸 수 있다. Settings → Environments → `release`에서 (1) 배포 허용 대상을 `v*` 태그로 제한하고 (2) 필요하면 승인자를 정한 뒤, 두 비밀값을 레포 비밀값에서 이 environment로 옮긴다. environment가 없으면 GitHub이 보호 없이 새로 만든다(레포 비밀값은 그대로 쓰인다).

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
| publish 중간 | 버전 파일 일부만 올라갔을 수 있다. 머리는 그대로라 설치는 영향 없음 | 그 run에서 **"Re-run failed jobs"**. 같은 run의 빌드 결과(7일 보관)를 다시 서명해도 바이트가 같으므로 이어서 올라간다. 올라간 파일을 지우지 않는다. |
| publish: `release.json`이 `.sig` 없이 있다고 멈춤 | 둘 사이에서 끊겼다. 피드의 파일에 서명해 줄 수는 없어 사람이 본다 | 내용을 확인한 뒤 버킷에서 그 `release.json`만 지우고 "Re-run failed jobs" |
| publish: `.sig`가 `release.json` 없이 있다고 멈춤 | `.sig`만 남았다. 새 `release.json`과 맞지 않는다 | 버킷에서 그 `.sig`만 지우고 "Re-run failed jobs" |
| publish: `.sig`가 `release.json`을 검증하지 못한다고 멈춤 | 끊겨서 생기는 상태가 아니다. 둘 중 하나가 바뀌었다 | 지우지 않는다. 누가 왜 바꿨는지 먼저 본다. 고친 뒤 새 버전으로 낸다 |
| publish: `HTTP 5xx`, 네트워크 오류로 멈춤 | 5번 해도 실패했다. 올리기 전 확인이나 업로드에서 멈췄으면 머리는 그대로다. 올린 뒤 재확인에서 멈췄으면 그 파일이나 머리까지 이미 올라갔을 수 있다(로그의 `↑` 줄로 구분한다) | 잠시 뒤 "Re-run failed jobs". 이미 올라간 파일은 같은 바이트라 건너뛴다 |
| publish: `HTTP 404, but the file is there`로 멈춤 | 피드는 404인데 버킷에는 있다. 아무것도 덮어쓰지 않았다 | Worker 배포를 본다(`hosting.ts status`) |
| publish: `list <key>: HTTP …`로 멈춤 | 버킷 목록을 못 읽어 404를 확인할 수 없다. 아무것도 올리지 않았다 | 토큰 권한을 본다(`hosting.ts status`) |
| "Re-run all jobs"나 workflow_dispatch로 다시 | 새로 빌드한 파일은 이미 올라간 것과 내용이 달라 거부된다 | 새 버전으로 태그 |
| github-release | 피드는 이미 끝남 | "Re-run failed jobs" |
| 잘못된 버전이 나감 | 설치는 뒤로 가지 않는다. stable이면 단계적 배포로 첫날은 약 10%만 받았다 | 고친 새 버전을 태그 메시지 `Rollout: all`로 낸다(2장 "단계적 배포"). 리눅스 서버는 새 버전이 켜지지 않으면 이전 버전으로 스스로 돌아가고 7일간 다시 시도하지 않는다. 사무실 맥도 되돌린다(`docs/OFFICE.md`). |

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
   gh secret set RELEASE_SIGNING_KEY --repo trina-app/trina-ax < ~/.config/<트리나 keyDir>/release-key.pem
   gh secret set CLOUDFLARE_API_TOKEN --repo trina-app/trina-ax
   ```
   다른 제품 키를 넣으면 prepare가 멈춘다(key id만 보여 준다).
3. 그 제품의 업데이트 주소를 만든다: `bun scripts/release/hosting.ts setup`(그 레포 작업본에서, 그 계정 토큰으로).
4. 위 4장의 결제 확인과 태그 보호를 그 레포에서도 한다.
5. **의료판 버전 규칙**: 지금 의료판 버전은 `0.2.1-medical.N`이다. `-`가 있어 이 워크플로는 beta로 낸다. stable로 내려면 버전 규칙을 정해야 한다(예: `0.2.3`처럼 `-` 없이). 정하기 전에는 의료판 태그를 달지 않는다.
6. 트리나 AX는 공개 레포다.
   - 공개 레포에서도 fork PR은 비밀값을 받지 않고, release.yml은 PR로 돌지 않는다.
   - 공개 전에 `gh secret list`로 필요한 비밀값만 있는지 본다.

## User-facing release notes

Write the annotated tag message from [the EN/KO release template](../.github/RELEASE_TEMPLATE.md). The workflow carries it into Linux bundles, signed feeds and the GitHub release body. A line `Rollout: all` in it publishes a stable release to every server at once instead of the staged roll-out (section 2); the workflow takes that line out of the notes. Review default changes, artifact names, README/FAQ/llms parity before tagging. Backfilling published release bodies is a separate authorized maintainer action; this docs branch does not publish them.
