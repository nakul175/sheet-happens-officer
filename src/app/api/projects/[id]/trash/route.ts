import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { attachmentsEnabled } from "@/lib/flags";
import { listTrash } from "@/lib/tasks";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) =>
  Response.json({ ...(attachmentsEnabled() ? { attachmentsEnabled: true } : {}), items: await listTrash(await currentUser(), (await ctx.params).id) }),
);
