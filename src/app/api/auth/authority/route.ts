import { authorityRevision } from "@/lib/authority-revision";
import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";

// A cache invalidation hint, never a permission token. Native handlers still
// evaluate the current database authority on every read and mutation.
export const GET = handle(async () => {
  const user = await currentUser();
  const revision = await authorityRevision(user);
  return Response.json({ revision }, { headers: { "Cache-Control": "private, no-store" } });
});
