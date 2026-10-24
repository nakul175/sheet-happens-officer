// SHO-2689 F7 independent measurement (W40). NOT part of the app: loaded with
// `node --require scripts/w40-exit-hold.cjs` so a probe can observe what the drain
// did to the PostgreSQL connections at the LAST moment the process is alive.
//
// src/lib/shutdown.ts:435 writes the outcome line and then calls process.exit(code)
// inside the write callback. That window is ~1ms, too short to sample pg_stat_activity
// from another connection. This preload replaces process.exit with one that keeps the
// process alive for W40_EXIT_HOLD_MS before really exiting. Nothing else changes: the
// disconnect still ran, the server is already closed, no request can be served.
if (Number(process.env.W40_EXIT_HOLD_MS || "0") > 0) {
  const holdMs = Number(process.env.W40_EXIT_HOLD_MS);
  const realExit = process.exit.bind(process);
  let holding = false;
  process.exit = function patchedExit(code) {
    if (holding) return realExit(code);
    holding = true;
    const at = Date.now();
    process.stdout.write(`w40-exit-requested code=${code} at=${at}\n`);
    // ref'd timer: keeps the event loop alive for the hold window.
    setTimeout(() => {
      process.stdout.write(`w40-exit-now at=${Date.now()} held=${Date.now() - at}ms\n`);
      realExit(code);
    }, holdMs);
  };
}
