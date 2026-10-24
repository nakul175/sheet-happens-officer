import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { projectMemberCandidates } from "@/lib/project-member-search";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) =>
  Response.json({ people: await projectMemberCandidates(await currentUser(), (await ctx.params).id, new URL(req.url).searchParams.get("q") ?? "") }),
);
