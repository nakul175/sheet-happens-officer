# PHASE 2 CONTRACT — slot 9 (`sho-pr9`), the contained slot

**Packet:** CONTAINMENT (w97). **This is a specification, not a deployment.** Nothing in this document was run
on a host; no host was contacted. **Status:** written and checkable offline.

**Why it exists.** `slot9-optionR.sh` R6 installs the unit and stops at exit 4 when
`/home/shoslot/pr9/current/server.js` is absent (`scripts/containment/slot9-optionR.sh:390-395`). That is the
designed stopping point, not a failure. Phase 2 is whatever fills it in: it ships a release, points
`current/` at it, and creates `current/release.env` — which the unit loads as its **fourth** EnvironmentFile
(`slot9-optionR.sh:103`), the only one that did not exist when R3/R4 scanned the slot, and the only one whose
content no runbook step ever inspects.

So "phase 2 shipped it" was unfalsifiable, and a wrong phase 2 can put the production env back into the slot
**without touching the unit at all**. This document says exactly what phase 2 must leave behind, and
`scripts/containment/check-phase2-shape.sh` is the falsifier.

| file | what it is |
|---|---|
| `app/sho-status-plan/execution/PHASE2-CONTRACT.md` | this specification |
| `scripts/containment/check-phase2-shape.sh` | read-only shape checker (booleans/counts only) |
| `scripts/containment/phase2-shape.test.mjs` | 16 offline tests: missing file, wrong mode, marker, outside path, clean case |

---

## 1. The shape phase 2 must leave on disk

Slot root is `/home/shoslot/pr9` (`slot9-optionR.sh:48`). `SLOT` below is that path. Modes are octal.
"Owner"/"group" name the identities the contract requires on the staging host; the checker compares numeric
uids/gids, so it needs no passwd database.

| path | type | mode | owner:group | created by | who may write it afterwards |
|---|---|---|---|---|---|
| `SLOT` | dir | 0700 | `shoslot:shoslot` | R2 (`:284`) | root only |
| `SLOT/env` | dir | 0700 | `shoslot:shoslot` | R2 | root only |
| `SLOT/env/db.env` | file | 0600 | `shoslot:shoslot` | R3 (`:295`) | **nobody but root** — phase 2 must not touch it |
| `SLOT/env/app.env` | file | 0600 | `shoslot:shoslot` | R3 | same |
| `SLOT/env/local.env` | file | 0600 | `shoslot:shoslot` | R3 | same |
| `SLOT/releases` | dir | 2770 | `shoslot:deploy` | R2 (`:285`) | `deploy` (setgid: new entries inherit group `deploy`) |
| `SLOT/releases/<sha>` | dir | 0755 | `deploy:deploy` | **phase 2** | `deploy` while shipping; never the slot |
| `SLOT/releases/<sha>/server.js` | file | 0644 | `deploy:deploy` | phase 2 | `deploy` (shipping), never the slot |
| `SLOT/current` | symlink → `releases/<sha>` | — | — | **phase 2** | `deploy`; must resolve **inside** `SLOT` |
| `SLOT/current/server.js` | file (via `current`) | 0644 | `deploy:deploy` | phase 2 | phase 2 |
| `SLOT/current/release.env` | file (via `current`) | **0640** | **`deploy:shoslot`** | **phase 2** | phase 2 only; the slot may read, never write |
| `SLOT/var`, `SLOT/log` | dirs | 0700 | `shoslot:shoslot` | R2 | the slot process (the unit's only `ReadWritePaths=`, `:121`) |

Notes that make the table enforceable rather than decorative:

- `current` **must resolve inside the slot tree**. `WorkingDirectory=${CURRENT_DIR}` (`:98`) and
  `EnvironmentFile=-${CURRENT_DIR}/release.env` (`:103`) are resolved by systemd, so
  `current -> /opt/sho/production` would make the slot run production code and load the production env while
  every other control still passes. The checker refuses it (§8).
- `server.js` **must not be group- or world-writable**: it is the program the unit executes. 0644 with `o+r`

---

## 2. What `release.env` MUST contain

Three things, because those are the three things the rest of the containment story depends on:

```
RELEASE=<sha>                 # 7-40 lowercase hex; the identity /api/health answers with
PORT=3109                     # the slot's only port (:340); server.js reads PORT (server.js:24)
DATABASE_URL=postgresql://sho_slot_pr9_app@127.0.0.1:5432/sho_staging
                              # loopback, port 5432 (not the pooler), sho_staging, the slot's own role
```

- **Release identity.** `src/app/api/health/route.ts` returns `{ ok, release: process.env.RELEASE }` and
  `slot9-proof.sh` P4 reads it back as `release_sha=<sha>`. Without `RELEASE=` there is no way to tell which
  release the slot is serving — the "shipped it" claim becomes unattributable.
- **Port 3109.** The unit sets `NODE_ENV`, `NODE_OPTIONS` and `SHO_BIND_HOST` but *not* `PORT`
  (`slot9-optionR.sh:99`); `server.js` therefore takes its port from the environment, and 3109 is the slot's
  port in every other document (`:340`, `:403`, `:433`). `PORT=3000` here binds the production port — a
  collision at best, a routing surprise at worst.
- **The slot DSN shape.** `P5` asserts `dsn_is_loopback`, `dsn_port_5432` and `dsn_prod_marker_count=0` on the
  *running* process. This file is where that value comes from, so the same three properties are required
  here, plus the slot's own role and the slot database (`sho_slot_pr9_app`, `sho_staging` — §5's grant is
  CONNECT on `sho_staging` only).

