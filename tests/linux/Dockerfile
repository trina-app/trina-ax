# Linux job: fuzzer + backstop tests with separate unprivileged accounts (design tab 2 "엔진 계정").
#   axserver = server (owns team folder, DB, private socket)   axagent = engine account (launcher, bridge, engines)
# Works on arm64 (Apple silicon) and amd64 (GitHub runners): TARGETARCH is set by BuildKit.
# The base image is Debian 13 (bubblewrap 0.12.0, nftables 1.1.x). Run it with tests/linux/run.ts (--privileged
# --cgroupns=private: bwrap's user namespaces and mounts, nft's CAP_NET_ADMIN, a writable cgroup tree).
FROM oven/bun:1.3.12-debian
ARG PANDOC=3.9.0.2
ARG TARGETARCH
# bubblewrap + nftables + apparmor (apparmor_parser, for hosts with kernel.apparmor_restrict_unprivileged_userns=1):
# the Linux engine sandbox (linux-runtime spec 3.9.1, T1)
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep poppler-utils procps util-linux ca-certificates curl \
    bubblewrap nftables apparmor \
 && curl -fsSL -o /tmp/pandoc.deb https://github.com/jgm/pandoc/releases/download/${PANDOC}/pandoc-${PANDOC}-1-${TARGETARCH}.deb && dpkg -i /tmp/pandoc.deb && rm /tmp/pandoc.deb \
 && apt-get purge -y curl && rm -rf /var/lib/apt/lists/* && ! command -v sudo
RUN useradd --system -m -U -s /usr/sbin/nologin axserver && useradd --system -m -U -s /bin/bash axagent && useradd -m -U -s /bin/bash mallory \
 && chmod 700 /home/axserver /home/axagent /home/mallory
COPY package.json bun.lock /opt/mycel/
COPY shared /opt/mycel/shared
COPY server /opt/mycel/server
COPY tests/package.json /opt/mycel/tests/package.json
COPY web/package.json /opt/mycel/web/package.json
COPY desktop/package.json /opt/mycel/desktop/package.json
COPY relay/package.json /opt/mycel/relay/package.json
# every workspace of the root package.json, or the frozen lockfile does not match (ee/cloud depends on @mycel/shared)
COPY ee/cloud/package.json /opt/mycel/ee/cloud/package.json
RUN cd /opt/mycel && bun install --frozen-lockfile
COPY tests /opt/mycel/tests
# the browser's sealing code: the credential store test seals with it and opens on the server side
COPY web/src/lib/seal.ts /opt/mycel/web/src/lib/seal.ts
COPY native/bin/linux-${TARGETARCH} /opt/mycel/native/bin/linux-${TARGETARCH}
# the fake engine's own engine folder: the turn sandbox shows only this folder (read-only, executable) and the chat
# folder, so bun and the script live here together (tests/lib/run-turn.ts MYCEL_FAKE_ENGINE_DIR)
# + the chat tests' fake Claude Code / Codex (tests/lib/b-fake-engine.ts) compiled into one executable each, named like
# the real engines (the launcher binds Codex's lock files for a binary named codex): the managed turns of driver.ts
RUN install -d -m 755 /opt/fake-engine && cp /usr/local/bin/bun /opt/fake-engine/bun && cp /opt/mycel/tests/lib/fake-engine.ts /opt/fake-engine/ \
 && chmod 755 /opt/fake-engine/bun && chmod 644 /opt/fake-engine/fake-engine.ts \
 && bun build --compile /opt/mycel/tests/lib/b-fake-engine.ts --outfile /opt/fake-engine/claude \
 && cp /opt/fake-engine/claude /opt/fake-engine/codex && chmod 755 /opt/fake-engine/claude /opt/fake-engine/codex
RUN rm -rf /opt/mycel/tests/.work && chmod -R a+rX /opt/mycel && chmod 755 /opt/mycel/tests/linux/*.sh
ENV MYCEL_NATIVE_BIN=/opt/mycel/native/bin/linux-${TARGETARCH}
ENTRYPOINT ["/opt/mycel/tests/linux/entrypoint.sh"]
