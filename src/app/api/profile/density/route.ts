import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { handle, parseBody } from "@/lib/http";

// SHO-US-14.12: the person's own row-density choice. Only changes their own setting.
const input = z.object({ compact: z.boolean() });

export const GET = handle(async () => {
  const me = await currentUser();
  return Response.json({ compact: me.compactRows });
});

export const PUT = handle(async (req: Request) => {
  const me = await currentUser();
  const { compact } = await parseBody(req, input);
  const u = await db.user.update({ where: { id: me.id }, data: { compactRows: compact }, select: { compactRows: true } });
  return Response.json({ compact: u.compactRows });
});
