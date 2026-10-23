// CONTAINMENT / slot 9 — PHASE 2 SHAPE CHECKER, attacked.
//
// PHASE2-CONTRACT.md says what phase 2 must leave on disk. These tests are what keeps that statement
// falsifiable: each one builds a throwaway slot tree in the OS temp dir and asks the real checker about it.
// Nothing here touches the staging host, systemd, root, /home/shoslot or any real env file; no credential is
// written into a fixture and no fixture value may appear in the checker's output (one test asserts that).
//
// The five the packet names are here: missing server.js, wrong mode, marker present, path outside the tree,
// and the clean case. The rest pin the parts of the contract that are easy to lose silently.
import assert from "node:assert/strict";
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const CHECK = join(here, "check-phase2-shape.sh");
const SHA = "abcdef1234567890";
// A slot DSN: loopback, 5432 (not the pooler), sho_staging, the slot's own role. Never a production host.
const SLOT_DSN = "postgresql://sho_slot_pr9_app@127.0.0.1:5432/sho_staging";

// release.env as the contract describes it. `null` omits a key, which is how the negative cases are built.
const releaseEnv = (over = {}) => {
  const lines = { RELEASE: SHA, PORT: "3109", DATABASE_URL: SLOT_DSN, ...over };
  return Object.entries(lines)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
};

// A slot tree in the shape R2/R3 leave behind, plus phase 2's two artefacts. `current` is a symlink into
// releases/<sha> exactly as the release pattern does it, so a check that only worked on a plain directory
// would be caught here.
function tree({
  serverJs = true,
  release = releaseEnv(),
  releaseMode = 0o640,
  serverMode = 0o644,
  envMode = 0o600,
  currentOutside = false,
  serverJsOutside = false,
} = {}) {
  const base = mkdtempSync(join(tmpdir(), "sho-phase2-"));
  const slot = join(base, "pr9");
  const rel = join(slot, "releases", SHA);
  const outside = join(base, "outside");
  mkdirSync(join(slot, "env"), { recursive: true });
  mkdirSync(rel, { recursive: true });
  mkdirSync(outside, { recursive: true });
  for (const name of ["db", "app", "local"]) {
    writeFileSync(join(slot, "env", `${name}.env`), `${name.toUpperCase()}_STUB=1\n`);
    chmodSync(join(slot, "env", `${name}.env`), envMode);
  }
  if (serverJs) {
    writeFileSync(join(rel, "server.js"), "// shipped by phase 2\n");
    chmodSync(join(rel, "server.js"), serverMode);
  }
  if (release !== null) {
    writeFileSync(join(rel, "release.env"), release);
    chmodSync(join(rel, "release.env"), releaseMode);
  }
  // A release directory that is clean but lives OUTSIDE the slot tree: only the path question can fail it.
  const evil = join(outside, "release");
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(evil, "server.js"), "// outside the slot tree\n");
  writeFileSync(join(evil, "release.env"), releaseEnv());
  chmodSync(join(evil, "release.env"), 0o640);
  if (serverJsOutside) {
    writeFileSync(join(outside, "clean-server.js"), "// outside the slot tree, no marker\n");
    unlinkSync(join(rel, "server.js"));
    symlinkSync(join(outside, "clean-server.js"), join(rel, "server.js"));
  }
  symlinkSync(currentOutside ? evil : `releases/${SHA}`, join(slot, "current"));
  return { base, slot, rel, outside, evil };
}

