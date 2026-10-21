// Fake Codex CLI for the role-account install test (tests/install/g-macos-install.ts). Installed as
// app/engines/codex/<sha>/codex and run by the installed launcher as the engine account, under engine.sb and pf, so
// it checks the production Codex path from the inside (a compiled program: the sandbox allows no shell):
//   codex --version                     "codex-cli 0.163.0"
//   codex login --device-auth -c ...    CONNECT auth.openai.com:443 through HTTPS_PROXY (must be 200), print the URL and
//                                       a one-time code like the real CLI, write $CODEX_HOME/auth.json (account acc-install)
//   codex exec ... -                    read stdin; check: the login copy in $CODEX_HOME, a tunnel to chatgpt.com:443 (200),
//                                       example.com:443 refused (403), no direct internet, the login folder itself and
//                                       $CODEX_HOME/config.toml not writable/readable; refresh the login copy (same
//                                       account, new refresh token: the launcher writes it back); then answer with the
//                                       results as Codex JSON events.
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void b64(const char *in, char *out) {
  size_t n = strlen(in), o = 0;
  for (size_t i = 0; i < n; i += 3) {
    unsigned v = (unsigned char)in[i] << 16 | (i + 1 < n ? (unsigned char)in[i + 1] << 8 : 0) | (i + 2 < n ? (unsigned char)in[i + 2] : 0);
    out[o++] = B64[v >> 18 & 63]; out[o++] = B64[v >> 12 & 63];
    out[o++] = i + 1 < n ? B64[v >> 6 & 63] : '='; out[o++] = i + 2 < n ? B64[v & 63] : '=';
  }
  out[o] = 0;
}

static int tcp(const char *ip, int port) {
  struct sockaddr_in s; memset(&s, 0, sizeof s); s.sin_family = AF_INET; s.sin_port = htons(port);
  if (inet_pton(AF_INET, ip, &s.sin_addr) != 1) return -1;
  int fd = socket(AF_INET, SOCK_STREAM, 0); if (fd < 0) return -1;
  struct timeval tv = { 5, 0 }; setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv); setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  if (connect(fd, (struct sockaddr *)&s, sizeof s) < 0) { close(fd); return -1; }
  return fd;
}

// CONNECT target through $HTTPS_PROXY (http://user:pass@127.0.0.1:port); returns the HTTP status or -1
static int tunnel(const char *target) {
  const char *px = getenv("HTTPS_PROXY"); if (!px || strncmp(px, "http://", 7)) return -1;
  char cred[512], host[64]; int port = 0;
  const char *at = strrchr(px, '@'); if (!at || (size_t)(at - px - 7) >= sizeof cred) return -1;
  memcpy(cred, px + 7, at - px - 7); cred[at - px - 7] = 0;
  if (sscanf(at + 1, "%63[^:]:%d", host, &port) != 2) return -1;
  int fd = tcp(host, port); if (fd < 0) return -1;
  char enc[800], req[1200], resp[256];
  b64(cred, enc);
  int n = snprintf(req, sizeof req, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: Basic %s\r\n\r\n", target, target, enc);
  if (write(fd, req, n) != n) { close(fd); return -1; }
  ssize_t r = read(fd, resp, sizeof resp - 1); close(fd);
  if (r <= 12) return -1;
  resp[r] = 0;
  return atoi(resp + 9);
}

static int readable(const char *p) { int fd = open(p, O_RDONLY); if (fd < 0) return 0; close(fd); return 1; }
static int writable(const char *p) { int fd = open(p, O_WRONLY | O_CREAT, 0600); if (fd < 0) return 0; close(fd); unlink(p); return 1; }
static int slurp(const char *p, char *buf, size_t cap) {
  int fd = open(p, O_RDONLY); if (fd < 0) return -1;
  ssize_t n = read(fd, buf, cap - 1); close(fd); if (n < 0) return -1; buf[n] = 0; return (int)n;
}
static int spit(const char *p, const char *s) {
  char tmp[1100]; snprintf(tmp, sizeof tmp, "%s.new", p);
  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0600); if (fd < 0) return -1;
  size_t n = strlen(s); if (write(fd, s, n) != (ssize_t)n) { close(fd); return -1; } close(fd);
  return rename(tmp, p);
}

