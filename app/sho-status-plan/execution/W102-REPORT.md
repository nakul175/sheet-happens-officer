# W102 — INDEPENDENT RED-TEAM of the containment gate split

Scope: head of this worktree `7dd3581` (before my commits) — `scripts/containment/slot9-proof.sh` and everything it
sources (`lib/unit-env-sources.sh`, `lib/prod-marker-scan.sh`), `scripts/acceptance/linux-drain-gate.sh`,
`scripts/containment/check-phase2-shape.sh`, and their `*.test.mjs`.
Environment: this worktree only, offline, darwin arm64, node v24.21.0. No ssh, no host, no `/etc/sho`, no secret
read or printed; the dev server on 3254 was not needed. I formed the verdict from the code and my own runs before
opening CONTAINMENT-RUNBOOK.md, and trusted no commit subject.

Method: read the scripts, then ran the REAL script through the repo's own temp-dir sandbox (copy the script,
redirect host paths + the root/Linux preconditions into a temp dir, answer `systemctl`/`pgrep`/`ss`/`curl` from
`scripts/containment/proof-sandbox.mjs`) — the technique `proof-gates.test.mjs:52-125` already uses.

## Verdicts

| Claim | Verdict | Basis |
|---|---|---|
| C1 `PRESTART=PASS` cannot be produced on a slot that is not actually contained | **BROKEN** | F1: a production-env copy whose name misses the `app.env.bak*` glob is counted by nothing and probed by nothing, so a slot that CAN read the production env prints `CONTAINMENT=PASS`. |
| C2 `PROOF=PASS` needs every control its sentence names (unit sandbox, SSH persistence, cross-uid probe) to have been observed | **BROKEN at head; SOUND after `dcdcb80`**, with one designed escape hatch (F3) | F2 reproduced and fixed; the cross-uid probe and the 7 sandbox properties were already terms and their tests hold. |
| C3 `GATE=PASS` for SHO-2689 only from a built production release, never `next dev` | **SOUND** | Refused on darwin in two independent places; the only `GATE=PASS` emitter sits inside `production_run`, whose preconditions reject no-`BUILD_ID`, no-`server.js`, `.next/dev`. F4 is a residual, not a receipt hole. |

## Findings

**F1 — HIGH, C1 broken. `slot9-proof.sh:255-259`.** The stale copies are COUNTED by `find /etc/sho -name
'app.env.bak*'` and probed at ONE hard-coded path (`app.env.bak-20261019-115253`). A copy under any other name
(`app.env.old`, `release.env.2026`) is invisible to both. The gate's own doctrine (`:18`, `:84-88`) is "a denial
alone proves nothing — EXISTS and DENIED are separate, PASS needs both"; here neither is asked.
Command: `node --test scripts/containment/proof-vacuity.test.mjs` (my case 3). Verbatim, failing on head and still
failing after my two fixes:

```
✖ a readable stale copy named app.env.old is neither counted nor probed, so the gate passes anyway
  prod_env_bak_count=1 shoslot_can_read_prod_env_bak=1   (required 1 = denied; probe_exists=1)
  CONTAINMENT=PASS  the slot cannot reach the production env while the unit is stopped; it may be started.
```

Deliberately not repaired: closing it is a policy (which copies count — the glob, the one probe path, or every
env-shaped file under `/etc/sho`), not a one-line fix. This is this packet's one deliberate red test.

**F2 — HIGH, C2 broken at head, FIXED in `dcdcb80`. `slot9-proof.sh:285-290`.** `shoslot_can_write_authorized_keys`
read `as_slot test -w <path>`, which answers "denied" (1) for a path that does not exist, so a host with no
`authorized_keys` printed the PASSING value; an `INFO` line admitted the denial was vacuous, and `INFO` is not a
term — the verdict still said PASS. Exactly the vacuity its header forbids for `app.env`. Verbatim (head):

