#!/usr/bin/env node
// SHO-2689 — the release identity, checkable on any kernel.
//
// WHY THIS FILE EXISTS
// scripts/acceptance/linux-drain-gate.sh already knows what a release is: production_precondition
// asks for the production entry (server.js), a completed build (.next/BUILD_ID non-empty) and no
// dev-server artifacts (.next/dev), and run_bursts compares the release /api/health echoes with
// the release under test. But main() checks the kernel FIRST and returns 3 on darwin, before the
// precondition, before any build, before any socket. On a Mac the gate's own answer is therefore
// unreachable through its CLI — which is how a dev server came to be quoted as a release more than
// once. This module is that answer with no kernel to refuse.
//
// It is also now the ONLY implementation of that answer. The gate used to carry its own bash
// copies — production_precondition and release_matches — and W160 measured them drifting: for a
// DIRECTORY named server.js the probe said "release" and the gate said
// "GATE=FAIL missing-production-entry". So the gate no longer holds the rules; it shells out to
// this module (it already ran node for read_burst, for the build and for the burst harness) and
// maps the answer back to its own lines:
//   production_precondition <dir>   ->  node release-identity.mjs <dir>
//   release_matches <a> <b>         ->  node release-identity.mjs --match <a> <b>
// The rules here are therefore the gate's rules, and linux-drain-gate.test.mjs pins the gate's
// own output to this module's answer so the two cannot drift apart again.
//
// WHAT IT DOES NOT DO: it does not build, does not start anything, and is not acceptance. A tree
// that passes here is a release that exists; whether it serves, and whether it drains under
// SIGTERM, are separate questions (the drain needs a Linux kernel).
//
// USAGE
//   node scripts/acceptance/release-identity.mjs <dir> [<release>] [--url http://127.0.0.1:3391]
//     <dir>      the directory that will serve (cwd of server.js, i.e. the build root)
//     <release>  the identity it must report; required with --url, optional otherwise
//     --url      also GET /api/health and assert it answers 200 echoing <release>
//   node scripts/acceptance/release-identity.mjs --match <expected> <observed>
//     the gate's c0-release rule as an exit code: 0 they are the same release, 1 not
//
// EXIT  0 the tree is the release (and, with --url, it names itself)
//       1 not the release / health disagreed / the server could not be reached
//       2 usage
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const ENTRY = "server.js";

/** True only for a regular file (a symlink to one included), exactly what bash `[ -f ]` means. */
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The build id a completed `next build` left here, or "" when there is none.
 * Whitespace is stripped with the same class bash `tr -d '[:space:]'` strips, so a BUILD_ID
 * that only differs by what counts as a space cannot split the two answers.
 */
export function buildIdOf(root) {
  const file = path.join(root, ".next", "BUILD_ID");
  if (!isFile(file)) return "";
  return readFileSync(file, "utf8").replace(/[ \t\n\v\f\r]/g, "");
}

/**
 * null when `root` is a release, else the gate's reason code — the same three checks in the
 * same order, and with the same file tests, as the gate's production_precondition.
 * The entry must be a regular FILE: `existsSync` would accept a directory called server.js,
 * which is exactly how this probe and the gate came to disagree (W160).
 */
export function identityProblem(root) {
  if (!isFile(path.join(root, ENTRY))) return "missing-production-entry";
  if (!buildIdOf(root)) return "missing-build-id";
  if (existsSync(path.join(root, ".next", "dev"))) return "dev-artifacts-present";
  return null;
}

/**
 * The gate's release_matches rule (c0-release): equal, or a short SHA on one side that is a
 * prefix of the other, both at least 7 characters. Case-insensitive. Never empty.
 * This is the single implementation — the gate calls it through `--match`, and
 * linux-drain-gate.test.mjs fails if the two ever answer differently.
 */
export function releaseMatches(expected, observed) {
  const e = String(expected ?? "").toLowerCase();
  const o = String(observed ?? "").toLowerCase();
  if (!e || !o) return false;
  if (e === o) return true;
  if (e.length < 7 || o.length < 7) return false;
  return o.startsWith(e) || e.startsWith(o);
}

/** GET /api/health. Returns the status and the release it reports; throws only on transport. */
export async function healthRelease(baseUrl) {
  const res = await fetch(new URL("/api/health", baseUrl), { headers: { "cache-control": "no-store" } });
  let release = null;
  try {
    release = (await res.json())?.release ?? null;
  } catch {
    release = null;
  }
  return { status: res.status, release };
}

