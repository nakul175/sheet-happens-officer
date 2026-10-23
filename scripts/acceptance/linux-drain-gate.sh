#!/usr/bin/env bash
#
# SHO-2689 — the Linux drain gate.
#
# WHY THIS FILE EXISTS
# The drain is protected by a C handler (src/lib/shutdown.ts:205 loadNative) and a libc
# seize (src/lib/shutdown.ts:246 loadLibc). Both return null unless process.platform is
# "linux". On darwin the drain therefore runs unprotected and every leg prints
#     graceful shutdown: drain timed out
# and exits 1 (src/lib/shutdown.ts:477 report(clean ? CLEAN_LOG : TIMEOUT_LOG, ...)).
# It can never print "graceful shutdown: drained in-flight requests". A darwin "green"
# therefore says nothing about SHO-2689, and the ledger row stays PARTIAL only because
# that distinction lived in prose. This gate turns it into an exit code: on a non-Linux
# kernel it REFUSES (exit 3) and runs no burst at all.
#
# PROTOCOL (W85-REPORT.md "What Linux must confirm", BUG-2689-LINUX.md):
#   N=100 sockets opened and the request written on each, SIGTERM 40 ms later,
#   a NEW connection probed at +16 ms and +143 ms. Every run must show bad=[], the
#   drained line, server exit 0 and refused/refused.
#
# USAGE
#   scripts/acceptance/linux-drain-gate.sh --explain
#   DATABASE_URL='postgresql://…' scripts/acceptance/linux-drain-gate.sh <release-sha>
#
# EXIT CODES
#   0  PASS     (Linux only, every condition of every run held)
#   1  FAIL     one or more conditions failed -> "GATE=FAIL <which condition>"
#   2  usage    missing argument
#   3  REFUSED  not a Linux kernel -> "GATE=REFUSED reason=not-linux", no burst run
#
# OWNERSHIP: SHO-2689 / scripts/acceptance/**. The burst harness it drives is
# scripts/drain-burst.mjs (N=100, SIGTERM at 40 ms, probes at +16/+143 ms).

set -uo pipefail

CLEAN_LINE='graceful shutdown: drained in-flight requests'
TIMEOUT_LINE='graceful shutdown: drain timed out'

# Fixed by the protocol. GATE_RUNS may be lowered for a smoke run; the N of the burst
# and the SIGTERM delay are not overridable here — a different N is a different protocol.
GATE_N=100
GATE_RUNS="${GATE_RUNS:-5}"
case "$GATE_RUNS" in ''|*[!0-9]*) GATE_RUNS=5 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BURST="$ROOT/scripts/drain-burst.mjs"

usage() {
  printf 'usage: %s --explain | <release-sha>\n' "${0##*/}"
}

explain() {
  cat <<'TEXT'
SHO-2689 Linux drain gate — conditions (ALL required, on EVERY run)

  protocol   N=100 connections, request written on each; SIGTERM 40 ms later;
             a NEW connection probed at +16 ms and at +143 ms
  c1-bad     bad=[]                      - no connection accepted before SIGTERM is dropped
  c2-drain   graceful shutdown: drained in-flight requests
                                         - the clean-drain line, verbatim, must be printed
  c3-exit    exit=0                      - the server process must exit 0
  c4-probe   late16=refused late143=refused
                                         - both post-SIGTERM connections must be ECONNREFUSED

Expected verbatim lines of a PASSING run (one block per run, values shown for run 1):

  RELEASE=<sha-under-test>
  RUN 1/5 n=100 bad=[] drain=drained exit=0 late16=refused late143=refused
  GATE=PASS runs=5 n=100 release=<sha-under-test>

Expected verbatim lines of a FAILING run (any one of them):

  GATE=FAIL c1-bad run=1 bad=[reset:2]
  GATE=FAIL c2-drain run=1 drain=absent (printed "graceful shutdown: drain timed out")
  GATE=FAIL c3-exit run=1 exit=1
  GATE=FAIL c4-probe run=1 late16=open late143=refused

Refusal on any kernel that is not Linux (this is the darwin answer, always):

  GATE=REFUSED reason=not-linux

Why darwin cannot pass: the accept-queue seizure is a Linux-only C handler plus a libc
seize (src/lib/shutdown.ts:205 and :246 both return null when process.platform != "linux").
Without them the drain can only print "graceful shutdown: drain timed out" and exit 1, so
c2-drain and c3-exit can never hold. The gate does not try to measure that: it refuses
before any socket is opened.

Exit codes: 0 PASS · 1 FAIL · 2 usage · 3 REFUSED.
TEXT
}

