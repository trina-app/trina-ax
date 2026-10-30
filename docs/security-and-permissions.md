# Security and permissions

[한국어](security-and-permissions.ko.md)

The same question, “Summarize our onboarding policy,” can use an HR file only for a person permitted to read it. The server checks the asking person's access on file requests. A skill is an accessible instruction, not extra authority.

Skills follow the same folder rules. A skill in a restricted folder such as `skills/finance/` is listed and usable only for the people who can read that folder. A personal skill in `users/<you>/skills/` is yours only: other members, owners and admins cannot see it. Scheduled tasks use the skills of the schedule owner.

Owners configure the team and its AI connections. App admins have administrative actions and activity records, not a screen for reading everyone's private chats. Server/OS/storage operators can read stored files and chats. This includes Trina operators in hosted deployments.

Prompts, relevant conversation history and selected file/tool content go to the chosen model provider. That includes images: when the AI reads a photo, screenshot or scanned PDF page it sees the image (decoded in an isolated converter, metadata such as GPS removed), unless an admin turns off "Send images and PDF pages to the AI" in Team settings. Standard connections route Claude to Anthropic and Codex to OpenAI. The experimental API engine can use another configured provider. External integrations receive their requests too. Self-hosting is not offline model processing, and AWS Seoul hosting describes the team server location, not a guarantee that provider processing stays in Korea. This project does not promise a particular provider retention or training policy; confirm the terms of the authorized account and service.

The server asks for confirmation when tracked restricted context is written to a broader audience. This is not universal data-loss prevention: it does not control all external transfers or human copying. Revoking folder access does not retract quotations in previous answers. No certification or zero-leak guarantee is claimed.

Linux and role-account Mac installations add dedicated engine accounts and OS isolation. Office Mac runs as the logged-in user; development mode is not production account isolation. [Detailed permission model (Korean)](PERMISSIONS.md) · [IT handoff](for-admins.md).

New teams allow subscription sharing by default, existing saved settings persist, eligible personal connections take priority, and connection-level consent still applies. Software settings are not permission under provider terms. Use only authorized accounts and plans.

Report security problems [privately](../SECURITY.md).
