# ACCEPTANCE-2689-RUNBOOK — the Linux drain acceptance, in the order it can actually be run

**STATUS: NOT-RUN.** Written on darwin, in an isolated worktree (`/tmp/w2-w227`, branch
`pool/w5t-2689-runbook`), by reading the shipped scripts. No ssh, no host, no staging, no
production, no `app.env`. Every command below is quoted from a script in this repo with its
line number. Steps marked **[ran here]** were executed on this darwin worktree and their real
output is quoted verbatim; steps marked **[not run]** are Linux-only and were **not** executed —
they are evidenced by the code path that produces their output line.

**REVIEWED, FOUND WRONG, CORRECTED (W250 → W262).** W250 read this document as a stranger with a
root shell and returned **RUNBOOK-WRONG-AT step 8 (cannot execute) and step 1 (false expected
output)**, with three secondary findings. Each was reproduced against the shipped scripts and is
closed here; the corrected expected lines are quoted from the gate's own `printf`, and the ones
marked **[ran here, W262]** were produced by a real run on this darwin worktree. What changed:

| finding | where it was | what it is now |
|---|---|---|
| **C1** step 1 said "no `GATE=` line at all" | was `:71-74` | `--explain` really prints **15** lines containing `GATE=`. The check is now the anchored `grep -c '^GATE='` → `0`, and the 15 is explained rather than denied |
| **C1b** (found while re-verifying C1) the corrected check exited **1** on success | new here | `grep -c` exits 1 when it counts 0, so the block now ends `grep -c '^GATE=' … \|\| true`; a pass ends `rc=0` |
| **C2** step 8 read `gate.log`, which no step writes | was `:163-174` | step 6 now `tee`s the run into `$LOG`; step 8 reads `$LOG`, tests it exists, and never invents a filename |
| **C3** §1 row 13 named step 7 as the *producer* of the build root | was `:50` | step 7 only consumes `GATE_BUILD_ROOT` (`gate.sh:683-687`); the cell now says so and names the alternative |
| **C4** `UNBLOCK-2689.md` was "nowhere" | was `:21` | it is 274 lines at `app/sho-status-plan/execution/UNBLOCK-2689.md`, beside the repo. It holds the authorisation precondition, so there is now a **step 0** |
| **C5** the quoted `grep -rn SHO_RELEASE scripts/ src/` was said to be empty | was `:51`, `:161` | it returns 2 hits — both in this runbook. The quoted command is now the explicit file list, which returns 0 |

Nothing else in the document changed. The acceptance statement (§4) is untouched: **only a real
Linux run with a built release is acceptance; nothing offline substitutes.**

It replaces, for an operator, the pair `RUN-2689-ON-LINUX.md` + `UNBLOCK-2689.md`: the first is
not on this branch, the second is not in this repository at all, but it does exist — beside the repo,
not inside it (§0, and the source is named in step 0).

---

## 0. What a stranger is actually handed

| document the packet names | where it really is | at HEAD? | what it contains |
|---|---|---|---|
| `RUN-2689-ON-LINUX.md` (the commands) | `scripts/acceptance/RUN-2689-ON-LINUX.md` @ `f40c974`, branch `pool/w3e-linux-runner` | **NO** — `git merge-base --is-ancestor f40c974 HEAD` is false | one bash block: 7 steps (0, a–f), `SRC`/`REL`/`OUTDIR`/`SHA`/`DATABASE_URL` |
| — (the commands, as shipped) | `scripts/acceptance/linux-drain-gate-runbook.md` (added `21574c2`, 52 lines) | yes | **one** command, a threat table, LIMITS. No preconditions, no cwd, no ordering |
| `UNBLOCK-2689.md` (the preconditions) | **outside this repository**: `app/sho-status-plan/execution/UNBLOCK-2689.md` (274 lines, 21 051 B — verified present) | not applicable — it lives *beside* the repo, so `git log` cannot see it | the authority to run: which host, whose account, on whose decision (now **step 0**) |

