import { connection } from "next/server";
import { db } from "@/lib/db";

// Health page for the deploy script and the external uptime check (SHO-US-9.3).
// 200 only when the app can reach the database.
export async function GET() {
  await connection();
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, release: process.env.RELEASE ?? null }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
