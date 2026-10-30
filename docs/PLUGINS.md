# 플러그인 설치·관리

회사에 필요한 기능만 골라 더하는 방법입니다. 1단계에서는 **회사 전체** 범위만 있고, **소유자와 관리자만** 설치·관리합니다. 팀·개인 범위는 다음 단계입니다. 설계 배경은 [DECISIONS](DECISIONS.md)의 "Plugins, stage 1"에 있습니다.

## 지금 되는 것

- **관리 > 플러그인** 화면: 설치된 플러그인, 공식 목록, 파일로 설치, 서버에 놓인 꾸러미.
- 두 종류를 설치할 수 있습니다.
  - **스킬 꾸러미**: 회사 스킬(`SKILL.md`)만 든 데이터 꾸러미. 실행되는 코드는 없습니다.
  - **네이티브 도구·미리보기**: 서버에서 격리해 돌리는 프로그램. 코어가 이미 아는 드라이버만 받습니다(지금은 HWP 미리보기의 `rhwp-v1` 하나).
- 연결 프리셋, 지역 꾸러미, 언어 꾸러미는 형식에 자리만 있고 아직 설치할 수 없습니다.

## 설치

1. **파일로 설치**(또는 공식 목록의 **설치**)를 누릅니다.
2. 서버가 먼저 꾸러미를 검사합니다: 크기·개수 한도, 경로(링크·`..`·숨김 이름 거부), 설명 파일(`trina-plugin.json`), 서명, 모든 파일의 SHA-256, 이 서버의 운영체제·CPU·glibc, 제품 버전.
3. 권한 확인 창이 뜹니다. 하는 일, 제공자, 서명 종류(공식/시험용/서명 확인 안 됨), 필요한 권한, 선택 권한, 포함된 소프트웨어와 라이선스, 꾸러미 digest가 보입니다.
4. **설치하고 켜기** 또는 **설치만 하기**를 고릅니다. 서버는 관리자가 본 digest와 권한이 그대로일 때만 설치합니다(검토 뒤 꾸러미가 바뀌면 거부). 확인은 15분 안에, 같은 관리자만 할 수 있습니다.

설치된 꾸러미는 팀 파일 밖인 `<데이터 폴더>/plugins/store/`에 들어갑니다. 임시 폴더에서 다시 확인한 뒤 한 번에 옮깁니다. 파일 도구·검색·공유 링크로는 닿지 않습니다.

## 켜기·끄기·업데이트·되돌리기·제거

- **켜기/끄기**: 회사 전체에 켜거나 끕니다. 켤 때 저장된 모든 파일의 해시를 다시 확인합니다.
- **업데이트**: 더 높은 버전 꾸러미를 같은 방법으로 설치합니다. 새 권한을 요청하면 창에 "새 권한"으로 표시됩니다. 같은 버전이나 낮은 버전은 업데이트로 설치할 수 없습니다.
- **되돌리기**: 이 서버에 설치·검증된 바로 이전 버전으로만 돌아갑니다. 저장된 파일이 바뀌었으면 거부합니다.
- **제거**: 꾸러미 파일을 지웁니다. 원본 문서와 사람들이 만든 스킬 사본, 기록은 남습니다.
- 모든 동작은 **관리 > 기록**에 `plugin.install`, `plugin.update`, `plugin.enable`, `plugin.disable`, `plugin.rollback`, `plugin.uninstall`로 남습니다.
- 끄기·업데이트·되돌리기·제거를 하면 진행 중인 미리보기를 취소하고, 만들어 둔 미리보기를 버리고, 렌더러를 새로 준비합니다.

## 스킬 꾸러미

켜면 스킬이 `skills/<플러그인 id>/<스킬>/SKILL.md`에 회사 스킬로 놓입니다. `skills/`를 읽을 수 있는 모든 사람의 AI에 보이고, 로더 경고 없이 읽혀야 설치됩니다. 이 폴더는 플러그인이 관리하므로 소유자·관리자도 그 자리에서 고치거나 옮기거나 지울 수 없습니다(AI 도구 포함). 고치려면 다른 폴더로 복사해 사본을 고치세요. 끄면 스킬이 빠지고, 다시 켜면 돌아옵니다. 같은 이름의 폴더가 `skills/`에 이미 있으면 설치하지 않습니다.

## 한글 문서 미리보기(HWP)

