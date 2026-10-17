import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { search } from "@/lib/search";

export const GET = handle(async (req: Request) => {
  const me = await currentUser();
  const u = new URL(req.url).searchParams;
  return Response.json(await search(me, u.get("q") ?? "", u.get("archived") === "true", u.get("idea") === "true"));
});