Anything else is optional and must be added deliberately: the checker allows `DIRECT_DATABASE_URL`
(migrations) and reports any other key as `RELEASE_ENV_UNEXPECTED_KEY_COUNT` (they can be allowed one by one
with `PHASE2_ALLOW_KEYS="FOO BAR"`, which is a change to this contract, not a workaround).

## 3. What `release.env` MUST NOT contain

| forbidden | why it is a refusal, not a warning |
|---|---|
| any line matching `defaultdb\|doadmin\|25061\|sho-prod-pool` (case-insensitive) | this is the **same list and the same match** as the unit's four `ExecStartPre` guards (`:107-110`). The guard re-runs on **every start**, so a marker here makes the unit fail to start, forever, until somebody fixes the file. That is the designed outcome: a refusal, not a degraded start. |
| any `/etc/sho` path | `/etc/sho` is `InaccessiblePaths=` for the slot (`:120`); a path pointing into it is either a copy-paste of the production env or a probe at the one directory the sandbox hides. |
| any production credential (production DB user/password, pooler port, DO host) | the whole point of the slot. The marker list catches the common shapes; a credential no marker names is what §7 admits we cannot detect. |
| `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `BASH_ENV`, `ENV`, `PATH`, `PYTHONPATH` | an `EnvironmentFile=` is **data**. `NODE_OPTIONS=--require /x.js` turns it into code execution inside the slot sandbox under the slot uid — a way *around* the containment that needs no marker at all. |

Consequence to state plainly: **a marker added to `release.env` by phase 2 does not degrade the slot, it
stops it.** That is correct behaviour (D1 in `CONTAINMENT-RUNBOOK.md`: §5's R3 printed `ABORT` and kept
going), and it is why nobody may "fix" a failed start by deleting the guard, relaxing the marker list, adding
an `EnvironmentFile=` or turning `User=` back into `deploy`.

  is the intended shape (the unit runs as `shoslot`, the file is shipped by `deploy`).
- `release.env` is **0640 `deploy:shoslot`**, not 0600 and not 0644. `shoslot` must be able to *read* it (the
  unit loads it as `shoslot`); nobody but its owner may *write* it; it is not world-readable because a slot
  DSN carries a password. `ProtectHome=read-only` (`:118`) is the runtime half of the same rule: the slot
  process cannot write anywhere under `/home`, whatever the mode says. The mode is still specified, because
  `ProtectHome` is one systemd directive away from being wrong and a guard should not be the only one.
- The three `env/*.env` files are **R3's**, not phase 2's. Phase 2 re-writing one of them is a contract
  violation even when the result happens to scan clean: it means the shipping path reached into

---

## 4. Ordering rule: the guards run before the process, after the file exists

R4 writes the unit and exits. Phase 2 then writes `current/` + `release.env`. On the next
`systemctl start sho-pr9`, systemd does this, in this order, and only this order:

1. `WorkingDirectory=` (`:98`) — the directory the process will run in.
2. all four `EnvironmentFile=` (`:100-103`) — **`release.env` is read here**, whichever identity wrote it.
3. the four `ExecStartPre=` guards (`:107-110`), one per source, each shaped
   *absent ⇒ OK · unreadable ⇒ fail · any marker ⇒ fail*.
4. `ExecStart=/usr/bin/node server.js` (`:111`).

So the guard is not a check on what phase 2 *did*; it is a precondition on every single start, evaluated
against the bytes on disk at that moment. Phase 2 therefore does not get to "get it right once": the file it
writes is re-judged at every start, every boot, every restart, forever.

**What the operator sees when phase 2 wrote a marker** (a REFUSAL, not a degraded start):

```
# systemctl start sho-pr9
Job for sho-pr9.service failed because the control process exited with error code.

# systemctl status sho-pr9
● sho-pr9.service - SHO PR preview slot 9 (port 3109)
     Active: failed (Result: exit-code) since ...
    Process: 12345 ExecStartPre=/bin/sh -c 'test ! -e /home/shoslot/pr9/current/release.env || { ... }' (code=exited, status=1/FAILURE)

# journalctl -u sho-pr9 -n 5
sho-pr9.service: Control process exited, code=exited, status=1/FAILURE
sho-pr9.service: Failed with result 'exit-code'.
Failed to start SHO PR preview slot 9 (port 3109).
```

How to read that, in order:

- `Active: failed (Result: exit-code)` — the unit is **not** active and **not** "active but broken". `node`
  never started: step 4 was never reached.
- **nothing is listening on 3109.** `ss -ltn | grep ':3109 '` is empty and `/api/health` refuses the
  connection. That is the falsifier that separates a refusal from a healthy-but-broken slot.
- the failing `ExecStartPre` line in `status` names **which** source failed — one guard per file by design
  (`:104-106`: a one-time scan cannot cover a file phase 2 creates later).
- if the manager retries (`Restart=on-failure`, `:112`), every attempt re-runs the same guard against the
  same file and ends the same way until the start limit stops the loop. A retry loop changes nothing about
  the verdict; it only makes the journal longer.
- **`CONTAINMENT=FAIL` is not a token any script in this tree prints.** `grep -rn 'CONTAINMENT='` over
  `scripts/` and `app/` returns nothing. The tokens that do exist are the ones quoted here:
  `PHASE2_SHAPE=ABSENT|OK|BROKEN`, `PROOF=PASS|FAIL` (slot9-proof.sh), `REFUSING (partial=0|1)` and
  `ENV_CONTAMINATED` (slot9-optionR.sh / prod-marker-scan.sh). Treat "CONTAINMENT=FAIL" in a report as a
  paraphrase and ask for the line it was copied from.

Do **not** repair a refusal by editing the unit, adding another `EnvironmentFile=`, deleting a guard, or
switching `User=` back. The only repair is to fix `release.env` (or remove it) and start again.

---

## 5. What phase 2 must NOT do

| forbidden | what it would break | what sees it |
|---|---|---|
| write anything under `/etc/sho` | the sandbox hides it from the slot (`:120`); reaching into it is the production-env path this packet exists to close | `check-phase2-shape.sh`: `RELEASE_ENV_ETC_SHO_COUNT>0` |
| change `User=`/`Group=` (`:96-97`) | the uid separation *is* the containment (`PROOF` P1). Nothing else in the unit matters if the slot runs as `deploy`. | outside this checker — `slot9-proof.sh` P3 prints the live properties |
| add or change an `EnvironmentFile=` (`:100-103`) | a fifth source is a fifth way in, and guard *parity* exists because the proof used to accept `count=5 guard=4` | `lib/unit-env-sources.sh` (`unit_env_sources`), run by P4 |
| `systemctl enable` / `enable --now` on its own | the runbook enables only **after** R6's preconditions (`:402`); a phase 2 that enables first can turn a failed start into a boot-time restart loop — which rollback (`:205-227`) exists to remove | outside this checker: a `systemctl` property, not a file |
| touch `sho` or `sho-pr1..pr8` | nine other units, one of them production. R7's blast radius is `sho-pr9` + the `shoslot` account and nothing else. | outside this checker: not visible from a slot tree |
| rewrite `env/db.env`, `env/app.env`, `env/local.env` | R3 is the marker gate for those; a phase-2 write bypasses it with a file that may still scan clean | `ENV_FILE_MODE_BAD`/`_OWNER_BAD`/`_GROUP_BAD` catch a rewrite that changed the shape, not a byte-identical one written as root |
| leave `current` pointing outside the slot, or at a non-release directory | systemd follows the symlink for `WorkingDirectory=` and `EnvironmentFile=` | `CURRENT_INSIDE_TREE=0` / `SERVER_JS_INSIDE_TREE=0` |


---

## 6. "Not shipped yet" vs "shipped something wrong"

The two states look different and must not be conflated. The first is a schedule; the second is a refusal.

| | phase 2 **has not shipped** | phase 2 **shipped something wrong** |
|---|---|---|
| R6 (`slot9-optionR.sh`) | exits **4**, prints `R6 SKIPPED: …/current/server.js is absent (phase 2 has not shipped code yet)` and `R6 skipped is safe: unit installed but NOT enabled.` (`:390-395`) | R6 runs to the end and prints `RESULT r1_6=done` — **R6 does not look at `release.env` at all** |
| unit state | unit installed, not enabled; no start attempted | `systemctl start` → `Active: failed (Result: exit-code)`, ExecStartPre `status=1/FAILURE` |
| listener on 3109 | none | none (**the same**, which is why the unit state, not the port, is the discriminator) |
| `check-phase2-shape.sh` | `PHASE2_SHAPE=ABSENT reason=current_server_js_missing` | `PHASE2_SHAPE=BROKEN reason=<codes>`, e.g. `release_env_marker`, `release_env_mode`, `current_outside_tree` |
| `slot9-proof.sh` | not applicable (no slot to probe; P2/P3/P5 have no pid) | `unit_envfile_count=4 … prod_markers=N`, `gap_closed=0`, `PROOF=FAIL` |
| what the operator does | ship, then re-run R6 (`bash slot9-optionR.sh`) | **stop.** Fix `release.env`; never relax the unit |

The asymmetry to keep in mind: **R6 is not a phase-2 validator.** It exits 4 only when `server.js` is
missing; otherwise it proceeds to `enable --now`. A phase 2 that ships `server.js` *and* a contaminated
`release.env` therefore passes R6 and fails at the guards — the refusal comes from the unit, one step later.
That is the system working (the guard is the last gate and it runs before `node`), but it means "R6 said
done" is not evidence that phase 2 was correct.

---

## 7. The one condition that is not checkable from a slot tree

**Provenance and ordering: that `release.env` was written by phase 2, after R4, and not by the slot, by hand,
or from a stale copy of another host.** The checker can prove the *state* is safe; it cannot prove the
*history*. `mtime` is the only local evidence and it is a heuristic (clock skew, `cp -p`, a restore from
backup), and systemd records nothing about who wrote an `EnvironmentFile=`.

What bounds the gap today:

- `ProtectHome=read-only` (`:118`) means the slot process cannot create or modify `release.env` at runtime,
  and `0640 deploy:shoslot` means it could not write it even without that directive.
- the marker guard re-runs on every start, so a file that arrives *later* — from any author — is still
  refused if it carries a marker.
- the mode/owner check is the closest thing to a provenance check that survives a snapshot: a file owned by
  `shoslot`, or world-writable, did not come from the shipping path.

A real provenance check needs a signed release (a `RELEASE` value checkable against a build record). That is
out of scope here, and it would be a new contract, not a new flag on this checker.

---

## 8. The checker

```bash
bash scripts/containment/check-phase2-shape.sh /home/shoslot/pr9
# offline (no root, no host): against a copy of the tree
bash scripts/containment/check-phase2-shape.sh /tmp/slot-copy/pr9 --expect-release-owner-uid "$(id -u)"
```

Read-only (asserted by a test), no root, no `systemctl`, no host access, no new sudo. It prints `NAME=value`
lines of booleans, counts, octal modes and numeric uids/gids — **never a file's content, a key, a value or a
DSN** — so its output is safe to paste into a ticket or a journal. Exit `0` shape OK, `1` ABSENT or BROKEN,
`2` usage. The verdict line is one of:

```
PHASE2_SHAPE=OK
PHASE2_SHAPE=ABSENT reason=current_server_js_missing
PHASE2_SHAPE=BROKEN reason=current_outside_tree,release_env_marker
```

Path normalization is not re-implemented: it sources `scripts/containment/lib/unit-env-sources.sh` and uses
`unit_env_canon_path` (resolves symlinks *and* `..` against the real tree) plus `unit_env_under` (component
boundary, so `/home/shoslot/pr9x` is not under `/home/shoslot/pr9`). The marker count comes from
`lib/prod-marker-scan.sh` — the same script the unit's guards and R3 use, so the checker and the gate cannot
drift apart. A scan that prints nothing counts as a hit, as in `unit_env_sources`.

It is a **pre-flight, not the proof**. For the full answer run both:

```bash
bash scripts/containment/check-phase2-shape.sh /home/shoslot/pr9   # the files
bash scripts/containment/slot9-proof.sh                            # unit + runtime + listener (P1..P5)
```

Tests: `node --test scripts/containment/phase2-shape.test.mjs` — 16 tests, offline, macOS-safe, no root:
clean case, missing `server.js`, world-readable / group-writable / 0600 `release.env`, five marker spellings
(and that no marker is echoed), `/etc/sho`, `NODE_OPTIONS`, `current` outside the tree, `server.js` symlinked
outside the tree, identity/port/DSN negatives, a widened `env/`, the default owner expectation,
read-only-ness, a missing slot root, and usage.

  `/home/shoslot/pr9/env`, which no phase-2 step needs.
