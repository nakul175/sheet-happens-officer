import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { profileInput, updateName } from "@/lib/feed";

export const PATCH = handle(async (req: Request) => {
  const u = await currentUser();
  const { name } = await parseBody(req, profileInput);
  return Response.json(await updateName(u, name));
});
