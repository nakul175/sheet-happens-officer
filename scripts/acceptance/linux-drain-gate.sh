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
# WHAT MAY PRINT GATE=PASS (W99)
# A burst against a dev server is not deployed acceptance. The first version of this gate
# spawned `node --import tsx server.js` with NODE_ENV=development and no `next build`, so
# even a green on Linux would have measured a dev server. Now there are two modes:
#
#   --production  (DEFAULT, and the ONLY mode that can print GATE=PASS)
#                 builds the release once, in an ISOLATED COPY of this checkout, asserts the
#                 serving process is the production entry with a completed build and no dev
#                 artifacts, starts it with NODE_ENV=production and RELEASE=<sha>, compares
#                 the release identity /api/health echoes (src/app/api/health/route.ts:10)
#                 with that <sha>, and only then runs the N=100 / SIGTERM-at-40 ms protocol.
#
#   --dev         a quick local look. It always ends on `GATE=NOT-ACCEPTANCE mode=dev` and
#                 can never emit GATE=PASS: the single GATE=PASS site is inside
#                 production_run(), and the mode branch of gate_verdict() returns
#                 NOT-ACCEPTANCE before PASS is reachable. scripts/acceptance/
#                 linux-drain-gate.test.mjs fails if that stops being true.
#
# PROTOCOL (W85-REPORT.md "What Linux must confirm", BUG-2689-LINUX.md):
#   N=100 sockets opened and the request written on each, SIGTERM 40 ms later,
#   a NEW connection probed at +16 ms and +143 ms. Every run must show bad=[], the
#   drained line, server exit 0 and refused/refused.
#
# USAGE
#   scripts/acceptance/linux-drain-gate.sh --explain
#   DATABASE_URL='postgresql://…' scripts/acceptance/linux-drain-gate.sh --production <sha>
#   DATABASE_URL='postgresql://…' scripts/acceptance/linux-drain-gate.sh <sha>    # same
#   scripts/acceptance/linux-drain-gate.sh --dev <sha>                            # never PASS
#   GATE_BUILD_ROOT=/path/to/a/prebuilt/release scripts/acceptance/linux-drain-gate.sh <sha>
#       reuse a release `next build` already produced instead of building again.
#
# EXIT CODES
#   0  PASS             (Linux, production mode, every condition of every run held)
#   1  FAIL             one or more conditions failed -> "GATE=FAIL <which condition>"
#   2  usage            missing argument / unknown option
#   3  REFUSED          not a Linux kernel -> "GATE=REFUSED reason=not-linux", no burst run
#   4  NOT-ACCEPTANCE   a dev-mode run; never PASS
#
# OWNERSHIP: SHO-2689 / scripts/acceptance/**. The burst harness it drives is
# scripts/drain-burst.mjs (N=100, SIGTERM at 40 ms, probes at +16/+143 ms).

set -uo pipefail

CLEAN_LINE='graceful shutdown: drained in-flight requests'
TIMEOUT_LINE='graceful shutdown: drain timed out'

# The production entry the repo actually ships: deploy/cloud-init.yaml:63 runs
#   ExecStart=/usr/bin/node --import tsx server.js
# and server.js:2 says systemd runs it "instead of `next start`". `next start` handles
# SIGTERM itself (exit 143) before the app can drain, so it is not the receipt's entry.
ENTRY='server.js'

# Fixed by the protocol. GATE_RUNS may be lowered for a smoke run; the N of the burst
# and the SIGTERM delay are not overridable here — a different N is a different protocol.
GATE_N=100
GATE_RUNS="${GATE_RUNS:-5}"
case "$GATE_RUNS" in ''|*[!0-9]*) GATE_RUNS=5 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BURST="$ROOT/scripts/drain-burst.mjs"
# Set by main() for the run; declared here so the functions can be sourced and exercised
# by a test on any kernel without `set -u` tripping over it.
TMP=""

usage() {
  printf 'usage: %s [--production|--dev] <release-sha> | --explain\n' "${0##*/}"
}


