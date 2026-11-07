# 저장소 규칙

기능을 만들기 전에 보고 첫 줄에 `넣을 곳: <레포/폴더>, 이유: <한 문장>`을 쓴다.

코드를 쓰기 전에 `docs/AGENTS/plan/<timestamp>-<feature>.md`에 계획을 먼저 쓰고 브랜치의 첫 커밋으로 올린다. 형식과 템플릿은 [AGENTS/README.md](AGENTS/README.md).

- 채팅·권한·파일·스킬·휴대폰·AI 연결·사용량·Linux 실행 기반은 Team AX 코어에 먼저 넣는다.
- 트리나 브랜드는 `editions/trina/branding/`에 둔다. Payple/Paddle·요금제·AWS 리전 선택과 고객 서버 운영·고객 주소·사이트는 비공개 `trina-ax-core`의 `editions/trina/`에 둔다(공개 레포에 넣지 않는다).
- 의료 전용 코드는 메디컬 포크의 `editions/medical/`에 둔다. 운영 중인 메디컬 작업을 수정하지 않는다.
- 코어 파일에 필요한 변경은 설정·훅 같은 공통 확장 지점을 코어에 먼저 만든다.
- 코어는 고객 정보를 제거한 거울을 통해서만 받아 오고, `UPSTREAM.md`에 원본/필터 SHA와 충돌 해결을 기록한다.
- 시스템 패키지나 내려받는 프로그램(apt 패키지, 글꼴, 브라우저, node 등)이 필요한 기능은 한 목록 `scripts/system/packages.json`에 넣는다. 설치 스크립트 하나(이미지, `install-linux.sh`, 개발 환경, 사무실 맥)에만 넣지 않는다. 내려받는 프로그램은 버전과 플랫폼별 sha256을 함께 적는다. `tests/unit/system-packages.test.ts`가 확인하고, 목록이 바뀐 릴리스는 root 업데이트가 된다.
- 비밀값은 팀/개인 폴더·프롬프트·로그·커밋에 두지 않는다.
- GitHub 이름 변경·생성·공개, 기록 재작성·force push, 코어 main 병합·푸시, 고객 서버 접속, 결제·AWS·Cloudflare 계정 변경은 대표 승인 뒤에 한다.
- 코어에서 받아 올 때 다음 경로는 가져오지 않는다(비공개 코어에만 둔다): 코어의 `CLAUDE.md`, `docs/OWNER-TODO.md`, `docs/TODO.md`, `docs/TEST-ENV.md`, `docs/PUBLIC-MIRROR.md`, `docs/SECURITY-AUDIT.md`, `scripts/public-mirror/`, `scripts/check-public-mirror.sh`, `scripts/sync-public-mirror.sh`, `tests/public-mirror/`, `ee/`, `editions/trina/`(단 `branding/` 제외).

## 공개 기여 / Public contributions

외부 기여자는 이 공개 저장소에 이슈·PR을 제출하면 됩니다. 비공개 코어 접근은 필요하지 않으며 유지보수자가 코어 반영 경로를 처리합니다. External contributors submit here; maintainers handle upstream routing. [개발·검증](DEVELOPMENT.md).
