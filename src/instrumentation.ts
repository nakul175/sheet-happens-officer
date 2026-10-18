// Fallback for a process that is still started with `next start`. Production
// systemd runs server.js, which owns SIGTERM on the http.Server it listens with.
// register() runs too late to set NEXT_MANUAL_SIG_HANDLE (Next reads it before
// this hook) and, in production, only on the first request.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installGracefulShutdown } = await import("@/lib/shutdown");
  installGracefulShutdown();
}
