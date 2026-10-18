import { connection } from "next/server";
import { db } from "@/lib/db";

// Health page for the deploy script and the external uptime check (SHO-US-9.3).
// 200 only when the app can reach the database.
export async function GET() {
  await connection();
  // DRILL (18 Oct 2026): deliberately unhealthy on the live server only (APP_URL is https there, http in CI) so the release rolls back. Reverted by the next commit.
  if ((process.env.APP_URL ?? "").startsWith("https://")) return Response.json({ ok: false, drill: true }, { status: 503, headers: { "cache-control": "no-store" } });
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, release: process.env.RELEASE ?? null }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