explain() {
  cat <<'TEXT'
SHO-2689 Linux drain gate — conditions (ALL required, on EVERY run)

  mode       --production (default) is the only mode that can print GATE=PASS.
             --dev is a local look; it always ends on GATE=NOT-ACCEPTANCE mode=dev.

  protocol   N=100 connections, request written on each; SIGTERM 40 ms later;
             a NEW connection probed at +16 ms and at +143 ms
  c0-serving serving=entry:server.js nodeEnv:production build:yes dev:none
                                         - the production entry, a completed build,
                                           and no dev-server artifacts
  c0-release release=<RELEASE it was given>
                                         - /api/health echoes the RELEASE under test
  c1-bad     bad=[]                      - no connection accepted before SIGTERM is dropped
  c2-drain   graceful shutdown: drained in-flight requests
                                         - the clean-drain line, verbatim, must be printed
  c3-exit    exit=0                      - the server process must exit 0
  c4-probe   late16=refused late143=refused
                                         - both post-SIGTERM connections must be ECONNREFUSED

Expected verbatim lines of a PASSING production run (one block per run, values shown
for run 1). A dev run prints GATE=NOT-ACCEPTANCE instead and never GATE=PASS:

  GATE=MODE mode=production
  RELEASE=<sha-under-test>
  BUILD=isolated source=<checkout> root=<temp>/app
  BUILD=ok build-id=<next build id>
  PRECONDITION=production build-id=<next build id> entry=server.js
  RUN 1/5 mode=production n=100 bad=[] drain=drained exit=0 late16=refused late143=refused
  GATE=PASS runs=5 n=100 release=<sha-under-test> entry=server.js

Expected verbatim lines of a FAILING run (any one of them):

  GATE=FAIL missing-build-id (.next/BUILD_ID is absent: run next build in this directory first)
  GATE=FAIL missing-production-entry (<dir> has no server.js; a dev server is not the release)
  GATE=FAIL dev-artifacts-present (.next/dev exists: that is a dev server, not the release)
  GATE=FAIL c0-release run=1 release=<echoed> expected=<given>
  GATE=FAIL c1-bad run=1 bad=[reset:2]
  GATE=FAIL c2-drain run=1 drain=absent (printed "graceful shutdown: drain timed out")
  GATE=FAIL c3-exit run=1 exit=1
  GATE=FAIL c4-probe run=1 late16=open late143=refused

The dev mode ends on exactly:

  GATE=NOT-ACCEPTANCE mode=dev

Refusal on any kernel that is not Linux (the darwin answer, always, in BOTH modes):

  GATE=REFUSED reason=not-linux

Why darwin cannot pass: the accept-queue seizure is a Linux-only C handler plus a libc
seize (src/lib/shutdown.ts:205 and :246 both return null when process.platform != "linux").
Without them the drain can only print "graceful shutdown: drain timed out" and exit 1, so
c2-drain and c3-exit can never hold. The gate does not try to measure that: it refuses
before any socket is opened, before any mode is honoured and before any build.

Build isolation: production mode never runs `next build` in this checkout. `.next` here may
belong to a live `next dev` (W83: `next build` rewrote `.next` under a running server), so
the sources are copied to a temp root with node_modules symlinked, and the build runs there.

Exit codes: 0 PASS · 1 FAIL · 2 usage · 3 REFUSED · 4 NOT-ACCEPTANCE.
TEXT
}

# ---------------------------------------------------------------- the verdict
#
# A pure function of (kernel, mode, evidence) so a test can hand it forged evidence — every
# condition satisfied — on any host and see what it answers. The kernel branch is the FIRST
# branch and it returns REFUSED; the mode branch is second and returns NOT-ACCEPTANCE for
# anything that is not production. PASS is therefore reachable only on Linux in production
# mode, no matter what the evidence says. Nothing else in this script prints PASS.
gate_verdict() {
  local kernel="$1"
  local mode="$2"
  local evidence_ok="$3"
  if [ "$kernel" != "Linux" ]; then
    printf 'REFUSED'
    return 3
  fi
  if [ "$mode" != "production" ]; then
    printf 'NOT-ACCEPTANCE'
    return 4
  fi
  if [ "$evidence_ok" != "true" ]; then
    printf 'FAIL'
    return 1
  fi
  printf 'PASS'
  return 0
}

