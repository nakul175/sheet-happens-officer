import { calendarEvents, calendarIcs, feedRange, feedUser } from "@/lib/calendar";
import { connection } from "next/server";
import { appUrl } from "@/lib/email";
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  await connection();
  const token = (await ctx.params).token;
  const user = token.endsWith(".ics") ? await feedUser(token.slice(0,-4)) : null;
  const headers = { "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
  if (!user) return new Response(null, { status: 404, headers });
  const range = feedRange();
  return new Response(calendarIcs(await calendarEvents(user, range.from, range.to), appUrl()), { headers: { ...headers, "Content-Type": "text/calendar; charset=utf-8" } });
}
