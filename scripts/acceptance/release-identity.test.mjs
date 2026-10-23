// SHO-2689 — "is this directory the release, and does it name itself?" must be answerable
// on ANY kernel, not only inside a Linux gate run.
//
// The gap this pins: scripts/acceptance/linux-drain-gate.sh answers both questions, but it
// checks the kernel in main() first and returns 3 on darwin, BEFORE production_precondition
// and before any build or burst. So on a Mac the gate's own answer — the one its receipt
// depends on — is unreachable through its CLI. scripts/acceptance/release-identity.mjs is
// that answer with no kernel to refuse: the same three precondition rules, plus the
// c0-release leg (/api/health echoes the RELEASE under test), reachable over a local port.
//
// The last test runs the gate's production_precondition next to the probe on the same
// directories, so the two cannot drift into disagreeing about what a release is.
//
// Run with: node --test "scripts/acceptance/**/*.test.mjs"
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildIdOf, check, identityProblem, releaseMatches } from "./release-identity.mjs";

const gate = fileURLToPath(new URL("./linux-drain-gate.sh", import.meta.url));
const probe = fileURLToPath(new URL("./release-identity.mjs", import.meta.url));

function tempTree() {
  const root = mkdtempSync(path.join(tmpdir(), "sho-release-"));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

// A directory that has been through `next build`: the entry, a non-empty BUILD_ID, no dev.
function builtRelease(root, id = "sRxBtLUUZRc5LUDXn1GTm") {
  mkdirSync(path.join(root, ".next"), { recursive: true });
  writeFileSync(path.join(root, "server.js"), "// entry\n");
  writeFileSync(path.join(root, ".next", "BUILD_ID"), `${id}\n`);
}

// What `next dev` leaves behind: no BUILD_ID at all, only .next/dev.
function devServer(root) {
  mkdirSync(path.join(root, ".next", "dev"), { recursive: true });
  writeFileSync(path.join(root, "server.js"), "// entry\n");
}

// ---------------------------------------------------------------- 1. the three rules

test("a built directory is the release, and it reports its own build id", () => {
  const t = tempTree();
  try {
    builtRelease(t.root);
    assert.equal(identityProblem(t.root), null);
    assert.equal(buildIdOf(t.root), "sRxBtLUUZRc5LUDXn1GTm", "the trailing newline is trimmed");
  } finally {
    t.done();
  }
});

test("a dev server's directory is not the release: it has no BUILD_ID", () => {
  const t = tempTree();
  try {
    devServer(t.root);
    assert.equal(identityProblem(t.root), "missing-build-id");
  } finally {
    t.done();
  }
});

test("a stale BUILD_ID next to .next/dev is still not the release — HTTP cannot see this, the tree can", () => {
  const t = tempTree();
  try {
    builtRelease(t.root);
    mkdirSync(path.join(t.root, ".next", "dev"), { recursive: true });
    assert.equal(identityProblem(t.root), "dev-artifacts-present");
  } finally {
    t.done();
  }
});

test("a directory without the production entry is not the release, whatever else it holds", () => {
  const t = tempTree();
  try {
    mkdirSync(path.join(t.root, ".next"), { recursive: true });
    writeFileSync(path.join(t.root, ".next", "BUILD_ID"), "abc12345");
    assert.equal(identityProblem(t.root), "missing-production-entry");
  } finally {
    t.done();
  }
});

// ---------------------------------------------------------------- 2. the release comparison

test("release_matches rule: equal, or a >=7-character prefix either way; never empty", () => {
  assert.equal(releaseMatches("d08e66abe2eb", "d08e66abe2eb"), true);
  assert.equal(releaseMatches("d08e66abe2eb", "d08e66a"), true, "short side is a prefix");
  assert.equal(releaseMatches("D08E66A", "d08e66abe2eb"), true, "case-insensitive, as the shell lowercases");
  assert.equal(releaseMatches("d08e66abe2eb", "deadbeef"), false);
  assert.equal(releaseMatches("d08e66abe2eb", null), false, "a dev server echoes null");
  assert.equal(releaseMatches("d08e66abe2eb", ""), false);
  assert.equal(releaseMatches("abc", "abcdefgh"), false, "under 7 characters is ambiguous, so it is not a match");
  assert.equal(releaseMatches("", ""), false);
});

// ---------------------------------------------------------------- 3. over HTTP: the c0-release leg

async function withServer(release, body) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body(release)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test("health echoing the release under test holds; another release, or null, fails", async () => {
  const t = tempTree();
  const must = "d08e66abe2eb";
  try {
    builtRelease(t.root, "sRxBtLUUZRc5LUDXn1GTm");

    const good = await withServer(must, (r) => ({ ok: true, release: r }));
    try {
      const got = await check(good.url, t.root, must);
      assert.equal(got.ok, true, got.lines.join("\n"));
    } finally {
      await good.close();
    }

    const wrong = await withServer("deadbeef", (r) => ({ ok: true, release: r }));
    try {
      const got = await check(wrong.url, t.root, must);
      assert.equal(got.ok, false, "a different release must not pass");
      assert.ok(got.lines.some((l) => l.includes("expected=" + must)), got.lines.join("\n"));
    } finally {
      await wrong.close();
    }

    const devish = await withServer(null, (r) => ({ ok: true, release: r }));
    try {
      assert.equal((await check(devish.url, t.root, must)).ok, false, "release null is not a release");
    } finally {
      await devish.close();
    }
  } finally {
    t.done();
  }
});

test("the tree rules still bite over HTTP: a matching health from a dev-shaped tree fails", async () => {
  const t = tempTree();
  const must = "d08e66abe2eb";
  try {
    devServer(t.root);
    const lying = await withServer(must, (r) => ({ ok: true, release: r }));
    try {
      const got = await check(lying.url, t.root, must);
      assert.equal(got.ok, false, "a dev server started with RELEASE set must not be able to pass");
      assert.ok(got.lines.some((l) => l.includes("missing-build-id")), got.lines.join("\n"));
    } finally {
      await lying.close();
    }
  } finally {
    t.done();
  }
});

// ---------------------------------------------------------------- 4. the CLI, and the gate agrees

test("the CLI exits 0 on a release and 1 with a reason on a dev tree", () => {
  const t = tempTree();
  try {
    builtRelease(t.root);
    const ok = spawnSync(process.execPath, [probe, t.root, "sRxBtLUUZRc5LUDXn1GTm"], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^RELEASE-IDENTITY=release build-id=sRxBtLUUZRc5LUDXn1GTm entry=server\.js$/m);

    const dev = mkdtempSync(path.join(t.root, "dev-"));
    devServer(dev);
    const no = spawnSync(process.execPath, [probe, dev, "sRxBtLUUZRc5LUDXn1GTm"], { encoding: "utf8" });
    assert.equal(no.status, 1, no.stdout + no.stderr);
    assert.match(no.stdout, /^RELEASE-IDENTITY=not-release reason=missing-build-id$/m);
  } finally {
    t.done();
  }
});

test("the gate's own precondition and this probe never disagree about a directory", () => {
  const t = tempTree();
  try {
    const built = path.join(t.root, "built");
    const dev = path.join(t.root, "dev");
    const stale = path.join(t.root, "stale");
    const bare = path.join(t.root, "bare");
    for (const d of [built, dev, stale, bare]) mkdirSync(d, { recursive: true });
    builtRelease(built);
    devServer(dev);
    builtRelease(stale);
    mkdirSync(path.join(stale, ".next", "dev"), { recursive: true });

    for (const dir of [built, dev, stale, bare]) {
      const out = spawnSync("bash", ["-c", 'source "$1"; production_precondition "$2"', "--", gate, dir], {
        encoding: "utf8",
      });
      const mine = identityProblem(dir);
      const theirs = out.status === 0 ? null : /GATE=FAIL ([a-z-]+)/.exec(out.stdout)?.[1];
      assert.equal(mine, theirs, `disagreement on ${path.basename(dir)}\ngate: ${out.stdout}\nmine: ${mine}`);
    }
  } finally {
    t.done();
  }
});
