// CI tier — THE PROBE, ATTACKED: ONE TEST PER WAY A SERVER CAN FAIL TO BE THE APP.
//
// scripts/ci/boot-check.mjs exists because the offline suite cannot see a 404 and a 200 is not a pass on its own.
// A probe is only worth its exit code if it has been shown to fail: a probe that only ever meets 200 proves nothing.
// So every failure the script claims to distinguish gets its own throwaway server here — 404, 500, a 200 whose body
// belongs to something else, a health body with no release field, and nothing listening at all.
//
// These tests start nothing from the app: the server is `node -e` on 127.0.0.1 with an ephemeral port, and each test
// chooses the answers it gives. No database, no Chromium, no build, no port of ours, no app import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROBE = join(ROOT, "scripts/ci/boot-check.mjs");
const SOURCE = readFileSync(PROBE, "utf8");

/** The shell this app serves at `/`: a branded title, no form (the tasks page renders client-side). */
const SHELL_HTML =
  '<!DOCTYPE html><html><head><title>My tasks · Sheet Happens Officer</title></head>' +
  '<body><span>Sheet Happens Officer</span></body></html>';
/** The signed-out page: accepted for `/` too, because a candidate that sends visitors here has not 404'd. */
const SIGNIN_HTML =
  '<!DOCTYPE html><html><head><title>Sign in · Sheet Happens Officer</title></head><body>' +
  '<form><input name="email"><input type="password" name="password"></form></body></html>';
/** A 200 from something that is not this app: the shape of a proxy or framework page answering for us. */
const FOREIGN_HTML = '<!DOCTYPE html><html><head><title>Welcome to nginx!</title></head><body>It works!</body></html>';
const NOT_FOUND_HTML =
  '<!DOCTYPE html><html><head><title>404: This page could not be found.</title></head><body>404</body></html>';

/** Routes as `node -e` source: argv[1] is a JSON map of path -> { status, body }. Anything unlisted is a 404. */
const SERVER = [
  'const http = require("http");',
  "const routes = JSON.parse(process.argv[1]);",
  "const server = http.createServer((req, res) => {",
  '  const route = routes[req.url] || { status: 404, body: "<html><body>not found</body></html>" };',
  "  res.statusCode = route.status;",
  '  res.setHeader("content-type", route.type || "text/html; charset=utf-8");',
  '  if (route.hang) return;',
  '  res.end(route.body || "");',
  "});",
  'server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));',
].join("\n");

/** The healthy answers both routes must give. Each test overrides one of them. */
const HEALTHY = {
  "/": { status: 200, body: SHELL_HTML },
  "/api/health": { status: 200, body: '{"ok":true,"release":"abc1234"}' },
};

