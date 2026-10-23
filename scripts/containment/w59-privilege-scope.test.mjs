// CONTAINMENT / w59 — PRIVILEGE SCOPE + BLAST RADIUS of the slot-9 Option R artefacts.
//
// This file is the review packet's own executable evidence. It asserts properties of
// slot9-optionR.sh / OS-IDENTITY-ISOLATION.md §5 / CONTAINMENT-RUNBOOK.md that were previously
// only *claimed* in prose, so that the claims are graded by a program rather than by a reader:
//
//   F1/F2  the sudoers rule R5 installs, rendered verbatim by the artefact itself (`--check`, no root),
//          and how much of it is bounded by a bare argument wildcard.
//   F3     what the rule does NOT grant (the part §4:290-291 gets right, so it is pinned too — a review
//          that only records defects cannot detect over-correction later).
//   F4     the runbook's exit-code contract "2 = refused a precondition (nothing changed)" against the
//          script: `fail()` is reachable *after* the first unconditional mutation.
//   F5     R7's rollback completeness: it checks the unit file, the account and the sudoers fragment, but
//          never the enable-symlink that `systemctl enable` created.
//   F6     D4's claim that a resolved binary path cannot produce an inert rule.
//
// Nothing here touches the staging host, needs root, or reads an env file. Everything is either a
// static read of the reviewed files or a run of `--check`, which the artefact guarantees writes nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const here = fileURLToPath(new URL(".", import.meta.url));
const OPTION_R = join(here, "slot9-optionR.sh");

const body = () => readFileSync(OPTION_R, "utf8");