# ---------------------------------------------------------------- the verdict
#
# A pure function of (kernel, evidence) so a test can hand it forged evidence — every
# condition satisfied — on any host and see what it answers. The kernel branch is the
# FIRST branch and it returns REFUSED, so PASS (below it) is unreachable on a non-Linux
# kernel no matter what the evidence says. Nothing else in this script prints PASS.
gate_verdict() {
  local kernel="$1"
  local evidence_ok="$2"
  if [ "$kernel" != "Linux" ]; then
    printf 'REFUSED'
    return 3
  fi
  if [ "$evidence_ok" != "true" ]; then
    printf 'FAIL'
    return 1
  fi
  printf 'PASS'
  return 0
}

# ---------------------------------------------------------------- the run
#
# Reads one drain-burst.mjs JSON document on stdin and prints five "key=value" lines.
# Anything unparsable prints PARSE_FAIL and no other line, which the caller turns into
# GATE=FAIL.
read_burst() {
  node -e '
const fs = require("node:fs");
let j;
try { j = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.stdout.write("PARSE_FAIL\n"); process.exit(0); }
if (!j || typeof j !== "object") { process.stdout.write("PARSE_FAIL\n"); process.exit(0); }
const inFlight = j.inFlight || {};
const statuses = inFlight.statuses || {};
const non200 = Number(inFlight.non200 || 0);
const parts = Object.keys(statuses).sort().map((k) => `${k}:${statuses[k]}`);
const bad = non200 === 0 && (statuses["200"] || 0) === 100 ? "bad=[]" : `bad=[${parts.join(" ")}]`;
const drain = j.drainedLine === "logged" ? "drained" : "absent";
const ex = j.exit || {};
const code = typeof ex.code === "number" ? `exit=${ex.code}` : `exit=signal:${ex.signal || "unknown"}`;
const a = j.afterSigterm || {};
const lines = Array.isArray(j.shutdownLines) ? j.shutdownLines.join(" ; ") : "";
process.stdout.write([bad, `drain=${drain}`, code, `late16=${a.late16 || "unmeasured"}`, `late143=${a.late143 || "unmeasured"}`, `lines=${lines}`].join("\n") + "\n");
'
}

