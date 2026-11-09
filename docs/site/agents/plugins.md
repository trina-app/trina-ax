---
title: Plugins
description: Packages admins install for the whole company: skill bundles and isolated native tools such as HWP preview.
---

Plugins add features a company needs. In this stage, only the owner and admins install them, for the whole company, in **Admin › Plugins**.

## Two kinds

| Kind | Contains | Runs code? |
|---|---|---|
| **Skill bundle** | Company skills (`SKILL.md`) only | No |
| **Native tool or preview** | A program the server runs in isolation, through a driver the core already knows | Yes, isolated |

Today the only native driver is the HWP preview (`rhwp-v1`). While it is on, Hangul files (HWP, HWPX) open as pages in the file panel: files in team folders, and files sent in a room, DM or thread, for the people who can see that message. Without it, Hangul files are downloaded to open them.

## Install

:::steps
#### Choose a package
Install from the official list, from a file, or from a package placed on the server.

#### The server checks it
Size and file count, paths, the manifest, the pinned digest or signature, every file's SHA-256, the OS, CPU and glibc, and the product version.

#### Review the permissions
A dialog shows what it does, who provides it, the check result, required and optional permissions, and licences.

#### Install, and turn it on
The server installs only if the package and permissions are exactly what the admin saw.
:::

Admins can turn a plugin on or off, update it, roll back to the previous version or remove it. Each action is recorded in the activity log.

## Skill bundles

When on, a bundle's skills appear at `skills/<plugin id>/<skill>/SKILL.md`. That folder is managed by the plugin: to change a skill, copy it elsewhere and edit the copy.

## Package format

| Item | Rule |
|---|---|
| File | `.trinaplugin`: a POSIX tar, optionally gzipped |
| Manifest | `trina-plugin.json`: id (reverse domain), SemVer version, provider, kind, names and descriptions in five languages, permissions, platforms, and every file's path, size and SHA-256 |
| Permissions | `skills.company`, `files.read.selected`, `preview.render`, `runtime.native.isolated`, `model.send.preview-pixels` |
| Format version | `schemaVersion` 1. Unknown fields, keys or permissions are refused. |

Full details: [Plugins (Korean)](../../PLUGINS.md).
