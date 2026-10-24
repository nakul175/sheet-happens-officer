import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { markAllRead } from "@/lib/feed";

export const POST = handle(async () => {
  await markAllRead(await currentUser());
  return new Response(null, { status: 204 });
});
