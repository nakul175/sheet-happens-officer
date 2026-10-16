import { db } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";

export const GET = handle(async () => {
  const me = await currentUser();
  const users = await db.user.findMany({
    where: { workspaceId: me.workspaceId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true },
  });
  return Response.json({ users });
});