```
✖ no authorized_keys to write: the pre-start gate must not PASS on an unmeasured SSH control
  shoslot_can_write_authorized_keys=1   (required 1 = denied; authkeys_exists=0)
  INFO authorized_keys is absent on this host - not a verdict term here: ...
  containment_terms_failed=none
  CONTAINMENT=PASS  the slot cannot reach the production env while the unit is stopped; it may be started.
  0 !== 1
```

and the full run on the same sandbox printed `PROOF=PASS  slot 9 runtime cannot read the production env, and the
slot is healthy.` Fix: `authorized_keys_absent` is now a term (`:293-295`).

**F3 — MEDIUM. `:66-71`, `:228-230`, `:275-280`: `--accept-unproven` turns an unrun cross-uid probe into
`CONTAINMENT/PROOF=PASS unproven=deploy_environ`.** It is printed, not silent, and
`proof-verdict-terms.test.mjs:265` pins the wording — so a designed opt-out, not an accident. But C2 says PASS
"cannot be produced unless every control … was really observed", and under this flag it can. Suggest requiring a
printed reason and refusing the flag when a deploy-owned process exists but only the read failed.


**F4 — LOW. `linux-drain-gate.sh:157-175`: `gate_verdict()` takes the kernel as its FIRST ARGUMENT**, so anything
that sources the file can print the GATE=PASS text on any host:
`bash -c '. scripts/acceptance/linux-drain-gate.sh; gate_verdict Linux production true; echo " rc=$?"'` → `PASS rc=0`.
No receipt path does this (`main` computes the kernel at `:530` and refuses first), so it constrains callers and
future tests only. The darwin refusal itself holds, verbatim:

```
$ bash scripts/acceptance/linux-drain-gate.sh deadbeef ; echo exit=$?
GATE=REFUSED reason=not-linux
kernel=Darwin arch=arm64
no burst was run: the drain needs the Linux-only C handler and libc seize (src/lib/shutdown.ts:205,246).
on Darwin every leg can only print "graceful shutdown: drain timed out" and exit 1, so a pass here would be invented.
exit=3
```

`--dev <sha>` prints the same refusal (exit 3): the kernel branch precedes the mode dispatch, as `:527-538` claims.
No env override exists for the kernel (it is computed from `uname`, never read from the environment), and no flag
reaches `production_run` without that branch.

**F5 — MEDIUM (print-only), reproduced and FIXED in `dcdcb80`. `slot9-proof.sh:374-375`.** `listen_on_3109_count=`
was printed with its own `(expect >=1)` and no term read it, so a host without `iproute2` (`ss` absent — normal on
a slim image) printed `0` and reached `PROOF=PASS`. Verbatim (head):

```
✖ a listener count of 0 (ss absent) violates the line's own expect >=1 and must fail the proof
  listen_on_3109_count=0   (expect >=1)
  proof_terms_failed=none
  gap_closed=1
  PROOF=PASS  slot 9 runtime cannot read the production env, and the slot is healthy.
```

Fix: a `case` at `:428-434` fails `listen_on_3109_count` when the count is `<1`, unset or non-numeric.

**F6 — MEDIUM (print-only), reported not fixed. `slot9-proof.sh:378-381`.** `release_sha=` is printed as evidence
and no term reads it. The PROOF=PASS sentence does not name the release, so `release_sha=unknown` — what `next
dev` answers, since `src/app/api/health/route.ts:10` returns `process.env.RELEASE`, unset outside a build — still
yields `PROOF=PASS`. The proof therefore cannot tell a built release from a dev server on 3109; that distinction
lives only in the drain gate (C3). Making it a term changes the proof's contract, so it is reported, not changed.

**F7 — LOW, informational. `:244` (`slot_uid/deploy_uid/uids_differ`) and `:250-252` (`deploy_home_exists`) are
printed and asserted by nothing.** The first is correctly labelled INFO (the term is `sandbox_User`). The second is
not a term either: on a host with no `/home/deploy` the traverse probe "passes" for the wrong reason. After F2's fix
that host fails the `authorized_keys` term, so it is caught indirectly.