/** Start the throwaway server and wait for its port line, so the probe never races the listen. */
async function startServer(routes) {
  const child = spawn(process.execPath, ["-e", SERVER, JSON.stringify(routes)], { stdio: ["ignore", "pipe", "pipe"] });
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
  return { child, base: `http://127.0.0.1:${port}` };
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
    execFile(process.execPath, [PROBE, ...args], { timeout: 20_000 }, (error, stdout, stderr) => {
      // error is null on exit 0; otherwise error.code is the numeric exit status of the script.
      done({ code: error === null ? 0 : error.code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** Start a server whose answers differ from HEALTHY only where `overrides` says, probe it, and report both. */
async function probeWith(t, overrides, args = []) {
  const routes = { ...HEALTHY, ...overrides };
  const server = await startServer(routes);
  t.after(() => stopServer(server.child));
  return probe([server.base, ...args]);
}

test("a server that really serves the app passes, and the summary names both routes", async (t) => {
  const result = await probeWith(t, {});
  assert.equal(result.code, 0, `a healthy candidate must pass:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /GET \/ +200 title="My tasks · Sheet Happens Officer"/, "the pass line must quote the title it found");
  assert.match(result.stdout, /GET \/api\/health +200 ok=true release="abc1234"/, "the pass line must quote the release field");
  assert.match(result.stdout, /^BOOT-CHECK PASS: \/ and \/api\/health served by http:\/\/127\.0\.0\.1:\d+$/m, "the summary must be the last line");
  assert.equal(result.stderr, "", "a pass must not write to stderr");
});

test("the sign-in page is an accepted answer for /, so a candidate that sends visitors there still passes", async (t) => {
  // The packet names "the sign-in or app shell" as the pass condition. This is that half of it.
  const result = await probeWith(t, { "/": { status: 200, body: SIGNIN_HTML } });
  assert.equal(result.code, 0, `the sign-in page must be accepted:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /title="Sign in · Sheet Happens Officer"/);
});

test("a 404 on / is exit 20 and the failure names the status and the incident", async (t) => {
  // The router-root incident exactly: every route 404s while the offline suite is green.
  const result = await probeWith(t, { "/": { status: 404, body: NOT_FOUND_HTML } });
  assert.equal(result.code, 20, `expected exit 20, got ${result.code}:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /BOOT-CHECK FAIL \(exit 20\): GET http:\/\/127\.0\.0\.1:\d+\/ returned 404, expected 200/);
  assert.match(result.stderr, /7dd3581/, "the failure must point at the commit that undid this before");
  assert.doesNotMatch(result.stdout, /BOOT-CHECK PASS/, "a failing run must never print the pass summary");
});

test("a 200 whose body is not this app is exit 21 - a status alone is not a served candidate", async (t) => {
  // This is the case boot-probe.sh cannot see: something answers 200 and it is not us.
  const result = await probeWith(t, { "/": { status: 200, body: FOREIGN_HTML } });
  assert.equal(result.code, 21, `expected exit 21, got ${result.code}:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /returned 200 but the body is not this app/);
});

test("a framework 404 page served WITH a 200 is still refused: its bare title is not a branded one", async (t) => {
  const result = await probeWith(t, { "/": { status: 200, body: NOT_FOUND_HTML } });
  assert.equal(result.code, 21, `expected exit 21, got ${result.code}:\n${result.stdout}\n${result.stderr}`);
});

test("a 500 on /api/health is exit 30, distinct from the root failures", async (t) => {
  const result = await probeWith(t, { "/api/health": { status: 500, body: '{"ok":false}' } });
  assert.equal(result.code, 30, `expected exit 30, got ${result.code}:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /GET http:\/\/127\.0\.0\.1:\d+\/api\/health returned 500, expected 200/);
  assert.match(result.stdout, /GET \/ +200 title=/, "the routes before the failure must still be reported");
});

test("a 200 health body with no release/version field is exit 31 - the missing-field failure", async (t) => {
  const result = await probeWith(t, { "/api/health": { status: 200, body: '{"ok":true}' } });
  assert.equal(result.code, 31, `expected exit 31, got ${result.code}:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /neither a "release" nor a "version" field/);
});

test("a health body that is not JSON at all is exit 31, not a pass", async (t) => {
  const result = await probeWith(t, { "/api/health": { status: 200, body: "<html>ok</html>" } });
  assert.equal(result.code, 31, `expected exit 31, got ${result.code}:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /the body is not a JSON object/);
});

test("a health body saying ok=false is exit 31: 200 is not the same as healthy", async (t) => {
  const result = await probeWith(t, { "/api/health": { status: 200, body: '{"ok":false,"release":"abc1234"}' } });
  assert.equal(result.code, 31, `expected exit 31, got ${result.code}:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /ok=false/);
});

test("a null release still passes but is reported: the field is proven, the release identity is not", async (t) => {
  // This is what `next dev` answers with no RELEASE set. Failing here would make the probe red on a working server.
  const result = await probeWith(t, { "/api/health": { status: 200, body: '{"ok":true,"release":null}' } });
  assert.equal(result.code, 0, `a null release must not fail:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /release=null/);
  assert.match(result.stdout, /note: release is empty - this server identifies no release/);
});

test("nothing listening is exit 10, and says why nothing answered", async (t) => {
  // Take a real ephemeral port and close it, so the probe talks to a port that was open a moment ago and is not now.
  const server = await startServer(HEALTHY);
  await stopServer(server.child);

  const result = await probe([server.base]);
  assert.equal(result.code, 10, `expected exit 10, got ${result.code}:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /nothing answered \(ECONNREFUSED\)/, "an unreachable server must name the transport failure");
});

test("a server that accepts the connection and never answers is exit 10, not a hang", async (t) => {
  const server = await startServer({ "/": { hang: true }, "/api/health": { hang: true } });
  t.after(() => stopServer(server.child));

  const started = Date.now();
  const result = await probe([server.base, "--timeout-ms", "400"]);
  assert.equal(result.code, 10, `expected exit 10, got ${result.code}:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /the request timed out/);
  assert.ok(Date.now() - started < 10_000, "the probe must honour --timeout-ms rather than wait for the socket");
});

test("bad usage is exit 1, so a typo cannot look like a passing probe or a failing server", async () => {
  const noUrl = await probe([]);
  assert.equal(noUrl.code, 1, "no URL must exit 1");
  assert.match(noUrl.stderr, /usage: boot-check\.mjs/);
  assert.equal(noUrl.stdout, "", "a usage error must not start a run and print a pass line");

  const gibberish = await probe(["not-a-url"]);
  assert.equal(gibberish.code, 1, "an unparseable URL must exit 1");

  const ftp = await probe(["ftp://127.0.0.1/"]);
  assert.equal(ftp.code, 1, "a non-http(s) scheme must exit 1");

  // A caller who passes a path means a prefix. Dropping it silently would probe a different path than they named.
  const withPath = await probe(["http://127.0.0.1:3264/app"]);
  assert.equal(withPath.code, 1, "a base URL with a path must be refused, not silently reduced to its origin");
  assert.match(withPath.stderr, /pass the origin only/);

  const zeroTimeout = await probe(["http://127.0.0.1:1/", "--timeout-ms", "0"]);
  assert.equal(zeroTimeout.code, 1, "a zero timeout would prove nothing, so it is refused");
});

test("every failure has its own exit code: one diagnosis cannot be read as another", () => {
  // The packet's requirement, asserted rather than described. Each code is a different claim about the server.
  const codes = { unreachable: 10, rootNon200: 20, rootWrongBody: 21, healthNon200: 30, healthMissingField: 31 };
  assert.equal(new Set(Object.values(codes)).size, Object.keys(codes).length, "two failures share a code");
  for (const code of Object.values(codes)) assert.ok(code !== 0 && code !== 1, `${code} collides with pass/usage`);
});

test("the probe starts nothing and needs no database - the two things its contract forbids", () => {
  // A static claim, so it is asserted statically: no child process, no listening socket, no Prisma/pg import.
  assert.doesNotMatch(SOURCE, /node:child_process|require\(["']child_process/, "the probe must not spawn a server");
  assert.doesNotMatch(SOURCE, /\.listen\(/, "the probe must not listen on a port");
  assert.doesNotMatch(SOURCE, /@prisma\/client|from ["']pg["']|\$queryRaw/, "the probe must not touch a database");
  assert.doesNotMatch(SOURCE, /readFileSync\(process\.env/, "the probe must not read a deployment env file");
  assert.match(SOURCE, /BOOT-CHECK PASS/, "the pass summary is the line callers quote; it must exist");
});

