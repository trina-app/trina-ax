# Linux job: fuzzer + backstop tests with separate unprivileged accounts (design tab 2 "엔진 계정").
#   axserver = server (owns team folder, DB, private socket)   axagent = engine account (launcher, bridge, engines)
# Works on arm64 (Apple silicon) and amd64 (GitHub runners): TARGETARCH is set by BuildKit.
FROM oven/bun:1.3.12-debian
ARG PANDOC=3.9.0.2
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep poppler-utils procps util-linux ca-certificates curl \
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
RUN cd /opt/mycel && bun install --frozen-lockfile
COPY tests /opt/mycel/tests
COPY native/bin/linux-${TARGETARCH} /opt/mycel/native/bin/linux-${TARGETARCH}
RUN rm -rf /opt/mycel/tests/.work && chmod -R a+rX /opt/mycel && chmod 755 /opt/mycel/tests/linux/*.sh
ENV MYCEL_NATIVE_BIN=/opt/mycel/native/bin/linux-${TARGETARCH}
ENTRYPOINT ["/opt/mycel/tests/linux/entrypoint.sh"]
