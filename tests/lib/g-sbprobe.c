// Sandbox / firewall probe for the installer-ops tests (component G). One operation per run, exit 0 = allowed.
//   probe read <file> | write <file> | list <dir> | tcp <ip> <port> | talk <ip> <port> | unix <socket path> | exec <program>
//         | stat <path> | realpath <path> | procs | procargs <pid> | hold <ms> [ignored ...] | watchargv <needle> <marker> <ms>
// stat exits 0 (found), 1 (EPERM: the sandbox said no), 3 (ENOENT) or 4 (other error), so a test can tell "denied"
// from "does not exist" (a denied stat must not reveal whether the path exists). procs = list every process
// (KERN_PROC_ALL), procargs = read another process's argv (KERN_PROCARGS2).
// hold = stand-in for an engine turn: sleep <ms>, ignoring the rest of argv (the real engine arguments ride along).
// watchargv = for <ms>, read KERN_PROCARGS2 of every pid near our own (pids are handed out in order) and print
// "SEEN <pid> <argv>" for each process whose argv contains <marker> and "LEAK <pid> <argv>" when it contains <needle>.
// talk = connect, send "ping\n", wait up to 3 s for any reply (an echo server answers): data really flows. On macOS pf
// matches the engine account on IPv6 only once the connection exists, so a bare connect() can succeed while every
// data packet is dropped; talk tells the two apart.
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static int fail(const char *what) { fprintf(stderr, "%s: %s\n", what, strerror(errno)); return 1; }

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "procs")) {
    int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0 }; size_t len = 0;
    if (sysctl(mib, 3, NULL, &len, NULL, 0) < 0 || len == 0) return fail("sysctl kern.proc.all");
    return 0;
  }
  if (argc < 3) { fprintf(stderr, "usage: probe read|write|list|tcp|unix|exec <arg> [port]\n"); return 2; }
  const char *op = argv[1], *a = argv[2];
  if (!strcmp(op, "read")) {
    char buf[64]; int fd = open(a, O_RDONLY); if (fd < 0) return fail("open");
    if (read(fd, buf, sizeof buf) < 0) return fail("read"); return 0;
  }
  if (!strcmp(op, "write")) {
    int fd = open(a, O_WRONLY | O_CREAT | O_TRUNC, 0600); if (fd < 0) return fail("open");
    if (write(fd, "x", 1) != 1) return fail("write"); close(fd); unlink(a); return 0;
  }
  if (!strcmp(op, "stat")) {
    struct stat st; if (stat(a, &st) == 0) return 0;
    int e = errno; fail("stat"); return e == EPERM ? 1 : e == ENOENT ? 3 : 4;
  }
  if (!strcmp(op, "procargs")) {
    int mib[3] = { CTL_KERN, KERN_PROCARGS2, atoi(a) }; static char buf[1 << 16]; size_t len = sizeof buf;
    if (sysctl(mib, 3, buf, &len, NULL, 0) < 0) return fail("sysctl kern.procargs2"); return 0;
  }
  if (!strcmp(op, "realpath")) {
    // what an engine does with its working folder: getcwd() and realpath() of <path> must both work and agree
    char cwd[PATH_MAX], rp[PATH_MAX];
    if (!getcwd(cwd, sizeof cwd)) return fail("getcwd");
    if (!realpath(a, rp)) return fail("realpath");
    printf("%s\n%s\n", cwd, rp); return 0;
  }
  if (!strcmp(op, "hold")) { usleep((useconds_t)atoi(a) * 1000); return 0; }
  if (!strcmp(op, "watchargv")) {
    if (argc < 5) return 2;
    const char *needle = a, *marker = argv[3]; long ms = atol(argv[4]);
    static char buf[1 << 18]; static int seen[1 << 17]; static int leaked[1 << 17];
    int self = getpid(); struct timeval t0, t; gettimeofday(&t0, NULL);
    for (;;) {
      for (int pid = self > 300 ? self - 300 : 1; pid < self + 3000 && pid < (1 << 17); pid++) {
        if (pid == self) continue;
        int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid }; size_t len = sizeof buf;
        if (sysctl(mib, 3, buf, &len, NULL, 0) < 0 || len <= sizeof(int)) continue;
        for (size_t i = sizeof(int); i < len; i++) if (!buf[i]) buf[i] = ' ';
        buf[len < sizeof buf ? len : sizeof buf - 1] = 0;
        const char *args = buf + sizeof(int);
        if (!seen[pid] && strstr(args, marker)) { seen[pid] = 1; printf("SEEN %d %s\n", pid, args); fflush(stdout); }
        if (!leaked[pid] && strstr(args, needle)) { leaked[pid] = 1; printf("LEAK %d %s\n", pid, args); fflush(stdout); }
      }
      gettimeofday(&t, NULL);
      if ((t.tv_sec - t0.tv_sec) * 1000 + (t.tv_usec - t0.tv_usec) / 1000 >= ms) return 0;
    }
  }
  if (!strcmp(op, "list")) { DIR *d = opendir(a); if (!d) return fail("opendir"); return readdir(d) ? 0 : 1; }
  if (!strcmp(op, "tcp") || !strcmp(op, "talk")) {
    if (argc < 4) return 2;
    struct sockaddr_storage ss; memset(&ss, 0, sizeof ss); socklen_t len;
    struct sockaddr_in *s4 = (struct sockaddr_in *)&ss; struct sockaddr_in6 *s6 = (struct sockaddr_in6 *)&ss;
    if (inet_pton(AF_INET, a, &s4->sin_addr) == 1) { s4->sin_family = AF_INET; s4->sin_port = htons(atoi(argv[3])); len = sizeof *s4; }
    else if (inet_pton(AF_INET6, a, &s6->sin6_addr) == 1) { s6->sin6_family = AF_INET6; s6->sin6_port = htons(atoi(argv[3])); len = sizeof *s6; }
    else return 2;
    int fd = socket(ss.ss_family, SOCK_STREAM, 0); if (fd < 0) return fail("socket");
    struct timeval tv = { 3, 0 }; setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    if (connect(fd, (struct sockaddr *)&ss, len) < 0) return fail("connect");
    if (!strcmp(op, "tcp")) return 0;
    struct timeval rt = { 3, 0 }; setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &rt, sizeof rt);
    if (write(fd, "ping\n", 5) != 5) return fail("write");
    char b[16]; ssize_t n = read(fd, b, sizeof b);
    if (n <= 0) return fail("read");
    return 0;
  }
  if (!strcmp(op, "unix")) {
    struct sockaddr_un su; memset(&su, 0, sizeof su); su.sun_family = AF_UNIX;
    strncpy(su.sun_path, a, sizeof su.sun_path - 1);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0); if (fd < 0) return fail("socket");
    if (connect(fd, (struct sockaddr *)&su, sizeof su) < 0) return fail("connect"); return 0;
  }
  if (!strcmp(op, "exec")) {
    pid_t p = fork(); if (p < 0) return fail("fork");
    if (p == 0) { execl(a, a, (char *)0); _exit(127); }
    int st; waitpid(p, &st, 0); return WIFEXITED(st) && WEXITSTATUS(st) != 127 ? 0 : 1;
  }
  return 2;
}