int main(int argc, char **argv) {
  if (argc >= 2 && !strcmp(argv[1], "--version")) { puts("codex-cli 0.163.0"); return 0; }
  const char *home = getenv("CODEX_HOME"); if (!home) { fputs("no CODEX_HOME\n", stderr); return 2; }
  char auth[1024]; snprintf(auth, sizeof auth, "%s/auth.json", home);
  if (argc >= 3 && !strcmp(argv[1], "login") && !strcmp(argv[2], "--device-auth")) {
    int s = tunnel("auth.openai.com:443");
    if (s != 200) { fprintf(stderr, "Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode) [proxy %d]\n", s); return 1; }
    printf("\nWelcome to Codex [v0.163.0]\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n"
           "1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n"
           "2. Enter this one-time code (expires in 15 minutes)\n   TEST-INST1\n\n");
    fflush(stdout);
    sleep(1);
    if (spit(auth, "{\"auth_mode\":\"chatgpt\",\"OPENAI_API_KEY\":null,\"tokens\":{\"id_token\":\"i\",\"access_token\":\"a\",\"refresh_token\":\"r-0\",\"account_id\":\"acc-install\"},\"last_refresh\":\"2026-10-21T00:00:00Z\"}")) { perror("auth.json"); return 1; }
    puts("Successfully logged in");
    return 0;
  }
  if (argc >= 2 && !strcmp(argv[1], "exec")) {
    char in[4096]; while (read(0, in, sizeof in) > 0) {}
    char buf[2048];
    const char *a = slurp(auth, buf, sizeof buf) > 0 && strstr(buf, "\"acc-install\"") ? "ok" : "missing";
    int t1 = tunnel("chatgpt.com:443"), t2 = tunnel("example.com:443");
    int d = tcp("1.1.1.1", 443); const char *direct = d >= 0 ? "open" : "blocked"; if (d >= 0) close(d);
    // the login folder: <agent root>/codex-auth, with CODEX_HOME = <agent root>/<chat>/.codex
    char root[1024], real[1100]; snprintf(root, sizeof root, "%s", home);
    for (int i = 0; i < 2; i++) { char *sl = strrchr(root, '/'); if (sl) *sl = 0; }
    snprintf(real, sizeof real, "%s/codex-auth/auth.json", root);
    const char *authdir = readable(real) ? "readable" : "blocked";
    char cfg[1100]; snprintf(cfg, sizeof cfg, "%s/config.toml", home);
    const char *config = writable(cfg) ? "writable" : "blocked";
    // a token refresh: same account, new refresh token
    char nb[512]; snprintf(nb, sizeof nb, "{\"auth_mode\":\"chatgpt\",\"OPENAI_API_KEY\":null,\"tokens\":{\"id_token\":\"i\",\"access_token\":\"a\",\"refresh_token\":\"r-%ld\",\"account_id\":\"acc-install\"},\"last_refresh\":\"2026-10-21T01:00:00Z\"}", (long)time(NULL));
    const char *refresh = spit(auth, nb) == 0 ? "written" : "failed";
    printf("{\"type\":\"thread.started\",\"thread_id\":\"00000000-0000-4000-8000-000000000001\"}\n");
    printf("{\"type\":\"item.completed\",\"item\":{\"id\":\"m1\",\"type\":\"agent_message\",\"text\":\"fakecodex auth=%s tunnel=%d other=%d direct=%s authdir=%s config=%s refresh=%s\"}}\n", a, t1, t2, direct, authdir, config, refresh);
    printf("{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"cached_input_tokens\":0,\"output_tokens\":5}}\n");
    return 0;
  }
  fputs("fake codex: unknown command\n", stderr);
  return 2;
}
