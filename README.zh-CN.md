<div align="center">

<picture><source media="(prefers-color-scheme: dark)" srcset="editions/trina/branding/logo/mark-dark.svg"><img src="editions/trina/branding/logo/mark-light.svg" width="64" alt="Trina AX 标志"></picture>

<h1>Trina AX</h1>

<b>整个团队共用的 AI。</b><br>
Trina AX 把团队的文件、技能和工具集中在一台服务器上。每个人的 AI 都从这里开始。<br>同事的 AI 会话，点开就能接着做。AI 打开的每个文件，都会按提问者本人的权限检查。

<a href="https://ax.trina.app/download"><img src="docs/images/readme/v4/download-mac-zh.png" height="40" alt="下载 Mac 版"></a>&nbsp;&nbsp;<a href="https://ax.trina.app/download"><img src="docs/images/readme/v4/download-windows-zh.png" height="40" alt="下载 Windows 版"></a>&nbsp;&nbsp;<a href="https://apps.apple.com/app/trina-ax/id6829192435"><img src="docs/images/readme/v3/badge-app-store.svg" height="40" alt="在 App Store 下载"></a>&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=app.trina.ax"><img src="docs/images/readme/v3/badge-google-play.png" height="40" alt="在 Google Play 下载"></a><br>
<sub>Linux：.deb 和 AppImage（x64、arm64）见<a href="https://ax.trina.app/download">下载页面</a></sub>

