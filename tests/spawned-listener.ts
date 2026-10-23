// SHO-2771. Three mode tiers answered two questions about a server they had themselves spawned by
// walking Linux procfs: "who is holding this port" (/proc/net/tcp + /proc/<pid>/fd) and "what did it
// start, so I can stop it" (/proc/<pid>/stat, a parent walk). Both answers are already in hand at the
// spawn. The child is `detached: true`, so its pid is the leader of its own process group: the group is
// everything the spawn started (kill(-pid) reaches all of it) and the port is the thing the server was
// started for (a TCP connect either lands or does not). So neither question needs procfs, and neither
// reads another process's /proc image - which is why the same code path runs on macOS, where /proc does
// not exist, instead of reporting a red tier for a missing directory.
//
// Nothing here reads the environment of any process, its own included: the modes are proven by what a
// mode server answers (tests/crm-visible-modes-server.test.ts) and by the marker line the child writes.
import net from "node:net";

/** True when something accepts a TCP connection on 127.0.0.1:port. No /proc, no ps, no lsof. */
export function portAnswers(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (answer: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.on("error", () => { /* the destroy below is the last word */ });
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** SIGKILLs the process group `pid` leads, then `pid` itself: everything the spawn started, nothing else.
 *  POSIX only, exactly like the `detached: true` spawn that created the group. There is no Windows tier. */
export function stopTree(pid: number | undefined): void {
  if (!pid || pid === process.pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* the group is already gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/** Polls until nothing answers on the port, so a caller can prove the tree is really down. */
export async function waitForPortClosed(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portAnswers(port, 500))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
