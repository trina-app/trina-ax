# 스토어 등록 문구: 简体中文 (zh-Hans)

App Store Connect(아이폰 앱과 Mac App Store 앱, 같은 앱 레코드), Google Play Console, Microsoft Store에 붙여 넣을 간체
중국어 문구입니다. 원문은 지금 Google Play에 올라가 있는 영어 등록 정보("Team chat with an AI that works from your
company's files", 2026-11-14에 Play Console에서 복사)이고, 기기마다 다른 두 번째 문단 한 줄만 바꿉니다. 판매 국가에서 중국
본토는 빠져 있으므로 싱가포르·말레이시아처럼 간체 중국어를 쓰는 지역과 기기 언어를 간체 중국어로 둔 사용자에게 보입니다.

- Google Play Console: 기본 스토어 등록정보 › 언어 관리 › "중국어(간체) – zh-CN". 2026-11-14에 이 문구로 넣고 검토를 보냈습니다.
- App Store Connect: 앱 정보 › 현지화에 "Chinese (Simplified) / 简体中文"을 더하고, 각 플랫폼 버전(iOS, macOS)에서 프로모션
  문구·설명·키워드를 넣습니다. 스크린샷은 영어 스크린샷을 그대로 씁니다.
- Microsoft Store: 설명은 아래 "설명"에 Windows 문단을 씁니다. [Microsoft Store 등록 정보](../microsoft-store/listing.md)의
  zh-CN 설명은 예전 문구이므로 Partner Center에 넣을 때는 이 파일의 설명을 씁니다.
- 영어 원문이 바뀌면 이 파일도 같이 고칩니다. 글자 수는 고칠 때마다 다시 셉니다(아래 표는 2026-11-14 기준). 키워드는 UTF-8로
  92바이트라 App Store Connect가 바이트로 세어도 100 안에 들어갑니다.
- 문구에서 AI 사용료가 포함된 것처럼, 또는 Trina가 Claude를 제공하는 것처럼 읽히는 말은 쓰지 않습니다(AI 사용료는 팀이
  연결한 Claude 또는 OpenAI 계정으로 청구).

| 항목 | 한도 | 이 문구 |
| --- | --- | --- |
| App Store 이름 | 30 | 8 |
| App Store 부제 | 30 | 16 |
| App Store 프로모션 문구 | 170 | 66 |
| App Store 키워드 | 100 | 48 (92바이트) |
| App Store 설명 | 4000 | 약 847 |
| Play 앱 이름 | 30 | 8 |
| Play 간단한 설명 | 80 | 23 |
| Play 자세한 설명 | 4000 | 848 |

## App Store

이름(App Name):

```
Trina AX
```

부제(Subtitle):

```
团队聊天，AI 依据公司文件工作
```

프로모션 문구(Promotional Text):

```
整个团队共用一个 AI。把公司文件和团队的工作方法放在同一个地方，和同事聊天，也和 Trina 对话：它只打开每个人有权打开的内容。
```

키워드(Keywords, 쉼표 뒤 띄어쓰기 없음, 이름에 있는 단어는 넣지 않음):

```
团队聊天,群聊,AI助手,公司文件,团队协作,Claude,Codex,办公,文档,权限,HWP
```

설명(Description): 아래 "설명"을 쓰고, 두 번째 문단은 iOS 버전에 "这个 iPhone 应用…", macOS 버전에 "这个 Mac 应用…"을 씁니다.

## Google Play

앱 이름:

```
Trina AX
```

간단한 설명(Short description):

```
团队聊天，加上一个依据你们公司文件工作的 AI
```

자세한 설명(Full description): 아래 "설명"에 두 번째 문단 "这个 Android 应用…"을 씁니다.

## 설명

두 번째 문단(기기마다 하나):

- iPhone: `这个 iPhone 应用连接到你们团队的 Trina AX。团队地址由管理员提供，也可以在 ax.trina.app 创建团队。`
- Mac: `这个 Mac 应用连接到你们团队的 Trina AX。团队地址由管理员提供，也可以在 ax.trina.app 创建团队。`
- Android: `这个 Android 应用连接到你们团队的 Trina AX。团队地址由管理员提供，也可以在 ax.trina.app 创建团队。`
- Windows: `这个 Windows 应用连接到你们团队的 Trina AX。团队地址由管理员提供，也可以在 ax.trina.app 创建团队。`

```
Trina AX 是整个团队共用的 AI。把公司的文件和团队的工作方法放在同一个地方，然后和同事聊天，也和 Trina 对话：它依据这些资料工作，并且只打开每个人有权打开的内容。

这个 iPhone 应用连接到你们团队的 Trina AX。团队地址由管理员提供，也可以在 ax.trina.app 创建团队。

在任何群聊旁边问 Trina
在对话旁边打开 Trina 直接提问。也可以在某条消息上选择"就这条问 Trina"，让它翻译、总结或解释。Trina 使用你的文件，按你的权限工作。

一键发送答案
对答案满意？把它发到群聊里，大家就基于同一份内容工作。如果答案用到了部分成员打不开的文件，Trina 会先问你。

接着同事的 AI 对话继续
在同事停下的地方继续共享的项目对话。你发出的每一轮都按你自己的权限运行。

团队的工作方法，直接内置
团队负责人把步骤写一次：报价、会议记录、跟进邮件。每个人的 AI 都照着做，所以无论谁来问，结果都一样。

每个人只看到自己有权打开的内容
AI 打开的每个文件，都会按提问人的身份检查权限。你打不开的文件，Trina 也不会替你读取。

在应用里
• 群聊、私聊和讨论串，可以加表情回应
• 被提及和新消息的通知
• 把 PDF、Word、Excel、PowerPoint 和韩文 HWP 文件交给 AI 处理
• 发送照片或用语音提问
• 团队文件夹和个人文件夹，保留每个版本
• 在多个团队之间切换

用你们的服务器，或用我们的
可以使用 Trina 托管，也可以在你们自己的服务器上免费运行 Trina AX。Trina AX 是开源软件（AGPL-3.0）：github.com/trina-app/trina-ax。AI 使用费由你们团队连接的 Claude 或 OpenAI 账户计费。

Claude 是 Anthropic 的商标。Codex 是 OpenAI 的商标。Trina AX 由 Trina Inc. 开发。
```