[官网](https://ax.trina.app) · [文档](docs/README.md) · [价格](https://ax.trina.app/pricing) · [Discord](https://discord.gg/zUVfSR8MVk)

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [Español](README.es.md) · 简体中文 · [Bahasa Indonesia](README.id.md)

</div>

https://github.com/user-attachments/assets/073b18ae-403c-4139-9518-1eed8e21a931

<p align="center"><sub>入职第一天，新员工的 AI 能做什么？80 秒短片。</sub><br>开源（AGPL-3.0）· 自托管免费，不限人数<br><br><a href="https://github.com/trina-app/trina-ax?tab=readme-ov-file"><img src="docs/images/readme/v4/star-zh.png" height="44" alt="在 GitHub 上为 Trina AX 点 Star"></a><br><sub>点开后，再点页面顶部的 ☆ Star。Star 越多，知道 Trina AX 的团队就越多。</sub></p>

<br>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/v4/divider-dark.png"><img src="docs/images/readme/v4/divider-light.png" width="100%" alt=""></picture>

## 设置一次，全员可用

**一个 AI 账号，全员共用。** 接入一个 Claude 或 OpenAI 的 API 密钥（或条款允许的套餐），所有人都用它提问；token 上限可按人、小组或团队设置。

一个人在团队服务器上设置好，每个人的 AI 从第一个问题起就能用上，浏览器和应用里都一样。其他人不用装 Claude Code，也不用复制技能，最多只需登录自己的账号。

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/v4/set-up-once-zh-dark.webp"><img src="docs/images/readme/v4/set-up-once-zh-light.webp" width="100%" alt="一个人在 Trina 服务器上把 AI 账号、Google、应用、公司 API、Slack、技能和团队文件设置一次，用 Mac 的 Alex、用 iPhone 的 Mina、用 Windows 的 Sam、用浏览器的 Leo 和用 Android 的 Jordan，他们的 AI 都能用上。"></picture>

| 设置一次 | 每个人都能用上 |
| --- | --- |
| **AI 账号。** 所有者或管理员接入 Claude 或 OpenAI 的 API 密钥，或条款允许的套餐。 | 全员都能提问、得到回答；token 上限可按人、小组或团队设置。 |
| **Google。** 把 Drive 文件夹共享给团队，或为 Gmail、Calendar、Docs 和 Sheets 接入一个团队账号（共享邮箱或日历）。 | 你选定的人可以在自己的对话里使用。每个人也可以另外接入自己的 Google 账号。 |
| **应用。** 应用列表里的 Higgsfield、Notion、Linear、Figma 等，或填地址接入任意 MCP 服务器（比如 Bright Data）。 | 每个人的对话里都能用这个应用的工具：可以共用一个团队账号登录，也可以各自用自己的账号登录。 |
| **公司 API。** 一个地址、一个密钥和几行说明。 | AI 可以调用你们自己的系统，范围仅限这个地址。 |
| **Slack。** 所有者或管理员添加一次。 | 在私信里，或在邀请了 Trina 的频道里提问，Trina 按你本人的权限回答。 |
| **技能。** 写一个 `SKILL.md`，或直接导入你 `.claude`、`.codex` 文件夹里的技能。 | 每个人的 AI 都按同样的步骤做。输入 `/` 就能用。 |
| **团队文件。** 一个团队云盘：全公司、小组、项目、团队技能和个人文件夹。 | 每个人的 AI 都从团队文件开始，只打开本人有权打开的内容。 |

<table>
<tr>
<td colspan="2"><img src="docs/images/readme/v4/connected-apps.webp" alt="管理 › 已连接的应用（对整个团队生效）：Google Drive、Gmail、Calendar、Docs、Sheets（设置一次，之后每个成员只需登录 Google）、Slack、Notion、Linear、Atlassian、Canva，以及按地址添加"><br><sub>管理 › 已连接的应用：设置一次，全员可用</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/images/readme/v4/team-drive-v2.webp" alt="团队云盘：Company-wide、Groups、Projects、Team skills、Personal"><br><sub>一个团队云盘</sub></td>
<td width="50%"><img src="docs/images/readme/v4/team-skills-v2.webp" alt="团队技能列表和 Bring my skills"><br><sub>团队技能，也能导入你自己的</sub></td>
</tr>
</table>

<br>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/v4/divider-dark.png"><img src="docs/images/readme/v4/divider-light.png" width="100%" alt=""></picture>

## 每个人用它做什么

**同事做到一半，你接着往下做。** 在团队项目里打开同事的 AI 会话，之前的对话和回答都看得到，马上就能接着问。新的回答按提问者本人的权限处理。其他会话也能像 Google Drive 里的文件一样，共享给个人或小组。

<img src="docs/images/readme/v4/shared-sessions.gif" width="100%" alt="Mina 打开 Sam 的项目会话，接着修改图文卡片；她的提问按她自己的权限处理。">

**在任何聊天旁边问 Trina，回答一键发出。** 侧边聊天只有你能看到；点一下，Trina 的回答就发到聊天里。

<img src="docs/images/readme/v4/room-share.gif" width="100%" alt="在 Expo booth crew 聊天里，Mina 在只有她能看到的侧边聊天里请 Trina 把参展规定做成清单，再发到这个聊天里。">

**每个人的 AI，只能看到本人能打开的内容。** Mina 打不开 Finance，她的 AI 也打不开。[权限说明](docs/PERMISSIONS.md)

<img src="docs/images/readme/v4/folder-access.gif" width="100%" alt="管理员修改谁能打开 Sales 文件夹，然后查看 Mina 能打开哪些：Finance 不在她的列表里。">

**文件按内容就能找到。** 每天夜里，团队的 AI 会读一遍共享、小组和项目文件夹里新增和改动的文件，给每个文件写一行说明，讲清它是什么。所以哪怕扫描件叫 `temp.pdf`、照片叫 `IMG_2031.jpg`，也能按内容找到。这一步用的是团队的 AI 账号，从不读取个人文件夹。我们用 2238 个虚构文件做了测试：184 个问题里，Claude Code 有这些说明时找对了 181 个，没有时找对 172 个。

<table>
<tr>
<td width="50%"><b>定时任务。</b> 交代一次，Trina 就按你定的时间（团队所在时区）重复执行。<br><br><img src="docs/images/readme/v4/scheduled-list.webp" alt="定时任务页面：6 个任务，每个都显示要做的事、重复时间和上次运行结果"></td>
<td width="50%"><b>访客。</b> 邀请公司外的人进群聊或项目，并决定他们能否使用 AI。<br><br><img src="docs/images/readme/v4/guest-room.webp" alt="有代理公司访客 Morgan Reyes 的 Launch email 群聊：标题方案、@提及和 Trina 的回答"></td>
</tr>
<tr>
<td width="50%"><b>用量与上限。</b> 按人显示回答数、token 和预估费用；token 上限可按人、小组或团队设置。<br><br><img src="docs/images/readme/v4/usage-v2.webp" alt="管理员用量页面：每个人的 token、回答数和预估费用"></td>
<td width="50%"><b>全局搜索。</b> 用 ⌘K 搜索聊天、历史、项目、文件、技能和定时任务。<br><br><img src="docs/site/images/search/palette.webp" alt="⌘K 搜索：聊天、历史、项目、文件、技能和定时任务"></td>
</tr>
<tr>
<td colspan="2"><b>像 Slack 一样的团队聊天，自带 Trina AI。</b> 全员频道、小组频道、私密频道、私信、群聊、话题和 @提及都有，网页、桌面和手机都能用。在任何聊天旁边，都能打开只有你能看到的侧边聊天问 Trina。<br><br><img src="docs/images/readme/v4/team-chat.webp" alt="团队聊天中的 Marketing 频道：左侧是频道和私信，还有表情回应、@提及和发到频道里的一条回答，右侧打开了一个话题"></td>
</tr>
</table>

- **每次改动都会保留。** 不管是人改的还是 AI 改的，任何版本都能恢复。
- **内置浏览器。** 在桌面应用里，Trina 会在聊天旁边的面板中打开网页、阅读、点击、填表，你可以看着它操作，点 Stop 随时停下。打开新网站前会先问你，除非你已允许所有网站。
- **应用动态推送到聊天里。** Sentry、GitHub、Stripe、Jira 和 HubSpot 的动态以卡片推送。
- **查找工作文件。** 桌面应用在你的电脑上找出最近的工作文件，只添加你选中的。
- **文档。** 读取韩文 HWP/HWPX 文档的文字，预览 PDF 和 PowerPoint。
- **多端可用。** Mac、Windows、Linux、iPhone、Android 和任意浏览器都能用，界面支持六种语言。

<br>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/v4/divider-dark.png"><img src="docs/images/readme/v4/divider-light.png" width="100%" alt=""></picture>

## 开始使用

- **在线试用：** 无需安装，用一个虚构团队体验（AI 已关闭）。[打开演示](https://ax.trina.app/demo/zh/)
- **Trina 托管：** 不用自己运维服务器。免费试用 14 天，之后按月订阅。[价格](https://ax.trina.app/pricing)
- **应用：** [Mac、Windows、Linux、iPhone、Android](https://ax.trina.app/download)，也可以直接用浏览器。
- **自托管：** 部署在你们自己的 Linux 服务器、Docker 或办公室的 Mac 上，免费。[Linux](docs/INSTALL-LINUX.en.md) · [Docker](docs/INSTALL-DOCKER.md) · [办公室 Mac](docs/OFFICE.en.md) · [用 AI Agent 安装](docs/INSTALL-LINUX.en.md#install-with-your-ai-agent)

<b>用 Docker 自托管</b>（Linux，或装了 OrbStack 的 Mac）

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax/docker
cp env.example .env && docker compose up -d --build
docker compose exec trina-ax trina-ax-setup-link   # 打开链接，创建所有者账号
```

Docker 方式比 Linux 安装推出得晚，测试也更少；Ubuntu 24.04 服务器需要先改一项主机设置。[Docker 指南](docs/INSTALL-DOCKER.md)

<b>10 分钟在自己的电脑上跑起来</b>（虚构团队，AI 关闭）

```sh
git clone https://github.com/trina-app/trina-ax.git && cd trina-ax
bun install --frozen-lockfile && bun run demo   # → http://127.0.0.1:19760 · alice / teamax-demo-1
```

需要 Bun 1.3.12 和 Go 1.27+。仅供体验，不要用于生产环境。[详细步骤](docs/QUICKSTART.md)

<br>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/v4/divider-dark.png"><img src="docs/images/readme/v4/divider-light.png" width="100%" alt=""></picture>

## 工作原理

一台服务器以 Claude Code 和 Codex 为引擎。每个文件请求，不管来自人还是他的 AI，都要经过服务器上的同一道权限检查。在 Linux 服务器上，引擎以专用账号运行在 bubblewrap、Landlock 和 seccomp 沙箱里，shell 和内置文件工具都已关闭，只能通过 Trina 的工具打开文件。[安全与权限](docs/security-and-permissions.md)

Trina 提供的是工作空间，不是 AI 本身：请接入你们获得授权的 Claude 或 OpenAI 账号与套餐。AI 费用记在你接入的账号上。

<details>
<summary><b>数据、限制和我们不承诺的事</b></summary>

### 我们不承诺的事

- 自托管不等于离线运行：每次请求所需的上下文都会发给你接入的 AI 服务商，已配置的集成也会收到各自的请求。Codex 每次联网搜索，都会把截至当时的对话发给 OpenAI 的搜索服务。如果管理员允许用 OpenRouter 处理语音，视频和音频文件的声音会发给 OpenRouter。服务器每 30 分钟会向 `updates.trina.app` 查询一次自己的公网地址（设置 `MYCEL_EXIT_ADDRESS_CHECK=off` 即可关闭）。[详情](docs/security-and-permissions.md)
- 服务器运维人员可以读取存储的文件和聊天记录；使用 Trina 托管时，也包括 Trina 的运维人员。应用管理员没有查看所有人私人对话的入口。
- 撤销文件夹权限并不会删除之前的回答。扩大共享范围时的确认提示，也不等于全面的数据防泄漏（DLP）。
- 没有任何安全认证；不保证回答完美，不保证一定省钱，也不会自动做出法务、财务或人事决策。输出结果和部署边界请自行审核。
- Linux 服务器不做 OCR：AI 会把照片和扫描页面当作图片来看，但无法按文字搜索。办公室 Mac 暂不支持读取视频。
- 任何团队都能读取 HWP/HWPX 的文字；[预览和新建韩文（Hangul）文档](resources/hwp/README.md)需要可选的 HWP Preview 插件（macOS，或 glibc 2.39 及以上的 Linux；不支持 Debian 12）。
- 连接：优先使用本人符合条件的连接，然后依次是分配给本人、小组和整个团队的连接。新建的 Trina 团队默认允许整个团队共用一个公司连接；已经保存过的选择保持不变。**这个软件设置并不代表 Anthropic 或 OpenAI 的条款允许你这样用。** [连接详情](docs/FAQ.md)
- Linux 自托管需要 Debian 12/13 或 Ubuntu 24.04、启用 cgroup v2 的 systemd、amd64 或 arm64 架构、4 GB 内存和 20 GB 磁盘。安装、升级和从备份恢复都由你们的 IT 团队负责。

</details>

<br>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/v4/divider-dark.png"><img src="docs/images/readme/v4/divider-light.png" width="100%" alt=""></picture>

## 社区

如果 Trina AX 对你的团队有帮助，欢迎在 GitHub 上点个 Star ⭐，让更多团队找到它。

[Discord](https://discord.gg/zUVfSR8MVk) · [X](https://x.com/trina_ax) · [版本发布](https://github.com/trina-app/trina-ax/releases/latest) · [更新日志](CHANGELOG.md) · [获取支持](SUPPORT.md) · [参与贡献](CONTRIBUTING.md) · [安全](SECURITY.md) · [开发](docs/DEVELOPMENT.md) · [配置](docs/CONFIGURATION.md) · [llms.txt](llms.txt)

应用界面支持英语、韩语、印尼语、日语、西班牙语和简体中文。所有图片中的公司和人物均为虚构。

<br>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/v4/divider-dark.png"><img src="docs/images/readme/v4/divider-light.png" width="100%" alt=""></picture>

## 开源协议

本项目基于 [AGPL-3.0-only](LICENSE) 协议开源，可免费使用，也可以商用。如果你通过网络提供修改后的版本，需要向这些用户公开对应的源代码。云端通信协议（cloud protocol）的代码单独采用 MIT 许可证（[许可证全文](shared/src/cloud-protocol/LICENSE)）。[声明](NOTICE) · [第三方声明](docs/THIRD-PARTY-NOTICES.md)

Claude Code 和 Codex 各有其使用条款；本项目并未获得 Anthropic 或 OpenAI 的认可或背书。Claude 是 Anthropic 的商标。
