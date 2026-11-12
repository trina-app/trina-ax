- Dev environment: the podman box runner is removed, and srt is the only runner. The Linux kit no longer has
  `root/mycel-boxd`. On a server where `scripts/dev-env/install-trial.sh` ran, the update stops and removes
  `mycel-boxd.service` and the box trial's drop-in, so the dev environment is off until `install-srt.sh` runs. The box
  state stays, and the update says where it is. `docs/INSTALL-LINUX.md` "Removed: the box runner" says how to remove it.
- The project endpoints of the box are gone: the per-project dev environment setting and the preview link. The stop of
  all runs of a project is now `POST /api/projects/:id/dev-env/stop`.
