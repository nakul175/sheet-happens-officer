import { currentUser } from "@/lib/auth";
import { calendarEvents } from "@/lib/calendar";
import { parseDueDate, addDays } from "@/lib/dates";
import { ApiError, handle } from "@/lib/http";
export const GET = handle(async (req: Request) => {
  const user = await currentUser();
  const q = new URL(req.url).searchParams;
  const from = q.get("from") ?? "", to = q.get("to") ?? "";
  const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
  if (!valid(from) || !valid(to) || to < from || Date.parse(to)-Date.parse(from) > 62*86400000) throw new ApiError(400, "Choose a date range of at most 62 days.");
  return Response.json({ events: await calendarEvents(user, parseDueDate(from), addDays(parseDueDate(to), 1)) }, { headers: { "Cache-Control": "private, no-store" } });
});
