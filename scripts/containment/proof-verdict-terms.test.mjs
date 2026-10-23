// CONTAINMENT (slot 9) — PROOF=PASS must mean what its own sentence says.
//
// `assess_containment()` used to judge six things and print several others. `systemctl show -p User -p
// NoNewPrivileges … -p InaccessiblePaths -p RestrictNamespaces` was a DISPLAY: nothing consumed it, so a unit
// with `User=root` and an empty `InaccessiblePaths=` printed CONTAINMENT=PASS and PROOF=PASS. So did a slot
// that could rewrite /home/deploy/.ssh/authorized_keys, and so did a run where the cross-uid /proc probe never
// ran at all (`pgrep -u deploy` found nothing -> `shoslot_can_read_deploy_environ=skipped`).
//
// Two rules are pinned here:
//   1. the sandbox properties are TERMS, read from render_unit() so they cannot drift into a second copy;
//   2. every line the script prints is a term, an `INFO` line that says why it cannot be one, or a header.
//
// Offline and macOS-safe: the real script runs against a temp-dir sandbox, with `systemctl`/`pgrep` answered
// by proof-sandbox.mjs. No host, no root, no sudo, no systemd, no ssh, no /etc/sho.
import assert from "node:assert/strict";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { containmentLines, pgrepBody, systemctlBody } from "./proof-sandbox.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const PROOF = join(here, "slot9-proof.sh");
const OPTIONR = join(here, "slot9-optionR.sh");
const LIB = join(here, "lib", "unit-env-sources.sh");
const SCAN = join(here, "lib", "prod-marker-scan.sh");
const MARKERS = "defaultdb|doadmin|25061|sho-prod-pool";

// ---------------------------------------------------------------------------
// The required values, read out of the script so a test can compare them with render_unit().
// ---------------------------------------------------------------------------
const proofSrc = () => readFileSync(PROOF, "utf8");
const requiredTable = () => {
  const m = /^readonly SANDBOX_REQUIRED='([^']*)'$/m.exec(proofSrc());
  assert.ok(m, "slot9-proof.sh must declare a single readonly SANDBOX_REQUIRED table");
  return m[1].split("\n").map((l) => l.trim()).filter(Boolean);
};