function plan() {
  const res = spawnSync("bash", [OPTION_R, "--check"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  assert.equal(res.status, 0, `--check must succeed without root: ${res.stderr}`);
  return res.stdout;
}

function sudoersRule() {
  const rule = plan()
    .split("\n")
    .find((line) => line.startsWith("deploy ALL=(root) NOPASSWD:"));
  assert.ok(rule, "--check must render the sudoers fragment it would install");
  return rule;
}

// F1 — the grant, as the artefact renders it. A trailing `*` in a sudoers command-argument pattern is a
// shell-style wildcard over the WHOLE remaining argument string (sudoers(5)); it does not stop at the next
// flag. So `-u sho-pr9 *` and `status sho-pr9 *` pin the first two words and then accept anything.
test("W59-F1: R5's sudoers rule pins a unit name but leaves two entries open-ended with a bare wildcard", () => {
  const rule = sudoersRule();
  assert.match(rule, /systemctl status sho-pr9 \*/, "status <unit> * is open-ended");
  assert.match(rule, /journalctl -u sho-pr9 \*$/, "journalctl -u <unit> * is open-ended");
  // The exact bytes matter: this string is what a human is asked to install into /etc/sudoers.d.
  assert.equal(
    rule,
    "deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart sho-pr9, " +
      "/usr/bin/systemctl start sho-pr9, /usr/bin/systemctl status sho-pr9, " +
      "/usr/bin/systemctl status sho-pr9 *, /usr/bin/journalctl -u sho-pr9 *",
  );
});

// F2 — quantify it. Two of the five comma-separated entries end in `*`; the wildcard is copied from the
// pre-existing per-unit pattern, so this artefact would make it the tenth instance of the same defect.
test("W59-F2: two of five granted command forms are wildcard-open (measured, not asserted in prose)", () => {
  const rule = sudoersRule();
  const entries = rule.slice(rule.indexOf("NOPASSWD:") + "NOPASSWD:".length).split(",").map((s) => s.trim());
  assert.equal(entries.length, 5);
  const openEnded = entries.filter((e) => e.endsWith("*"));
  assert.deepEqual(openEnded, [
    "/usr/bin/systemctl status sho-pr9 *",
    "/usr/bin/journalctl -u sho-pr9 *",
  ]);
  assert.equal(openEnded.length, 2);
});


// F3 — what the rule does not grant. §4:290-291 claims the line is narrow: no daemon-reload, no shell, no
// `sudo -u`. That claim is true and load-bearing (a `daemon-reload` there would let deploy rewrite its own
// sandbox), so the review pins it: it must not be lost while the wildcards are being narrowed.
test("W59-F3: the rule grants no second-order power (no reload, no shell, no arbitrary-command ALL)", () => {
  const rule = sudoersRule();
  assert.doesNotMatch(rule, /daemon-reload/, "daemon-reload would let deploy reload a unit it cannot edit");
  assert.doesNotMatch(rule, /(^|[^=(])\bALL\b\s*$/, "no bare ALL command entry");
  assert.doesNotMatch(rule, /\b(bash|sh|tee|install|cp|mv|useradd|userdel|chown)\b/, "no file/system mutation tools");
  assert.match(rule, /^deploy ALL=\(root\) NOPASSWD: /, "the runner is deploy, run-as is root, no password");
});

// F4 — CONTAINMENT-RUNBOOK.md:75 says exit `2` means "refused a precondition (nothing changed)". The script
// contradicts that: only the four preconditions at :150-156 precede the first mutation (:228 `useradd` /
// :234 `install -d`). R4's own prod-env guard (:276) and every R5 guard (:286, :290, :295) call the same
// `fail`, which exits 2 — after R1/R2/R3 have already written to /etc/passwd and /home.
test("W59-F4: `fail` (exit 2) is reachable after the first mutation, so exit 2 does not mean 'nothing changed'", () => {
  const lines = body().split("\n");
  const firstMutation = lines.findIndex((l) => /^\s*(useradd|install -d) /.test(l));
  assert.ok(firstMutation > -1, "the audit must find the first mutation it reasons about");
  const lateFails = lines
    .map((l, i) => ({ i: i + 1, l }))
    .filter(({ i, l }) => i > firstMutation && /\bfail "/.test(l));
  assert.ok(lateFails.length > 0, "this pin records the defect: fail() IS called after R1/R2 in the current code");
  // Named so the report can quote them without re-reading the file.
  const described = lateFails.map(({ i, l }) => `:${i} ${l.trim()}`);
  assert.ok(
    described.some((d) => d.includes("production env file")),
    `expected the R4 prod-env refusal among ${JSON.stringify(described)}`,
  );
  assert.ok(described.length >= 4, `expected every R4/R5 refusal, got ${JSON.stringify(described)}`);
});

// F5 — rollback completeness. `systemctl enable` writes a wants symlink; only `systemctl disable` removes it.
// R7 removes UNIT_PATH directly and tolerates a failing `disable` (:172 `|| say "note: unit was not running"`),
// then reports ROLLBACK_OK from three booleans (:193-199) that do not include the symlink. A disable that
// failed therefore leaves the host enabled-for-a-unit-that-does-not-exist and still prints success.
test("W59-F5 (todo): R7 can report ROLLBACK_OK with the enable-symlink still in place", {
  todo:
    "R7 checks UNIT_PATH, the account and the sudoers fragment; it never checks " +
    "multi-user.target.wants/sho-pr9.service, and :172 treats a failed `disable` as 'was not running'. " +
    "The fix edits the artefact under review, which this packet's BOUNDARY forbids, so it is tracked here " +
    "rather than applied.",
}, () => {
  // Deliberately a boolean, not assert.match: the failure message must not dump the whole script.
  assert.ok(
    body().includes("multi-user.target.wants"),
    "R7 must verify the enable-symlink, not just the unit file",
  );
});

// F6 — the script's D4 claim: "the resolved absolute path is written into the sudoers rule, so a different
// prefix cannot produce a rule that silently does nothing" (:29-31). True for systemctl, which is asserted
// non-empty at :159. Not true for journalctl: JOURNALCTL_BIN is resolved at :160 and never checked, and
// render_sudoers (:118) falls back to `/usr/bin/journalctl` — a rule pinned to a path that may not exist,
// which sudo silently declines to match. That is exactly the failure mode D4 says it prevents.
test("W59-F6: the journalctl path is resolved but never asserted, so the rule can be silently inert", () => {
  const src = body();
  assert.match(src, /JOURNALCTL_BIN=\$\(command -v journalctl \|\| true\)/, "resolved");
  assert.doesNotMatch(src, /\[ -n "\$JOURNALCTL_BIN" \]/, "never asserted (contrast :159 for systemctl)");
  assert.match(src, /JOURNALCTL_BIN:-\/usr\/bin\/journalctl/, "falls back to an unverified absolute path");
});
