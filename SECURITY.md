# Security policy

## Report a vulnerability privately

Email **contact@trina.app** with the subject `Trina AX security report`.
Do not open a public issue or pull request containing exploit details, secrets or customer data.

Include the affected release/commit, OS, installation mode, a short impact description and minimal reproduction
steps using synthetic data. Describe which roles and folder permissions are involved. Do not send live credentials,
private files or a database dump; describe any sensitive evidence first so a suitable transfer can be arranged.

Maintainers will assess the report and coordinate any fix and disclosure with the reporter. Response times and
bounties are not guaranteed. If possible, allow coordination before publishing exploit details.

## Versions

Use the latest published release from [GitHub Releases](https://github.com/trina-app/trina-ax/releases).
There is no published long-term support or older-release backport schedule. Report issues on any version and state
which version you tested; a fix may require upgrading.

## Deployment boundaries

- Every file-tool request is checked against the asking person's folder permissions on the server.
- Linux and role-account Mac installations add engine restrictions, dedicated OS accounts, sandboxing and network rules. Office Mac mode uses the logged-in OS account and has a different isolation boundary; see [OFFICE.md](docs/OFFICE.md). Follow the selected installation guide and review its diagnostics.
- Development mode runs engines as the current OS user and does not provide production OS isolation. Use synthetic data and keep it local.
- Server administrators can read stored files, chats and backups. Application folder permissions do not protect against the server administrator.
- Selected context goes to the model provider; external-service connections send requests to their configured services. Self-hosting alone does not keep all processing offline.
- Revoking access does not remove information already quoted in an earlier answer.

See the [security model](README.md#what-we-dont-promise), [Mac installation](docs/INSTALL.md),
[Linux installation](docs/INSTALL-LINUX.md) and [permissions (한국어)](docs/PERMISSIONS.md).

User-facing boundaries: [Security and permissions](docs/security-and-permissions.md) / [보안·권한](docs/security-and-permissions.ko.md).