## Attack list, item by item

1. **Print-only controls** — F5 and F6 are printed-with-no-assertion, with `file:line`; F7 informational. Every
   `sandbox_*`, `shoslot_can_read_*`, `environ_*`, `health_http_code` and `unit_env*` line does have an assertion
   behind it in `assess_containment` (`:183-236`) / `:414-434`.
2. **Manufacture a pass** — succeeded three times on head (F2 authkeys-absent → CONTAINMENT=PASS **and**
   PROOF=PASS; F5 listener-0 → PROOF=PASS; F1 stale copy → CONTAINMENT=PASS). The other fixtures do NOT pass, and
   that is behavioural, not textual: a missing prod env fails `prod_env_exists` (`:186-190`); a fifth unguarded
   out-of-tree `EnvironmentFile` fails `unguarded`/`outside_slot` via `lib/unit-env-sources.sh`; a vanished
   `/proc/<pid>/environ` fails `environ_readable`/`environ_key_count` (`:414-420`); an unrun probe fails
   `deploy_environ_unproven` (`:228-230`).
3. **Ordering** — no marker exists to forge: `grep -rn 'PRESTART|prestart' scripts/` finds only `slot9-proof.sh`
   and one test, so nothing writes or reads a receipt, and `slot9-optionR.sh:381-392` starts the unit (`R6`)
   without consulting one (it only prints `NEXT: … slot9-proof.sh` at `:405`). The rule "no candidate until
   PRESTART=PASS" is therefore **procedural only** — a candidate can be started with no gate run and nothing
   detects it. What saves the receipt is structural: the full run recomputes `assess_containment` in-process
   (`:406`) and prints `CONTAINMENT=` before `gap_closed=`/`PROOF=`, so a post-start PASS cannot be minted from a
   pre-start PASS that was never true. Short-circuiting fails closed: `--pre-start` exits before P2/health/release
   (`:359-370`), and the full run aborts `exit 2` with no verdict when `MainPID` is absent (`:298`).
4. **Platform substitution** — refusal holds at `main` (exit 3, both modes) and at `gate_verdict`; no env override;
   no flag path skips it. Residual F4 only.
5. **Phase-2 checker** — genuinely read-only: no `chmod`/`mkdir`/`rm`/`touch`/redirect anywhere in
   `check-phase2-shape.sh` (only the promise at `:47`), and `phase2-shape.test.mjs` has a test asserting it changes
   no file in the tree. It cannot report OK on a violating tree for the dimensions it covers — its 16 tests show
   marker, mode, owner/gid, allow/deny key lists, `current/` and `server.js` symlink escapes, port and DSN shape
   each failing when violated. It cannot say WHO wrote a file or WHEN (`:51`), and that stays unproven.


## 6. Tests that grade the scripts

Proxy count over `^test(` blocks (behavioural = block contains `spawnSync(` or `.run(`):

```
ci-gate.test.mjs               behavioural=0  string_only=5
containment-scripts.test.mjs   behavioural=8  string_only=11
phase2-shape.test.mjs          behavioural=0  string_only=15   (all 16 DO run it: shared run() at :84)
proof-gates.test.mjs           behavioural=9  string_only=0
proof-vacuity.test.mjs (mine)  behavioural=4  string_only=0
proof-verdict-terms.test.mjs   behavioural=9  string_only=1
unit-env-sources.test.mjs      behavioural=1  string_only=10
w59-privilege-scope.test.mjs   behavioural=0  string_only=5
linux-drain-gate.test.mjs      behavioural=4  string_only=18   (the rest go through run() at :26 / bash -c)
```

