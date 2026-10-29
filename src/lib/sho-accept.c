/* SIGTERM must refuse new connections even while JS is stuck in a synchronous
 * chunk. accept() and shutdown() run in the handler, on the thread that is
 * already on CPU: a helper thread stays unscheduled on a busy 2-vCPU box.
 * listen(fd, 0) first. shutdown(SHUT_RD) alone drops the queue (accept then
 * returns EINVAL), and accept() before that still takes a handshake that
 * arrives mid-loop — on 2 vCPU the loop ran past +16ms and accepted the probe.
 * listen(0) refuses new handshakes immediately and leaves the completed queue
 * to be accept()ed. shutdown(SHUT_RD) then makes the refusal stick.
 *
 * Rebuild (Ubuntu 24.04, gcc 13, same as the droplet) and commit the .so:
 *   gcc -O2 -fPIC -shared -o src/lib/sho-accept.so src/lib/sho-accept.c */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define MAX_LISTEN 4
#define MAX_SEIZED 8192
/* fd slots grown at arm time. Covers MAX_SEIZED accepts plus what the process already holds. */
#define RESERVE_FDS 16384

static int listen_fds[MAX_LISTEN];
static int listen_n = 0;
static int seized[MAX_SEIZED];
static volatile sig_atomic_t seized_n = 0;
static volatile sig_atomic_t did_seize = 0;
static volatile sig_atomic_t seize_ok = 1;
/* Time from listen(0), which can drop a SYN while the old accept queue is
 * drained, through SHUT_RD, after which the kernel replies with RST. */
static volatile sig_atomic_t drop_window_us = -1;
static int wake_read = -1;
static int wake_write = -1;

static void seize_all(void) {
  int n = 0;
  int ok = 1;
  struct timespec drop_start;
  struct timespec drop_end;
  int timed = clock_gettime(CLOCK_MONOTONIC, &drop_start) == 0;
  for (int i = 0; i < listen_n; i++) {
    /* Refuse before accept(). A handshake that completes during the loop would
     * otherwise be taken and look like a connection accepted after SIGTERM. */
    if (listen(listen_fds[i], 0) != 0) ok = 0;
  }
  for (int i = 0; i < listen_n; i++) {
    int fd = listen_fds[i];
    for (;;) {
      int client = accept4(fd, 0, 0, SOCK_NONBLOCK | SOCK_CLOEXEC);
      if (client >= 0) {
        if (n < MAX_SEIZED) seized[n++] = client;
        else {
          close(client);
          ok = 0;
        }
        continue;
      }
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) break;
      ok = 0;
      break;
    }
    if (shutdown(fd, SHUT_RD) != 0 && errno != ENOTCONN && errno != EBADF) ok = 0;
  }
  if (timed && clock_gettime(CLOCK_MONOTONIC, &drop_end) == 0) {
    long seconds = drop_end.tv_sec - drop_start.tv_sec;
    long nanos = drop_end.tv_nsec - drop_start.tv_nsec;
    long micros = seconds * 1000000L + nanos / 1000L;
    drop_window_us = micros >= 0 && micros <= 2147483647L ? (sig_atomic_t)micros : -1;
  }
  seized_n = n;
  seize_ok = ok;
  did_seize = 1;
  char byte = 1;
  if (wake_write >= 0) {
    ssize_t w2 = write(wake_write, &byte, 1);
    (void)w2;
  }
}

static void on_term(int sig) {
  (void)sig;
  /* The handler interrupts whatever the thread was doing. accept4/listen/
   * shutdown/write set errno, and the interrupted code may read it next. */
  int saved_errno = errno;
  if (!did_seize) seize_all();
  errno = saved_errno;
}

/* Growing the fd table in a multi-threaded process waits for an RCU grace
 * period. Node is multi-threaded, so the accept() that crossed fd 128 inside
 * seize_all stalled 5-11ms. listen(0) was already in force, so a new SYN in that
 * window was dropped rather than refused, and the client only got ECONNREFUSED
 * on its 1s retransmit (APL-2689 QA D2). Grow the table once here, outside the
 * signal. F_DUPFD never replaces an open fd, and the table does not shrink when
 * the dup is closed. */
static void reserve_fd_slots(int fd) {
  struct rlimit rl;
  if (getrlimit(RLIMIT_NOFILE, &rl) != 0) return;
  rlim_t top = rl.rlim_cur;
  if (top == RLIM_INFINITY || top > RESERVE_FDS) top = RESERVE_FDS;
  if (top < 2) return;
  int high = fcntl(fd, F_DUPFD_CLOEXEC, (int)(top - 1));
  if (high >= 0) close(high);
}

int sho_arm(int fd) {
  if (fd >= 0 && listen_n < MAX_LISTEN) listen_fds[listen_n++] = fd;
  if (fd >= 0) reserve_fd_slots(fd);
  if (wake_read >= 0) return wake_read;
  int wake[2];
  if (pipe(wake) != 0) return -1;
  int flags = fcntl(wake[0], F_GETFL, 0);
  if (flags >= 0) fcntl(wake[0], F_SETFL, flags | O_NONBLOCK);
  wake_read = wake[0];
  wake_write = wake[1];
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_term;
  sigemptyset(&sa.sa_mask);
  /* No SA_RESTART: the handler must run as the interruption, and a restarted
   * syscall would return to a listener that this handler has already shut. */
  sa.sa_flags = 0;
  if (sigaction(SIGTERM, &sa, 0) != 0) return -1;
  return wake_read;
}

int sho_seize_ok(void) { return seize_ok; }

int sho_drop_window_us(void) { return drop_window_us; }

int sho_seized(void) { return did_seize; }

int sho_take(int *out, int cap) {
  int n = seized_n;
  if (n > cap) n = cap;
  if (n < 0) n = 0;
  for (int i = 0; i < n; i++) out[i] = seized[i];
  seized_n = 0;
  return n;
}