// The default expectations are the contract (release.env owned by uid 1000 = deploy, group = the slot
// group). The offline tier cannot chown, so most tests pass the current uid instead; the default is
// exercised by its own test below.
const run = (slot, args = []) => {
  const res = spawnSync("bash", [CHECK, slot, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const out = {};
  // The verdict line carries its reasons on the same line: `PHASE2_SHAPE=BROKEN reason=a,b`.
  let verdict;
  let reasons = [];
  for (const line of `${res.stdout}`.split("\n")) {
    const v = /^PHASE2_SHAPE=([A-Z]+)(?: reason=(.*))?$/.exec(line);
    if (v) {
      verdict = v[1];
      reasons = (v[2] ?? "").split(",").filter(Boolean);
      continue;
    }
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return { ...res, out, verdict, reasons };
};

const asBuilt = ["--expect-release-owner-uid", String(process.getuid())];


test("the clean case passes every shape check", () => {
  const { slot } = tree();
  const res = run(slot, asBuilt);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.verdict, "OK");
  assert.equal(res.out.SHAPE_CHECKS_FAILED, "0");
  // current/ resolves to releases/<sha> and every artefact sits inside the slot tree.
  assert.equal(res.out.CURRENT_INSIDE_TREE, "1");
  assert.equal(res.out.SERVER_JS_PRESENT, "1");
  assert.equal(res.out.SERVER_JS_INSIDE_TREE, "1");
  assert.equal(res.out.RELEASE_ENV_PRESENT, "1");
  assert.equal(res.out.RELEASE_ENV_INSIDE_TREE, "1");
  assert.equal(res.out.RELEASE_ENV_MODE, "640");
  assert.equal(res.out.RELEASE_ENV_MARKER_COUNT, "0");
  assert.equal(res.out.RELEASE_ENV_RELEASE_OK, "1");
  assert.equal(res.out.RELEASE_ENV_PORT_3109, "1");
  assert.equal(res.out.RELEASE_ENV_DSN_LOOPBACK, "1");
  assert.equal(res.out.RELEASE_ENV_DSN_PORT_5432, "1");
  assert.equal(res.out.RELEASE_ENV_DSN_SLOT_DB, "1");
  assert.equal(res.out.ENV_FILE_MISSING, "0");
  assert.equal(res.out.ENV_FILE_MODE_BAD, "0");
});

test("a missing current/server.js is ABSENT (R6's exit 4), not BROKEN", () => {
  const { slot } = tree({ serverJs: false });
  const res = run(slot, asBuilt);
  assert.equal(res.status, 1, "a missing server.js must not read as success");
  assert.equal(res.verdict, "ABSENT");
  assert.equal(res.out.SERVER_JS_PRESENT, "0");
  assert.ok(res.reasons.includes("current_server_js_missing"), res.stdout);
});

test("a world-readable release.env fails the mode check", () => {
  const { slot } = tree({ releaseMode: 0o644 });
  const res = run(slot, asBuilt);
  assert.equal(res.status, 1, res.stdout);
  assert.equal(res.verdict, "BROKEN");
  assert.equal(res.out.RELEASE_ENV_MODE, "644");
  assert.equal(res.out.RELEASE_ENV_MODE_OK, "0");
  assert.ok(res.reasons.includes("release_env_mode"), res.stdout);
});

test("a group-writable release.env fails: the slot must not be able to rewrite its own env", () => {
  const { slot } = tree({ releaseMode: 0o660 });
  const res = run(slot, asBuilt);
  assert.equal(res.status, 1, res.stdout);
  assert.equal(res.out.RELEASE_ENV_MODE_OK, "0");
});

test("0600 is refused too: the contract's shape is 0640, not merely 'safe enough'", () => {
  // 0600 would lock the slot group out of a file the unit has to load as shoslot.
  const { slot } = tree({ releaseMode: 0o600 });
  const res = run(slot, asBuilt);
  assert.equal(res.status, 1, res.stdout);
  assert.equal(res.out.RELEASE_ENV_MODE, "600");
  assert.equal(res.out.RELEASE_ENV_MODE_OK, "0");
});

test("a production marker in release.env fails, and no marker is echoed", () => {
  for (const marker of ["doadmin", "DOADMIN", "25061", "defaultdb", "sho-prod-pool"]) {
    const { slot } = tree({
      release: releaseEnv({
        DATABASE_URL: `postgresql://${marker === "25061" ? "svc" : marker}@db.example:${marker === "25061" ? "25061" : "25060"}/${marker === "defaultdb" ? "defaultdb" : "sho"}`,
      }),
    });
    const res = run(slot, asBuilt);
    assert.equal(res.status, 1, `${marker}: ${res.stdout}`);
    assert.equal(res.out.RELEASE_ENV_MARKER_COUNT, "1", `${marker} must be counted`);
    assert.ok(res.reasons.includes("release_env_marker"), res.stdout);
    // The whole point of counts: the refusal must not put the value on the terminal or into the journal.
    assert.ok(!res.stdout.toLowerCase().includes(marker.toLowerCase()), res.stdout);
    assert.ok(!res.stdout.includes("postgresql"), "the DSN must never be printed");
  }
});

test("an /etc/sho path in release.env is refused as well as the marker list", () => {
  const { slot } = tree({ release: releaseEnv({ EXTRA_SOURCE: "/etc/sho/app.env" }) });
  const res = run(slot, asBuilt);
  assert.equal(res.status, 1, res.stdout);
  assert.ok(Number(res.out.RELEASE_ENV_ETC_SHO_COUNT) >= 1, res.stdout);
  assert.ok(res.reasons.includes("release_env_etc_sho"), res.stdout);
});

test("NODE_OPTIONS in release.env is refused: an env file is data, not code", () => {
  const { slot } = tree({ release: releaseEnv({ NODE_OPTIONS: "--require /tmp/x.js" }) });
  const res = run(slot, asBuilt);
  assert.equal(res.status, 1, res.stdout);
  assert.equal(res.out.RELEASE_ENV_UNSAFE_KEY_COUNT, "1");
  assert.ok(res.reasons.includes("release_env_unsafe_key"), res.stdout);
});


test("a current/ that resolves outside the slot tree is refused", () => {
  // The release an attacker would point at is otherwise perfectly clean, so only the path question fails it.
  const { slot } = tree({ currentOutside: true });
  const res = run(slot, asBuilt);
  assert.equal(res.status, 1, res.stdout);
  assert.equal(res.out.CURRENT_PRESENT, "1");
  assert.equal(res.out.CURRENT_INSIDE_TREE, "0");
  assert.equal(res.out.RELEASE_ENV_MARKER_COUNT, "0", "no marker anywhere: this is a path refusal");
  assert.ok(res.reasons.includes("current_outside_tree"), res.stdout);
});

test("a server.js symlinked out of the slot tree is refused even with no marker anywhere", () => {
  const { slot } = tree({ serverJsOutside: true });
  const res = run(slot, asBuilt);
  assert.equal(res.status, 1, res.stdout);
  assert.equal(res.out.SERVER_JS_PRESENT, "1");
  assert.equal(res.out.SERVER_JS_INSIDE_TREE, "0");
  assert.equal(res.out.RELEASE_ENV_MARKER_COUNT, "0", "the refusal is about the path, not a marker");
  assert.ok(res.reasons.includes("server_js_outside_tree"), res.stdout);
});

test("release.env needs identity, port 3109 and a 5432 slot DSN", () => {
  const noIdentity = run(tree({ release: releaseEnv({ RELEASE: null }) }).slot, asBuilt);
  assert.equal(noIdentity.status, 1);
  assert.equal(noIdentity.out.RELEASE_ENV_RELEASE_OK, "0");
  assert.ok(noIdentity.reasons.includes("release_env_no_release_identity"), noIdentity.stdout);

  const wrongPort = run(tree({ release: releaseEnv({ PORT: "3000" }) }).slot, asBuilt);
  assert.equal(wrongPort.status, 1);
  assert.equal(wrongPort.out.RELEASE_ENV_PORT_3109, "0");
  assert.ok(wrongPort.reasons.includes("release_env_port"), wrongPort.stdout);

  const pooler = run(
    tree({ release: releaseEnv({ DATABASE_URL: "postgresql://sho_slot_pr9_app@127.0.0.1:6432/sho_staging" }) }).slot,
    asBuilt,
  );
  assert.equal(pooler.status, 1, pooler.stdout);
  assert.equal(pooler.out.RELEASE_ENV_DSN_LOOPBACK, "1");
  assert.equal(pooler.out.RELEASE_ENV_DSN_PORT_5432, "0");
  assert.ok(pooler.reasons.includes("release_env_dsn_port"), pooler.stdout);

  const wrongDb = run(
    tree({ release: releaseEnv({ DATABASE_URL: "postgresql://sho_slot_pr9_app@127.0.0.1:5432/sho" }) }).slot,
    asBuilt,
  );
  assert.equal(wrongDb.status, 1, wrongDb.stdout);
  assert.equal(wrongDb.out.RELEASE_ENV_DSN_SLOT_DB, "0");
  assert.ok(wrongDb.reasons.includes("release_env_dsn_db"), wrongDb.stdout);
});

test("phase 2 widening env/ (a group-readable db.env) is reported, not ignored", () => {
  const { slot } = tree({ envMode: 0o640 });
  const res = run(slot, asBuilt);
  assert.equal(res.status, 1, res.stdout);
  assert.equal(res.out.ENV_FILE_MODE_BAD, "3", "db, app and local are all 0640 here");
  assert.ok(res.reasons.includes("env_file_mode"), res.stdout);
});

test("the default owner expectation is deploy's uid 1000, not whoever owns the tree", (t) => {
  if (process.getuid() === 1000) {
    t.skip("the test uid is 1000; the default and the fixture would agree for the wrong reason");
    return;
  }
  const { slot } = tree();
  const res = run(slot);   // no overrides: the contract's default
  assert.equal(res.status, 1, res.stdout);
  assert.equal(res.out.RELEASE_ENV_OWNER_OK, "0");
  assert.ok(res.reasons.includes("release_env_owner"), res.stdout);
});

test("the checker is read-only: it changes no file in the slot tree", () => {
  const { slot } = tree();
  const snapshot = () => {
    const out = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        const st = lstatSync(p);
        out.push(`${p} ${st.mode} ${st.size} ${st.mtimeMs} ${st.isSymbolicLink() ? "link" : "file"}`);
        if (st.isDirectory()) walk(p);
      }
    };
    walk(slot);
    return out;
  };
  const before = snapshot();
  const res = run(slot, asBuilt);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(snapshot(), before, "the checker must not write anything into the slot it inspects");
});

test("a slot root that does not exist is BROKEN, not ABSENT", () => {
  const res = run(join(tmpdir(), "sho-phase2-does-not-exist-000"));
  assert.equal(res.status, 1, res.stdout);
  assert.equal(res.out.SLOT_ROOT_PRESENT, "0");
  assert.ok(res.reasons.includes("slot_root_missing"), res.stdout);
});

test("usage: no slot root is a usage error, not a clean verdict", () => {
  const res = spawnSync("bash", [CHECK], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage:/);
  const help = spawnSync("bash", [CHECK, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
});
