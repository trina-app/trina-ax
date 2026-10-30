# A systemd machine for tests/install/g-linux-install.ts when no Linux VM is at hand (the T2 job itself runs on a
# GitHub ubuntu-24.04 VM, linux-runtime spec 3.9.2). Debian 13 with systemd as PID 1, the packages the installer would
# fetch (so it runs offline after the first build), and bun 1.3.12 to run the test.
#
#   docker build -t mycel-t2-systemd -f tests/install/linux/Dockerfile tests/install/linux
#   docker run -d --name mycel-t2 --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
#     -v "$PWD:/src:ro" mycel-t2-systemd
#   docker exec mycel-t2 /src/tests/install/linux/run-in-container.sh      (copies the repository, runs the test)
#
# --privileged: bwrap (user, mount and pid namespaces), nftables (CAP_NET_ADMIN in the container's network namespace),
# cgroup delegation to the units, and loading the installer's AppArmor profile (the host kernel may restrict
# unprivileged user namespaces, as Ubuntu 24.04 and colima's VM do).
FROM debian:trixie
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus ca-certificates curl gnupg \
      file zstd util-linux procps iproute2 bubblewrap nftables apparmor poppler-utils \
      ffmpeg unzip rsync cron xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask getty.target console-getty.service systemd-firstboot.service systemd-logind.service >/dev/null 2>&1 || true
COPY --from=oven/bun:1.3.12-debian /usr/local/bin/bun /usr/local/bin/bun
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
