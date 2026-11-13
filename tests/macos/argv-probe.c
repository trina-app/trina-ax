/* argv-probe <pid>...: print the argv and environment of each pid (KERN_PROCARGS2), NUL bytes as spaces, or the error.
 * The attack checks of the dev environment on a Mac (tests/macos/srt-attack-mac.ts) run it in a run: macOS lets a
 * process read this for every process of its own uid, and a sandbox cannot block it, so a run must never share a uid
 * with the server or with another run. */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>

int main(int argc, char **argv) {
  static char buf[1 << 18];
  for (int i = 1; i < argc; i++) {
    int mib[3] = {CTL_KERN, KERN_PROCARGS2, atoi(argv[i])};
    size_t n = sizeof buf;
    if (sysctl(mib, 3, buf, &n, NULL, 0) != 0) { printf("%s: error %s\n", argv[i], strerror(errno)); continue; }
    printf("%s: ", argv[i]);
    for (size_t k = sizeof(int); k < n; k++) putchar(buf[k] ? buf[k] : ' ');
    putchar('\n');
  }
  return 0;
}
