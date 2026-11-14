# 스토어 등록 문구: 简体中文 (zh-Hans)

App Store Connect(아이폰 앱과 Mac App Store 앱, 같은 앱 레코드)와 Google Play Console에 붙여 넣을 간체 중국어 문구입니다.
원문은 [Microsoft Store 등록 정보](../microsoft-store/listing.md)의 영어 문구(Mac App Store 문구와 같음)이고, 기기마다 다른
한 줄만 바꿉니다. 판매 국가에서 중국 본토는 빠져 있으므로(Mac App Store·Microsoft Store와 같음) 싱가포르·말레이시아처럼
간체 중국어를 쓰는 지역과 기기 언어를 간체 중국어로 둔 사용자에게 보입니다.

- App Store Connect: 앱 정보 › 현지화에 "Chinese (Simplified) / 简体中文"을 더하고, 각 플랫폼 버전(iOS, macOS)에서 프로모션
  문구·설명·키워드를 넣습니다. 스크린샷은 영어 스크린샷을 그대로 씁니다.
- Google Play Console: 기본 스토어 등록정보 › 번역 관리 › "중국어(간체) – zh-CN"을 더합니다.
- 글자 수는 이 파일을 고칠 때 다시 셉니다(아래 표의 숫자는 2026-11-14 기준). 키워드는 UTF-8로 121바이트입니다. App Store
  Connect가 바이트로 세어 넘친다고 하면 뒤에서부터 단어를 뺍니다(`聊天,HWP`, `协作` 순).

| 항목 | 한도 | 이 문구 |
| --- | --- | --- |
| App Store 이름 | 30 | 8 |
| App Store 부제 | 30 | 19 |
| App Store 프로모션 문구 | 170 | 59 |
| App Store 키워드 | 100 | 61 |
| App Store 설명 | 4000 | 약 890 |
| Play 앱 이름 | 30 | 8 |
| Play 간단한 설명 | 80 | 42 |
| Play 자세한 설명 | 4000 | 약 890 |

## App Store

이름(App Name):

```
Trina AX
```

부제(Subtitle):

```
公司专属的 AI 工作空间，按权限协作
```

프로모션 문구(Promotional Text):

```
把 Claude、公司文件和团队技能放在同一台公司服务器上。每个人都用同一套文件和做法工作，并且只在自己的权限范围内。
```

키워드(Keywords, 쉼표 뒤 띄어쓰기 없음, 이름에 있는 단어는 넣지 않음):

```
AI工作空间,团队AI,公司文件,团队技能,Claude,Codex,智能体,办公,文档,权限,知识库,协作,聊天,HWP
```

설명(Description): 아래 "설명"을 쓰고, 두 번째 문단은 iOS 버전에 "这个 iPhone 应用…", macOS 버전에 "这个 Mac 应用…"을 씁니다.

## Google Play

앱 이름:

```
Trina AX
```

간단한 설명(Short description):

```
公司专属的 AI 工作空间：Claude、公司文件和团队技能都在你们自己的服务器上。
```

자세한 설명(Full description): 아래 "설명"에 두 번째 문단 "这个 Android 应用…"을 씁니다.

## 설명

두 번째 문단(기기마다 하나):

- iPhone: `这个 iPhone 应用连接到你们团队的 Trina AX 服务器。团队地址和账号请向团队管理员索取。`
- Mac: `这个 Mac 应用连接到你们团队的 Trina AX 服务器。团队地址和账号请向团队管理员索取。`
- Android: `这个 Android 应用连接到你们团队的 Trina AX 服务器。团队地址和账号请向团队管理员索取。`

```
Trina AX 是你们公司自己的 AI 工作空间。Claude 运行在公司的服务器上，团队里的每个人都可以用日常的话把工作交给它，公司文件和团队技能都已准备就绪。

这个 iPhone 应用连接到你们团队的 Trina AX 服务器。团队地址和账号请向团队管理员索取。

从公司自己的文件开始
Claude 会读取你有权打开的团队文件夹：方案、价目表、会议记录、规章制度。不用每次从头介绍公司情况。

无论谁来做，结果都一样
用一个 /命令 运行团队负责人设置好的技能。写方案、整理会议记录、跟进客户邮件，每次都按相同的步骤和标准完成。

想找的文件马上找到
用日常的话描述要找的文件，Claude 会在你能打开的文件夹里帮你找，还能帮你整理文件夹。

每个人的权限，严格执行
每个文件、每个回答都遵守按人员和按小组设置的文件夹权限。你打不开的文件，Claude 也不会替你读取。

在应用里你可以
• 与团队服务器上运行的 Claude Code 或 Codex 对话
• 把 PDF、Word、Excel、PowerPoint 和韩文 HWP 文件交给 AI 处理
• 浏览和管理团队文件夹和个人文件夹
• 使用团队技能，并提议新技能
• 让 AI 在内置浏览器中查资料。打开新网站前会先询问你，也绝不会填写密码或银行卡信息。
• 在多个团队之间切换

你的服务器，你的数据
Trina AX 可以安装在你们自己的 Mac mini 或服务器上，也可以使用 Trina 托管的 AWS 首尔专用服务器。Trina AX 是开源软件（AGPL-3.0）：github.com/trina-app/trina-ax

开始使用
你需要一台 Trina AX 团队服务器和一个账号。自行安装免费。托管方案请访问 ax.trina.app 了解。AI 使用费由你的 AI 服务商（如 Anthropic 或 OpenAI）另行收取。

Claude 是 Anthropic 的商标。Codex 是 OpenAI 的商标。Trina AX 是 Trina Inc. 的独立产品。
```
