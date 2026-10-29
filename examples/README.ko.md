# 팀 스킬 복사해서 쓰기

[English](README.md)

저장소의 파일이 자동 설치되지는 않습니다. 스킬 관리자가 앱 **파일** 화면에서 `skills/<이름>/SKILL.md`를 만들고 예제 내용을 붙여 넣습니다. 예: `skills/meeting-summary/SKILL.md`, YAML의 `name: meeting-summary`. 폴더 이름과 영문 name을 그대로 유지하세요. 팀원은 대상 폴더의 스킬 관리자에게 검토할 스킬을 제안할 수 있습니다.

[예제 목록·입력 파일](README.md): 대표·팀장은 `weekly-team-report`, 영업은 `sales-follow-up`, 마케팅은 `brand-brief`, 재무는 `expense-review`, 인사는 `new-hire-guide`, 공통 업무는 `meeting-summary`입니다.

가상 입력 파일을 `shared/demo/`에 올리고 스킬과 자료의 읽기 권한을 부여하세요. 실제 인사·재무 자료에는 별도의 제한 폴더를 사용하세요. 스킬이 추가 권한을 주지는 않습니다. 팀 스킬 화면에서 로더 경고가 없는지 확인하세요. 잘못된 헤더나 폴더와 다른 이름은 읽히지 않습니다.

새 채팅에서 스킬을 선택하거나 `/meeting-summary shared/demo/meeting-notes.md를 읽고 한국어로 요약해 줘`를 입력합니다. 출처·금액·날짜·불확실성을 확인한 뒤 사용하세요. 저장은 요청할 때만 허용된 위치에 하며 이메일 발송·게시·결재·지급은 예제에 포함되지 않습니다.

로컬 빠른 체험은 AI가 꺼져 있어 파일과 스킬만 확인합니다. 실제 실행에는 별도 환경의 허용된 AI 연결이 필요합니다. [결과 파일](data/example-result.md)은 사람이 작성한 설명용 예시이며 실제 AI 응답이 아닙니다.
