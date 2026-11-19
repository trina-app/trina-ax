# Remove a stray Bun build file from the repository

- Date (UTC): 2026-11-19
- Branch: `chore/remove-bun-build-temp`
- Status: done
- Where: repository root and `.gitignore`. Why: an 87 MB file that is not part of the product.
- Version impact: none.

## Goal

`.59e544c719e3fdc6-00000000.bun-build` (87 MB, a macOS arm64 executable) has been in the root since cc5d50bc0
(2026-11-17, answer_comments review fixes). It is the temporary file `bun build --compile` writes in the current folder
and leaves behind when a build stops early: the Bun runtime without our code (no strings from this repository and no
key-like strings in it). Every clone and the GitHub file list carry it.

## Steps

1. Delete the file.
2. Ignore `*.bun-build` so it cannot be added again by `git add -A`.

Out: rewriting history to drop the blob (every clone and open branch would need a reset right after today's repository
swap). The file stays in history only.