main() {
  local sha="${1:-}"

  # Explain is documentation, not a verdict: no burst, no state, no platform branch.
  if [ "$sha" = "--explain" ] || [ "$sha" = "-h" ] || [ "$sha" = "--help" ]; then
    explain
    return 0
  fi

  # THE GATE. First branch of the run path: before argument checks, before any socket.
  local kernel arch
  kernel="$(uname -s 2>/dev/null || echo unknown)"
  arch="$(uname -m 2>/dev/null || echo unknown)"
  if [ "$kernel" != "Linux" ]; then
    printf 'GATE=REFUSED reason=not-linux\n'
    printf 'kernel=%s arch=%s\n' "$kernel" "$arch"
    printf 'no burst was run: the drain needs the Linux-only C handler and libc seize (src/lib/shutdown.ts:205,246).\n'
    printf 'on %s every leg can only print "%s" and exit 1, so a pass here would be invented.\n' "$kernel" "$TIMEOUT_LINE"
    return 3
  fi

  if [ -z "$sha" ]; then
    printf 'GATE=FAIL missing-release-sha (a receipt without the build under test cannot be trusted)\n'
    usage >&2
    return 2
  fi
  printf 'RELEASE=%s\n' "$sha"

  if [ ! -f "$BURST" ]; then
    printf 'GATE=FAIL missing-burst-harness %s\n' "$BURST"
    return 1
  fi
  # Pin the protocol: the harness must still SIGTERM 40 ms after the writes. If that
  # number moves, the gate would be measuring a different protocol and saying nothing.
  if ! grep -Eq 'setTimeout\(r, 40\)' "$BURST"; then
    printf 'GATE=FAIL harness-sigterm-40ms (scripts/drain-burst.mjs no longer waits 40 ms before SIGTERM)\n'
    return 1
  fi
  if [ -z "${DATABASE_URL:-}" ]; then
    printf 'GATE=FAIL missing-database-url (set it in the environment; this gate never prints it)\n'
    return 1
  fi
  # The SHA is the build the receipt is attached to. When git can answer, it must agree.
  local head
  head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$head" ]; then
    case "$head" in
      "$sha"*) : ;;
      *) printf 'GATE=FAIL release-head-mismatch (requested %s, HEAD is %s)\n' "$sha" "$head"; return 1 ;;
    esac
  fi

  local tmp evidence_ok=true failed=0 run fields
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  for ((run = 1; run <= GATE_RUNS; run += 1)); do
    if ! node "$BURST" "$GATE_N" 0 >"$tmp/$run.json" 2>"$tmp/$run.err"; then
      printf 'GATE=FAIL run-%s-harness-error (see stderr: %s)\n' "$run" "$(tr '\n' ' ' <"$tmp/$run.err" | cut -c1-300)"
      evidence_ok=false
      failed=1
      continue
    fi
    local bad drain ecode late16 late143 printed
    mapfile -t fields < <(read_burst <"$tmp/$run.json")
    if [ "${#fields[@]}" -ne 6 ] || [ "${fields[0]}" = "PARSE_FAIL" ]; then
      printf 'GATE=FAIL run-%s-unparsable (drain-burst printed no usable JSON)\n' "$run"
      evidence_ok=false
      failed=1
      continue
    fi
    bad="${fields[0]}"; drain="${fields[1]}"; ecode="${fields[2]}"; late16="${fields[3]}"; late143="${fields[4]}"; printed="${fields[5]#lines=}"
    printf 'RUN %s/%s n=%s %s %s %s %s %s\n' "$run" "$GATE_RUNS" "$GATE_N" "$bad" "$drain" "$ecode" "$late16" "$late143"

    if [ "$bad" != "bad=[]" ]; then
      printf 'GATE=FAIL c1-bad run=%s %s\n' "$run" "$bad"
      evidence_ok=false; failed=1
    fi
    if [ "$drain" != "drain=drained" ]; then
      printf 'GATE=FAIL c2-drain run=%s drain=absent%s\n' "$run" "${printed:+ (printed \"$printed\")}"
      evidence_ok=false; failed=1
    fi
    if [ "$ecode" != "exit=0" ]; then
      printf 'GATE=FAIL c3-exit run=%s %s\n' "$run" "$ecode"
      evidence_ok=false; failed=1
    fi
    if [ "$late16" != "late16=refused" ] || [ "$late143" != "late143=refused" ]; then
      printf 'GATE=FAIL c4-probe run=%s %s %s\n' "$run" "$late16" "$late143"
      evidence_ok=false; failed=1
    fi
  done

  local rc
  gate_verdict "$kernel" "$evidence_ok" >/dev/null
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'GATE=PASS runs=%s n=%s release=%s\n' "$GATE_RUNS" "$GATE_N" "$sha"
  elif [ "$rc" -eq 3 ]; then
    printf 'GATE=REFUSED reason=not-linux\n'
  fi
  [ "$failed" -eq 0 ] || return 1
  return "$rc"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
  exit $?
fi
