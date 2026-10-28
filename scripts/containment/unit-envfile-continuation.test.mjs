// CONTAINMENT (slot 9) — the `EnvironmentFile` backslash-continuation limit, measured offline.
//
// `unit-env-sources.test.mjs:271-285` carries this suite's one TODO: "systemd EnvironmentFile continuation
// semantics are unmeasured here". This file answers the part of that question that is answerable without
// systemd, against the SHIPPED text rather than a hand-copied guard:
//
//   A. systemd's documented rules (systemd.exec(5), `EnvironmentFile=`; systemd.syntax(7)), quoted:
//        "A line ending with a backslash will be continued to the following one, with the newline itself
//         discarded."                                            (env FILE contents)
//        "Lines ending in a backslash are concatenated with the following line while reading and the
//         backslash is replaced by a space character. This may be used to wrap long lines."   (unit FILE)
//      Neither rule is EXECUTED here: no systemd, no host, no root. Test 2 applies them as a reference
//      implementation to the fixture only, so "the fixture really does hide a marker" is measured, while
//      "systemd joins it" stays documented, not measured.
//
//   B. Whatever systemd does with a continuation, the two gates that read env-file CONTENT are line-based
//      `grep -E`: they cannot see a marker that only exists after the join. Tests 1 and 3 measure that on
//      R4's own rendered guard lines and on the shipped scanner.
//
//   C. The unit-file half ("a continued EnvironmentFile= could load a source the enumeration does not
//      count") is closable offline: the enumeration counts one entry per directive line
//      (lib/unit-env-sources.sh:143), and every continuation shape leaves the counted path carrying a
//      trailing backslash or a space-joined value, which the lib then reports UNGUARDED/OUTSIDE — so the
//      gate fails closed instead of undercounting. Test 4 measures that with the real lib.
//
// Nothing here touches the staging host, root, systemd, sudoers or a real env file, and no env VALUE is
// written into any fixture: every value below is a synthetic DSN that exists only to carry a marker.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const OPTION_R = join(here, "slot9-optionR.sh");
const LIB = join(here, "lib", "unit-env-sources.sh");
const SCAN = join(here, "lib", "prod-marker-scan.sh");

const MARKERS = /defaultdb|doadmin|25061|sho-prod-pool/i;

