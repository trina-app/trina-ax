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
# + typst and the Linux bundle's fonts (Noto Sans CJK), with the same pins as scripts/linux/downloads.ts (a unit test
# compares them): make_file PDFs with Korean, Japanese and Chinese in bwrap (tests/unit/make-file-pdf-fonts.test.ts). The
# fonts stay outside the system font folders, which hold only DejaVu here, as on a stock Debian server.
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep poppler-utils procps util-linux ca-certificates curl xz-utils \
    bubblewrap nftables apparmor \
 && curl -fsSL -o /tmp/pandoc.deb https://github.com/jgm/pandoc/releases/download/${PANDOC}/pandoc-${PANDOC}-1-${TARGETARCH}.deb && dpkg -i /tmp/pandoc.deb && rm /tmp/pandoc.deb \
 && case "$TARGETARCH" in \
      amd64) T=x86_64; TS=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c ;; \
      arm64) T=aarch64; TS=5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee ;; \
      *) echo "no typst pin for $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/typst.tar.xz https://github.com/typst/typst/releases/download/v0.15.1/typst-$T-unknown-linux-musl.tar.xz \
 && echo "$TS  /tmp/typst.tar.xz" | sha256sum -c - && install -d -m 755 /opt/typst \
 && tar -xJf /tmp/typst.tar.xz -C /tmp && install -m 755 /tmp/typst-$T-unknown-linux-musl/typst /opt/typst/typst && rm -rf /tmp/typst* \
 && install -d -m 755 /opt/mycel-fonts && F=https://github.com/notofonts/noto-cjk/raw/523d033d6cb47f4a80c58a35753646f5c3608a78/Sans/OTC \
 && curl -fsSL -o /opt/mycel-fonts/NotoSansCJK-Regular.ttc $F/NotoSansCJK-Regular.ttc && curl -fsSL -o /opt/mycel-fonts/NotoSansCJK-Bold.ttc $F/NotoSansCJK-Bold.ttc \
 && printf '%s  %s\n' b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a /opt/mycel-fonts/NotoSansCJK-Regular.ttc \
      faa5f3656a78b2e2d450d27fe8382c778bc2b6bb5ea29c986664a6a435056ceb /opt/mycel-fonts/NotoSansCJK-Bold.ttc | sha256sum -c - \
 && chmod 644 /opt/mycel-fonts/* \
 && apt-get purge -y curl && rm -rf /var/lib/apt/lists/* && ! command -v sudo
RUN useradd --system -m -U -s /usr/sbin/nologin axserver && useradd --system -m -U -s /bin/bash axagent && useradd -m -U -s /bin/bash mallory \
 && chmod 700 /home/axserver /home/axagent /home/mallory
COPY package.json bun.lock /opt/mycel/
COPY shared /opt/mycel/shared
COPY server /opt/mycel/server
# T1 runs server sources directly: runtime resource imports (including the HWP
# manifest) must exist even when the optional preview renderer is disabled.
COPY resources /opt/mycel/resources
COPY tests/package.json /opt/mycel/tests/package.json
COPY web/package.json /opt/mycel/web/package.json
COPY desktop/package.json /opt/mycel/desktop/package.json
COPY relay/package.json /opt/mycel/relay/package.json
# every workspace of the root package.json, or the frozen lockfile does not match (this repository has no ee/)
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
ENV MYCEL_TYPST_BIN=/opt/typst/typst MYCEL_FONT_DIR=/opt/mycel-fonts
ENTRYPOINT ["/opt/mycel/tests/linux/entrypoint.sh"]
