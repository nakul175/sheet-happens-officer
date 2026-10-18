// Runs once inside `next start` (and `next dev`) before the server accepts traffic.
// Production is `node .../next start` under systemd; this is how SIGTERM reaches
// the drain without changing that command.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installGracefulShutdown } = await import("@/lib/shutdown");
  installGracefulShutdown();
}