# ---------------------------------------------------------------- the harness pins
#
# The protocol fixes SIGTERM at 40 ms. The harness reads the delay from
# BURST_SIGTERM_DELAY_MS with 40 as the default and hands it to the setTimeout that fires
# the signal, so BOTH halves have to still be there. The first version of this gate grepped
# for a literal `setTimeout(r, 40)`, which the harness never contained (it names the
# constant), so on Linux it failed on `GATE=FAIL harness-sigterm-40ms` before the first
# run: a receipt that could never be produced. This is the same pin, matched to the code.
harness_pin() {
  local file="$1"
  grep -Eq 'BURST_SIGTERM_DELAY_MS *\?\? *"40"' "$file" || return 1
  grep -Eq 'setTimeout\(r, SIGTERM_DELAY_MS\)' "$file" || return 1
  return 0
}

# A gate run with the delay overridden would measure a different protocol and still print
# a number that looks like the receipt.
harness_delay_ok() {
  local given="${BURST_SIGTERM_DELAY_MS:-40}"
  [ "$given" = "40" ]
}

# Is the release /api/health echoed the release under test? Equal, or a short SHA on one
# side that is a prefix of the other (both at least 7 characters, the shortest unambiguous
# abbreviation git itself allows).
release_matches() {
  local expected observed
  expected="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  observed="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
  [ -n "$expected" ] || return 1
  [ -n "$observed" ] || return 1
  [ "$expected" = "$observed" ] && return 0
  [ "${#expected}" -ge 7 ] || return 1
  [ "${#observed}" -ge 7 ] || return 1
  case "$observed" in "$expected"*) return 0 ;; esac
  case "$expected" in "$observed"*) return 0 ;; esac
  return 1
}

# ---------------------------------------------------------------- the production precondition
#
# What "the deployed artifact" means, checked on the directory that will actually serve:
#   - the production entry (server.js) is there;
#   - `next build` completed (`.next/BUILD_ID` is non-empty);
#   - no dev-server artifacts (`.next/dev`) mixed in, which is what a `next dev` leaves and
#     would make "production" a label rather than a fact.
# Prints the GATE=FAIL line itself so the reason travels with the receipt.
production_precondition() {
  local app="${1:-$ROOT}"
  local entry="$app/$ENTRY"
  local build_id=""

  if [ ! -f "$entry" ]; then
    printf 'GATE=FAIL missing-production-entry (%s has no %s; a dev server is not the release)\n' "$app" "$ENTRY"
    return 1
  fi
  if [ -f "$app/.next/BUILD_ID" ]; then
    build_id="$(tr -d '[:space:]' <"$app/.next/BUILD_ID")"
  fi
  if [ -z "$build_id" ]; then
    printf 'GATE=FAIL missing-build-id (%s/.next/BUILD_ID is absent: run next build in this directory first)\n' "$app"
    return 1
  fi
  if [ -e "$app/.next/dev" ]; then
    printf 'GATE=FAIL dev-artifacts-present (%s/.next/dev exists: the serving process would be a dev server, not the release)\n' "$app"
    return 1
  fi
  printf 'PRECONDITION=production build-id=%s entry=%s\n' "$build_id" "$ENTRY"
  return 0
}