So the procedure a root shell needs exists in two halves that do **not** meet: at HEAD there is
one 52-line operator page with a single command and no prerequisites, and the only document that
ever spelled out the prerequisites is an unmerged branch. The precondition table below is
therefore reconstructed from the gate's own checks (`scripts/acceptance/linux-drain-gate.sh`),
from `scripts/drain-burst.mjs`, and from the old block — each row says which.

---

## 1. Every prerequisite, and who produces it

"Produced" = an earlier step in this runbook creates it. "Host" = must already be true before
step 1 and nothing here creates it. "MISSING" = needed by a step, stated by no document.

| # | prerequisite | needed by | origin | stated by the old block? | stated by the HEAD page? |
|---|---|---|---|---|---|
| 1 | a Linux kernel with readable `/proc/sys/kernel/ostype` **and** `/proc/version` | everything (`gate.sh:204-205,777`) | **host** | yes (step 0, `uname -s`) | yes, as prose ("a real Linux kernel") |
| 2 | a shell with **no** `BASH_ENV`/`ENV` debug trap | load, before any step (`gate.sh:120,142,751`) | **host** | no | no |
| 3 | a checkout of the code, at **exactly** the release sha, clean | `gate.sh:816-822` | **host** (clone/checkout) | yes (step a) | **no** |
| 4 | `node_modules/` installed in that checkout (`next/dist/bin/next`, `tsx`) | build (`gate.sh:494,511,513`), entry (`drain-burst.mjs:100`) | **host** (`npm ci`; `package.json:20 postinstall: prisma generate`) | implicitly (`cp -al node_modules`) | no |
| 5 | `DATABASE_URL`, non-empty, reachable from the host | `gate.sh:808`; build may prerender with it (`gate.sh:517`) | **host** | yes (exported) | only as `postgresql://…` in the command |
| 6 | `git` on PATH, and a `.git` in the checkout | `gate.sh:816` | **host** | yes | no |
| 7 | `tar`, `cp`, `mktemp`, `sed`, `grep`, `tr`, `cut`, `rm` | `gate.sh:479,494,827,442,386` | **host** | no | no |
| 8 | free space for a full source copy + one `next build` (node_modules is hardlinked, ~900 MB not copied) | build (`gate.sh:470-503`) | **host** | no | no |
| 9 | loopback bind + a free ephemeral port (the burst picks its own; nothing pins 3210) | `drain-burst.mjs:53-65` | **host** | **wrong**: the block exports `PORT` (step 0), unused by the gate | no |
| 10 | `curl` | old block step (c) only | **host** | yes | no (not needed at HEAD's flow) |
| 11 | the release sha, 40 lowercase hex | positional arg (`gate.sh:759-766`) | **host** (a decision, from the release) | yes (`SHA`) | as `<sha>`, length not stated |
| 12 | `GATE_RUNS=5` for the receipt the documents describe | `gate.sh:156` | **host** (env) | yes (`GATE_RUNS=5`) | no |
| 13 | a build root whose `.next/BUILD_ID` exists and which has no `.next/dev` | `GATE_BUILD_ROOT` mode only (`gate.sh:683-687,429-457`) | **produced by nothing in this document.** Step 7 only *consumes* an already-built root — `if [ -n "${GATE_BUILD_ROOT:-}" ]` then `app="$GATE_BUILD_ROOT"` (`gate.sh:683-684`). Build it outside this sequence, or skip step 7 and let step 6 build its own copy into `$TMP/app` (`gate.sh:690-693`) | yes (step b) | no |
| 14 | `.next/SHO_RELEASE` naming the sha | **nothing reads it** | **MISSING** — the old block writes it and claims the gate requires it; `grep -rn SHO_RELEASE scripts/acceptance/linux-drain-gate.sh scripts/acceptance/release-identity.mjs scripts/drain-burst.mjs src/` returns nothing (0 hits, measured). The bare `scripts/ src/` form returns 2 hits — both inside this runbook, which is why the quoted command names its files | wrongly stated | — |
| 15 | `uname -a` of the host, captured in the receipt | the receipt rule | **host** | yes (step 0, step f) | no |

---

## 2. The sequence

Run every step **from the root of the checkout** (`cd /srv/sho-src` or wherever the release is
checked out). The gate itself does not care about your cwd — it derives `ROOT` from
`BASH_SOURCE` (`gate.sh:159`) — but the *invocation path is relative*, so any other cwd is
"no such file". Nothing in either document says this.

`SHA` below is a shell variable holding the full 40-character release sha. Set it once:

```sh
SHA=<full 40-char release sha>       # not abbreviated: see step 8
```

### Step 0 — the authority to run at all
- **Precondition:** none. This is the step that can cancel the session, so it is step 0.
- **Command:** get a written yes/no to the one question no script in this repo asks — *may the gate
  run on a disposable Linux host that is **not** the staging host, with its own throwaway database?*
  — and then, on the host that answer names:
  ```sh
  uname -s -m
  ```
- **Expected:** a host name, an account, and `Linux x86_64` (or `aarch64`). Nothing in steps 1–8
  creates this. The gate never reads `EUID` and cannot tell an authorised host from a frozen one.
- **If it fails:** **stop.** Staging is stopped under a containment instruction; this runbook does
  not clear it, and the gate would not print a single line to warn you. `GATE=REFUSED
  reason=not-linux` (step 2) is the *cheap* wrong answer; running candidate code on the containment
  host is the expensive one.
- **Source:** the requirement is not in this repository. It is in
  `app/sho-status-plan/execution/UNBLOCK-2689.md` §1/§4 — beside the repo, which is why `git log`
  cannot find it.

### Step 1 — prove the shell is clean enough to run the gate at all
- **Precondition:** none (this is step 1 because everything else is decided after it).
- **Command:**
  ```sh
  env -u BASH_ENV -u ENV bash scripts/acceptance/linux-drain-gate.sh --explain >/tmp/sho-explain.txt 2>&1; echo "explain rc=$?"
  head -1 /tmp/sho-explain.txt
  grep -c '^GATE=' /tmp/sho-explain.txt || true   # must print 0 (grep exits 1 when it counts nothing)
  ```
- **Expected:** `explain rc=0`, then `SHO-2689 Linux drain gate — conditions (ALL required, on EVERY run)`, then `0`.
- **The `|| true` is load-bearing.** `grep -c` exits **1** whenever the count is `0`, so without it the
  last command of a *correct* step 1 returns non-zero and a `set -e` shell aborts here — the same
  class of defect as the old expected line: the harness reports failure on success.
  **[ran here, W262]**: the block prints `explain rc=0`, the heading, `0`, and ends `rc=0`.
- **Do not grep for `GATE=` unanchored.** `--explain` is a heredoc (`gate.sh:283-333`) that *documents*
  the verdicts, so `grep -c 'GATE='` answers **15** on a correct run — one of them the template
  `GATE=PASS runs=5 n=100 release=<sha-under-test> entry=server.js` (`gate.sh:314`). Only the anchored
  count is 0, because every verdict the gate really prints starts in column 1:
  `printf 'GATE=PASS runs=%s n=%s release=%s entry=%s\n'` (`gate.sh:704`),
  `printf 'GATE=REFUSED reason=not-linux\n'` (`gate.sh:242`).
- **If it fails:** `GATE=REFUSED reason=environment-hook` (exit 3, `gate.sh:130`) means your shell
  exports `BASH_ENV`/`ENV` or carries a `DEBUG` trap; the gate refuses at load (`gate.sh:142`),
  before `--explain` runs at all, because such a trap can repoint the kernel markers. Re-run under a
  shell with no such file (`env -i` plus an explicit `PATH`).
- **[ran here, W262]** on darwin, verbatim: `explain rc=0`;
  `SHO-2689 Linux drain gate — conditions (ALL required, on EVERY run)`; unanchored `grep -c 'GATE='` → `15`; anchored `grep -c '^GATE='` → `0`.
- **[ran here, W262]** the failure action, verbatim: with `BASH_ENV` pointing at a file containing
  `trap "" DEBUG`, the same command prints `GATE=REFUSED reason=environment-hook`,
  `BASH_ENV=set ENV= debug-trap=set`, and exits `3` — before a single explain line.
- **Why this step exists:** `--explain` and an unknown option are decided **before** the kernel check (`gate.sh:753-768`), so this is the one command that works on any kernel and shows the file loaded.

### Step 2 — the kernel must answer Linux, and the refusal must not happen
- **Precondition:** step 1 exit 0.
- **Command:** `bash scripts/acceptance/linux-drain-gate.sh --production 0000000000000000000000000000000000000000`
- **Expected on a Linux host:** **not** a refusal — it walks on to `GATE=FAIL release-head-mismatch` or `missing-database-url` (both cheap, neither builds). Exit 1.
- **Expected on anything else:** `GATE=REFUSED reason=not-linux` + `marker=/proc/sys/kernel/ostype uname=<kernel> arch=<arch>` + `no burst was run: …`, exit 3 (`gate.sh:242-246,778-781`). **Stop here**: nothing else in this runbook can produce a receipt. This is a refusal, not a failure of the code.
- **[ran here, W262]** on darwin, verbatim — the whole refusal, four lines, from
  `printf 'GATE=REFUSED reason=not-linux\n'` (`gate.sh:242`), `printf 'marker=%s uname=%s arch=%s\n'`
  (`gate.sh:243`) and the two explanation lines (`gate.sh:244-245`):
  ```
  GATE=REFUSED reason=not-linux
  marker=/proc/sys/kernel/ostype uname=Darwin arch=arm64
  no burst was run: the drain needs the Linux-only C handler and libc seize (src/lib/shutdown.ts:205,246).
  on this kernel every leg can only print "graceful shutdown: drain timed out" and exit 1, so a pass here would be invented.
  production rc=3
  ```
- **Ordering, which no document states:** with **no arguments at all** the gate still refuses **before** it complains about the missing sha — `[ran here]` `linux-drain-gate.sh` alone gave `noarg rc=3` with the refusal text, not the `missing-release-sha` usage error. An unknown flag is the opposite: `[ran here]` `--bogus` gave `bogus rc=2`, first line `GATE=FAIL unknown-option --bogus`. So the exit code says *where* the run died: 2 = argument parsing, 3 = kernel, 1 = everything after.

### Step 3 — the tree must be the release and must be clean
- **Precondition:** steps 1–2 survived.
- **Command:**
  ```sh
  git -C "$PWD" rev-parse HEAD
  git -C "$PWD" status --porcelain
  ```
- **Expected:** the first prints `$SHA` and nothing else; the second prints **nothing**.
- **If it fails:** the gate prints `GATE=FAIL release-head-mismatch (requested <sha>, HEAD is <head>)` and builds nothing (`gate.sh:818-821`). Check out the release sha, or accept that the sha you are passing belongs to a different build.
- **Failure mode neither document states:** the guard is `head="$(git … || true)"` then `if [ -n "$head" ]` (`gate.sh:816-817`). On a tree with **no `.git`** (a tarball, a copied release directory, `git` absent) that guard is **silently skipped** and nothing replaces it. On a scp'd release root you must do this check by hand — the gate will not.

### Step 4 — the dependencies are there, because the build will not fetch them
- **Precondition:** `npm ci` has run in this checkout at least once (that is also what generated the Prisma client — `package.json:20` `postinstall: prisma generate`).
- **Command:**
  ```sh
  test -f node_modules/next/dist/bin/next && test -d node_modules/tsx && echo deps-ok
  ```
- **Expected:** `deps-ok`, exit 0.
- **If it fails:** the run reaches `GATE=FAIL build-tooling-missing (<root>/node_modules/next/dist/bin/next)` (`gate.sh:513-515`) or `GATE=FAIL build-deps-failed (could not copy <checkout>/node_modules)` (`gate.sh:496-498`). Nothing downloads them: the build root is populated by hardlinking this tree's `node_modules` (`gate.sh:494`). `tsx` matters because the production entry is `node --import tsx server.js` (`deploy/cloud-init.yaml:63`, spawned at `drain-burst.mjs:100`) and `tsx` is a **devDependency** (`package.json:45`) — a `npm ci --omit=dev` checkout cannot be accepted.

### Step 5 — `DATABASE_URL` in the shell, never on the command line, never echoed
- **Precondition:** a **disposable** database you are willing to let a release read and prerender against.
- **Command (never printed by the gate):**
  ```sh
  : "${DATABASE_URL:?export DATABASE_URL first}"   # expect no output
  ```
- **Expected:** silence, exit 0.
- **If it fails:** `GATE=FAIL missing-database-url (set it in the environment; this gate never prints it)` (`gate.sh:808-811`).
- **What no step can check:** that the URL points at the database you meant. The gate echoes nothing and asserts nothing about it (`linux-drain-gate-runbook.md:45-46` says so in LIMITS), and `build_release` **inherits** it for `next build` (`gate.sh:517-518`), so a prerendering page can touch whatever it names. Point it at a throwaway DB; `missing-database-url` is the only trap there is.

### Step 6 — the run itself: one command, five protocol runs
- **Precondition:** steps 1–5 clean; `HEAD == $SHA`; `GATE_RUNS` unset (or `5`).
- **Command (the `tee` is not cosmetic — step 8 reads the file it writes):**
  ```sh
  mkdir -p /srv/sho-receipts
  LOG="/srv/sho-receipts/gate-$(git rev-parse --short HEAD)-$(date -u +%Y%m%dT%H%M%SZ).log"
  ( set -o pipefail
    DATABASE_URL="$DATABASE_URL" ./scripts/acceptance/linux-drain-gate.sh --production "$SHA" 2>&1 | tee "$LOG" )
  echo "gate rc=$? log=$LOG"
  ```
  `set -o pipefail` is inside the subshell, so it does not leak into your shell, and the subshell's
  status **is** the gate's. A bare `… | tee` reports *tee's* status, which is `0` whatever the gate
  said — **[ran here, W262]**: `false | tee` → `0`; `( set -o pipefail; false | tee )` → `1`. Keep the
  `rc=` line: it is the second half of the receipt. `LOG` must stay set in this shell for step 8.
  (`--production` is the default — `gate.sh:744` — and is accepted as a mode word at `gate.sh:756`; passing it documents intent, it is not required.)
- **Expected lines, in this order (each quoted from its emitter):**
  ```
  GATE=MODE mode=production                                              (gate.sh:824)
  RELEASE=<sha>                                                          (gate.sh:825)
  BUILD=isolated source=<checkout root> root=<tmp>/app                   (gate.sh:690)
  BUILD=ok build-id=<next build id>                                      (gate.sh:531)
  PRECONDITION=production build-id=<next build id> entry=server.js       (gate.sh:438)
  RUN 1/5 mode=production n=100 bad=[] drain=drained exit=0 late16=refused late143=refused serving=entry:server.js nodeEnv:production build:present dev:none release=<sha> sigterm=40   (gate.sh:622)
  … RUN 2/5 … RUN 5/5 …
  GATE=PASS runs=5 n=100 release=<sha> entry=server.js                   (gate.sh:704)
  ```
  The `RUN` line above is what the gate prints. The copy of it inside `--explain` (`gate.sh:313`) stops after `late143=refused` and omits `serving=`, `release=`, `sigterm=`; do not "correct" a real RUN line to match the explain text.
- **If it fails:** the last line is `GATE=FAIL <condition>`, and the condition names the step to re-check:

  | last line | what actually broke | go back to |
  |---|---|---|
  | `GATE=FAIL build-failed (log …)` (`:519`) | `next build` died; its last 25 lines are printed indented | step 4, node version, memory, DB reachable |
  | `GATE=FAIL missing-build-id (…/.next/BUILD_ID is absent…)` (`:528`) | the build produced no release | as above |
  | `GATE=FAIL dev-artifacts-present (…/.next/dev exists…)` (`:451`) | that root is a dev server | only reachable via `GATE_BUILD_ROOT` |
  | `GATE=FAIL c0-serving run=N …` (`:649`) | something other than `server.js` under `NODE_ENV=production` served | steps 4 and 6 |
  | `GATE=FAIL c0-release run=N … expected=<sha>` (`:653`) | `/api/health` echoed a release that is not the sha under test — artifact and receipt disagree | step 3, and the `RELEASE` the build got |
  | `GATE=FAIL c1-bad run=N bad=[…]` (`:625`) | a connection accepted before SIGTERM was dropped | **this is the defect SHO-2689 is about: report it, do not retry it away** |
  | `GATE=FAIL c2-drain run=N drain=absent (printed "graceful shutdown: drain timed out")` (`:631`) | the drain did not finish inside the budget | as above |
  | `GATE=FAIL c3-exit run=N exit=<n>` (`:635`) | the process exited non-zero | as above |
  | `GATE=FAIL c4-probe run=N late16=… late143=…` (`:639`) | a post-SIGTERM connection was still answered | as above |
  | `GATE=FAIL c4-signal run=N sigterm=<n>` (`:643`) | the harness did not wait 40 ms | `BURST_SIGTERM_DELAY_MS` was overridden — unset it |
  | `GATE=FAIL run-N-harness-error` (`:588`) / `run-N-unparsable` (`:617`) | the harness died or printed no JSON; its stderr is quoted | a node/cwd problem, not a drain verdict |
  | `GATE=FAIL release-head-mismatch (requested …, HEAD is …)` (`:819`) | step 3 | step 3 |
  | `GATE=FAIL mode=production release=<sha> (see the c0..c4 lines above)` (`:712`) | at least one condition above already printed | read upward |
- Run count is `$GATE_RUNS`, default 5 (`gate.sh:156`). `GATE_RUNS=1` is legal and still prints **`GATE=PASS runs=1 …`** — a PASS, but not the receipt either document describes (§4).

### Step 7 — reuse a pre-built root (optional, and only if you built it)
- **Precondition:** a directory that already holds `server.js`, a completed `.next/BUILD_ID`, and **no** `.next/dev`.
- **Command:**
  ```sh
  GATE_BUILD_ROOT=/srv/sho-release DATABASE_URL="$DATABASE_URL" ./scripts/acceptance/linux-drain-gate.sh --production "$SHA"
  ```
- **Expected:** `BUILD=reused root=/srv/sho-release` (`gate.sh:685`) where step 6 prints `BUILD=isolated …`, then the same `PRECONDITION=`, `RUN`, `GATE=PASS` lines.
- **If it fails:** `missing-production-entry` (`:445`), `missing-build-id` (`:448`), `dev-artifacts-present` (`:451`) or `release-identity-unavailable` (`:454`) — all four mean "that directory is not a release".
- **Do not write `.next/SHO_RELEASE`.** The old block does (its step b) and says "the gate refuses a build root without it"; this gate has no such check — `grep -rn SHO_RELEASE scripts/acceptance/linux-drain-gate.sh scripts/acceptance/release-identity.mjs scripts/drain-burst.mjs src/` returns nothing (0 hits, measured). Quote the file list, not `grep -rn SHO_RELEASE scripts/ src/`: that broader form returns 2 hits at HEAD, and both are this paragraph and §1 row 14 — the runbook quoting itself. Writing the marker changes nothing, and trusting it means trusting a check that does not exist.

### Step 8 — the receipt, or it is not a receipt
- **Precondition:** step 6 (or 7) printed `GATE=PASS` **and** step 6's `tee` wrote the transcript.
  No step before this one creates a file called `gate.log`; that name appeared only here, which is
  why the old version of this step died on its first line.
- **Command (run on the saved transcript, not instead of it):**
  ```sh
  : "${LOG:?set LOG to the file step 6 wrote}"
  test -s "$LOG" || { echo "no transcript at $LOG — step 6's tee did not run"; exit 1; }
  last="$(tail -n 1 "$LOG")"
  printf '%s\n' "$last"
  test "$last" = "GATE=PASS runs=5 n=100 release=$SHA entry=server.js" && echo receipt-shape-ok
  grep -c '^RUN ' "$LOG"        # must be 5
  grep -c '^GATE=PASS ' "$LOG"  # must be 1
  ```
- **Expected:** the PASS line exactly, then `receipt-shape-ok`, `5`, `1`.
  **[ran here, W262]** against a transcript shaped by the gate's own `printf` formats
  (`gate.sh:824`, `:825`, `:690`, `:531`, `:438`, `:622`, `:704`), verbatim:
  `GATE=PASS runs=5 n=100 release=0123456789abcdef0123456789abcdef01234567 entry=server.js`,
  `receipt-shape-ok`, `5`, `1`. The test string is the one the gate prints:
  `printf 'GATE=PASS runs=%s n=%s release=%s entry=%s\n' "$GATE_RUNS" "$GATE_N" "$sha" "$ENTRY"` (`gate.sh:704`).
- **If it fails:** it is a transcript, not acceptance. Rename it (`*.NOT-ACCEPTANCE.log`) rather than
  filing it. Two distinct cases, and the first line of the block tells them apart:
  - `no transcript at …` / `tail: …: No such file or directory` (rc 1) — step 6 was run without its
    `tee`, so there is nothing to file. Re-run step 6; do not reconstruct the log from scrollback.
  - the PASS line or a count is wrong — the run did not do what the receipt requires. If
    `tail -n 1` is not the PASS line but `grep -n '^GATE=PASS ' "$LOG"` shows exactly one hit *before*
    it, something wrote to the log after the gate exited: the counts still hold but the transcript is
    untidy, so re-take it with step 6 rather than editing it.
- **What the gate will *not* enforce for you:** that `$SHA` is 40 lowercase hex, and that `runs=5`. The gate prints `release=%s` with whatever string it was given (`gate.sh:704`), and the comparison rule accepts prefixes of ≥7 characters (`scripts/acceptance/release-identity.mjs:83-90`). **[ran here]**, verbatim: `--match <40hex> <40hex>` → `RELEASE-IDENTITY=match … match=yes`, rc 0; `--match <40hex> 0123456` → `… match=yes`, rc 0; `release-identity.mjs .` on an unbuilt tree → `RELEASE-IDENTITY=not-release reason=missing-build-id`, rc 1. So `GATE=PASS runs=1 n=100 release=0123456 entry=server.js` is a PASS the gate will print and **not** the receipt: the 40-character and `runs=5` requirements are the operator's, and this step is where they are checked.
- The receipt also needs the **host's own** `uname -a` next to the sha (old block step f). The gate prints neither, so capture them into the same file yourself.

---

## 3. Flag inventory — proof that each exists

Quoted from `main()` in `scripts/acceptance/linux-drain-gate.sh:753-768`:

```sh
    case "$arg" in
      --explain|-h|--help) explain; return 0 ;;
      --production) mode="production" ;;
      --dev) mode="dev" ;;
      -*) printf 'GATE=FAIL unknown-option %s\n' "$arg"; usage >&2; return 2 ;;
      *)
        if [ -n "$sha" ]; then
          printf 'GATE=FAIL too-many-arguments (%s)\n' "$arg"
```

| flag | exists? | behaviour | line |
|---|---|---|---|
| `--explain` / `-h` / `--help` | yes | prints the conditions, exit 0, **before** the kernel check | 755 |
| `--production` | yes | the default (`mode="production"`, 744) and the only mode that reaches the single `GATE=PASS` emitter (704) | 756 |
| `--dev` | yes | always ends `GATE=NOT-ACCEPTANCE mode=dev` (733), then **exit 0** if its legs held and **1** if not (`dev_run`, 734-739). The header's "4 NOT-ACCEPTANCE" is `gate_verdict`'s answer for a non-production mode (366-368), which the CLI never reaches: `main` returns `dev_run`'s status (839-841) | 757 |
| an unknown `-…` | yes, refused | `GATE=FAIL unknown-option`, exit **2** | 758 |
| the release argument | yes, **positional** | exactly one non-flag word; a second gives `too-many-arguments`, exit 2 | 759-766 |
| `--release`, `--sha`, `--root`, `--url` | **no** | no such flag on this script; typing `--sha <sha>` exits 2 | 758 |

Environment, not flags: `DATABASE_URL` (required, 808), `GATE_RUNS` (default 5, 156),
`GATE_BUILD_ROOT` (reuse a build, 683), `BURST_SIGTERM_DELAY_MS` (refused unless 40, 804).
There is **no** `PORT` read anywhere in the gate — `grep -n '\bPORT\b' scripts/acceptance/linux-drain-gate.sh`
returns nothing — and the burst picks its own free port (`drain-burst.mjs:53-65`, invoked
with `0` at `gate.sh:587`), so the `PORT` the old block exports does nothing for the acceptance.

---

## 4. What counts as a receipt (the two documents disagree; this is the stricter reading)

1. the host's own `uname -a`, and the machine it came from;
2. the **full 40-character** sha, and `runs=5`;
3. last line exactly `GATE=PASS runs=5 n=100 release=<sha> entry=server.js`;
4. five `RUN n/5 …` lines, each `bad=[] drain=drained exit=0 late16=refused late143=refused … sigterm=40`.

A `GATE=REFUSED` (exit 3), `GATE=NOT-ACCEPTANCE mode=dev` (exit 0 or 1 — the header's "4" is
`gate_verdict`'s internal answer, not what `--dev` exits with) or `GATE=FAIL` (1) transcript is not
a receipt even when the exit status looks harmless. A `--dev` run is a local look; both documents
agree on that much.

---

## 5. What still cannot be written down

- **The host itself.** Whether `/proc/sys/kernel/ostype` and `/proc/version` are readable and say
  `Linux`; whether it is amd64; whether `node`, `git`, `tar` are installed and at what versions;
  whether there is room for one build. Step 2 tests the kernel and step 4 the deps; nothing tests
  the rest.
- **The database.** Reachability, credentials, whether it is the database you think it is, what it
  contains. The gate opens no connection itself; the *server under test* does, and `next build`
  may (`gate.sh:517`).
- **Whether `next build` succeeds on that host.** Memory, CPU, node version, a prerender that
  needs the DB. Only the run says.
- **Whether the drain holds at N=100.** That is the whole question of SHO-2689; every test in
  `scripts/acceptance/` simulates the branch, and the branch is not the measurement.
- **Provenance of the transcript.** Nothing in the gate proves which machine produced it. Only the
  `uname -a` pasted next to it can, and that is an assertion, not a check.
- **Duration.** Not measured here and stated nowhere: one build plus five spawn/teardown cycles.
  Expect minutes; do not wrap it in a short timeout.
- **The host's authority.** Step 0 asks for it and no script verifies it. The gate never reads
  `EUID`, never checks a hostname and never looks for the containment instruction; a correct,
  fully-PASSing transcript from the *wrong* host is indistinguishable from a right one. That is a
  judgement the operator makes before step 1, not a line in the receipt.
- **That the receipt directory is writable.** Step 6 `mkdir -p /srv/sho-receipts` and expects `tee` to
  succeed there. Whether that path exists, is writable by the account running the gate, and survives
  the session is host state — the gate itself writes only into `mktemp -d` (`gate.sh:827-830`) and
  never checks where your copy is going.
- **That `tar`, `cp -al` and the hardlink of `node_modules` (`gate.sh:479,494`) work on that
  filesystem.** A filesystem that cannot hardlink (a bind mount with `nolinks`, some NFS setups) fails
  as `build-deps-failed`, which reads like a missing dependency and is not one.