- 첫 공식 플러그인입니다. 공식 목록에는 **"아직 설치할 수 없습니다. 배포 요건과 지원 환경을 검토 중입니다."**로 보이고 설치 단추가 없습니다. rhwp 실행 파일의 정확한 버전 고지, 네이티브 Skia 의존성 목록, 컴파일된 글꼴 측정값의 출처 정리와 실제 Linux·Mac 확인이 끝나야 공개합니다.
- **추천** 배지는 작업공간 기본 언어가 한국어일 때만 붙습니다(브라우저 언어·IP는 쓰지 않음). 추천은 아무것도 설치하거나 켜지 않습니다.
- 미리보기와 AI의 `hwp_render` 도구는 **두 조건이 모두** 맞을 때만 동작합니다: 플러그인이 회사 전체에 켜져 있고, 서버 운영자가 출시 잠금을 연 경우(`MYCEL_HWP_PREVIEW=1`, 내부 검토 서버만). 관리 화면에서 켜는 것만으로는 아직 정리되지 않은 렌더러가 돌지 않습니다.
- `hwp_render`는 위 조건에 더해 "AI가 페이지 이미지를 본다"(선택 권한)를 허용했을 때만 AI에게 보입니다. 허용하지 않으면 사람용 미리보기만 됩니다.
- Debian 12(glibc 2.36)는 지원하지 않습니다(고정 렌더러는 glibc 2.39 필요). Ubuntu 24.04, Debian 13, macOS(Apple 실리콘·Intel)가 대상입니다.
- 플러그인과 상관없이 늘 되는 것: HWP/HWPX **글자 읽기와 검색**, **원본 다운로드**, `.hwp`/`.hwpx`에 평문을 쓰는 것을 막는 보호.
- 꾸러미에는 제3자 파일만 들어 있습니다: rhwp 실행 파일(MIT), Noto Sans KR Regular(OFL-1.1), 고지와 소스 안내. 입력 검사(preflight), 한도, 격리, 고정 해시는 코어에 남아 있어 꾸러미가 바꿀 수 없습니다.

### 기존 내부 검토 서버 옮기기

예전 검토 빌드는 `MYCEL_HWP_PREVIEW=1`만으로 미리보기를 켰습니다. 이번 버전으로 올리면 미리보기가 꺼집니다(스위치만으로는 아무것도 켜지지 않고, 기본 번들에는 렌더러가 없습니다). 계속 쓰려면:

