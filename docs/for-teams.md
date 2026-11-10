# A guide for CEOs and team leads

[한국어](for-teams.ko.md)

Trina fits teams that have company files, repeatable tasks and different access needs. Prepare shared sources, procedures and permissions instead of attaching the same files to each personal AI chat. This does not promise a better model or immediate high-quality output.

## Start with one task

The team folder has five folders at the top, and the Files screen names them in your language. **Company-wide**
(`shared/`, 전사 공유 in Korean) is the company's material that everyone on the team sees: the setup's company intro,
brand and meeting notes and the first company files go there, and forms and templates such as quotes and reports go in
`shared/Templates/` (`shared/양식/` on a Korean team; the AI starts there when it makes that kind of document).
**Groups** (`groups/`, 부서 in Korean) have one folder per department, seen by its people; **Projects** (`projects/`)
one folder per project; **Team skills** (`skills/`) the skills and rules everyone's AI follows; **Personal** (`users/`)
each person's own folder (**My folder**). Ask the AI to tidy up and finished work moves into an `Archive` folder (`보관`)
of its area. Only the names on screen change; the paths stay as they are.

Use the [example catalog](../examples/README.md): weekly report for leadership, follow-up for sales, brand brief for marketing, expense review for finance, onboarding guide for HR. Each gives fictional input paths, required access, a prompt and review criteria. Operations and support teams can adapt the meeting-summary skill to handovers.

A skill is a reusable procedure. A skill manager creates `skills/<name>/SKILL.md` in Files, or reviews a member's suggestion for that folder. Select it from the chat skill menu. Registering it does not train the model. The folder rules decide who sees a team skill (for example, `skills/finance/` only for the finance group). You can also keep personal skills in `users/<you>/skills/`: only you see them, and you can suggest one to the team.

A project is a folder with instructions, for work that keeps coming back to the same files (a launch, a client, a quarter's report). Make one on the Projects page: a team project gets a new folder in `projects/`, and you choose who works in it (people, and your own groups); a personal project lives in your own folder (`users/<you>/projects/`) and only you see it. Under the members you choose, the dialog says how many people will see it ("9 people see it (owner and admins included)"). The creator, the owner and admins always see it, and nobody else does unless you choose them. The person who made it and admins change its members from the **Members** line of the project page (**Manage**), or from **Members** in the ⋯ of its card on the Projects list: the members now, × to take one out, a search to add one. Adding someone first says what they will see (its files, its shared chats with their whole history, its project skills). Other members see how many people see it and who changes its members. A chat started in the project, or moved into it from the chat title's menu, gives the AI that folder and those instructions. A folder holds one project; Files opens a folder's project but no longer turns a folder into one. An admin can let only admins make team projects (Admin › Team settings). Projects made before on other folders keep working as they were. Instructions you did not write all by yourself count as outside content, so the AI asks before it remembers anything after reading them.

## Your first week

Choose an owner and a server operator, then create the owner account.

1. **Permissions:** verify allowed and blocked files with two fictional accounts.
2. **AI connection:** select an authorized provider account and plan. On new teams one company connection can serve the whole team by default, but provider permission is separate.
3. **Invite the team:** invite a small pilot group and confirm roles and folder access.
4. **First skill:** compare figures, dates and owners against source files; a person decides whether to share. Usage costs can be estimates, not invoices.
5. **First backup:** perform a [restore drill](BACKUP-RESTORE.md) with IT. A backup file alone does not prove recoverability.

Read [permissions and data flows](security-and-permissions.md). Give [IT](for-admins.md) your team size, required files, data constraints and an operational owner.

## Cost and help

Self-hosted software is free; hardware, operations and provider costs are separate. Free 14-day trial on Trina hosting (AWS Seoul), then a monthly plan; AI usage is billed separately by the account you connect. [Current prices and enquiries](https://ax.trina.app/#pricing) · [Support](../SUPPORT.md).

## Real demo screens

Local development mode with fictional data. No model calls were made; the example result is a prepared file.

![Team skill](images/team-skills-en.png)
![Illustrative result file](images/result-file-en.png)
![Admin usage with no AI calls](images/usage-en.png)
![Phone-width web view](images/mobile-web-en.png)