# ---------------------------------------------------------------- build isolation
#
# `next build` writes `.next` in the directory it is run from. In this worktree `.next` is a
# live `next dev`'s directory (only `.next/dev`, no BUILD_ID), so building in place would
# corrupt the server the operator is using — the exact trap W83 hit. Instead the sources are
# copied to a temp root and node_modules is SYMLINKED into it: the copy holds sources only,
# the build writes its `.next` inside the copy, and the checkout's `.next` is never opened
# for writing. node_modules is shared read-only (the build writes `.next/cache`, inside the
# copy), so there is no second `npm ci` and no second copy of 500 MB of dependencies.
prepare_build_root() {
  local src="$1"
  local dest="$2"
  local excl="$dest/.build-exclude.txt"

  rm -rf "$dest"
  mkdir -p "$dest" || return 1
  # -X is read by both GNU tar and bsdtar, and the members are named with their leading
  # `./` because that is how they appear in the archive.
  printf '%s\n' './node_modules' './.next' './.git' './coverage' './out' './build' './.outbox-ci' >"$excl"
  if ! tar -C "$src" -cf - -X "$excl" . 2>/dev/null | tar -C "$dest" -xf - 2>/dev/null; then
    printf 'GATE=FAIL build-copy-failed (%s -> %s)\n' "$src" "$dest"
    return 1
  fi
  rm -f "$excl"
  # node_modules must be a REAL directory tree in the copy, not a symlink. A symlink is the
  # obvious way to share 900 MB of dependencies, and it is what this gate did first: the
  # build then died with
  #   Error: Could not find the Next.js package (next/package.json)
  # because Turbopack resolves packages inside its filesystem root and will not leave the
  # workspace through a link. Hardlinks give the same saving without the link: nothing is
  # copied, so ~900 MB of dependencies take ~9 s, and `cp -a` is the fallback for a
  # different filesystem (paths on another volume cannot be hardlinked). `.cache` is dropped
  # afterwards so a build can never write through a shared inode into the checkout's cache.
  if ! cp -al "$src/node_modules" "$dest/node_modules" 2>/dev/null; then
    rm -rf "$dest/node_modules"
    if ! cp -a "$src/node_modules" "$dest/node_modules" 2>/dev/null; then
      printf 'GATE=FAIL build-deps-failed (could not copy %s/node_modules)\n' "$src"
      return 1
    fi
  fi
  rm -rf "$dest/node_modules/.cache"
  return 0
}

# Build the release once, at the SHA being accepted. RELEASE is passed into the build as
# well as into the serving process so the artifact and the identity it reports agree.
build_release() {
  local app="$1"
  local sha="$2"
  local log="${3:-${TMPDIR:-/tmp}/sho-release-build.log}"
  local next_bin="$app/node_modules/next/dist/bin/next"

  if [ ! -f "$next_bin" ]; then
    printf 'GATE=FAIL build-tooling-missing (%s)\n' "$next_bin"
    return 1
  fi
  # DATABASE_URL is inherited, never echoed: a build that prerenders may need the database.
  if ! ( cd "$app" && NODE_ENV=production RELEASE="$sha" node "$next_bin" build ) >"$log" 2>&1; then
    printf 'GATE=FAIL build-failed (log %s; last lines below)\n' "$log"
    tail -n 25 "$log" | sed 's/^/  /'
    return 1
  fi
  printf 'BUILD=ok build-id=%s\n' "$(tr -d '[:space:]' <"$app/.next/BUILD_ID" 2>/dev/null || printf 'missing')"
  return 0
}


# ---------------------------------------------------------------- the run
#
# Reads one drain-burst.mjs JSON document on stdin and prints nine "key=value" lines:
#   c1 bad · c2 drain · c3 exit · c4 late16 · c4 late143 · the shutdown lines ·
#   c0 serving (what was actually serving) · c0 release (the identity /api/health echoed) ·
#   the SIGTERM delay the harness actually used.
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
const s = j.serving || {};
const serving = s.entry
  ? `serving=entry:${s.entry} nodeEnv:${s.nodeEnv} build:${s.buildId} dev:${s.devArtifacts ? "yes" : "none"}`
  : "serving=unknown";
const release = `release=${j.release == null ? "none" : j.release}`;
const sigterm = `sigterm=${typeof j.sigtermDelayMs === "number" ? j.sigtermDelayMs : "unknown"}`;
process.stdout.write([bad, `drain=${drain}`, code, `late16=${a.late16 || "unmeasured"}`, `late143=${a.late143 || "unmeasured"}`, `lines=${lines}`, serving, release, sigterm].join("\n") + "\n");
'
}


