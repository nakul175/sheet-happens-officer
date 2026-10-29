import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { listScreenViews, saveScreenView, screenViewInput } from "@/lib/screen-views";
import { screens } from "@/lib/screen-view-state";
export const GET = handle(async (req: Request) => {
  const user = await currentUser();
  const screen = screens.parse(new URL(req.url).searchParams.get("screen"));
  return Response.json({ views: await listScreenViews(user, screen) });
});
export const POST = handle(async (req: Request) => {
  const user = await currentUser();
  return Response.json({ view: await saveScreenView(user, await parseBody(req, screenViewInput)) }, { status: 201 });
});
