# Linux drain gate — operator runbook (SHO-2689)

## SHO-2760 accepted timing criterion (24 October 2026)

The owner selected refusal within one SYN retransmission, at most **1,200 ms**, with
**no new connection accepted**. No host firewall or sysctl change is part of this decision.
The early (+16 ms) and later (+143 ms) connection probes measure time from each
connect attempt using a monotonic clock. `refusalTiming` in each burst JSON records
both elapsed values and states. Only `ECONNREFUSED` within the limit passes; an
accepted connection, timeout, another error, missing timing or an over-limit result fails.
This replaces the probe's former 300 ms observation timeout, consistent with SHO-2689 AC2 v1.1.

Retain each burst JSON with deployed release SHA and listener URL. A historical
`late16=refused late143=refused` line without timing is not sufficient evidence for
SHO-2760. Run the updated harness against a built isolated staging release; never
signal the shared production process or change host networking to make the test pass.

The gate is `scripts/acceptance/linux-drain-gate.sh`. Its conditions are printed by
`--explain`; this page is the part an operator needs before running it: what it is for, and what
it deliberately does not do. Threat model: **operator error on a host you already control** — not
an adversary who owns the machine.

## The documented run

```bash
DATABASE_URL='postgresql://…' scripts/acceptance/linux-drain-gate.sh --production <sha>
```

`--production` is the default and the only mode that can print `GATE=PASS`. `--dev` is a local
look and always ends on `GATE=NOT-ACCEPTANCE mode=dev`. A receipt is the single line

```
GATE=PASS runs=5 n=100 release=<sha> entry=server.js
```

and it only means something on a real Linux kernel: the drain needs the Linux-only C handler and
libc seize (`src/lib/shutdown.ts:205`,`:246`), so on any other kernel the gate refuses (exit 3)
before it opens a socket.

## IN SCOPE — the five mistakes the gate catches, and the test for each

| threat | caught by | test |
|---|---|---|
| running on the wrong platform | `platform_is_linux` / `platform_gate` / `gate_verdict` kernel branch | `scripts/acceptance/linux-drain-gate.refusal.test.mjs:37,60,78`; `w184-platform.test.mjs:43,74,129`; `linux-drain-gate.test.mjs:50` |
| measuring a dev build | `c0-serving`, `dev-artifacts-present`, `--dev` | `linux-drain-gate.test.mjs:240,270,68` |
| measuring an unbuilt tree | `production_precondition` (`missing-build-id`, `missing-production-entry`) | `linux-drain-gate.test.mjs:200,213,227`; `drain-burst.mjs` own refusal at `:270` |
| a mismatched release | `c0-release` (the health echo) and `release-head-mismatch` (the checkout's HEAD) | `linux-drain-gate.test.mjs:396,416`; `release-head.test.mjs:49,66` |
| a burst off the pinned protocol | `harness_pin`, `harness_delay_ok`, `sigterm=40` | `linux-drain-gate.test.mjs:488,494,512`; `drain-conditions-fixtures.test.mjs:88,152` |

## LIMITS — out of scope on purpose (not defects; do not redesign against them)

- **An operator who edits the gate.** A rewritten `linux-drain-gate.sh`, `release-identity.mjs` or
  `drain-burst.mjs` is a different gate; the receipt is evidence for the committed file only.
- **Shimmed coreutils / a kernel that lies.** W184 reads the kernel from `bash` builtins on procfs
  so a `PATH` `uname` cannot answer it; a bind-mounted `/proc` or a kernel that says `Linux` when
  it is not is trusted, because no self-check can out-rank the kernel.
- **A sourced internal function with a forged token.** W172 measured the sourced
  `production_run`; W184 gave both runners their own kernel check and a token only `main()` mints.
  Reassigning either in a shell you control is running your own code.
- **The deployment.** The gate does not check that this is the right host, that `DATABASE_URL` is
  the intended database, or that the release was deployed. It measures a built release on Linux.

## The one constraint this page cannot remove

A real Linux amd64 kernel on a host where you hold the capability to run a build and a process —
in practice a decision by whoever holds root/the host. Every test in `scripts/acceptance/` simulates
that branch; **none of them, and nothing in this runbook, substitutes for the run.**
