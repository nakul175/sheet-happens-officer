#!/usr/bin/env node
// OPERATOR TIER — A WORKER THAT DIES SILENTLY LOOKS EXACTLY LIKE ONE THAT FINISHED.
//
// The incident behind this file: packet w157 stopped after 9 iterations, wrote no report, and was only noticed because
// an operator compared the live process list against the packet table by hand. Nothing in the harness could tell the
// difference between "still working" and "gone", because the only liveness signal was `state/<id>.pid` and nothing
// re-read it.
//
// The second reason this exists: a pid file is not a liveness record. The launcher writes `echo $! > state/$id.pid`,
// so a relaunch overwrites the pid of a worker that is still running, and a dead worker's pid is eventually REUSED by
// an unrelated process. A checker that answers only `kill -0` therefore prints RUNNING for a recycled pid. This checker
// says RUNNING only when the process at that pid names the worker's OWN worktree (`/tmp/w2-<id>`) or its own data-dir
// (`<workers>/<id>-data`) on its command line — the check that had to be done by hand.
//
// Usage:
//   node scripts/ci/worker-liveness.mjs --tsv <packets.tsv> --state <state dir> \
//     [--logs <dir>] [--reports <execution dir>] [--launches <wave log>] [--json]
//
// --tsv       the packet table the launcher reads: id<TAB>branch<TAB>port<TAB>schema<TAB>keys
// --state     directory holding <id>.pid and <id>.started
// --logs      directory holding <id>.log (default: the parent of --state)
// --reports   directory holding <ID>-REPORT.md, i.e. app/sho-status-plan/execution. Without it no run can be called
//             FINISHED: "I cannot see a report" is not the same as "there is a report".
// --launches  wave log written by launch-wave3.sh; each `LAUNCH <id> pid=<pid>` line lets the checker spot a packet
//             that was launched more than once (a relaunch truncates the earlier run's log and overwrites its pid).
//
// Verdicts, one per dispatched packet:
//   RUNNING             the pid is alive AND its command line names this worker's own worktree or data-dir
//   FINISHED            <ID>-REPORT.md exists and is not empty
//   DEAD-WITHOUT-REPORT everything else — including a pid that is alive but belongs to somebody else
// Exit: 0 when every dispatched packet is RUNNING or FINISHED, 1 when any DEAD-WITHOUT-REPORT exists, 2 bad usage.
//
// What this cannot see: a process that is alive and looping, and a run that was abandoned while its pid stayed alive.
// Liveness is a process question; progress is not answerable from a pid, a log tail or a report on disk.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";

const EXIT_DEAD = 1;
const EXIT_USAGE = 2;
const TAIL_BYTES = 256 * 1024;

// Records a dying run leaves behind. These are matched against PARSED log records, not raw substrings: the first real
// run of this checker reported an abort in w185's own log because the worker's prompt quotes the string "run_aborted".
// `aborted by another client` is the Cline CLI's default wording when a run comes back with finishReason "aborted" and
// this process did not request the abort (see the report) — it does NOT by itself mean a second client was involved,
// so it is evidence of an abort, not of its cause.
const PARTIAL_ABORT_PATTERNS = [/run_aborted/, /external_abort/];

/** The abort record on a log line, or null. Only a record this process could not parse is scanned as raw text. */
function abortMarker(text) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record?.type === "run_aborted" || record?.event?.type === "run_aborted") return "run_aborted";
      if (record?.finishReason === "aborted") return "finishReason aborted";
      if (record?.status === "aborted") return "status aborted";
      if (record?.errorName === "AgentRuntimeAbortError") return "AgentRuntimeAbortError";
      if (record?.event?.error_type === "AgentRuntimeAbortError") return "AgentRuntimeAbortError";
    } catch {
      const partial = PARTIAL_ABORT_PATTERNS.map((pattern) => trimmed.match(pattern)?.[0]).find(Boolean);
      if (partial) return `${partial} (partial line)`;
    }
  }
  return null;
}