# ---------------------------------------------------------------- one loop, both modes
#
# The protocol is identical in both modes; what changes is what the harness is pointed at
# (the built release vs the checkout) and the two conditions only a release can satisfy
# (c0-serving, c0-release). Returns 0 only when every condition of every run held.
run_bursts() {
  local mode="$1"
  local sha="$2"
  local app="$3"
  local tmp="$TMP/burst"
  local run ok=true bad drain ecode late16 late143 printed serving release sigterm detail

  mkdir -p "$tmp" || return 1
  for ((run = 1; run <= GATE_RUNS; run += 1)); do
    if [ "$mode" = "production" ]; then
      if ! SHO_APP_ROOT="$app" SHO_ENTRY="$ENTRY" RELEASE="$sha" BURST_SIGTERM_DELAY_MS=40 \
        node "$BURST" "$GATE_N" 0 --production >"$tmp/$run.json" 2>"$tmp/$run.err"; then
        printf 'GATE=FAIL run-%s-harness-error (see stderr: %s)\n' "$run" "$(tr '\n' ' ' <"$tmp/$run.err" | cut -c1-300)"
        ok=false
        continue
      fi
    else
      if ! SHO_APP_ROOT="$app" SHO_ENTRY="$ENTRY" BURST_SIGTERM_DELAY_MS=40 \
        node "$BURST" "$GATE_N" 0 >"$tmp/$run.json" 2>"$tmp/$run.err"; then
        printf 'GATE=FAIL run-%s-harness-error (see stderr: %s)\n' "$run" "$(tr '\n' ' ' <"$tmp/$run.err" | cut -c1-300)"
        ok=false
        continue
      fi
    fi

    bad=""; drain=""; ecode=""; late16=""; late143=""; printed=""; serving=""; release=""; sigterm=""
    {
      read -r bad
      read -r drain
      read -r ecode
      read -r late16
      read -r late143
      read -r printed
      read -r serving
      read -r release
      read -r sigterm
    } <<EOF
$(read_burst <"$tmp/$run.json")
EOF

    if [ "$bad" = "PARSE_FAIL" ] || [ -z "$sigterm" ]; then
      printf 'GATE=FAIL run-%s-unparsable (drain-burst printed no usable JSON)\n' "$run"
      ok=false
      continue
    fi
    printf 'RUN %s/%s mode=%s n=%s %s %s %s %s %s %s %s %s\n' \
      "$run" "$GATE_RUNS" "$mode" "$GATE_N" "$bad" "$drain" "$ecode" "$late16" "$late143" "$serving" "$release" "$sigterm"

    if [ "$bad" != "bad=[]" ]; then
      printf 'GATE=FAIL c1-bad run=%s %s\n' "$run" "$bad"
      ok=false
    fi
    if [ "$drain" != "drain=drained" ]; then
      detail=""
      [ -n "$printed" ] && detail=" (printed \"${printed#lines=}\")"
      printf 'GATE=FAIL c2-drain run=%s drain=absent%s\n' "$run" "$detail"
      ok=false
    fi
    if [ "$ecode" != "exit=0" ]; then
      printf 'GATE=FAIL c3-exit run=%s %s\n' "$run" "$ecode"
      ok=false
    fi
    if [ "$late16" != "late16=refused" ] || [ "$late143" != "late143=refused" ]; then
      printf 'GATE=FAIL c4-probe run=%s %s %s\n' "$run" "$late16" "$late143"
      ok=false
    fi
    if [ "$sigterm" != "sigterm=40" ]; then
      printf 'GATE=FAIL c4-signal run=%s %s (the protocol is SIGTERM at 40 ms)\n' "$run" "$sigterm"
      ok=false
    fi

    if [ "$mode" = "production" ]; then
      if [ "$serving" != "serving=entry:$ENTRY nodeEnv:production build:present dev:none" ]; then
        printf 'GATE=FAIL c0-serving run=%s %s\n' "$run" "$serving"
        ok=false
      fi
      if ! release_matches "$sha" "${release#release=}"; then
        printf 'GATE=FAIL c0-release run=%s %s expected=%s\n' "$run" "$release" "$sha"
        ok=false
      fi
    fi
  done

  [ "$ok" = "true" ]
}


