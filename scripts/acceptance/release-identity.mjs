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
// once. This module is that answer with no kernel to refuse. It decides nothing new: the three
// rules and the comparison are the gate's, and release-identity.test.mjs runs the gate's
// production_precondition beside this probe on the same directories so the two cannot drift.
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
//
// EXIT  0 the tree is the release (and, with --url, it names itself)
//       1 not the release / health disagreed / the server could not be reached
//       2 usage
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const ENTRY = "server.js";

/** The build id a completed `next build` left here, or "" when there is none. */
export function buildIdOf(root) {
  const file = path.join(root, ".next", "BUILD_ID");
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").replace(/\s+/g, "");
}

/**
 * null when `root` is a release, else the gate's reason code — the same three checks in the
 * same order as production_precondition, so a disagreement is a bug in one of them.
 */
export function identityProblem(root) {
  if (!existsSync(path.join(root, ENTRY))) return "missing-production-entry";
  if (!buildIdOf(root)) return "missing-build-id";
  if (existsSync(path.join(root, ".next", "dev"))) return "dev-artifacts-present";
  return null;
}

/**
 * The gate's release_matches rule (linux-drain-gate.sh:202): equal, or a short SHA on one side
 * that is a prefix of the other, both at least 7 characters. Case-insensitive. Never empty.
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
  process.stderr.write("usage: release-identity.mjs <dir> [<release>] [--url http://127.0.0.1:PORT]\n");
}

async function main(argv) {
  const args = argv.slice(2);
  let root = "";
  let expected = "";
  let url = "";

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
