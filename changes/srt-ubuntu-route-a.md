- The dev environment now works on Ubuntu 24.04 servers. The installer turns it on there as on Debian 13.
- Each dev environment run is now a systemd unit `trina-dev@<run id>.service` of a template that the install writes as
  root. The limits and the sandbox stay the same. The first update with this change stops runs that are still going
  (jobs and dev servers end as stopped); start them again after the update.
