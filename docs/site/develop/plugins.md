---
title: Build a plugin
description: Make a plugin for Trina AX: what you can build today, a small example to copy, how to try it, how the server checks it, and how to share it.
---

A plugin adds something a company needs, such as a set of team skills. Owners and admins install it in **Admin › Plugins**, for the whole company. This page is for people who want to build one.

## What you can build today

| You want to add | Can the community build it now? |
|---|---|
| **Skills**: instructions the AI follows, such as "turn meeting notes into action items" | **Yes.** A *skill pack* is a set of `SKILL.md` files. It runs no code. |
| **A program on the server**, such as a file preview | **No, not yet.** A program runs only through a driver built into Trina AX, and each driver accepts only the build it was made for. The only driver today is the HWP preview (`rhwp-v1`), and it accepts only the official HWP plugin. |
| Connection presets, regional packs, language packs | **No, not yet.** The format has names for them, but the server refuses them until they exist. |

So today a community plugin is a **skill pack**.

:::warning
**Where it can be installed today.** A company's server installs a plugin only if it is on the official list of its Trina AX version or signed by a key the server trusts. No keys for community publishers exist yet. Until they do, a community plugin installs only on a **development server** or a **test server** set up to accept it (see [Try it](#try-it-on-a-development-server)). It cannot be installed on a hosted Trina AX server.
:::

## A minimal example

A skill pack is a folder with a description file, `trina-plugin.json`, and one folder per skill:

```text
meeting-notes/
├── trina-plugin.json
└── skills/
    └── meeting-notes/
        └── SKILL.md
```

:::steps
#### Write the skill
Save this as `skills/meeting-notes/SKILL.md`. The `name` must equal the folder name. All rules: [SKILL.md format](../agents/skills-format.md).

```markdown
---
name: meeting-notes
description: Turn rough meeting notes into a short summary with decisions, owners and due dates. Use when someone pastes or selects meeting notes.
---

# Inputs
Ask for the notes if none are given. Use only files the person can read.

# Output
1. A three-line summary.
2. Decisions, one per line.
3. Action items as a table: task, owner, due date. Write "not specified" when the notes do not say.

Do not send the result to anyone. It is a draft for the person to check.
```

#### Write the description file
Save this as `trina-plugin.json` next to the `skills` folder.

```json
{
  "schemaVersion": 1,
  "id": "com.example.meeting-notes",
  "version": "1.0.0",
  "publisher": { "id": "example", "name": "Example Co" },
  "kinds": ["skill-pack"],
  "product": { "apiVersion": 1, "minVersion": "0.5.0" },
  "scopes": { "install": ["company"], "enable": ["company"] },
  "i18n": {
    "en": { "name": "Meeting notes", "description": "Turns rough meeting notes into a summary with decisions and action items." }
  },
  "permissions": { "required": ["skills.company"], "optional": [] },
  "contributes": {
    "skills": [{ "name": "meeting-notes", "path": "skills/meeting-notes" }]
  },
  "license": "MIT",
  "components": [],
  "notices": [],
  "files": [
    {
      "path": "skills/meeting-notes/SKILL.md",
      "size": 495,
      "sha256": "e87df085d331d00e1172a3d6ca6c33bc1027d54b9182797a2b0ea8bb2598ab1f"
    }
  ]
}
```

#### List every file's size and SHA-256
`files` must list every file in the package except `trina-plugin.json`, with its exact size in bytes and SHA-256. The numbers above fit the skill above exactly as written, ending with one newline. After you change a file, measure it again:

```sh
wc -c < skills/meeting-notes/SKILL.md
shasum -a 256 skills/meeting-notes/SKILL.md     # Linux: sha256sum
```

#### Pack it
A plugin file is a tar archive in the plain `ustar` format, optionally gzipped, named `.trinaplugin`. Run this inside the `meeting-notes` folder:

```sh
COPYFILE_DISABLE=1 tar --format ustar -czf ../meeting-notes.trinaplugin trina-plugin.json skills
```

`COPYFILE_DISABLE=1` stops macOS from adding hidden `._` files, which the server refuses. It does nothing on Linux.
:::

### The description file, field by field

