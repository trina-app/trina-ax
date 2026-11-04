# Trina AX team server in Docker (docs/INSTALL-DOCKER.md).
#
# The image holds a signed release kit, the distribution packages the Linux installer needs and the two role accounts.
# It does not install the server at build time: the entrypoint runs scripts/install-linux.sh from the kit at container
# start, into the named volume on /var/lib/mycel, and then starts `mycel-ctl supervise` (no systemd in the container).
#
#   docker build --build-arg TRINA_AX_VERSION=0.3.0 -t trina-ax:0.3.0 docker/
#
# A kit from your own build (development, unsigned): put the unpacked kit folder in docker/kit-local/ and build with
# --build-arg TRINA_AX_KIT=local. The container then needs TRINA_AX_ALLOW_UNSIGNED=1.
ARG DEBIAN_IMAGE=debian:trixie-slim
# release (download the published kit) or local (docker/kit-local/)
ARG TRINA_AX_KIT=release

# ---- the kit: download the release, check SHA256SUMS, check the release signature ----
FROM ${DEBIAN_IMAGE} AS kit-release
ARG TRINA_AX_VERSION
ARG TARGETARCH
ARG TRINA_AX_RELEASES=https://github.com/trina-app/trina-ax/releases/download
RUN test -n "$TRINA_AX_VERSION" || { echo "set --build-arg TRINA_AX_VERSION=<version>" >&2; exit 1; } \
 && apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl >/dev/null \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /dl
RUN set -eu; \
    case "$TARGETARCH" in amd64|arm64) ;; *) echo "no Linux kit for $TARGETARCH (amd64 or arm64)" >&2; exit 1 ;; esac; \
    kit="TrinaAX-server-${TRINA_AX_VERSION}-linux-${TARGETARCH}.tar.gz"; \
    curl -fsSL --proto =https -o "$kit" "$TRINA_AX_RELEASES/v${TRINA_AX_VERSION}/$kit"; \
    curl -fsSL --proto =https -o SHA256SUMS "$TRINA_AX_RELEASES/v${TRINA_AX_VERSION}/SHA256SUMS"; \
    grep -E "^[0-9a-f]{64}  \*?${kit}\$" SHA256SUMS | sed 's/ \*/  /' | sha256sum -c -; \
    mkdir /kit-x && tar -xzf "$kit" -C /kit-x --no-same-owner; \
    mv "/kit-x/TrinaAX-server-${TRINA_AX_VERSION}-linux-${TARGETARCH}" /kit; \
    test "$(cat /kit/VERSION)" = "$TRINA_AX_VERSION"; \
    "/kit/app/${TRINA_AX_VERSION}/root/mycel-ctl" verify-bundle "/kit/app/${TRINA_AX_VERSION}"; \
    rm -rf /dl /kit-x

FROM ${DEBIAN_IMAGE} AS kit-local
COPY kit-local/ /kit/

FROM kit-${TRINA_AX_KIT} AS kit

# ---- the runtime image ----
FROM ${DEBIAN_IMAGE}
# The packages scripts/install-linux.sh installs on a Linux server (its PKGS list), so it can run with --skip-apt;
# No init program is needed: mycel-ctl supervise is PID 1 and reaps orphans itself.
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      bubblewrap nftables poppler-utils ffmpeg libheif-examples ca-certificates curl gnupg file zstd util-linux \
      procps passwd python3 >/dev/null \
 && rm -rf /var/lib/apt/lists/*
# Fixed ids: the files in the volume belong to these numbers, so every image version must use the same ones (the same
# numbers as the hosted tenant image). System range, no login shell, locked password: install-linux.sh checks all three.
RUN groupadd --system --gid 980 axserver \
 && useradd --system --uid 980 --gid 980 --home-dir /var/lib/mycel/data --shell /usr/sbin/nologin --no-create-home \
      --comment "Trina AX server (mycel)" axserver \
 && groupadd --system --gid 981 axagent \
 && useradd --system --uid 981 --gid 981 --home-dir /var/lib/mycel/agent/home --shell /usr/sbin/nologin --no-create-home \
      --comment "Trina AX AI engine (mycel)" axagent \
 && passwd -l axserver >/dev/null && passwd -l axagent >/dev/null
COPY --from=kit /kit /opt/trina-ax/kit
COPY entrypoint.sh /usr/local/bin/trina-ax-entrypoint
COPY setup-link.sh /usr/local/bin/trina-ax-setup-link
RUN chown -R root:root /opt/trina-ax && chmod -R go-w /opt/trina-ax \
 && chmod 755 /usr/local/bin/trina-ax-entrypoint /usr/local/bin/trina-ax-setup-link \
 && mkdir -p /var/lib/mycel && chmod 755 /var/lib/mycel
LABEL org.opencontainers.image.title="Trina AX team server" \
      org.opencontainers.image.source="https://github.com/trina-app/trina-ax" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
VOLUME /var/lib/mycel
EXPOSE 47820
# mycel-ctl supervise stops the server and the launcher on SIGTERM and kills them after 30 s
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=3 \
  CMD curl -fsS --max-time 4 http://127.0.0.1:47820/api/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/trina-ax-entrypoint"]
