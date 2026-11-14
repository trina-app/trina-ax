---
title: Google 应用
description: 连接你的 Google Drive、Gmail、Google 日历、Google 文档和 Google 表格，让 AI 可以使用它们；以及在自己运行的服务器上，管理员需要先设置什么。
---

Google Drive、Gmail、Google 日历、Google 文档和 Google 表格是 Trina AX 内置的。每个人连接自己的 Google 账号，每个应用连接一次。
AI 只会在这个人自己的对话中使用它，权限也和这个人在 Google 中的权限一样。

不需要复制或粘贴任何内容：你是在 Google 上登录的。

## 连接 Google 应用（所有人）

:::tip
**你需要准备的**

- 你的 Google 账号（公司的 Google Workspace 账号或个人 Gmail 账号），并已在浏览器中登录。
:::

:::steps
#### 在连接器中打开应用
点左侧栏底部你的头像，再点**设置 › 连接器**，然后在**发现**下选择应用（例如 Gmail）。它的页面会说明 AI 能做什么，并列出所有工具。

#### 选择“连接”
Google 自己的登录页面会打开（在桌面应用中，会在你的浏览器中打开）。选择你的账号。

#### 保持所有选项都勾选
Google 会列出 Trina AX 可以做的事，例如“阅读、撰写和发送电子邮件”。请保持**所有**选项都勾选，然后选择**继续**（Continue）。
如果有选项没有勾选，登录会被拒绝：“部分权限未勾选。请重新连接，并保持所有选项都勾选。”

#### 确认账号
回到 Trina AX，检查显示的账号（“连接此账号？”），然后选择**确认此账号**。页面会显示**已连接为**你的地址。
:::

读取不需要确认。AI 在发送邮件、添加日程或编辑文档之前，会显示一张卡片，列出它要做的所有事，并等你同意。在卡片上，或者在应用的
**设置**（它的 **⋯** 菜单）中，你可以选择**始终允许**，而不是**先问我**。Google Drive 只读取：它从不更改、移动或发送任何内容。

### 如果你看到“请管理员添加”

这个应用在你的团队中还没有设置好。选择**请管理员添加**：所有者和管理员会收到通知，你可以连接时会收到回复。

![成员在设置 › 连接器中看到的 Google Drive 页面：连接按钮的位置是请管理员添加，下面是 AI 能用 Drive 做什么，以及它的三个工具](../../images/connect/google-member-ask.webp "请管理员添加")

## 团队共享的 Google 账号（管理员）

共享的邮箱或日历，例如 `sales@acme.com`，可以为需要它的人连接一次。在**管理 › 已连接的应用**中打开这个 Google 应用，在
**团队设置 › 共享的 Google 账号**下选择**为团队连接**。用共享账号登录，然后选择谁使用它。Google Drive 在同一位置有
**与团队共享**。

## 设置 Google 应用（自己运行服务器的管理员）

在由 Trina 托管的团队中，Google 登录已经准备好了：不需要设置。在公司自己运行的服务器上，需要管理员在 Google Cloud 中创建一次
Google 登录应用，再在**管理 › 已连接的应用**中添加它。

:::tip
**你需要准备的**

- 团队服务器的**公网 https 地址**（大家从 Google 登录后会回到这个地址）。在设置好之前，Google 应用会显示“需要先设置这台服务器的公网地址。”
  由运行服务器的人设置：见[配置](../../operate/configuration.md)（英文）。
- 一个 **Google Cloud 项目**、每个应用需要启用的 **API**，以及一个类型为 **Web 应用**（Web application）的**登录客户端**。
- 从 Google Cloud 获取：客户端的 **JSON 文件**（或它的**客户端 ID** 和**客户端密钥**）。
- 填到 Google Cloud 中：Trina AX 显示的**返回地址**，一个给 Google Drive，一个给另外四个应用。
:::

![没有公网地址的服务器上，管理 › 已连接的应用中的 Gmail 页面：未设置、需要先设置这台服务器的公网地址，以及团队设置下需要启用的 Google API](../../images/connect/google-admin-gmail.webp "Gmail，尚未设置")

:::steps
#### 在 Google Cloud 中创建应用
按照公司应用页面上的[在 Google Cloud 中](google-own-app.md#在-google-cloud-中)操作：一个项目、几个 API、应用的名称和受众群体
（使用 Google Workspace 的公司选**内部**（Internal）；否则选**外部**（External）并添加测试用户）、权限，以及一个
**Web 应用**（Web application）客户端。

#### 添加返回地址
在客户端的**已获授权的重定向 URI**（Authorized redirect URIs）下，添加每个应用的**设置**对话框中显示的地址，用它的复制按钮复制：

```
https://<your team address>/api/integrations/google-drive/callback
https://<your team address>/api/integrations/google-apps/callback
```

#### 在 Trina AX 中上传文件
在**管理 › 已连接的应用**中打开 **Google Drive**，选择**设置**。上传你下载的 JSON 文件，或粘贴**客户端 ID** 和**客户端密钥**，
然后保存。接着逐个打开 Gmail、Google 日历、文档和表格，选择**设置**并打开**使用与 Google Drive 相同的 Google 应用**：不需要再上传别的。
:::

每个应用的页面会在 **Google API** 下列出需要为它启用的 API：

| 应用 | 需要启用的 Google API |
|---|---|
| Google Drive | Google Drive API |
| Gmail | Gmail API |
| Google 日历 | Google Calendar API |
| Google 文档 | Google Docs API、Google Drive API |
| Google 表格 | Google Sheets API、Google Drive API |

Gmail、日历、文档和表格应用运行在 Linux 服务器上。在 Mac 应用中，它们的页面会显示“团队服务器暂不支持”。

## 在 Google 的页面上显示公司名称

使用 Google Workspace 的公司可以让所有 Google 应用都通过公司自己的 Google 应用登录，这样大家在 Google 的页面上会看到公司名称，
不会出现警告：[使用公司自己的 Google 应用](google-own-app.md)。

## 常见问题

| 你看到的 | 该怎么做 |
|---|---|
| **部分权限未勾选。请重新连接，并保持所有选项都勾选。** | 重新连接，并让 Google 页面上的所有选项都保持勾选。 |
| **Google 要求你重新登录。** | 在应用的页面上选择**重新连接**。这通常发生在修改密码之后，或者公司管理员取消了访问权限。 |
| Google 页面上出现 **`redirect_uri_mismatch`**（自己运行的服务器） | Google Cloud 中的某个返回地址和 Trina AX 显示的不一样。请从**设置**对话框中重新复制。 |
| **“This app is blocked”** 或 **`admin_policy_enforced`** | 公司的 Google 管理员限制了哪些应用可以使用 Google 账号。请他们信任这个应用：见[在管理控制台信任应用](google-own-app.md#可选在管理控制台信任应用)。 |
| **Google hasn't verified this app** | 这是处于测试（Testing）状态的外部（External）应用。只有当应用是你的管理员创建的时，才选择 **Advanced** › **Go to …**；或者请他们改用公司自己的应用。 |

面向开发者和运维人员的完整说明：[Google 应用](../../../GOOGLE-APPS.md)（英文）和 [Google Drive](../../../GOOGLE-DRIVE.md)（英文）。
