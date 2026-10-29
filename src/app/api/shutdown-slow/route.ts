import { connection } from "next/server";

// Used only by tests/shutdown-next.test.ts. Production does not set
// SHUTDOWN_TEST_SLOW_MS, and this route is then a 404. It exists so a real
// `next start` can hold a request open between accept and the end of the handler.
// The folder cannot start with "_" — Next treats that as a private folder and does not route it.
// connection() runs first so the build does not prerender the 404 from an empty env.
export async function GET(request: Request) {
  await connection();
  if (!process.env.SHUTDOWN_TEST_SLOW_MS) {
    return new Response(null, { status: 404 });
  }
  const ms = Number(new URL(request.url).searchParams.get("ms") ?? "0");
  process.stdout.write("sho-hit\n");
  if (Number.isFinite(ms) && ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Response("done\n", {
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}