# ---------------------------------------------------------------- the two modes
#
# production_run is the ONLY place that prints GATE=PASS, and main only reaches it from the
# production arm of its mode dispatch. A structural test asserts both halves:
#   - exactly one GATE=PASS emitter in this file, inside this function;
#   - dev_run prints GATE=NOT-ACCEPTANCE mode=dev and no PASS at all.
production_run() {
  local sha="$1"
  local app=""
  local held

  if [ -n "${GATE_BUILD_ROOT:-}" ]; then
    app="$GATE_BUILD_ROOT"
    printf 'BUILD=reused root=%s\n' "$app"
    # A reused root is only a release if it still carries its build; the precondition says so.
    production_precondition "$app" || return 1
  else
    app="$TMP/app"
    printf 'BUILD=isolated source=%s root=%s\n' "$ROOT" "$app"
    prepare_build_root "$ROOT" "$app" || return 1
    build_release "$app" "$sha" "$TMP/build.log" || return 1
    production_precondition "$app" || return 1
  fi

  run_bursts production "$sha" "$app"
  held=$?
  gate_verdict "$(uname -s 2>/dev/null || echo unknown)" production \
    "$([ "$held" -eq 0 ] && printf 'true' || printf 'false')" >/dev/null
  case "$?" in
    0)
      printf 'GATE=PASS runs=%s n=%s release=%s entry=%s\n' "$GATE_RUNS" "$GATE_N" "$sha" "$ENTRY"
      return 0
      ;;
    3)
      printf 'GATE=REFUSED reason=not-linux\n'
      return 3
      ;;
  esac
  printf 'GATE=FAIL mode=production release=%s (see the c0..c4 lines above)\n' "$sha"
  return 1
}

# A local look. It never prints GATE=PASS and it always prints the NOT-ACCEPTANCE line,
# whether the legs held or not, so a transcript from this mode can never be filed as a
# SHO-2689 receipt.
dev_run() {
  local sha="$1"
  local held

  printf 'DEV=local-look (NODE_ENV=development, no next build: this is a dev server)\n'
  run_bursts dev "$sha" "$ROOT"
  held=$?
  printf 'GATE=NOT-ACCEPTANCE mode=dev\n'
  if [ "$held" -ne 0 ]; then
    printf 'NOT-ACCEPTANCE: legs=failed. A red dev run is not a red release either.\n'
    return 1
  fi
  printf 'NOT-ACCEPTANCE: legs=held. Exit 0 here is a local look, not deployed acceptance.\n'
  return 0
}

# ---------------------------------------------------------------- main
main() {
  local mode="production"
  local sha=""
  local arg

  for arg in "$@"; do
    case "$arg" in
      --explain|-h|--help) explain; return 0 ;;
      --production) mode="production" ;;
      --dev) mode="dev" ;;
      -*) printf 'GATE=FAIL unknown-option %s\n' "$arg"; usage >&2; return 2 ;;
      *)
        if [ -n "$sha" ]; then
          printf 'GATE=FAIL too-many-arguments (%s)\n' "$arg"
          usage >&2
          return 2
        fi
        sha="$arg"
        ;;
    esac
  done

  # THE GATE. First branch of the run path: before the mode is honoured, before the
  # argument checks, before any build and before any socket.
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

  case "$mode" in
    production|dev) : ;;
    *) printf 'GATE=FAIL unknown-mode %s\n' "$mode"; return 2 ;;
  esac

  if [ -z "$sha" ]; then
    printf 'GATE=FAIL missing-release-sha (a receipt without the build under test cannot be trusted)\n'
    usage >&2
    return 2
  fi
  if [ ! -f "$BURST" ]; then
    printf 'GATE=FAIL missing-burst-harness %s\n' "$BURST"
    return 1
  fi
  if ! harness_pin "$BURST"; then
    printf 'GATE=FAIL harness-sigterm-40ms (%s no longer waits 40 ms before SIGTERM)\n' "$BURST"
    return 1
  fi
  if ! harness_delay_ok; then
    printf 'GATE=FAIL harness-sigterm-40ms (BURST_SIGTERM_DELAY_MS=%s; the protocol fixes 40)\n' "$BURST_SIGTERM_DELAY_MS"
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

  printf 'GATE=MODE mode=%s\n' "$mode"
  printf 'RELEASE=%s\n' "$sha"

  TMP="$(mktemp -d)" || {
    printf 'GATE=FAIL mktemp-failed\n'
    return 1
  }
  # shellcheck disable=SC2064
  trap 'rm -rf "$TMP"' EXIT

  case "$mode" in
    production)
      production_run "$sha"
      return $?
      ;;
    dev)
      dev_run "$sha"
      return $?
      ;;
  esac
  printf 'GATE=FAIL unknown-mode %s\n' "$mode"
  return 2
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
  exit $?
fi