/**
 * Both halves in one answer: the tree on disk, and the release the process serving from it
 * claims to be. `lines` are printable as-is.
 */
export async function check(baseUrl, root, expected) {
  const lines = [];
  let ok = true;

  const problem = identityProblem(root);
  if (problem) {
    lines.push(`RELEASE-IDENTITY=not-release reason=${problem} root=${root}`);
    ok = false;
  } else {
    lines.push(`RELEASE-IDENTITY=release build-id=${buildIdOf(root)} entry=${ENTRY} root=${root}`);
  }

  try {
    const { status, release } = await healthRelease(baseUrl);
    const claimed = release == null ? "none" : String(release);
    const matches = status === 200 && releaseMatches(expected, release);
    lines.push(
      `RELEASE-IDENTITY=health status=${status} release=${claimed} expected=${expected ?? "none"} match=${matches ? "yes" : "no"}`,
    );
    if (!matches) ok = false;
  } catch (err) {
    lines.push(`RELEASE-IDENTITY=health unreachable url=${baseUrl} (${String(err?.message ?? err)})`);
    ok = false;
  }

  return { ok, lines };
}

// ---------------------------------------------------------------- CLI

function usage() {
  process.stderr.write(
    "usage: release-identity.mjs <dir> [<release>] [--url http://127.0.0.1:PORT]\n" +
      "       release-identity.mjs --match <expected> <observed>\n",
  );
}

/** `--match <a> <b>`: the c0-release rule as an exit code, so the gate needs no copy of it. */
function matchMain(args) {
  const [expected, observed, extra] = args;
  // An EMPTY release is a value to judge, not a usage error: /api/health can echo "". Only a
  // missing argument is usage, so `--match <sha> ""` answers 1 like the gate always did.
  if (expected === undefined || observed === undefined || extra !== undefined) {
    process.stderr.write("RELEASE-IDENTITY=usage --match takes exactly <expected> <observed>\n");
    return 2;
  }
  const matches = releaseMatches(expected, observed);
  process.stdout.write(
    `RELEASE-IDENTITY=match expected=${expected} observed=${observed} match=${matches ? "yes" : "no"}\n`,
  );
  return matches ? 0 : 1;
}

/** `--build-id <dir>`: the completed build's id, or an empty exit status. The gate prints
 * `BUILD=ok build-id=…` and used to read `.next/BUILD_ID` itself, which made a THIRD copy of
 * the directory rule (W184); now it asks this. */
function buildIdMain(args) {
  const [root, extra] = args;
  if (!root || extra !== undefined) {
    process.stderr.write("RELEASE-IDENTITY=usage --build-id takes exactly <dir>\n");
    return 2;
  }
  const id = buildIdOf(root);
  process.stdout.write(`RELEASE-IDENTITY=build-id=${id || "none"} root=${root}\n`);
  return id ? 0 : 1;
}

async function main(argv) {
  const args = argv.slice(2);
  let root = "";
  let expected = "";
  let url = "";

  if (args[0] === "--match") return matchMain(args.slice(1));
  if (args[0] === "--build-id") return buildIdMain(args.slice(1));

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--url") {
      url = args[(i += 1)] ?? "";
    } else if (a === "-h" || a === "--help") {
      usage();
      return 0;
    } else if (a.startsWith("-")) {
      process.stderr.write(`RELEASE-IDENTITY=usage unknown-option ${a}\n`);
      usage();
      return 2;
    } else if (!root) {
      root = a;
    } else if (!expected) {
      expected = a;
    } else {
      process.stderr.write(`RELEASE-IDENTITY=usage too-many-arguments ${a}\n`);
      usage();
      return 2;
    }
  }

  if (!root) {
    usage();
    return 2;
  }
  if (url && !expected) {
    process.stderr.write("RELEASE-IDENTITY=usage missing-release (--url needs the release it must echo)\n");
    return 2;
  }

  if (url) {
    const { ok, lines } = await check(url, root, expected);
    for (const line of lines) process.stdout.write(`${line}\n`);
    return ok ? 0 : 1;
  }

  const problem = identityProblem(root);
  if (problem) {
    process.stdout.write(`RELEASE-IDENTITY=not-release reason=${problem}\n`);
    return 1;
  }
  process.stdout.write(`RELEASE-IDENTITY=release build-id=${buildIdOf(root)} entry=${ENTRY}\n`);
  return 0;
}

if (process.argv[1]?.endsWith("release-identity.mjs")) {
  process.exit(await main(process.argv));
}