// R4's rendering, without root and without writes (`--check`): the guard text these tests attack is the
// text the runbook installs, so a drift in the rendering shows up here.
function rendered() {
  const res = spawnSync("bash", [OPTION_R, "--check"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  assert.equal(res.status, 0, `--check must plan without root: ${res.stderr}`);
  return res.stdout.split("\n");
}

const guardValues = () => rendered()
  .filter((l) => l.startsWith("ExecStartPre="))
  .map((l) => l.slice("ExecStartPre=".length));

// Point one shipped guard at a fixture file: same bytes, same marker list, every slot path rewritten, so
// each of the four guards really evaluates the file (a guard whose path is absent exits 0 for the wrong
// reason, which is how a harness passes everything).
const SLOT_PATHS = [
  "/home/shoslot/pr9/env/db.env",
  "/home/shoslot/pr9/env/app.env",
  "/home/shoslot/pr9/env/local.env",
  "/home/shoslot/pr9/current/release.env",
];
const retarget = (guard, to) => SLOT_PATHS.reduce((g, from) => g.split(from).join(to), guard);

function runGuard(guard) {
  return spawnSync("bash", ["-c", guard], { encoding: "utf8" });
}

const tmp = () => mkdtempSync(join(tmpdir(), "sho-envfile-cont-"));

// A value whose marker exists ONLY after the join: every physical line is marker-free on its own, so a
// line-based grep cannot match it. (The fixture in the existing TODO does not have this property — see
// test 6 — and a fixture that already carries a marker proves nothing about continuations.)
const SPLIT = [
  "DATABASE_URL=postgres://doad\\", "min@db:250\\", "61/defaul\\", "tdb",
  "SLOT_DSN=postgres://u@h/db?pool=sho-prod-\\", "pool",
];

const PLAIN = "DATABASE_URL=postgres://doadmin@db:25061/defaultdb\n";

// ---------------------------------------------------------------------------
// 1. The shipped guard is blind to a continued marker, and not blind to a plain one.
// ---------------------------------------------------------------------------
test("guard: R4's shipped ExecStartPre lines cannot see a marker split by a backslash continuation", () => {
  const dir = tmp();
  const clean = join(dir, "clean.env");
  writeFileSync(clean, "NODE_ENV=production\n");
  const split = join(dir, "split.env");
  writeFileSync(split, SPLIT.join("\n"));
  const plain = join(dir, "plain.env");
  writeFileSync(plain, PLAIN);

  const guards = guardValues();
  assert.equal(guards.length, 4, "R4 renders one guard per env source");

  // Controls: the harness is not passing everything. A clean file passes; a same-line marker is caught.
  for (const g of guards.map((x) => retarget(x, clean))) {
    assert.equal(runGuard(g).status, 0, `a clean env must pass the guard: ${g}`);
  }
  for (const g of guards.map((x) => retarget(x, plain))) {
    assert.notEqual(runGuard(g).status, 0, `a same-line marker must be caught: ${g}`);
  }

  // The claim under test: the continued form passes the SAME guard bytes.
  for (const g of guards.map((x) => retarget(x, split))) {
    assert.equal(
      runGuard(g).status, 0,
      `a continued marker must NOT be seen by the line-based guard; it was: ${g}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The premise, as a reference implementation of the documented rule (not as systemd).
// ---------------------------------------------------------------------------
test("documented rule: the split fixture is marker-free per line and marker-bearing once continued", () => {
  const text = SPLIT.join("\n");
  for (const line of text.split("\n")) {
    assert.doesNotMatch(line, MARKERS, `no physical line may carry a marker on its own: ${line}`);
  }
  // systemd.exec(5): "A line ending with a backslash will be continued to the following one, with the
  // newline itself discarded." Applied here as a reference implementation over the fixture only.
  const joined = text.replace(/\\\n/g, "");
  assert.match(joined, /doadmin/, "the joined value must carry the first marker");
  assert.match(joined, /25061/, "the joined value must carry the port marker");
  assert.match(joined, /defaultdb/, "the joined value must carry the db marker");
  assert.match(joined, /sho-prod-pool/, "the joined value must carry the pool marker");
  assert.match(joined, /^DATABASE_URL=postgres:\/\/doadmin@db:25061\/defaultdb$/m, "one variable, four lines");
});

// ---------------------------------------------------------------------------
// 3. The shipped scanner agrees with the guard: it is line-based too.
// ---------------------------------------------------------------------------
test("scan: the shipped marker scanner also reports a continued marker as ENV_CLEAN", () => {
  const dir = tmp();
  mkdirSync(join(dir, "env"), { recursive: true });
  writeFileSync(join(dir, "env", "db.env"), SPLIT.join("\n"));
  const res = spawnSync("bash", [SCAN, join(dir, "env")], { encoding: "utf8" });
  assert.equal(res.status, 0, `a continued marker must scan clean (that is the defect): ${res.stdout}`);
  assert.match(res.stdout, /^PROD_MARKER_COUNT=0$/m);
  assert.match(res.stdout, /^ENV_CLEAN$/m);
  assert.doesNotMatch(res.stdout + res.stderr, /doadmin|25061|defaultdb|sho-prod-pool/, "counts only");

  // Control: the same scanner does catch the marker on one line, so the clean result above is the join.
  writeFileSync(join(dir, "env", "db.env"), PLAIN);
  const caught = spawnSync("bash", [SCAN, join(dir, "env")], { encoding: "utf8" });
  assert.notEqual(caught.status, 0, "a same-line marker must not scan clean");
  assert.match(caught.stdout, /^PROD_MARKER_COUNT=1$/m);
});

// ---------------------------------------------------------------------------
// 4. The unit-file half: a continuation cannot hide a source from the enumeration.
// ---------------------------------------------------------------------------
function unitWith(slot, extra) {
  return [
    "[Unit]", "Description=sandbox", "",
    "[Service]",
    `EnvironmentFile=${slot}/env/db.env`,
    `EnvironmentFile=${slot}/env/app.env`,
    `EnvironmentFile=-${slot}/env/local.env`,
    `EnvironmentFile=-${slot}/current/release.env`,
    ...extra,
    "",
  ].join("\n");
}

function libRun(unitFile, roots) {
  return spawnSync("bash", ["-c", `source "${LIB}"; unit_env_sources "$@"`, "bash", unitFile, ...roots], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}

const counts = (stdout) => Object.fromEntries(
  stdout.split("\n")
    .map((l) => /^UNIT_(\w+)=(\d+)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], Number(m[2])]),
);

test("enumeration: every continuation shape in the unit file fails closed instead of undercounting", () => {
  const dir = tmp();
  for (const sub of ["slot/env", "slot/current", "outside"]) mkdirSync(join(dir, sub), { recursive: true });
  const slot = join(dir, "slot");
  const outside = join(dir, "outside", "app.env");
  writeFileSync(outside, "NODE_ENV=production\n");
  const roots = [`${slot}/env`, `${slot}/current`];

  // Two shapes: a continuation that tries to append a second path to one directive, and the naive
  // "second directive on the continuation line". systemd's own parser pushes exactly one entry per
  // EnvironmentFile= directive (src/core/load-fragment.c, config_parse_unit_env_file: one `strv_push`),
  // so neither shape can make systemd load more files than there are directive lines.
  const shapes = [
    ["one directive, continued value", [`EnvironmentFile=-${slot}/env/local.env \\`, `  ${outside}`]],
    ["second directive on the continuation line", [
      `EnvironmentFile=-${slot}/env/local.env \\`,
      `EnvironmentFile=${outside}`,
    ]],
  ];

  shapes.forEach(([name, extra], i) => {
    const text = unitWith(slot, extra);
    const unit = join(dir, `unit-${i}.service`);
    writeFileSync(unit, text);
    const res = libRun(unit, roots);
    const c = counts(res.stdout);
    const directives = text.split("\n").filter((l) => l.startsWith("EnvironmentFile=")).length;
    assert.equal(c.ENVFILE_COUNT, directives, `${name}: one counted entry per directive line\n${res.stdout}`);
    // R4's own refusal case is the tuple `outside:unguarded:unreadable:markers` (slot9-optionR.sh:330).
    const tuple = `${c.ENV_OUTSIDE}:${c.ENV_UNGUARDED}:${c.ENV_UNREADABLE}:${c.ENV_PROD}`;
    assert.notEqual(tuple, "0:0:0:0", `${name}: a continued source must not look clean\n${res.stdout}`);
    assert.ok(
      c.ENV_UNGUARDED >= 1 || c.ENV_OUTSIDE >= 1,
      `${name}: the continuation must leave the source unguarded or outside\n${res.stdout}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Why the unit-file shape needs a hand-edit: R4's bytes contain no continuation at all.
// ---------------------------------------------------------------------------
test("R4: the rendered unit has no continuation, and the install is 0644 root:root", () => {
  const lines = rendered();
  const start = lines.findIndex((l) => /^----- \/etc\/systemd\/system\/.+\.service -----$/.test(l));
  assert.ok(start >= 0, "the plan must print the unit block");
  const end = lines.findIndex((l, i) => i > start && l.startsWith("----- "));
  const unit = lines.slice(start + 1, end > start ? end : undefined);
  assert.ok(unit.some((l) => l.startsWith("EnvironmentFile=")), "the unit block must be the unit");
  for (const line of unit) {
    assert.doesNotMatch(line, /\\\s*$/, `R4 must not emit a backslash continuation: ${line}`);
  }
  const shipped = readFileSync(OPTION_R, "utf8");
  assert.match(
    shipped,
    /^install -m 0644 -o root -g root "\$unit_tmp" "\$UNIT_PATH"$/m,
    "the unit must be installed 0644 root:root, so a continuation in it is a root hand-edit",
  );
});

// ---------------------------------------------------------------------------
// 6. The existing TODO does not measure its own claim — recorded so the count is not read as coverage.
// ---------------------------------------------------------------------------
test("the existing TODO fixture keeps `defaultdb` on one line, so its guard assertion is satisfied by a catch", () => {
  // unit-env-sources.test.mjs:279 writes "DATABASE_URL=...2506\\\n1/defaultdb\n" — line 2 still contains
  // `defaultdb`, so the guard exits 1 and `assert.notEqual(guardFor(split).status, 0)` holds: the TODO's
  // body is green because the marker WAS caught, which is the opposite of its title.
  const dir = tmp();
  const legacy = join(dir, "legacy-split.env");
  writeFileSync(legacy, "DATABASE_URL=postgres://u:p@db:2506\\\n1/defaultdb\n");
  const lines = readFileSync(legacy, "utf8").split("\n");
  assert.ok(lines.some((l) => MARKERS.test(l)), "the legacy fixture must carry a marker on one line");
  const guard = `test ! -e "${legacy}" || { test -r "${legacy}" && ! grep -qEi -- "defaultdb|doadmin|25061|sho-prod-pool" "${legacy}"; }`;
  assert.notEqual(
    runGuard(guard).status, 0,
    "the guard catches the legacy fixture, so the TODO is green for the wrong reason",
  );
});