// render_unit() is a heredoc in slot9-optionR.sh. Extract JUST the function (never run the script: it
// installs things) and ask it to render with the variables it expands.
function renderedUnit() {
  const src = readFileSync(OPTIONR, "utf8");
  const start = src.indexOf("render_unit() {");
  assert.ok(start > 0, "render_unit() is not in slot9-optionR.sh");
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, "render_unit() has no closing brace");
  const fn = src.slice(start, end + 2);
  const res = spawnSync("bash", ["-c", [
    fn,
    "SLOT_PORT=3109 ACCOUNT=shoslot",
    "CURRENT_DIR=/home/shoslot/pr9/current ENV_DIR=/home/shoslot/pr9/env",
    "SLOT_ROOT=/home/shoslot/pr9",
    "render_unit",
  ].join("\n")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(res.status, 0, `render_unit() did not render:\n${res.stderr}`);
  return res.stdout;
}


// ---------------------------------------------------------------------------
// The sandbox.
// ---------------------------------------------------------------------------
function unitText({ slot, shoDir, overrides = {} } = {}) {
  const sources = [
    `${slot}/env/db.env`,
    `${slot}/env/app.env`,
    `${slot}/env/local.env`,
    `${slot}/current/release.env`,
  ];
  const lines = ["[Unit]", "Description=sandbox", "", "[Service]"];
  sources.forEach((p, i) => lines.push(`EnvironmentFile=${i < 2 ? "" : "-"}${p}`));
  sources.forEach((p) => lines.push(
    `ExecStartPre=/bin/sh -c 'test ! -e ${p} || { test -r ${p} && ! grep -qEi -- "${MARKERS}" ${p}; }'`,
  ));
  for (const line of containmentLines({ shoDir })) {
    const prop = line.slice(0, line.indexOf("="));
    // `overrides` is how a broken host is expressed: { User: "root" }, { InaccessiblePaths: "" }, …
    lines.push(prop in overrides ? `${prop}=${overrides[prop]}` : line);
  }
  return `${lines.join("\n")}\n`;
}

function build({
  overrides = {}, running = true, deployPid = true, authKeysWritable = false, prodEnvReadable = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sho-terms-"));
  for (const sub of ["slot/env", "slot/current", "sho", "deploy/.ssh", "lib", "unitdir", "bin", "proc"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  copyFileSync(SCAN, join(dir, "lib", "prod-marker-scan.sh"));
  copyFileSync(LIB, join(dir, "lib", "unit-env-sources.sh"));
  const slot = join(dir, "slot");
  const shoDir = join(dir, "sho");
  writeFileSync(join(shoDir, "app.env"), "DATABASE_URL=postgres://sho@127.0.0.1:5432/sho_staging\n");
  writeFileSync(join(shoDir, "app.env.bak-20261019-115253"), "NODE_ENV=production\n");
  writeFileSync(join(dir, "deploy", ".ssh", "authorized_keys"), "ssh-ed25519 AAAA sandbox\n");
  writeFileSync(join(slot, "env", "db.env"), "DATABASE_URL=postgres://sho@127.0.0.1:5432/sho_staging\n");
  writeFileSync(join(slot, "env", "app.env"), "NODE_ENV=production\n");
  writeFileSync(join(slot, "env", "extra.env"), "NODE_ENV=production\n");
  writeFileSync(join(dir, "unitdir", "sho-pr9.service"), unitText({ slot, shoDir, overrides }));

  const pids = [];
  const sleeper = () => {
    const s = spawnSync("bash", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
    pids.push(s.stdout.trim());
    return s.stdout.trim();
  };
  let pid = "";
  if (running) {
    pid = sleeper();
    mkdirSync(join(dir, "proc", pid), { recursive: true });
    writeFileSync(
      join(dir, "proc", pid, "environ"),
      "NODE_ENV=production\0DATABASE_URL=postgres://sho@127.0.0.1:5432/x\0",
    );
  }
  const deploy = deployPid ? sleeper() : "";

  const stub = (name, body) => {
    writeFileSync(join(dir, "bin", name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, "bin", name), 0o755);
  };
  stub("systemctl", systemctlBody({ unitFile: join(dir, "unitdir", "sho-pr9.service"), mainPid: pid }));
  stub("ss", `echo "LISTEN 0 511 127.0.0.1:3109 0.0.0.0:*"`);
  stub("curl", `for a in "$@"; do [ "$a" = "-o" ] && { printf 200; exit 0; }; done\nprintf '{"ok":true,"release":"deadbeef"}'`);
  stub("pgrep", pgrepBody(deploy));

  // as_slot: 0 = the probe SUCCEEDED (the slot could do it), 1 = denied. This is the script's own contract.
  const prodEnv = join(shoDir, "app.env");
  const authKeys = join(dir, "deploy", ".ssh", "authorized_keys");
  const asSlot = [
    'as_slot() { case "$*" in',
    '  "test -e /") echo 0 ;;',
    `  "test -r ${prodEnv}") echo ${prodEnvReadable ? 0 : 1} ;;`,
    `  "test -w ${authKeys}") echo ${authKeysWritable ? 0 : 1} ;;`,
    "  *) echo 1 ;;",
    "esac; }",
  ].join("\n");

  const patched = proofSrc()
    .replaceAll("/etc/systemd/system/", `${dir}/unitdir/`)
    .replaceAll("/home/shoslot/pr9", slot)
    .replaceAll("/home/deploy", `${dir}/deploy`)
    .replaceAll("/etc/sho", shoDir)
    .replaceAll("/proc/", `${dir}/proc/`)
    .replaceAll('$(id -u "$SLOT_ACCOUNT")', "9001")
    .replace(/^\[ "\$\(id -u\)" -eq 0 \].*$/m, '[ -n "$FAKE_ROOT" ] || fail "needs root"')
    .replace(/^\[ "\$\(uname -s\)" = 'Linux' \].*$/m, ":")
    .replace(/^id -u "\$SLOT_ACCOUNT".*$/m, ":")
    .replace(/^as_slot\(\).*$/m, () => asSlot);
  writeFileSync(join(dir, "proof.sh"), patched);

  const run = (...args) => {
    const res = spawnSync("bash", [join(dir, "proof.sh"), ...args], {
      encoding: "utf8",
      env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: process.env.HOME, FAKE_ROOT: "1" },
    });
    for (const p of pids) { try { process.kill(Number(p)); } catch { /* already gone is fine */ } }
    return res;
  };
  return { dir, run };
}

const verdict = (stdout) => /^CONTAINMENT=(PASS|FAIL)\b/m.exec(stdout)?.[1] ?? "(no CONTAINMENT line)";
const failedTerms = (stdout) =>
  (/^containment_terms_failed=(.*)$/m.exec(stdout)?.[1] ?? "(no containment_terms_failed line)").trim();

// ---------------------------------------------------------------------------
// 1. The required values are render_unit()'s values, not a second copy that can drift.
// ---------------------------------------------------------------------------
test("each required sandbox value is the one render_unit() renders", () => {
  const table = requiredTable();
  assert.ok(table.length >= 7, `expected at least 7 required properties, got ${JSON.stringify(table)}`);
  const unit = renderedUnit();
  for (const entry of table) {
    const contains = entry.startsWith("~");
    const body = contains ? entry.slice(1) : entry;
    const prop = body.slice(0, body.indexOf("="));
    const want = body.slice(body.indexOf("=") + 1);
    const line = unit.split("\n").find((l) => l.startsWith(`${prop}=`));
    assert.ok(line, `render_unit() does not set ${prop}, but slot9-proof.sh requires it`);
    assert.equal(line, `${prop}=${want}`,
      `slot9-proof.sh requires ${prop}=${want}, render_unit() writes ${line} - the two drifted apart`);
  }
});

// ---------------------------------------------------------------------------
// 2. The receipt that matters: a User=root unit must not print PASS.
// ---------------------------------------------------------------------------
test("User=root fails the pre-start gate and names the term", () => {
  const res = build({ running: false, overrides: { User: "root" } }).run("--pre-start");
  assert.equal(res.status, 1, `a root-owned slot was authorised:\n${res.stdout}\n${res.stderr}`);
  assert.equal(verdict(res.stdout), "FAIL", res.stdout);
  assert.match(res.stdout, /sandbox_User=root/, "the measured value must be printed, not assumed");
  assert.match(failedTerms(res.stdout), /sandbox_User/);
});

test("User=root fails the full run too (PROOF=FAIL, not just CONTAINMENT=)", () => {
  const res = build({ overrides: { User: "root" } }).run();
  assert.equal(res.status, 1, `a root-owned slot produced a proof:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /PROOF=FAIL/);
  assert.doesNotMatch(res.stdout, /PROOF=PASS/);
});

test("User=deploy fails: uid separation needs a third account, not the deployer's", () => {
  const res = build({ running: false, overrides: { User: "deploy" } }).run("--pre-start");
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(failedTerms(res.stdout), /sandbox_User/);
});

// ---------------------------------------------------------------------------
// 3. Every containment property is a term.
// ---------------------------------------------------------------------------
const BROKEN = [
  ["InaccessiblePaths", "", "the direct control for the credential path"],
  ["NoNewPrivileges", "no", "setuid paths survive"],
  ["ProtectSystem", "full", "/etc/sho stays writable"],
  ["ProtectHome", "yes", "/home/deploy stays visible"],
  ["PrivateTmp", "no", "shared tmp with the deployer"],
  ["RestrictNamespaces", "no", "the namespaces render_unit() closes"],
];

for (const [prop, value, why] of BROKEN) {
  test(`${prop}=${value || "(empty)"} fails the gate and names sandbox_${prop} (${why})`, () => {
    const res = build({ running: false, overrides: { [prop]: value } }).run("--pre-start");
    assert.equal(res.status, 1, `${prop}=${value} passed the gate:\n${res.stdout}\n${res.stderr}`);
    assert.equal(verdict(res.stdout), "FAIL", res.stdout);
    assert.match(res.stdout, new RegExp(`^sandbox_${prop}=`, "m"), "the term must be printed");
    assert.match(failedTerms(res.stdout), new RegExp(`sandbox_${prop}`), res.stdout);
  });
}

test("InaccessiblePaths that does not name /etc/sho fails even when it names something else", () => {
  const res = build({ running: false, overrides: { InaccessiblePaths: "/srv/other" } }).run("--pre-start");
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(failedTerms(res.stdout), /sandbox_InaccessiblePaths/);
});

// ---------------------------------------------------------------------------
// 4. SSH persistence is a term, not a line printed next to terms.
// ---------------------------------------------------------------------------
test("a slot that can write the deployer's authorized_keys fails the gate", () => {
  const res = build({ running: false, authKeysWritable: true }).run("--pre-start");
  assert.equal(res.status, 1, `a writable authorized_keys did not fail the gate:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /shoslot_can_write_authorized_keys=0/, "0 = the slot COULD write it");
  assert.match(failedTerms(res.stdout), /shoslot_can_write_authorized_keys/);
});

// ---------------------------------------------------------------------------
// 5. An unrun probe is not a denial: no deploy-owned process -> FAIL, not a skip.
// ---------------------------------------------------------------------------
test("no deploy-owned process prints not_probeable and FAILS the verdict by default", () => {
  const res = build({ running: false, deployPid: false }).run("--pre-start");
  assert.equal(res.status, 1, `an unmeasured probe earned a PASS:\n${res.stdout}\n${res.stderr}`);
  assert.equal(verdict(res.stdout), "FAIL", res.stdout);
  assert.match(res.stdout, /^deploy_environ_probe=not_probeable\b/m);
  assert.match(failedTerms(res.stdout), /deploy_environ_unproven/);
  assert.match(res.stdout, /INFO .*remedy/i, "the failure must say how to make the probe possible");
});

test("--accept-unproven is the documented opt-in: PASS says unproven=deploy_environ", () => {
  const res = build({ running: false, deployPid: false }).run("--pre-start", "--accept-unproven");
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /^CONTAINMENT=PASS unproven=deploy_environ\b/m);
});

test("a probeable deploy process is measured, and a denial is the passing answer", () => {
  const res = build({ running: false }).run("--pre-start");
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /^deploy_environ_probe=probeable\b/m);
  assert.match(res.stdout, /shoslot_can_read_deploy_environ=1/, "1 = denied");
});

// ---------------------------------------------------------------------------
// 6. The harness is not failing everything.
// ---------------------------------------------------------------------------
test("the clean sandbox still PASSES both gates", () => {
  const gate = build({ running: false }).run("--pre-start");
  assert.equal(gate.status, 0, `the pre-start gate failed a correct host:\n${gate.stdout}\n${gate.stderr}`);
  assert.match(gate.stdout, /^CONTAINMENT=PASS\b/m);
  assert.doesNotMatch(gate.stdout, /unproven=/, "nothing was unproven on this run");

  const full = build().run();
  assert.equal(full.status, 0, `the full proof failed a correct host:\n${full.stdout}\n${full.stderr}`);
  assert.match(full.stdout, /^CONTAINMENT=PASS\b/m);
  assert.match(full.stdout, /PROOF=PASS/);
  assert.match(full.stdout, /^containment_terms_failed=none$/m);
});

// ---------------------------------------------------------------------------
// 7. THE OUTPUT RULE: no unlabelled line that looks like a result.
// ---------------------------------------------------------------------------
const HEADERS = [
  "== P1  THE gap-closing proof: uid separation denies the credential ==",
  "== P2  runtime identity, and the SHAPE of its environment (counts and key names only) ==",
  "== P3  the sandbox is applied by the SYSTEM manager, asserted property by property (contrast :250-253) ==",
  "== P4  the unit cannot silently regain the production env; the slot answers ==",
  "== P5  DB identity unchanged and still slot-only (booleans; the DSN is never printed) ==",
  "== VERDICT ==",
  "== VERDICT (pre-start containment gate; P2/P5/listener/health not applicable to a stopped unit) ==",
];

// Every name the script may put in front of `=`. A new term has to be added here on purpose — that is the
// rule, not an obstacle to it.
const TERMS = new Set([
  "probe_positive_control", "shoslot_can_read_prod_env", "shoslot_can_traverse_deploy_home",
  "prod_env_bak_count", "shoslot_can_read_prod_env_bak", "deploy_environ_probe",
  "shoslot_can_read_deploy_environ", "shoslot_can_write_authorized_keys",
  "prod_env_exists", "prod_env_bak_probe_exists",
  "environ_readable", "environ_key_count", "environ_prod_marker_count",
  "listen_on_3109_count", "health_http_code", "release_sha",
  "sandbox_User", "sandbox_NoNewPrivileges", "sandbox_ProtectSystem", "sandbox_ProtectHome",
  "sandbox_PrivateTmp", "sandbox_InaccessiblePaths", "sandbox_RestrictNamespaces", "sandbox_terms_judged",
  "unit_envfile_count", "existing", "outside_slot", "unreadable", "unguarded", "prod_markers", "env_guard",
  "containment_terms_failed", "proof_terms_failed", "gap_closed",
]);

test("every printed line is a term, an INFO line with a reason, a header, or a verdict", () => {
  const stdouts = [
    build({ running: false }).run("--pre-start").stdout,
    build().run().stdout,
  ];
  const offenders = [];
  let checked = 0;
  for (const out of stdouts) {
    for (const raw of out.split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (line === "") continue;
      checked += 1;
      if (HEADERS.includes(line)) continue;
      if (line.startsWith("INFO ")) {
        // The rule is not "prefix it INFO and move on": the prefix must carry the reason.
        assert.match(line, /not a verdict term|not probeable|remedy|accept-unproven/i,
          `an INFO line must say why it is not a term:\n  ${line}`);
        continue;
      }
      if (/^(CONTAINMENT|PROOF)=(PASS|FAIL)\b/.test(line)) continue;
      // A term line: name=value, optionally repeated, optionally followed by ONE trailing parenthetical.
      const body = line.replace(/\s+\([^()]*\)$/, "");
      const keys = [...body.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]);
      assert.ok(keys.length > 0 && /^[a-z][A-Za-z0-9_]*=/.test(body),
        `unlabelled line (no term name, no INFO prefix): ${JSON.stringify(raw)}`);
      for (const key of keys) {
        if (!TERMS.has(key)) offenders.push(`${JSON.stringify(key)} in ${JSON.stringify(raw)}`);
      }
    }
  }
  assert.ok(checked > 40, `expected a substantial transcript, checked only ${checked} lines`);
  assert.deepEqual(offenders, [], `unlabelled result lines:\n${offenders.join("\n")}`);
});

