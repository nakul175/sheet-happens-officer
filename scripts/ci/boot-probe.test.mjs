// CI tier — THE PROBE, ATTACKED, AND THE GATE THAT SAYS A PROBE MUST EXIST.
//
// scripts/ci/boot-probe.sh answers one question a running server can answer and an offline suite cannot: does this
// candidate serve its own routes? The incident behind the gate is the reviewer's first finding here — 86/86 green
// offline while GET /api/health and GET / both returned 404 (commit 7dd3581 undid the cause).
//
// These tests start nothing from the app: the server is `node -e` on 127.0.0.1 with an ephemeral port, answering 200
// on /api/health and 404 elsewhere. No DB, no Chromium, no build, no port of ours. The last test is the contract the
// packet asks for — a candidate may not be called integrated unless a probe exists and something invokes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROBE = join(ROOT, "scripts/ci/boot-probe.sh");
const CI_WORKFLOW = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

/** The throwaway server, as `node -e` source: 200 on /api/health, 404 on everything else, ephemeral port, loopback. */
const SERVER = [
  'const http = require("http");',
  "const server = http.createServer((req, res) => {",
  '  res.statusCode = req.url === "/api/health" ? 200 : 404;',
  '  res.end(res.statusCode === 200 ? "ok" : "not found");',
  "});",
  'server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));',
].join("\n");

/** Start it and wait for the port line, so the probe never races the listen. */
async function startServer() {
  const child = spawn(process.execPath, ["-e", SERVER], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise((resolvePort, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("the throwaway server printed no port within 10s")), 10_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      clearTimeout(timer);
      resolvePort(Number(buffer.split("\n")[0]));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { child, url: (path) => `http://127.0.0.1:${port}${path}` };
}

function stopServer(child) {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once("exit", () => done());
    child.kill("SIGKILL");
  });
}

/** Run the probe exactly as a caller would, and report its exit code with stdout/stderr trimmed. */
function probe(args) {
  return new Promise((done) => {
    execFile(PROBE, args, { timeout: 20_000 }, (error, stdout, stderr) => {
      // error is null on exit 0; otherwise error.code is the numeric exit status of the script.
      done({ code: error === null ? 0 : error.code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

test("a live server's /api/health is 200 and the probe exits 0, printing only the status", async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server.child));

  const result = await probe([server.url("/api/health")]);
  assert.deepEqual(result, { code: 0, stdout: "200", stderr: "" });
});

test("a route the server does not have is 404 and the probe exits non-zero: the incident, caught in one line", async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server.child));

  const result = await probe([server.url("/no-such-route")]);
  assert.equal(result.stdout, "404", "the probe must print the status it saw");
  assert.equal(result.code, 1, "a 404 must not exit 0");
  assert.equal(result.stderr, "", "a status the probe saw is an answer, not an error message");
});

test("nothing listening is 000 and non-zero, not a silent success", async (t) => {
  // Take a real ephemeral port and close it, so the probe talks to a port that was open a moment ago and is not now.
  const server = await startServer();
  await stopServer(server.child);
  const url = server.url("/api/health");

  const result = await probe([url]);
  assert.equal(result.stdout, "000", "an unreachable server must print 000");
  assert.equal(result.code, 1, "an unreachable server must not exit 0");
});

test("bad usage is refused with exit 2, so a typo cannot look like a passing probe", async () => {
  const noUrl = await probe([]);
  assert.equal(noUrl.code, 2, "no URL must exit 2");
  assert.match(noUrl.stderr, /usage: boot-probe\.sh/, "no URL must print the usage line");
  assert.equal(noUrl.stdout, "", "usage errors must not print a status on stdout");

  const badAttempts = await probe(["http://127.0.0.1:1/api/health", "soon"]);
  assert.equal(badAttempts.code, 2, "a non-numeric attempt count must exit 2");

  const zeroAttempts = await probe(["http://127.0.0.1:1/api/health", "0"]);
  assert.equal(zeroAttempts.code, 2, "zero attempts would prove nothing, so it is refused");
});

test("a retry waits for a booting server without changing the verdict", async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server.child));

  const result = await probe([server.url("/api/health"), "3", "0"]);
  assert.deepEqual(result, { code: 0, stdout: "200", stderr: "" });
});

/** Every regular file under dir, recursively, skipping node_modules and .git. */
function filesUnder(dir) {
  const out = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.name === "node_modules" || dirent.name === ".git") continue;
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) out.push(...filesUnder(full));
    else if (dirent.isFile()) out.push(full);
  }
  return out;
}

test("a runtime probe exists, is executable, and something invokes it - offline green cannot be the only gate", () => {
  // The packet's rule: a candidate is not integrated until something can ask a running server whether it booted.
  // A missing, non-executable, or never-invoked probe is the same thing as no probe at all.
  assert.ok(existsSync(PROBE), "scripts/ci/boot-probe.sh is missing: nothing can then tell a booted candidate from a 404 one");
  assert.notEqual(statSync(PROBE).mode & 0o111, 0, "boot-probe.sh must be executable, or the documented command is not one");

  const callers = [...filesUnder(join(ROOT, "scripts")), ...filesUnder(join(ROOT, ".github/workflows"))]
    .filter((file) => file !== PROBE)
    .filter((file) => readFileSync(file, "utf8").includes("boot-probe.sh"));

  assert.ok(
    callers.length > 0,
    "nothing under scripts/ or .github/workflows names boot-probe.sh: a probe no one runs cannot fail a candidate",
  );
});

test("the CI workflow probes a running server's /api/health, so a pipeline run carries runtime evidence", () => {
  // The workflow's own step, unchanged by this packet: it starts `next start` and polls the health route. This
  // assertion keeps the inline copy from quietly disappearing, which would leave only the offline tier.
  assert.match(CI_WORKFLOW, /- name: Start the app/, "ci.yml no longer has a Start the app step");
  assert.match(CI_WORKFLOW, /api\/health/, "the app-start step no longer probes /api/health");
  assert.match(CI_WORKFLOW, /curl -fsS "\$url"/, "the app-start step no longer refuses a server that does not answer");
});


