# ACCEPTANCE-2689-RUNBOOK — the Linux drain acceptance, in the order it can actually be run

**STATUS: NOT-RUN.** Written on darwin, in an isolated worktree (`/tmp/w2-w227`, branch
`pool/w5t-2689-runbook`), by reading the shipped scripts. No ssh, no host, no staging, no
production, no `app.env`. Every command below is quoted from a script in this repo with its
line number. Steps marked **[ran here]** were executed on this darwin worktree and their real
output is quoted verbatim; steps marked **[not run]** are Linux-only and were **not** executed —
they are evidenced by the code path that produces their output line.

It replaces, for an operator, the pair `RUN-2689-ON-LINUX.md` + `UNBLOCK-2689.md`: the first is
not on this branch, the second is not in this repository at all (see §6).

---

## 0. What a stranger is actually handed

| document the packet names | where it really is | at HEAD? | what it contains |
|---|---|---|---|
| `RUN-2689-ON-LINUX.md` (the commands) | `scripts/acceptance/RUN-2689-ON-LINUX.md` @ `f40c974`, branch `pool/w3e-linux-runner` | **NO** — `git merge-base --is-ancestor f40c974 HEAD` is false | one bash block: 7 steps (0, a–f), `SRC`/`REL`/`OUTDIR`/`SHA`/`DATABASE_URL` |
| — (the commands, as shipped) | `scripts/acceptance/linux-drain-gate-runbook.md` (added `21574c2`, 52 lines) | yes | **one** command, a threat table, LIMITS. No preconditions, no cwd, no ordering |
| `UNBLOCK-2689.md` (the preconditions) | **nowhere** | — | no file with that name in any of the 400 most recent commits on all refs; `grep -ril unblock` reaches only `tests/e2e/stories/APL-2541.spec.ts` and `src/lib/activity-text.ts` (unrelated prose) |

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
| 13 | a build root whose `.next/BUILD_ID` exists and which has no `.next/dev` | `GATE_BUILD_ROOT` mode only (`gate.sh:683-687,429-457`) | **produced** by step 7, if the root is reused | yes (step b) | no |
| 14 | `.next/SHO_RELEASE` naming the sha | **nothing reads it** | **MISSING** — the old block writes it and claims the gate requires it; `grep -rn SHO_RELEASE scripts/ src/` returns nothing | wrongly stated | — |
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

### Step 1 — prove the shell is clean enough to run the gate at all
- **Precondition:** none (this is step 1 because everything else is decided after it).
- **Command:** `env -u BASH_ENV -u ENV bash scripts/acceptance/linux-drain-gate.sh --explain`
- **Expected:** the block headed `SHO-2689 Linux drain gate — conditions (ALL required, on EVERY run)`, no `GATE=` line at all; exit `0`.
- **If it fails:** `GATE=REFUSED reason=environment-hook` (exit 3, `gate.sh:130`) means your shell exports `BASH_ENV`/`ENV` with a `DEBUG` trap; the gate refuses because such a trap can repoint the kernel markers. Re-run under a shell with no such file (`env -i` plus an explicit `PATH`).
- **[ran here]** on darwin: `explain rc=0`, first line `SHO-2689 Linux drain gate — conditions (ALL required, on EVERY run)`.
- **Why this step exists:** `--explain` and an unknown option are decided **before** the kernel check (`gate.sh:753-768`), so this is the one command that works on any kernel and shows the file loaded.

### Step 2 — the kernel must answer Linux, and the refusal must not happen
- **Precondition:** step 1 exit 0.
- **Command:** `bash scripts/acceptance/linux-drain-gate.sh --production 0000000000000000000000000000000000000000`
- **Expected on a Linux host:** **not** a refusal — it walks on to `GATE=FAIL release-head-mismatch` or `missing-database-url` (both cheap, neither builds). Exit 1.
- **Expected on anything else:** `GATE=REFUSED reason=not-linux` + `marker=/proc/sys/kernel/ostype uname=<kernel> arch=<arch>` + `no burst was run: …`, exit 3 (`gate.sh:242-246,778-781`). **Stop here**: nothing else in this runbook can produce a receipt. This is a refusal, not a failure of the code.
- **[ran here]** on darwin: `production rc=3`, first line `GATE=REFUSED reason=not-linux`, `marker=/proc/sys/kernel/ostype uname=Darwin arch=arm64`.
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
- **Command:**
  ```sh
  DATABASE_URL="$DATABASE_URL" ./scripts/acceptance/linux-drain-gate.sh --production "$SHA"
  ```
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
- **Do not write `.next/SHO_RELEASE`.** The old block does (its step b) and says "the gate refuses a build root without it"; this gate has no such check — `grep -rn SHO_RELEASE scripts/ src/` is empty. Writing it changes nothing, and trusting it means trusting a check that does not exist.

### Step 8 — the receipt, or it is not a receipt
- **Precondition:** step 6 or 7 printed `GATE=PASS`.
- **Command (run on the saved transcript, not instead of it):**
  ```sh
  last="$(tail -n 1 gate.log)"
  printf '%s\n' "$last"
  test "$last" = "GATE=PASS runs=5 n=100 release=$SHA entry=server.js" && echo receipt-shape-ok
  grep -c '^RUN ' gate.log        # must be 5
  grep -c '^GATE=PASS ' gate.log  # must be 1
  ```
- **Expected:** the PASS line exactly, then `receipt-shape-ok`, `5`, `1`.
- **If it fails:** it is a transcript, not acceptance. Rename it (`*.NOT-ACCEPTANCE.log`) rather than filing it.
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
