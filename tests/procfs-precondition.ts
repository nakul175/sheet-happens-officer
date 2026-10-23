// QA (w272): three mode tiers find the pid listening on a mode server's port, and stop the server they
// started, through Linux procfs alone - /proc/net/tcp, /proc/<pid>/fd, /proc/<pid>/stat. On a host
// without procfs (macOS) those helpers throw a bare `ENOENT: no such file or directory, scandir '/proc'`
// from inside teardown, which vitest reports as "Failed Suites 1" with every test skipped: the same shape
// as a red tier, and the reason two local runs (w196, w272) could not say what was actually missing.
// Like the build precondition these files already throw ("CRM_VISIBLE mode cannot start: the production
// build is missing"), this says what the host lacks, before any server is spawned. On Linux it is a no-op.
import { readdirSync } from "node:fs";

/** Named, so a log or a report can quote the requirement instead of an errno. */
export const PROCFS_MISSING =
  "CRM_VISIBLE mode cannot be verified on this host: it has no Linux procfs (/proc), which this tier needs to find the pid listening on the mode server's port and to stop the server it started. Run it on Linux - CI does.";

export function procfsAvailable(): boolean {
  try {
    return readdirSync("/proc").length > 0;
  } catch {
    return false;
  }
}

export function assertProcfs(): void {
  if (!procfsAvailable()) throw new Error(PROCFS_MISSING);
}