1. 개발 맥에서 시험 꾸러미를 만듭니다: `bun run plugin:hwp -- --target linux-x64 --out dist/plugins`(대상: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`).
2. 검토 서버의 루트 소유 환경 파일(Linux: `/etc/default/<id>`)에 `MYCEL_HWP_PREVIEW=1`, `MYCEL_PLUGINS_TEST_SERVER=1`, `MYCEL_PLUGINS_TEST_KEYS=$(bun scripts/plugins/test-key.ts --public)` 값을 넣고 서비스를 다시 시작합니다. `server.json`으로는 켤 수 없습니다.
3. 관리 > 플러그인에서 **파일로 설치**로 꾸러미를 올리고(또는 `<데이터 폴더>/plugins/import/`에 두고 **검토**) 권한을 확인해 설치하고 켭니다. 화면 위에 시험용 서명 경고가 계속 보입니다.

고객 서버에서는 이 절차를 쓰지 않습니다. 공개 HWP 꾸러미는 공식 키로 서명된 뒤 공식 목록으로 나갑니다.

## 서버에 놓인 꾸러미(자체 설치)

운영자는 `<데이터 폴더>/plugins/import/`에 `.trinaplugin` 파일을 둘 수 있습니다. 관리 화면의 **이 서버에 놓인 꾸러미**에 이름이 보이고, **검토**를 누르면 같은 권한 확인 창을 거쳐 설치합니다. 폴더에 파일을 두는 것만으로는 아무것도 설치되거나 실행되지 않습니다.

## 호스팅 서버

호스팅 서버는 파일·서버 폴더 설치를 받지 않고 공식 목록의 꾸러미만 설치합니다(`deployment.ts` 기능 표의 `pluginFileInstall: false`). 시험 키와 서명 없는 꾸러미 설정은 호스팅과 사무실 Mac에서 무시됩니다.

## 서명 키(대표·운영 담당 단계, 아직 하지 않음)

플러그인과 공식 목록은 **제품 업데이트 키와 다른 플러그인 전용 키**로 서명합니다. 업데이트 키는 플러그인을 서명할 수 없고, 반대도 안 됩니다(서명 앞에 `trina-plugin-manifest-v1`, `trina-plugin-catalog-v1` 용도 문자열이 붙습니다). 지금 신뢰 목록(`editions/trina/branding/plugin-trust.json`)은 비어 있어 **실서버는 모든 꾸러미를 거부**합니다. 공식 목록도 서명이 없어 정보로만 보입니다.

운영 담당이 할 일:

1. 키 보관자와 예비 키 보관 위치를 정합니다(대표 결정).
2. 배포용 맥에서 주 키와 예비 키를 만듭니다. 저장소·로그·채팅·GitHub 비밀값에 넣지 않습니다.
   ```sh
   umask 077; mkdir -p ~/.config/trina-ax-plugins
   openssl genpkey -algorithm ed25519 -out ~/.config/trina-ax-plugins/plugin-key.pem
   openssl genpkey -algorithm ed25519 -out ~/.config/trina-ax-plugins/plugin-key-spare.pem
   ```
3. 공개키(32바이트 base64)만 `editions/trina/branding/plugin-trust.json`에 넣습니다. 예: `{"keys":[{"publicKey":"…","publishers":["trina"],"idPrefixes":["app.trina."],"catalog":true}]}`. `bun scripts/plugins/trust.ts editions/trina/branding/plugin-trust.json --apply`로 검사·적용합니다(제품 업데이트 키나 로컬 시험 키는 거부). 이 변경은 일반 서명 릴리스로 나갑니다.
4. 공식 목록에 서명합니다: `bun scripts/plugins/sign-catalog.ts --key ~/.config/trina-ax-plugins/plugin-key.pem`(→ `resources/plugins/catalog.sig`).
5. 키를 바꿀 때는 새 공개키를 먼저 넣은 빌드를 내보낸 뒤 새 키로 서명합니다(예비 키가 이 순서를 쉽게 합니다).

## 시험 키와 개발 설정

- 시험 키는 저장소 밖 `~/.config/trina-ax-plugin-test/test-key.pem`에 만듭니다: `bun run plugin:test-key`. 단위 시험은 실행할 때마다 새 키를 만들고, 저장소에는 시험 개인키가 없습니다.
- 서버가 시험 키를 믿게 하는 설정(환경 변수만):
  - `MYCEL_PLUGINS_TEST_KEYS=<공개키>[,<공개키>]`: 시험 키로 서명된 꾸러미를 "시험용"으로 받습니다.
  - `MYCEL_PLUGINS_ALLOW_UNSIGNED=1`: 서명이 없거나 맞지 않는 꾸러미를 "서명 확인 안 됨"으로 받습니다. 파일 목록 검사는 그대로 합니다.
  - 개발 모드에서만 쓰입니다. 운영 모드 시험 서버는 `MYCEL_PLUGINS_TEST_SERVER=1`도 있어야 합니다. 호스팅과 사무실 Mac은 셋 다 무시합니다.
  - 켜져 있는 동안 관리 > 플러그인 위에 경고 띠가 뜹니다.

## 꾸러미 형식(실험, schemaVersion 0)

- `.trinaplugin`: POSIX tar(gzip 가능). 일반 파일만 받습니다. 한도는 다른 압축 파일과 같습니다(펼친 합계 200 MiB, 100배 넘는 압축률 거부). 올리기 한도는 50 MB입니다.
- `trina-plugin.json`: id(역도메인, 예 `app.trina.hwp-preview`), 버전(SemVer), 제공자, 종류, 제품 범위, 5개 언어 이름·설명, 필요한/선택 권한, 지원 플랫폼, 런타임 드라이버, 스킬·도구·미리보기, 라이선스·구성 요소·고지, **모든 파일의 경로·크기·SHA-256**. 모르는 필드나 중복 키가 있으면 거부합니다.
- `trina-plugin.sig`: `trina-plugin-manifest-v1\n` + 정규화한 JSON에 대한 Ed25519 서명(`{keyId, sig}`).
- 권한 id: `skills.company`, `files.read.selected`, `preview.render`, `runtime.native.isolated`, `model.send.preview-pixels`. 모르는 권한은 거부합니다.
- 실제 키로 서명하기 전에 형식을 확정합니다(Claude Code의 `.claude-plugin/plugin.json` + `skills/` 배치에 맞출지 포함).

## 기본 릴리스에서 빠지는 것

서버·사무실·데스크톱 기본 묶음에는 공식 목록(`resources/plugins/catalog.json`, 메타데이터)만 들어갑니다. rhwp 실행 파일, Noto 글꼴, `.trinaplugin` 꾸러미, `resources/hwp/`는 들어가지 않습니다. 빌드 스크립트가 묶음마다 확인하고, `bun scripts/plugins/release-check.ts <폴더|압축 파일>`로 완성된 산출물도 확인합니다.

## 다음 단계

- 1.5단계: 실제 플러그인 키(주·예비), 첫 공식 데이터 꾸러미, 개인 스킬(`users/<id>/skills/`), 같은 이름 스킬 규칙과 `/플러그인:스킬` 이름, 공식 데이터 꾸러미 기본 설치(대표 결정 뒤).
- 2단계: 그룹·개인 켜기(같은 표에 `group`/`user` 대상), 연결 프리셋(기존 외부 연결로), 플러그인 스킬을 팀 파일에 펼치지 않고 읽기 전용으로 제공.
- 3단계: `updates.trina.app`의 서명된 원격 목록·채널 헤드·폐기 목록(첫 공개 배포 전에 반드시).
- 4–5단계: 외부 개발자 등록·심사(필요할 때 Supabase), 위임 키, 일반 네이티브 플러그인 실행 규약.
