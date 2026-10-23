// QA (w272): a tier that cannot run on this host must say so, and must say it before it spawns a server.
// Without the precondition the two job tiers crashed in teardown with `ENOENT ... scandir '/proc'` and
// reported "Failed Suites 1 / Tests 4 skipped (4)" - zero assertions executed, indistinguishable from a
// red tier.
//
// SHO-2771: the fix is that the tiers stopped needing procfs. They find their server through the port it
// answers on and stop it through the process group its `detached: true` spawn created
// (tests/spawned-listener.ts), so this file now guards the reduction rather than the precondition: no tier
// may read the process table again, and nothing in tests/ may read /proc except the whole-Linux drain tier
// and this precondition itself. The portable probe is proven live, on whatever host runs this file.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROCFS_MISSING, assertProcfs, procfsAvailable } from "./procfs-precondition";
import { portAnswers, stopTree } from "./spawned-listener";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The three mode tiers whose process discovery used to read procfs. */
const TIERS = [
  "tests/crm-visible-modes-server.test.ts",
  "tests/jobs-reminders-crm-server.test.ts",
  "tests/jobs-stalled-crm-server.test.ts",
];

/** A read of the process table: the CALL, not a mention in a comment or a path held as a fixture string. */
const PROCFS_READ = /read(?:dir|File|link)Sync\(\s*[`"']\/proc/;

/** The only files allowed to read /proc: the Linux-only drain tier, and the precondition's own probe. */
const PROCFS_READERS = ["tests/shutdown-next.test.ts", "tests/procfs-precondition.ts"];

/** Files that hold a /proc path as a FIXTURE STRING for the SHO-2917 scanner (they are that scanner and its
 *  cases) - they match the read pattern as text, never as a call. Named one by one so a new one is a red run. */
const PROCFS_FIXTURES = ["tests/base-url-no-environ-dump.test.ts", "tests/no-proc-environ-2917.test.ts"];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

describe("w272/SHO-2771: a mode tier finds its server without procfs", () => {
  it("a host without /proc is reported as missing procfs, naming the requirement", () => {
    if (procfsAvailable()) {
      // On Linux the guard is a no-op and the message is still the one a macOS run would print.
      expect(() => assertProcfs()).not.toThrow();
      expect(PROCFS_MISSING).toMatch(/no Linux procfs \(\/proc\)/);
      return;
    }
    expect(() => assertProcfs()).toThrow(/no Linux procfs \(\/proc\)/);
    expect(() => assertProcfs()).toThrow(/Run it on Linux/);
    // Not the bare errno that made two runs unable to triage the tier.
    expect(() => assertProcfs()).not.toThrow(/ENOENT/);
  });

  it.each(TIERS)("%s discovers its server through the port, not through /proc", (file) => {
    const text = readFileSync(path.join(root, file), "utf8");
    expect(PROCFS_READ.test(text), `${file} reads the process table again`).toBe(false);
    expect(text, `${file} still needs the procfs precondition`).not.toContain("assertProcfs");
    expect(text, `${file} asks the port instead`).toContain("portAnswers(");
  });

  it("no other file in tests/ reads /proc: only the Linux-only drain tier and the precondition do", () => {
    const readers = readdirSync(path.join(root, "tests"))
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => PROCFS_READ.test(readFileSync(path.join(root, "tests", name), "utf8")))
      .map((name) => `tests/${name}`);
    expect(readers.sort(), "files that read the process table").toEqual([...PROCFS_READERS, ...PROCFS_FIXTURES].sort());
  });

  it("finds and stops a detached server by its port and its process group, with no /proc read", async () => {
    const port = await freePort();
    expect(await portAnswers(port), "nothing answers on a port that was just freed").toBe(false);
    const child = spawn(
      process.execPath,
      ["-e", `require("net").createServer((socket) => socket.end()).listen(${port}, "127.0.0.1")`],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    try {
      await expect.poll(() => portAnswers(port), { timeout: 10_000 }).toBe(true);
      stopTree(child.pid);
      await expect.poll(() => portAnswers(port), { timeout: 10_000 }).toBe(false);
    } finally {
      stopTree(child.pid);
    }
  }, 20_000);
});