Corrected by hand for the two shared-helper files: **string-only ≈ 32 of ~92** (ci-gate 5 — workflow YAML by
nature; containment-scripts 11; w59-privilege-scope 5; unit-env-sources 10; proof-verdict-terms 1). Everything else
executes the real shell. **The load-bearing claims do have behavioural coverage** — the pre-start/post-start split,
the sandbox property terms, the unrun-probe FAIL, the darwin refusal, `--dev` never PASS, the release
preconditions — and that is exactly how F2 and F5 were found: the behavioural sandboxes existed but every one of
them *wrote* an `authorized_keys` and *answered* `ss`, so neither vacuity was reachable. F1/F2/F5 are coverage
gaps, not string-grading failures.

## What stays unproven without a Linux root host (NOT-VERIFIABLE-HERE)

| Claim | Why it cannot be verified here |
|---|---|
| `sandbox_*` is what systemd really renders for `sho-pr9` | the sandbox answers `systemctl show` from a stub; live-manager drift is untested |
| the cross-uid `/proc/<pid>/environ` denial between `shoslot` and `deploy` | needs two real uids and a live deploy-owned process |
| real `sudo -n -u shoslot` semantics, or sudoers rules that make a probe "denied" for the wrong reason | needs the host's sudoers |
| `pgrep -u deploy -n` picks a process whose environ matters | needs the real process table |
| F1's blast radius: which stale copies exist in `/etc/sho` and which `shoslot` can read | needs the host (§4 mentions 18 copies; I could see none) |
| `curl /api/health` answering 200 with a release | needs the running slot |
| C3 end to end: `GATE=PASS` from a real `next build` on Linux | needs Linux; on darwin every leg can only time out |
| the phase-2 checker against a real tree owned by uid 1000 | needs chown |

## What I changed, and why

* **`f73fa3d`** — new `scripts/containment/proof-vacuity.test.mjs` (5 tests): reproduces F1, F2 and F5
  behaviourally, plus a control asserting the clean sandbox still passes both gates.
* **`dcdcb80`** — the fix, two terms, nothing removed: `:285-295` `authorized_keys_absent` is now a term (the
  `INFO` that admitted the vacuity is gone); `:428-434` `listen_on_3109_count` is a term (`<1`, unset or
  non-numeric). It also fixes my own test helper `failedTerms()`, which read the first `*_terms_failed=` line (the
  pre-start answer) and so hid the post-start term — a real trap for anyone grepping these transcripts.
  Neither change makes F1 disappear, and I did not touch product code beyond those two terms.

## Verbatim runs

Head, my test file only, before any fix (4 tests at that point):

```
✖ no authorized_keys to write: the pre-start gate must not PASS on an unmeasured SSH control (1034.386625ms)
✖ no authorized_keys to write: the full run must not print PROOF=PASS either (1093.115708ms)
✖ a listener count of 0 (ss absent) violates the line's own expect >=1 and must fail the proof (1080.184625ms)
✔ the clean sandbox still PASSES both gates (the two probes above are the only difference) (1974.186791ms)
ℹ tests 4
ℹ pass 1
ℹ fail 3
```

Head, the whole containment tier before my file: `ℹ tests 87`, `EXIT=0`.

After both commits — `node --test 'scripts/containment/*.test.mjs'`, the command
`.github/workflows/containment.yml:73` uses:

```
ℹ tests 92
ℹ pass 90
ℹ fail 1
ℹ todo 1
EXIT=1
```

The single failure is F1, this packet's deliberate red; the `todo 1` is the pre-existing
`unit-env-sources.test.mjs:273` continuation-semantics todo, not mine.

## Gaps in this review, honestly

* Nothing ran on a Linux host: the above is code reading plus offline sandboxes.
* `slot9-optionR.sh` was read only for its ordering role (whether R6 consults a pre-start receipt), not audited
  step by step — it is outside this packet's subject list.
* I did not try to defeat `prod-marker-scan.sh` beyond what `containment-scripts.test.mjs` already covers
  (symlinks, marker case).
* The string-only/behavioural split is a heuristic, corrected by hand for the two files using a shared `run()`.

STATUS: DONE - dcdcb80