| Field | What to put |
|---|---|
| `schemaVersion` | `1`. Any other number is refused. |
| `id` | A reverse domain name you control, lower case, at least three parts: `com.yourcompany.meeting-notes`. It never changes between versions. |
| `version` | `1.0.0` style ([Semantic Versioning](https://semver.org/)). An update must have a higher number. |
| `publisher` | `id`: 2–40 lower-case letters, digits or hyphens. `name`: shown to admins. `homepage` (optional): an `https://` address. |
| `kinds` | `["skill-pack"]` |
| `product` | `apiVersion`: `1`. `minVersion`: the oldest Trina AX version it works with. |
| `scopes` | `{ "install": ["company"], "enable": ["company"] }`. Plugins are on for the whole company only. |
| `i18n` | Name (up to 60 characters) and description (up to 300) in `en`. Add `ko`, `id`, `ja` and `es` if you can; English is shown otherwise. |
| `permissions` | A skill pack needs `skills.company`. Admins see a fixed sentence for each permission, so you cannot word it yourself. |
| `contributes.skills` | One entry per skill. `path` must be `skills/<name>`, and that folder must have a `SKILL.md`. Up to 50 skills. |
| `license` | A licence name such as `MIT` or `CC-BY-4.0`. |
| `components`, `notices` | Third-party material you include and the paths of its licence files. `[]` if none. |
| `source` (optional) | `{ "url": "https://…" }` where people can read your source. |
| `files` | Every file with `path`, `size` and `sha256`. |

Unknown fields are refused, so check the spelling. The full format is [shared/src/plugins.ts](https://github.com/trina-app/trina-ax/blob/main/shared/src/plugins.ts).

## Try it on a development server

:::steps
#### Start a development server that accepts unsigned plugins
Set up the code as in [Local development](local-development.md), then start the server with one more setting:

```sh
MYCEL_PLUGINS_ALLOW_UNSIGNED=1 TEAM_AX_DEV_DIR="$HOME/.trina-dev-plugins" TEAM_AX_DEV_PORT=19761 bun run dev --no-relay
```

The setting works only on a development server. A self-hosted test server also needs `MYCEL_PLUGINS_TEST_SERVER=1`. Hosted servers and the office Mac ignore both. While it is on, Admin › Plugins shows a warning band.

#### Install from file
Open the server, create a team with fictional data, and go to **Admin › Plugins › Install from file**. Choose `meeting-notes.trinaplugin`.

#### Read the review
The dialog shows the name, publisher, version, the label **Unverified**, the permissions and the skills it adds. If the package is refused, the message says why: see [How a plugin is checked](#how-a-plugin-is-checked).

#### Install and turn it on
The skill appears in **Team skills**, in `skills/com.example.meeting-notes/meeting-notes/`. That folder belongs to the plugin: to change a skill, change the package and install a higher version.
:::

## How a plugin is checked

The server checks a package when you choose it and again when you press Install. Nothing in a skill pack runs on the server.

| Check | What the server does |
|---|---|
| **Where installing from a file is allowed** | Self-hosted servers, the office Mac and development servers. Hosted servers install only from the official list. |
| **The archive** | At most 50 MB, at most 200 MiB unpacked, at most 2,000 entries, and gzip that expands more than 100 times is refused. Only regular files and folders: links, devices and extended tar headers are refused, and so are files with special permission bits. Paths must be plain and relative: no hidden names, no `..`, and no two names that differ only by letter case. |
| **The description file** | `trina-plugin.json` must exist, be at most 256 KiB of strict JSON (a repeated key is refused) and follow format `1` exactly. Kinds the server cannot install yet are refused. |
| **Who vouches for it** | The server takes the SHA-256 of the description file in a fixed (canonical) JSON form: the *package digest*. Because the description lists every file's SHA-256, the digest covers every byte. The package is **Official** if this digest is on the official list that ships inside the signed Trina AX release. Otherwise it needs a signature file, `trina-plugin.sig` (Ed25519 over `trina-plugin-manifest-v1` + the canonical JSON), made by a key this server trusts for that publisher and id. No such keys exist for community publishers yet. Only a development or test server can accept a test key (**Test build**) or no signature (**Unverified**). A build the official list has withdrawn is always refused. |
| **The files** | Every file in the archive must be listed, with exactly that size and SHA-256, and every listed file must be there. This check never relaxes, also not on a development server. |
| **The skills** | Every `SKILL.md` must load under the [skill rules](../agents/skills-format.md), and the folder `skills/<plugin id>/` in the team's files must be free. |
| **This server** | `apiVersion` must be `1`, and the server must be at least `minVersion`. A package that runs a program must fit the server's OS, processor and C library, and use a driver the server knows. |
| **Versions** | The same version again is refused. A lower version is refused: an admin uses Roll back instead. |
| **The admin's approval** | The review is held for 15 minutes for the admin who opened it. Install goes ahead only for the exact package digest and permissions that admin saw, with every required permission approved. |
| **Later** | If the setting or key that let a package in is removed, the server turns the plugin off at its next start and removes its skills. Every install, update, change and removal is recorded in the activity log. |

## Share your plugin

There is no community plugin list in Trina AX yet, and the server does not download community plugins. To share one today:

- **Publish the `.trinaplugin` file and its folder** somewhere people can read the source, such as a public Git repository, with the licence you chose.
- **Tell people about it** in the [Trina AX Discord](https://discord.gg/zUVfSR8MVk), or open an [issue](https://github.com/trina-app/trina-ax/issues/new/choose) on github.com/trina-app/trina-ax.
- **Suggest a change** to the plugin format or a new kind of plugin with an issue or a [pull request](contributing.md).

People who install your file use **Install from file**, with every check above. Until community publishers can sign their plugins, that means a development or test server.

## Related

- [Plugins](../agents/plugins.md): the two kinds, installing and managing plugins, as an admin sees it.
- [SKILL.md format](../agents/skills-format.md): the rules every skill follows.
- [Plugins in detail (Korean)](../../PLUGINS.md): the official list, keys and test settings.
