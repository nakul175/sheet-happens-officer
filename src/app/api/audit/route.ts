import { currentUser } from "@/lib/auth";
import { handle, parseQuery } from "@/lib/http";
import { auditLog, auditQuery } from "@/lib/feed";

export const GET = handle(async (req: Request) =>
  Response.json(await auditLog(await currentUser(), parseQuery(new URL(req.url), auditQuery))),
);