function usage(message) {
  process.stderr.write(`worker-liveness: ${message}\n`);
  process.stderr.write("usage: node scripts/ci/worker-liveness.mjs --tsv <packets.tsv> --state <state dir> " +
    "[--logs <dir>] [--reports <dir>] [--launches <wave log>] [--json]\n");
  process.exit(EXIT_USAGE);
}

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--json") {
      args.json = true;
    } else if (["--tsv", "--state", "--logs", "--reports", "--launches"].includes(flag)) {
      const value = argv[i + 1];
      if (!value) usage(`${flag} needs a value`);
      args[flag.slice(2)] = value;
      i += 1;
    } else {
      usage(`unknown argument ${flag}`);
    }
  }
  if (!args.tsv) usage("--tsv is required");
  if (!args.state) usage("--state is required");
  args.logs ??= path.resolve(args.state, "..");
  return args;
}

/** The dispatched packets, in table order, first occurrence wins. Comments and blank lines are not packets. */
function readPackets(tsvPath) {
  if (!existsSync(tsvPath)) usage(`packet table not found: ${tsvPath}`);
  const packets = [];
  const seen = new Set();
  for (const line of readFileSync(tsvPath, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [id] = line.split("\t");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    packets.push({ id });
  }
  return packets;
}

function readText(filePath) {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

/** `kill -0` alone: true for a live pid AND for a recycled one. The caller must still check whose process it is. */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function commandLine(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * The anti-recycled-pid check. launch-wave3.sh passes `--cwd /tmp/w2-<id>` and `--data-dir <workers>/<id>-data`, so a
 * process that is really this worker names one of them. A pid reused by any other process does not, and is not RUNNING.
 */
function ownsProcess(id, command) {
  if (!command) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const worktree = new RegExp(`/w2-${escaped}(?=$|[\\s/"'])`);
  const dataDir = new RegExp(`/${escaped}-data(?=$|[\\s/"'])`);
  return worktree.test(command) || dataDir.test(command);
}

/** The tail of a run log: did it record an abort, and does it end mid-line (a writer that was killed)? */
function logEvidence(logPath) {
  const missing = { exists: false, bytes: 0, abort: null, truncated: false, firstTimestamp: null };
  if (!logPath || !existsSync(logPath)) return missing;
  const { size } = statSync(logPath);
  if (size === 0) return { ...missing, exists: true };
  const start = Math.max(0, size - TAIL_BYTES);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(logPath, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf8");
  const abort = abortMarker(text);
  const lines = text.split("\n").filter((line) => line.trim());
  let truncated = false;
  try {
    JSON.parse(lines.at(-1) ?? "");
  } catch {
    truncated = true;
  }
  const firstTimestamp = text.match(/"ts":"([^"]+)"/)?.[1] ?? null;
  return { exists: true, bytes: size, abort, truncated, firstTimestamp };
}

/** `LAUNCH <id> pid=<pid>` lines of the wave log, in file order. */
function readLaunches(waveLogPath) {
  const launches = new Map();
  if (!waveLogPath || !existsSync(waveLogPath)) return launches;
  for (const line of readFileSync(waveLogPath, "utf8").split("\n")) {
    const match = line.match(/^(\S+Z)\s+LAUNCH\s+(\S+)\s+pid=(\d+)/);
    if (!match) continue;
    const [, ts, id, pid] = match;
    if (!launches.has(id)) launches.set(id, []);
    launches.get(id).push({ ts, pid: Number(pid) });
  }
  return launches;
}

function reportFor(reportsDir, id) {
  if (!reportsDir) return { path: null, present: false, bytes: 0 };
  const candidate = path.join(reportsDir, `${id.toUpperCase()}-REPORT.md`);
  if (!existsSync(candidate)) return { path: candidate, present: false, bytes: 0 };
  const { size } = statSync(candidate);
  return { path: candidate, present: size > 0, bytes: size };
}

function classify(packet, paths) {
  const { id } = packet;
  const pidText = readText(path.join(paths.state, `${id}.pid`));
  const pid = Number.parseInt(pidText, 10);
  const started = readText(path.join(paths.state, `${id}.started`)) || null;
  const report = reportFor(paths.reports, id);
  const log = logEvidence(path.join(paths.logs, `${id}.log`));
  const launches = paths.launches.get(id) ?? [];
  const evidence = [];
  let verdict;

  if (report.present) {
    verdict = "FINISHED";
    evidence.push(`report ${path.basename(report.path)} (${report.bytes} bytes)`);
    if (isAlive(pid) && ownsProcess(id, commandLine(pid))) evidence.push(`pid ${pid} still alive`);
  } else if (isAlive(pid) && ownsProcess(id, commandLine(pid))) {
    // A live pid is not enough: the command line must name THIS worker, or a recycled pid reads as RUNNING forever.
    verdict = "RUNNING";
    evidence.push(`pid ${pid} alive, command line names w2-${id}`);
  } else {
    verdict = "DEAD-WITHOUT-REPORT";
    if (!pidText) evidence.push("no pid file");
    else if (!isAlive(pid)) evidence.push(`pid ${pid} gone`);
    else {
      const command = commandLine(pid);
      evidence.push(`pid ${pid} alive but is not this worker (reused): ${command.slice(0, 90) || "no command line"}`);
    }
    if (!paths.reports) evidence.push("no --reports dir, a report cannot be proven");
  }

  if (log.abort) evidence.push(`log abort marker ${log.abort}`);
  if (log.truncated) evidence.push("log ends mid-line (writer killed or log has no terminal record)");
  if (launches.length > 1) {
    evidence.push(`launched ${launches.length}x (${launches.map((entry) => `pid ${entry.pid}@${entry.ts}`).join(", ")})`);
    const firstLaunchedAt = Date.parse(launches[0].ts);
    const logStartedAt = log.firstTimestamp ? Date.parse(log.firstTimestamp) : Number.NaN;
    if (Number.isFinite(firstLaunchedAt) && Number.isFinite(logStartedAt) && logStartedAt > firstLaunchedAt + 60_000) {
      evidence.push("earlier run's log was overwritten by the relaunch");
    }
  }

  return { id, verdict, pid: pidText || null, started, evidence };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = {
    state: args.state,
    logs: args.logs,
    reports: args.reports ?? null,
    launches: readLaunches(args.launches),
  };

  const results = readPackets(args.tsv).map((packet) => classify(packet, paths));
  const counts = {
    RUNNING: results.filter((row) => row.verdict === "RUNNING").length,
    FINISHED: results.filter((row) => row.verdict === "FINISHED").length,
    "DEAD-WITHOUT-REPORT": results.filter((row) => row.verdict === "DEAD-WITHOUT-REPORT").length,
  };
  const dead = results.filter((row) => row.verdict === "DEAD-WITHOUT-REPORT").map((row) => row.id);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ results, counts, dead }, null, 2)}\n`);
  } else {
    const width = Math.max(7, ...results.map((row) => row.verdict.length));
    process.stdout.write(`${"PACKET".padEnd(8)} ${"VERDICT".padEnd(width)} ${"PID".padEnd(8)} EVIDENCE\n`);
    for (const row of results) {
      process.stdout.write(
        `${row.id.padEnd(8)} ${row.verdict.padEnd(width)} ${String(row.pid ?? "-").padEnd(8)} ${row.evidence.join("; ")}\n`,
      );
    }
    process.stdout.write(
      `\nSUMMARY: ${counts.RUNNING} RUNNING, ${counts.FINISHED} FINISHED, ` +
        `${counts["DEAD-WITHOUT-REPORT"]} DEAD-WITHOUT-REPORT of ${results.length} dispatched\n`,
    );
    process.stdout.write(dead.length ? `RESULT: FAIL (dead without report: ${dead.join(" ")})\n` : "RESULT: OK\n");
  }

  process.exit(dead.length ? EXIT_DEAD : 0);
}

main();
